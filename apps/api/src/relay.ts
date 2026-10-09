// Self-hosted settlement for the x402 check fee: the merchant account relays the buyer's EIP-3009 authorization to the
// USDC contract itself and pays gas in USDC (docs.arc.io: "Operate an EIP-3009 relayer on Arc"). This replaces the hosted
// facilitator's /verify, /settle and /status. Rules that matter for money:
//   - the signed relay transaction and its hash are persisted BEFORE broadcast, so a crash never loses track of a sent tx;
//   - "paid" means matching AuthorizationUsed + Transfer logs in one transaction — never the authorizationState boolean alone,
//     and never our own transaction's status on its own; an authorization executed by another broadcaster is still a payment;
//   - a cancellation (AuthorizationCanceled) is a terminal failure; unknown outcomes stay PENDING and are re-examined later;
//   - a balance floor pauses new settlements, a fee cap refuses expensive ones, and one in-process lock serialises the relayer nonce.
import { keccak256, toHex, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { FIAT_TOKEN_EIP3009_ABI, verifyTransferAuthorization, encodeTransferWithAuthorization, findSettlementInLogs, decodeRevertReason, authorizationCallMatches,
  AUTHORIZATION_USED_TOPIC, AUTHORIZATION_CANCELED_TOPIC, addressTopic, type Eip3009Authorization, type SettlementEvidence, type SettlementExpectation, type ArcNet } from "@arcpreflight/client";
import { type Db, row, run, now } from "./db.js";
import { sendIdentical, SEND_ATTEMPTS } from "@arcpreflight/runner";

export type RelayPayload = { signature: Hex; authorization: Eip3009Authorization };
export type RelayState = "SUBMITTED" | "PENDING" | "COMPLETED" | "FAILED";
export type RelayOutcome = { state: RelayState; txHash: Hex | null; reason: string | null; evidence: SettlementEvidence | null };
export type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };
/** The slice of chain access the relayer uses. Production adapts a viem PublicClient; tests inject a fake. */
export type RelayRpc = {
  getChainId(): Promise<number>;
  getBalance(a: { address: Hex }): Promise<bigint>;
  getTransactionCount(a: { address: Hex; blockTag?: "latest" | "pending" }): Promise<number>;
  readContract(a: { address: Hex; abi: any; functionName: string; args: readonly unknown[] }): Promise<unknown>;
  estimateGas(a: { account: Hex; to: Hex; data: Hex }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint | null; maxPriorityFeePerGas?: bigint | null }>;
  call(a: { account: Hex; to: Hex; data: Hex; blockNumber?: bigint }): Promise<unknown>;
  sendRawTransaction(a: { serializedTransaction: Hex }): Promise<Hex>;
  getTransactionReceipt(a: { hash: Hex }): Promise<any>;
  getTransaction(a: { hash: Hex }): Promise<any>;
  getBlockNumber(): Promise<bigint>;
  getLogs(a: { address: Hex; fromBlock: bigint; toBlock: bigint; topics: (string | string[] | null)[] }): Promise<RawLog[]>;
};
export type RelayConfig = {
  net: ArcNet; chainId: number; usdc: Hex; account: PrivateKeyAccount; rpc: RelayRpc;
  floorNativeAtomic: bigint; maxFeeNativeAtomic: bigint; receiptTimeoutMs: number; scanChunkBlocks: number; scanChunksPerCall: number;
  seal: (obj: unknown) => Promise<string>; open: (s: string) => Promise<any>; sleep?: (ms: number) => Promise<void>;
};

const FEE_FLOOR = 20_000_000_000n; // Arc drops transactions below 20 gwei
const revertText = (e: any): string => decodeRevertReason(e?.cause?.data ?? e?.data ?? null) ?? String(e?.shortMessage ?? e?.details ?? e?.message ?? e).slice(0, 160);

export class Relayer {
  private queue: Promise<unknown> = Promise.resolve();
  private chainVerified = false;
  constructor(private readonly c: RelayConfig) {}
  get address(): Hex { return this.c.account.address; }
  /** The RPC must serve the configured network: payment evidence from another chain must never count. Checked once per process. */
  private async assertChain() {
    if (this.chainVerified) return;
    const id = await this.c.rpc.getChainId();
    if (id !== this.c.chainId) throw new Error(`relayer RPC serves chain ${id}, expected ${this.c.chainId}`);
    this.chainVerified = true;
  }

  async paused(): Promise<{ paused: boolean; balanceNativeAtomic: bigint; floorNativeAtomic: bigint }> {
    const b = await this.c.rpc.getBalance({ address: this.address });
    return { paused: b < this.c.floorNativeAtomic, balanceNativeAtomic: b, floorNativeAtomic: this.c.floorNativeAtomic };
  }

  /** Idempotent entry point, called under the per-request lease: resumes whatever stage the payment row is in. With
   *  `allowSend: false` (read routes) it only records facts read from the chain — no first broadcast, rebroadcast or re-sign;
   *  those happen in the start-up pass, the recovery worker, POST /v1/preflight and the authorized recovery command (v3.2 §10.2). */
  async settle(db: Db, requestId: string, payload: RelayPayload, opts: { allowSend: boolean } = { allowSend: true }): Promise<RelayOutcome> {
    const p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
    if (!p) throw new Error("payment row missing");
    if (p.state === "COMPLETED" || p.state === "FAILED") return this.outcomeOf(p);
    if (p.tx_hash) return this.reconcileBroadcast(db, p, payload, opts.allowSend);
    if (opts.allowSend) return this.firstSubmit(db, p, payload);
    // observer: the accepted authorization may have been executed by another broadcaster meanwhile; otherwise it waits for the worker
    if (await this.authorizationUsed(payload.authorization)) return this.resolveExecutedElsewhere(db, p, this.expectation(payload.authorization), payload.authorization);
    return this.keep(db, p.request_id, "SUBMITTED", "authorization accepted; awaiting the settlement worker (read routes never broadcast)");
  }

  private expectation(a: Eip3009Authorization): SettlementExpectation { return { usdc: this.c.usdc, from: a.from, to: a.to, value: BigInt(a.value), nonce: a.nonce }; }
  private lock<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn, fn); this.queue = next.then(() => undefined, () => undefined); return next; }
  private sleep(ms: number) { return (this.c.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms); }
  private authorizationUsed(a: Eip3009Authorization) { return this.c.rpc.readContract({ address: this.c.usdc, abi: FIAT_TOKEN_EIP3009_ABI, functionName: "authorizationState", args: [a.from, a.nonce] }) as Promise<boolean>; }
  private async fees() {
    const f = await this.c.rpc.estimateFeesPerGas().catch(() => ({} as { maxFeePerGas?: bigint | null; maxPriorityFeePerGas?: bigint | null }));
    const maxFeePerGas = f.maxFeePerGas && f.maxFeePerGas > FEE_FLOOR ? f.maxFeePerGas : FEE_FLOOR + 1_000_000_000n;
    return { maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 1_000_000_000n };
  }
  private outcomeOf(p: any): RelayOutcome {
    const last = p.last_response_json ? JSON.parse(p.last_response_json) : null;
    return { state: p.state, txHash: p.tx_hash ?? null, reason: last?.reason ?? null, evidence: p.settlement_evidence_json ? JSON.parse(p.settlement_evidence_json) : null };
  }
  private finish(db: Db, requestId: string, state: "COMPLETED" | "FAILED", txHash: Hex | null, reason: string | null, ev: SettlementEvidence | null): RelayOutcome {
    run(db, "UPDATE payments SET state = ?, tx_hash = COALESCE(?, tx_hash), settlement_evidence_json = ?, last_response_json = ?, updated_at = ? WHERE request_id = ?",
      state, txHash, ev ? JSON.stringify(ev) : null, JSON.stringify({ stage: state, reason }), now(), requestId);
    return { state, txHash: txHash ?? row(db, "SELECT tx_hash FROM payments WHERE request_id = ?", requestId)?.tx_hash ?? null, reason, evidence: ev };
  }
  private keep(db: Db, requestId: string, state: "SUBMITTED" | "PENDING", reason: string): RelayOutcome {
    run(db, "UPDATE payments SET state = ?, last_response_json = ?, updated_at = ? WHERE request_id = ?", state, JSON.stringify({ stage: state, reason }), now(), requestId);
    return { state, txHash: row(db, "SELECT tx_hash FROM payments WHERE request_id = ?", requestId)?.tx_hash ?? null, reason, evidence: null };
  }

  // ---- first submission: local verification, then sign → persist → broadcast → bounded wait
  private async firstSubmit(db: Db, p: any, payload: RelayPayload): Promise<RelayOutcome> {
    const a = payload.authorization; const x = this.expectation(a);
    await this.assertChain();
    const v = await verifyTransferAuthorization(this.c.net, a, payload.signature);
    if (!v.ok) return this.finish(db, p.request_id, "FAILED", null, `authorization rejected: ${v.reason}`, null);
    if (await this.authorizationUsed(a)) return this.resolveExecutedElsewhere(db, p, x, a);
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(a.validBefore) <= nowS) return this.finish(db, p.request_id, "FAILED", null, "authorization expired before settlement", null);
    if (BigInt(a.validAfter) > nowS) return this.keep(db, p.request_id, "SUBMITTED", "authorization not yet valid");
    const bal = (await this.c.rpc.readContract({ address: this.c.usdc, abi: FIAT_TOKEN_EIP3009_ABI, functionName: "balanceOf", args: [a.from] })) as bigint;
    if (bal < x.value) return this.finish(db, p.request_id, "FAILED", null, "payer balance below the authorized amount", null);
    if ((await this.paused()).paused) return this.keep(db, p.request_id, "SUBMITTED", "settlement paused: relayer balance below floor");
    return this.lock(() => this.signAndBroadcast(db, p.request_id, payload, x, null));
  }
  /** `expectHash` is the relay transaction the caller saw on the row (null for a first submission): if another caller signed a
   *  different one while we waited for the lock, reconcile that instead of signing again. */
  private async signAndBroadcast(db: Db, requestId: string, payload: RelayPayload, x: SettlementExpectation, expectHash: string | null): Promise<RelayOutcome> {
    const current = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
    if (current?.tx_hash && current.state === "PENDING" && current.tx_hash !== expectHash) return this.reconcileBroadcast(db, current, payload);
    const data = encodeTransferWithAuthorization(payload.authorization, payload.signature);
    let gas: bigint;
    try { gas = await this.c.rpc.estimateGas({ account: this.address, to: this.c.usdc, data }); }
    catch (e: any) {
      if (await this.authorizationUsed(payload.authorization)) return this.resolveExecutedElsewhere(db, row(db, "SELECT * FROM payments WHERE request_id = ?", requestId), x, payload.authorization);
      return this.finish(db, requestId, "FAILED", null, `relay call would revert: ${revertText(e)}`, null);
    }
    const fees = await this.fees();
    const gasLimit = (gas * 12n) / 10n;
    if (gasLimit * fees.maxFeePerGas > this.c.maxFeeNativeAtomic) return this.keep(db, requestId, "SUBMITTED", `settlement fee above cap (${gasLimit * fees.maxFeePerGas} > ${this.c.maxFeeNativeAtomic} native units)`);
    const nonce = await this.c.rpc.getTransactionCount({ address: this.address, blockTag: "pending" });
    const raw = await this.c.account.signTransaction({ chainId: this.c.chainId, type: "eip1559", to: this.c.usdc, data, value: 0n, nonce, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    const hash = keccak256(raw);
    const head = await this.c.rpc.getBlockNumber().catch(() => null);
    run(db, "UPDATE payments SET tx_hash = ?, relay_nonce = ?, relay_raw_tx_encrypted = ?, created_block = COALESCE(created_block, ?), state = 'PENDING', last_response_json = ?, updated_at = ? WHERE request_id = ?",
      hash, nonce, await this.c.seal({ raw }), head === null ? null : Math.max(Number(head) - 2, 0), JSON.stringify({ stage: "signed", hash, nonce, previous: current?.tx_hash ?? null }), now(), requestId);
    return this.broadcastAndAwait(db, requestId, raw, hash, x, payload);
  }
  private async broadcastAndAwait(db: Db, requestId: string, raw: Hex, hash: Hex, x: SettlementExpectation, payload: RelayPayload): Promise<RelayOutcome> {
    // the IDENTICAL signed bytes are handed to the node again while the authorization is valid — a pool node may refuse one call
    // ("eth_sendRawTransaction does not exist", 2026-10-09); "already known" counts as taken. Never a different transaction: the fee
    // cap checked before signing and the single-sender lock the caller holds still bound it.
    const valid = () => BigInt(payload.authorization.validBefore) > BigInt(Math.floor(Date.now() / 1000));
    const sent = await sendIdentical(this.c.rpc, raw, valid, SEND_ATTEMPTS, 400, (ms) => this.sleep(ms));
    if (!sent.accepted) // nonce races and refusals are recorded and re-examined by reconcile
      run(db, "UPDATE payments SET last_response_json = ?, updated_at = ? WHERE request_id = ?", JSON.stringify({ stage: "broadcast-error", hash, error: sent.sendError, attempts: sent.attempts }), now(), requestId);
    return this.awaitReceipt(db, requestId, hash, x, payload, sent.accepted ? undefined
      : `the node did not confirm taking the relay transaction (${sent.attempts} identical attempt(s): ${sent.sendError ?? "no answer"}); the settlement worker re-examines it and may rebroadcast the identical bytes while the authorization is valid`);
  }
  private async awaitReceipt(db: Db, requestId: string, hash: Hex, x: SettlementExpectation, payload: RelayPayload, pendingReason = "relay transaction broadcast; receipt not yet available"): Promise<RelayOutcome> {
    const deadline = Date.now() + this.c.receiptTimeoutMs;
    for (;;) {
      const rc = await this.c.rpc.getTransactionReceipt({ hash }).catch(() => null);
      if (rc) return this.settleFromReceipt(db, requestId, rc, x, payload);
      if (Date.now() >= deadline) return this.keep(db, requestId, "PENDING", pendingReason);
      await this.sleep(1000);
    }
  }
  private async settleFromReceipt(db: Db, requestId: string, rc: any, x: SettlementExpectation, payload: RelayPayload): Promise<RelayOutcome> {
    if (rc.status === "success" || rc.status === "0x1") {
      const ev = findSettlementInLogs(rc.logs ?? [], x, rc.transactionHash);
      if (ev) return this.finish(db, requestId, "COMPLETED", ev.transactionHash, null, ev);
      return this.keep(db, requestId, "PENDING", "relay transaction succeeded but its receipt lacks matching AuthorizationUsed + Transfer logs; not treated as paid");
    }
    // reverted: either another broadcaster consumed the authorization first, or the transfer genuinely failed
    if (await this.authorizationUsed(payload.authorization)) return this.resolveExecutedElsewhere(db, row(db, "SELECT * FROM payments WHERE request_id = ?", requestId), x, payload.authorization);
    let why: string | null = null;
    try { await this.c.rpc.call({ account: this.address, to: this.c.usdc, data: encodeTransferWithAuthorization(payload.authorization, payload.signature), blockNumber: rc.blockNumber }); }
    catch (e: any) { why = revertText(e); }
    return this.finish(db, requestId, "FAILED", rc.transactionHash, `relay transaction reverted${why ? `: ${why}` : ""}`, null);
  }

  // ---- a row that already has a relay transaction: receipt → authorizationState → mempool → rebroadcast / re-sign
  private async reconcileBroadcast(db: Db, p: any, payload: RelayPayload, allowSend = true): Promise<RelayOutcome> {
    const x = this.expectation(payload.authorization); const hash = p.tx_hash as Hex;
    const rc = await this.c.rpc.getTransactionReceipt({ hash }).catch(() => null);
    if (rc) return this.settleFromReceipt(db, p.request_id, rc, x, payload);
    if (await this.authorizationUsed(payload.authorization)) return this.resolveExecutedElsewhere(db, p, x, payload.authorization);
    if (await this.c.rpc.getTransaction({ hash }).catch(() => null)) { // still in flight
      return allowSend ? this.awaitReceipt(db, p.request_id, hash, x, payload) : this.keep(db, p.request_id, "PENDING", "relay transaction in flight; receipt not yet available");
    }
    if (BigInt(payload.authorization.validBefore) <= BigInt(Math.floor(Date.now() / 1000))) return this.finish(db, p.request_id, "FAILED", null, "authorization expired before settlement", null);
    const latestNonce = await this.c.rpc.getTransactionCount({ address: this.address, blockTag: "latest" });
    if (p.relay_raw_tx_encrypted && p.relay_nonce !== null && latestNonce <= Number(p.relay_nonce)) {
      if (!allowSend) return this.keep(db, p.request_id, "PENDING", "relay transaction dropped inside the authorization's validity; the settlement worker may rebroadcast the identical bytes");
      const { raw } = await this.c.open(p.relay_raw_tx_encrypted); // same bytes, same hash: a rebroadcast cannot pay twice
      return this.lock(() => this.broadcastAndAwait(db, p.request_id, raw, hash, x, payload));
    }
    // our nonce was consumed by something else (or the raw tx is unavailable); one more receipt look-up for a lagging node, then re-sign
    await this.sleep(1000);
    const late = await this.c.rpc.getTransactionReceipt({ hash }).catch(() => null);
    if (late) return this.settleFromReceipt(db, p.request_id, late, x, payload);
    if (!allowSend) return this.keep(db, p.request_id, "PENDING", "relay nonce consumed by another transaction; the settlement worker will re-sign the same authorization (one authorization nonce, so it cannot pay twice)");
    return this.lock(() => this.signAndBroadcast(db, p.request_id, payload, x, hash));
  }

  // ---- the authorization is consumed on-chain but not by a transaction we can name: find the transaction that did it.
  //      Only a DIRECT USDC call whose calldata equals the stored authorization counts; wrappers stay pending for manual reconciliation.
  private async resolveExecutedElsewhere(db: Db, p: any, x: SettlementExpectation, a: Eip3009Authorization): Promise<RelayOutcome> {
    await this.assertChain();
    const head = await this.c.rpc.getBlockNumber();
    const chunk = BigInt(this.c.scanChunkBlocks);
    let from = p.scanned_to_block !== null && p.scanned_to_block !== undefined ? BigInt(p.scanned_to_block) + 1n
      : p.created_block !== null && p.created_block !== undefined ? BigInt(p.created_block) : head > chunk ? head - chunk : 0n;
    let to = from;
    for (let i = 0; i < this.c.scanChunksPerCall && from <= head; i++) {
      to = from + chunk - 1n; if (to > head) to = head;
      const logs = await this.c.rpc.getLogs({ address: this.c.usdc, fromBlock: from, toBlock: to, topics: [[AUTHORIZATION_USED_TOPIC, AUTHORIZATION_CANCELED_TOPIC], addressTopic(x.from), x.nonce] });
      for (const l of logs) {
        if (l.topics[0]?.toLowerCase() === AUTHORIZATION_CANCELED_TOPIC) return this.finish(db, p.request_id, "FAILED", l.transactionHash as Hex, "authorization canceled on-chain by the payer", null);
        const tx = await this.c.rpc.getTransaction({ hash: l.transactionHash as Hex }).catch(() => null);
        const direct = !!tx && String(tx.to ?? "").toLowerCase() === this.c.usdc.toLowerCase() && authorizationCallMatches(tx.input, a);
        if (!direct) return this.keep(db, p.request_id, "PENDING", `authorization consumed by transaction ${l.transactionHash} of an unrecognised shape (wrapper or mismatched calldata); manual reconciliation required`);
        const rc = await this.c.rpc.getTransactionReceipt({ hash: l.transactionHash as Hex }).catch(() => null);
        const ev = rc && (rc.status === "success" || rc.status === "0x1") ? findSettlementInLogs(rc.logs ?? [], x, rc.transactionHash) : null;
        if (ev) return this.finish(db, p.request_id, "COMPLETED", ev.transactionHash, p.tx_hash && p.tx_hash.toLowerCase() !== ev.transactionHash.toLowerCase() ? "settled by a transaction other than the relayer's" : null, ev);
      }
      run(db, "UPDATE payments SET scanned_to_block = ?, updated_at = ? WHERE request_id = ?", Number(to), now(), p.request_id);
      from = to + 1n;
    }
    return this.keep(db, p.request_id, "PENDING", `authorization consumed on-chain; settlement evidence not located yet (scanned to block ${to})`);
  }
}

/** Adapts a viem PublicClient to RelayRpc; eth_getLogs is issued raw so topic OR-lists work without an ABI event. */
export function relayRpcFromClient(client: PublicClient): RelayRpc {
  return {
    getChainId: () => client.getChainId(),
    getBalance: (a) => client.getBalance(a), getTransactionCount: (a) => client.getTransactionCount(a), readContract: (a) => client.readContract(a as any),
    estimateGas: (a) => client.estimateGas(a as any), estimateFeesPerGas: () => client.estimateFeesPerGas(), call: (a) => client.call(a as any),
    sendRawTransaction: (a) => client.sendRawTransaction(a), getTransactionReceipt: (a) => client.getTransactionReceipt(a), getTransaction: (a) => client.getTransaction(a), getBlockNumber: () => client.getBlockNumber(),
    getLogs: (a) => client.request({ method: "eth_getLogs", params: [{ address: a.address, fromBlock: toHex(a.fromBlock), toBlock: toHex(a.toBlock), topics: a.topics as any }] }) as Promise<RawLog[]>,
  };
}
