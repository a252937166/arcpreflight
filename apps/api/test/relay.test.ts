import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, toHex, type Hex } from "viem";
import { signTransferAuthorization, encodeTransferWithAuthorization, AUTHORIZATION_USED_TOPIC, AUTHORIZATION_CANCELED_TOPIC, TRANSFER_TOPIC, addressTopic, ARC } from "@arcpreflight/client";
import { openDb, row, run, type Db } from "../src/db.js";
import { Relayer, type RelayRpc, type RelayPayload } from "../src/relay.js";

// A real relayer key and a real buyer signature drive a fully fake chain: every branch of settlement recovery is exercised offline.
const relayerKey = privateKeyToAccount("0x" + "cd".repeat(32) as Hex);
const buyer = privateKeyToAccount("0x" + "ab".repeat(32) as Hex);
const USDC = ARC.testnet.usdc;
const REQ = "request-relay-00001";
const OTHER_TX = ("0x" + "99".repeat(32)) as Hex;

type Fake = RelayRpc & { chainId: number; txs: Map<string, { to: string; input: string }>; sent: Hex[]; receipts: Map<string, any>; known: Set<string>; authUsed: boolean; buyerBalance: bigint; relayerBalance: bigint; latestNonce: number; pendingNonce: number; head: bigint; logs: any[]; estimateError: Error | null; sendError: Error | null; getLogsCalls: { fromBlock: bigint; toBlock: bigint }[] };
function fakeRpc(): Fake {
  const f: Fake = {
    chainId: 5042002, txs: new Map(), sent: [], receipts: new Map(), known: new Set(), authUsed: false, buyerBalance: 10_000n, relayerBalance: 10n ** 18n, latestNonce: 5, pendingNonce: 5, head: 1_000n, logs: [], estimateError: null, sendError: null, getLogsCalls: [],
    getBalance: async () => f.relayerBalance,
    getTransactionCount: async ({ blockTag }) => (blockTag === "pending" ? f.pendingNonce : f.latestNonce),
    readContract: async ({ functionName }) => (functionName === "authorizationState" ? f.authUsed : functionName === "balanceOf" ? f.buyerBalance : undefined),
    estimateGas: async () => { if (f.estimateError) throw f.estimateError; return 65_000n; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    call: async () => { throw Object.assign(new Error("execution reverted"), { shortMessage: "FiatTokenV2: authorization is used or canceled" }); },
    sendRawTransaction: async ({ serializedTransaction }) => { if (f.sendError) throw f.sendError; f.sent.push(serializedTransaction); f.known.add(keccak256(serializedTransaction)); return keccak256(serializedTransaction); },
    getTransactionReceipt: async ({ hash }) => { const r = f.receipts.get(hash.toLowerCase()); if (!r) throw new Error("not found"); return r; },
    getTransaction: async ({ hash }) => (f.txs.get(hash.toLowerCase()) ? { hash, ...f.txs.get(hash.toLowerCase()) } : f.known.has(hash) ? { hash } : null),
    getChainId: async () => f.chainId,
    getBlockNumber: async () => f.head,
    getLogs: async ({ fromBlock, toBlock }) => { f.getLogsCalls.push({ fromBlock, toBlock }); return f.logs.filter((l) => BigInt(l.blockNumber) >= fromBlock && BigInt(l.blockNumber) <= toBlock); },
  };
  return f;
}
/** settlement logs for an authorization (value may arrive as the 6-decimal decimal string carried by the authorization) */
const logsFor = (hash: string, x: { nonce: Hex; value?: bigint | string; to?: Hex }, block = 1_001n) => [
  { address: USDC, topics: [AUTHORIZATION_USED_TOPIC, addressTopic(buyer.address), x.nonce], data: "0x", logIndex: 0, transactionHash: hash, blockNumber: block },
  { address: USDC, topics: [TRANSFER_TOPIC, addressTopic(buyer.address), addressTopic(x.to ?? relayerKey.address)], data: toHex(BigInt(x.value ?? 10_000n), { size: 32 }), logIndex: 1, transactionHash: hash, blockNumber: block },
];
const receipt = (hash: string, status: "success" | "reverted", logs: any[] = [], block = 1_001n) => ({ status, transactionHash: hash, blockNumber: block, logs, gasUsed: 60_000n, effectiveGasPrice: 20_000_000_000n });

let db: Db; let rpc: Fake; let relayer: Relayer; let payload: RelayPayload;
beforeEach(async () => {
  db = openDb(":memory:"); rpc = fakeRpc();
  relayer = new Relayer({ net: "testnet", chainId: 5042002, usdc: USDC, account: relayerKey, rpc, floorNativeAtomic: 50_000_000_000_000_000n, maxFeeNativeAtomic: 5_000_000_000_000_000n, receiptTimeoutMs: 0, scanChunkBlocks: 100, scanChunksPerCall: 2,
    seal: async (o) => JSON.stringify(o), open: async (s) => JSON.parse(s), sleep: async () => {} });
  payload = await signTransferAuthorization(buyer, "testnet", { payTo: relayerKey.address, valueTokenAtomic: 10_000n });
  run(db, "INSERT INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, backend, created_block) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    REQ, "ap_request-relay-00001", "eip155:5042002", USDC, buyer.address.toLowerCase(), payload.authorization.nonce, "SUBMITTED", new Date().toISOString(), new Date().toISOString(), "relay", 900);
});
const settle = () => relayer.settle(db, REQ, payload);
const saved = () => row(db, "SELECT * FROM payments WHERE request_id = ?", REQ);
/** the fake chain mines whatever the relayer sends, with proper settlement logs */
const mineSent = (f: Fake, x = payload.authorization) => { for (const raw of f.sent) { const h = keccak256(raw); if (!f.receipts.has(h)) f.receipts.set(h, receipt(h, "success", logsFor(h, { nonce: x.nonce }))); } };

describe("self-relayed EIP-3009 settlement", () => {
  it("signs, persists the transaction before broadcasting, and completes only on matching AuthorizationUsed + Transfer logs", async () => {
    let persistedBeforeSend: any = null;
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { persistedBeforeSend = saved(); rpc.sent.push(serializedTransaction); const h = keccak256(serializedTransaction); rpc.receipts.set(h, receipt(h, "success", logsFor(h, payload.authorization))); return h; };
    const r = await settle();
    expect(r.state).toBe("COMPLETED");
    expect(persistedBeforeSend).toMatchObject({ state: "PENDING", tx_hash: r.txHash, relay_nonce: 5 });
    expect(JSON.parse(persistedBeforeSend.relay_raw_tx_encrypted).raw).toBe(rpc.sent[0]);
    const tx = parseTransaction(rpc.sent[0]);
    expect(tx).toMatchObject({ chainId: 5042002, to: USDC.toLowerCase(), nonce: 5, maxFeePerGas: 21_000_000_000n });
    expect(tx.data?.slice(0, 10)).toBe("0xe3ee160e");
    expect(r.evidence).toMatchObject({ transactionHash: r.txHash, authorizationUsedLogIndex: 0, transferLogIndex: 1, value: "10000" });
    expect(saved()).toMatchObject({ state: "COMPLETED", tx_hash: r.txHash });
    expect(JSON.parse(saved().settlement_evidence_json).transactionHash).toBe(r.txHash);
  });
  it("does not treat a successful receipt as payment when the settlement logs are missing", async () => {
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { const h = keccak256(serializedTransaction); rpc.sent.push(serializedTransaction); rpc.receipts.set(h, receipt(h, "success", [])); return h; };
    expect(await settle()).toMatchObject({ state: "PENDING", reason: expect.stringContaining("lacks matching") });
    expect(saved().state).toBe("PENDING");
  });
  it("stays PENDING while the receipt is unavailable, then completes from the receipt on a later reconcile", async () => {
    expect(await settle()).toMatchObject({ state: "PENDING", reason: expect.stringContaining("receipt not yet available") });
    expect(rpc.sent).toHaveLength(1);
    mineSent(rpc);
    expect(await settle()).toMatchObject({ state: "COMPLETED", txHash: keccak256(rpc.sent[0]) });
    expect(rpc.sent).toHaveLength(1); // no second broadcast
  });
  it("recognises a payment executed by another broadcaster and records that transaction, not ours", async () => {
    expect((await settle()).state).toBe("PENDING"); // our tx is out, unmined
    const ours = keccak256(rpc.sent[0]);
    rpc.receipts.set(ours, receipt(ours, "reverted", [], 1_002n)); // ours reverted: authorization already used
    rpc.authUsed = true;
    rpc.txs.set(OTHER_TX, { to: USDC, input: encodeTransferWithAuthorization(payload.authorization, payload.signature) }); // a direct USDC call for exactly this authorization
    rpc.logs = logsFor(OTHER_TX, payload.authorization, 950n);
    rpc.receipts.set(OTHER_TX, receipt(OTHER_TX, "success", rpc.logs, 950n));
    const r = await settle();
    expect(r).toMatchObject({ state: "COMPLETED", txHash: OTHER_TX, reason: "settled by a transaction other than the relayer's" });
    expect(saved()).toMatchObject({ state: "COMPLETED", tx_hash: OTHER_TX });
    expect(rpc.getLogsCalls[0]).toEqual({ fromBlock: 900n, toBlock: 999n }); // scan starts at the row's created_block
  });
  it("keeps a consumed authorization PENDING until evidence is located, advancing the scan window without rescanning", async () => {
    rpc.authUsed = true; rpc.head = 1_500n; // consumed before we ever sent anything; no logs in range yet
    expect(await settle()).toMatchObject({ state: "PENDING", reason: expect.stringContaining("evidence not located yet") });
    expect(rpc.getLogsCalls).toEqual([{ fromBlock: 900n, toBlock: 999n }, { fromBlock: 1_000n, toBlock: 1_099n }]);
    expect(saved()).toMatchObject({ state: "PENDING", scanned_to_block: 1_099 });
    expect(rpc.sent).toHaveLength(0); // never signed: the authorization is not ours to relay any more
    rpc.txs.set(OTHER_TX, { to: USDC, input: encodeTransferWithAuthorization(payload.authorization, payload.signature) });
    rpc.logs = logsFor(OTHER_TX, payload.authorization, 1_150n); rpc.receipts.set(OTHER_TX, receipt(OTHER_TX, "success", rpc.logs, 1_150n));
    expect(await settle()).toMatchObject({ state: "COMPLETED", txHash: OTHER_TX });
    expect(rpc.getLogsCalls[2]).toEqual({ fromBlock: 1_100n, toBlock: 1_199n });
  });
  it("treats an on-chain cancellation as a terminal failure, never as a payment", async () => {
    rpc.authUsed = true;
    rpc.logs = [{ address: USDC, topics: [AUTHORIZATION_CANCELED_TOPIC, addressTopic(buyer.address), payload.authorization.nonce], data: "0x", logIndex: 0, transactionHash: OTHER_TX, blockNumber: 950n }];
    expect(await settle()).toMatchObject({ state: "FAILED", reason: expect.stringContaining("canceled") });
    expect(saved().settlement_evidence_json).toBeNull();
  });
  it("fails a reverted relay transaction with the decoded reason when the authorization is still unused", async () => {
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { const h = keccak256(serializedTransaction); rpc.sent.push(serializedTransaction); rpc.receipts.set(h, receipt(h, "reverted")); return h; };
    expect(await settle()).toMatchObject({ state: "FAILED", reason: expect.stringContaining("reverted: FiatTokenV2: authorization is used or canceled") });
  });
  it("refuses forged authorizations, insufficient payer balance and a would-revert call before spending any gas", async () => {
    const forged = { ...payload, signature: ("0x" + "11".repeat(65)) as Hex };
    expect(await relayer.settle(db, REQ, forged)).toMatchObject({ state: "FAILED", reason: expect.stringContaining("authorization rejected") });
    run(db, "UPDATE payments SET state = 'SUBMITTED'");
    rpc.buyerBalance = 9_999n;
    expect(await settle()).toMatchObject({ state: "FAILED", reason: expect.stringContaining("payer balance") });
    run(db, "UPDATE payments SET state = 'SUBMITTED'"); rpc.buyerBalance = 10_000n;
    rpc.estimateError = Object.assign(new Error("execution reverted"), { shortMessage: "FiatTokenV2: invalid signature" });
    expect(await settle()).toMatchObject({ state: "FAILED", reason: expect.stringContaining("would revert") });
    expect(rpc.sent).toHaveLength(0);
  });
  it("pauses below the relayer balance floor and refuses fees above the cap, leaving the payment resumable", async () => {
    rpc.relayerBalance = 49_000_000_000_000_000n;
    expect(await settle()).toMatchObject({ state: "SUBMITTED", reason: expect.stringContaining("paused") });
    rpc.relayerBalance = 10n ** 18n;
    rpc.estimateFeesPerGas = async () => ({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1n }); // 78k gas × 100 gwei = 0.0078 > 0.005 cap
    expect(await settle()).toMatchObject({ state: "SUBMITTED", reason: expect.stringContaining("fee above cap") });
    expect(rpc.sent).toHaveLength(0);
    rpc.estimateFeesPerGas = async () => ({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { const h = keccak256(serializedTransaction); rpc.sent.push(serializedTransaction); rpc.receipts.set(h, receipt(h, "success", logsFor(h, payload.authorization))); return h; };
    expect((await settle()).state).toBe("COMPLETED");
  });
  it("re-broadcasts the identical signed transaction after a crash between persisting and sending", async () => {
    rpc.sendError = new Error("socket hang up");
    expect(await settle()).toMatchObject({ state: "PENDING" });
    const first = saved(); expect(first.tx_hash).toBeTruthy(); expect(rpc.sent).toHaveLength(0);
    rpc.sendError = null;
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { const h = keccak256(serializedTransaction); rpc.sent.push(serializedTransaction); rpc.receipts.set(h, receipt(h, "success", logsFor(h, payload.authorization))); return h; };
    expect(await settle()).toMatchObject({ state: "COMPLETED", txHash: first.tx_hash });
    expect(keccak256(rpc.sent[0])).toBe(first.tx_hash); // same bytes, same hash
  });
  it("a node that refuses eth_sendRawTransaction is handed the identical relay bytes again, inside the authorization's validity (2026-10-09)", async () => {
    const tries: Hex[] = []; let refusals = 2;
    rpc.sendRawTransaction = async ({ serializedTransaction }) => {
      tries.push(serializedTransaction);
      if (refusals-- > 0) throw new Error('The method "eth_sendRawTransaction" does not exist / is not available.');
      const h = keccak256(serializedTransaction); rpc.sent.push(serializedTransaction); rpc.receipts.set(h, receipt(h, "success", logsFor(h, payload.authorization))); return h;
    };
    expect(await settle()).toMatchObject({ state: "COMPLETED", txHash: keccak256(tries[0]) });
    expect(tries).toHaveLength(3); expect(new Set(tries).size).toBe(1); // one signature, one hash, one nonce
    expect(saved().tx_hash).toBe(keccak256(tries[0]));
    // three refusals: recorded with the attempts, the row stays PENDING on the same hash (re-examined by the worker)
    db = openDb(":memory:");
    run(db, "INSERT INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, backend, created_block) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      REQ, "ap_request-relay-00001", "eip155:5042002", USDC, buyer.address.toLowerCase(), payload.authorization.nonce, "SUBMITTED", new Date().toISOString(), new Date().toISOString(), "relay", 900);
    const refused: Hex[] = []; rpc.receipts.clear();
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { refused.push(serializedTransaction); throw new Error('The method "eth_sendRawTransaction" does not exist / is not available.'); };
    expect(await settle()).toMatchObject({ state: "PENDING" });
    expect(refused).toHaveLength(3); expect(new Set(refused).size).toBe(1);
    expect(saved()).toMatchObject({ state: "PENDING", tx_hash: keccak256(refused[0]) });
    expect(JSON.parse(saved().last_response_json).reason).toMatch(/^the node did not confirm taking the relay transaction \(3 identical attempt\(s\): The method "eth_sendRawTransaction" does not exist/);
  });
  it("signs a fresh transaction when the relayer nonce was consumed elsewhere, but settles the same authorization exactly once", async () => {
    expect((await settle()).state).toBe("PENDING");
    const stale = saved().tx_hash;
    rpc.known.clear(); rpc.latestNonce = 6; rpc.pendingNonce = 6; // our tx vanished and nonce 5 was used by something else
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { const h = keccak256(serializedTransaction); rpc.sent.push(serializedTransaction); rpc.receipts.set(h, receipt(h, "success", logsFor(h, payload.authorization))); return h; };
    const r = await settle();
    expect(r.state).toBe("COMPLETED"); expect(r.txHash).not.toBe(stale);
    expect(parseTransaction(rpc.sent[1]).nonce).toBe(6);
    expect(JSON.parse(saved().last_response_json).stage).toBe("COMPLETED");
  });
  it("serialises concurrent relays so the relayer nonce never collides", async () => {
    const otherReq = "request-relay-00002";
    const payload2 = await signTransferAuthorization(buyer, "testnet", { payTo: relayerKey.address, valueTokenAtomic: 10_000n });
    run(db, "INSERT INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, backend) VALUES (?,?,?,?,?,?,?,?,?,?)",
      otherReq, "ap_request-relay-00002", "eip155:5042002", USDC, buyer.address.toLowerCase(), payload2.authorization.nonce, "SUBMITTED", new Date().toISOString(), new Date().toISOString(), "relay");
    rpc.sendRawTransaction = async ({ serializedTransaction }) => { const h = keccak256(serializedTransaction); rpc.sent.push(serializedTransaction); rpc.pendingNonce++; rpc.receipts.set(h, receipt(h, "success", logsFor(h, parseTransaction(serializedTransaction).nonce === 5 ? payload.authorization : payload2.authorization))); return h; };
    const [a, b] = await Promise.all([settle(), relayer.settle(db, otherReq, payload2)]);
    expect([a.state, b.state]).toEqual(["COMPLETED", "COMPLETED"]);
    expect(rpc.sent.map((raw) => parseTransaction(raw).nonce).sort()).toEqual([5, 6]);
  });
  it("leaves an authorization consumed through an unrecognised wrapper pending for manual reconciliation, never paid", async () => {
    rpc.authUsed = true;
    rpc.txs.set(OTHER_TX, { to: "0x" + "77".repeat(20), input: "0xdeadbeef" }); // some router, not the USDC contract
    rpc.logs = logsFor(OTHER_TX, payload.authorization, 950n); rpc.receipts.set(OTHER_TX, receipt(OTHER_TX, "success", rpc.logs, 950n));
    expect(await settle()).toMatchObject({ state: "PENDING", reason: expect.stringContaining("unrecognised shape") });
    expect(saved()).toMatchObject({ state: "PENDING", scanned_to_block: null }); // the window is not advanced past the unexplained transaction
    expect(rpc.sent).toHaveLength(0);
    // a direct call with DIFFERENT arguments (another amount) must not count either
    rpc.txs.set(OTHER_TX, { to: USDC, input: encodeTransferWithAuthorization({ ...payload.authorization, value: "20000" }, payload.signature) });
    expect(await settle()).toMatchObject({ state: "PENDING", reason: expect.stringContaining("unrecognised shape") });
  });
  it("refuses to relay when the RPC serves a different chain than configured", async () => {
    rpc.chainId = 1;
    await expect(settle()).rejects.toThrow("expected 5042002");
    expect(rpc.sent).toHaveLength(0);
    expect(saved().state).toBe("SUBMITTED");
  });
});

describe("read routes observe; only the worker and POST paths send (design v3.2 §10.2)", () => {
  it("an observer never performs the first broadcast of an accepted authorization", async () => {
    const r = await relayer.settle(db, REQ, payload, { allowSend: false });
    expect(r.state).toBe("SUBMITTED"); expect(r.reason).toContain("settlement worker"); expect(rpc.sent).toHaveLength(0); expect(saved().tx_hash).toBeNull();
    expect((await settle()).state).toBe("PENDING"); expect(rpc.sent).toHaveLength(1); // the act-mode path sends
  });
  it("an observer records a payment executed by another broadcaster but never rebroadcasts or re-signs a dropped relay transaction", async () => {
    expect((await settle()).state).toBe("PENDING");
    const first = saved().tx_hash;
    rpc.known.clear(); // our transaction vanished from the pool; the nonce is still free
    expect(await relayer.settle(db, REQ, payload, { allowSend: false })).toMatchObject({ state: "PENDING", reason: expect.stringContaining("may rebroadcast") });
    expect(rpc.sent).toHaveLength(1);
    rpc.latestNonce = 6; rpc.pendingNonce = 6; // the nonce was consumed by something else
    expect(await relayer.settle(db, REQ, payload, { allowSend: false })).toMatchObject({ state: "PENDING", reason: expect.stringContaining("re-sign") });
    expect(rpc.sent).toHaveLength(1); expect(saved().tx_hash).toBe(first);
    rpc.authUsed = true; rpc.txs.set(OTHER_TX.toLowerCase(), { to: USDC, input: encodeTransferWithAuthorization(payload.authorization, payload.signature) });
    rpc.receipts.set(OTHER_TX.toLowerCase(), receipt(OTHER_TX, "success", logsFor(OTHER_TX, payload.authorization))); rpc.logs = logsFor(OTHER_TX, payload.authorization, 950n);
    expect(await relayer.settle(db, REQ, payload, { allowSend: false })).toMatchObject({ state: "COMPLETED", txHash: OTHER_TX });
    expect(rpc.sent).toHaveLength(1);
  });
});

describe("expired-unused authorizations (AP32-11)", () => {
  it("never relays an authorization whose validity has passed, and closes a dropped relay as expired-unused rather than paid", async () => {
    vi.useFakeTimers();
    try {
      expect((await settle()).state).toBe("PENDING"); // signed and sent, no receipt yet
      const first = saved().tx_hash;
      rpc.known.clear(); // our transaction vanished from the pool; the nonce is still free
      vi.setSystemTime(Number(payload.authorization.validBefore) * 1000 + 1000); // the authorization's validity has passed on the clock
      const r = await settle();
      expect(r).toMatchObject({ state: "FAILED", reason: expect.stringContaining("expired") });
      expect(rpc.sent).toHaveLength(1); expect(saved().tx_hash).toBe(first); expect(saved().state).toBe("FAILED");
      // a brand-new submission of an already expired authorization is refused before anything is signed
      const otherReq = "request-relay-00003";
      const expired = await signTransferAuthorization(buyer, "testnet", { payTo: relayerKey.address, valueTokenAtomic: 10_000n });
      run(db, "INSERT INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, backend) VALUES (?,?,?,?,?,?,?,?,?,?)",
        otherReq, "ap_request-relay-00003", "eip155:5042002", USDC, buyer.address.toLowerCase(), expired.authorization.nonce, "SUBMITTED", new Date().toISOString(), new Date().toISOString(), "relay");
      vi.setSystemTime(Number(expired.authorization.validBefore) * 1000 + 1000);
      expect(await relayer.settle(db, otherReq, expired)).toMatchObject({ state: "FAILED", reason: expect.stringContaining("expired") });
      expect(rpc.sent).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
