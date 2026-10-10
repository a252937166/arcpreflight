// Thin typed client for the ArcPreflight API (same origin; Vite proxies /v1 in dev). Every call goes through `apiPath`, so the
// dual-network switch (P2) only has to change the base path: "" for the root instance, "/testnet" for the second one.
import type { BaselineCore } from "@arcpreflight/schema";

export type Fixture = "APPROVED_PAYMENT" | "CHANGED_IMPLEMENTATION" | "AMOUNT_UNIT_MISMATCH";
export type Step = { step: string; atMs: number; who?: string; why?: string; [k: string]: unknown };
export type Signal = { id: string; state: "observed" | "not_observed" | "unknown"; basis: string; scope: string; evidenceDigests: string[]; limitations: string[]; sourceIds: string[] };
export type Dependency = { address: string; role: string; codeHash: string | null; adapterDigest: string | null; resolution: string };
export type Report = {
  schemaVersion: string; mode: "OBJECT_OBSERVATION" | "SUPPORTED_INTENT"; intentDigest: string | null; decisionEligible: boolean;
  observation: { chainId: number; blockNumber: string; blockHash: string; observedAt: string; providerId: string; pinningMode: string };
  methodologyDigest: string; adapterManifestDigests: string[]; baselineDigest: string | null; baselineResult: string; dependencies: Dependency[]; signals: Signal[]; rawEvidenceDigests: string[]; exclusions: string[]; expiresAt: string;
};
export type Evidence = { evidence: { method: string; params: unknown; snapshot: unknown; result: unknown; error: string | null; [k: string]: unknown }; digest: string };
export type FixtureInfo = { id: Fixture; title: string; headline: string; expected: string; proxy: "MAIN" | "CHANGED"; blurb: string; merchant: string | null; implementation: string | null; approvedImplementation: string | null; upgradeTx: string | null; baselineDigest: string | null };
/** §19 of the design: where a capability stands. Different dimension from the LIVE_REQUEST / RECORDED_SAMPLE run labels. */
export type CapabilityStatus = "IMPLEMENTED_TESTNET" | "MAINNET_VERIFIED" | "PROPOSED" | "DISABLED";
export type Capability = { id: string; label: string; status: CapabilityStatus; note?: string };
export type NetworkInfo = {
  network: "mainnet" | "testnet"; chainId: number; caip2: string; rpc: string; explorer: string; usdc: string; profile: string; release: string; priceTokenAtomic: string; supportedTargets: string[];
  head: string | null;
  accounts: { deployerAdmin: string | null; demoRunner: string | null; merchantPayTo: string | null; orderCreator?: string | null; orderSignerRole?: "order-creator" | "deployer-admin" | null; adminKeyInProcess?: boolean };
  deployments: { implA: any; implB: any; proxies: any; deployedAtUTC: string; compiler: any } | null;
  fixtures: FixtureInfo[];
  budget: { maxRunsPerDay: number; usedToday: number; clientCooldownSeconds: number; amountNativeAtomic: string; activeRun: string | null;
    caps?: { businessAtomic: string; feeAtomic: string; gasAtomic: string }; reservedToday?: { business: string; fee: string; gas: string }; unresolvedBusinessTransactions?: number; note?: string };
  settlement?: { backend: string; relayer: string | null; feeAsset: string; note?: string };
  /** the only addresses GET /v1/subjects/{address} accepts in this release */
  observableSubjects?: { address: string; label: string; kind: "external" | "fixture" }[];
  capabilities?: Capability[];
  passport?: { version: string; costStatementVersion: string };
  /** testnet faucet (P3): project testnet funds for a connected wallet with no USDC; `enabled: false` everywhere else, never on mainnet */
  faucet?: FaucetInfo;
  /** the worker's latest reading of the project keys' balances (operator decision 2026-10-09): reads only, thresholds are the operator's */
  funds?: FundsInfo;
  /** open self-service (P3): anyone who visits gets an anonymous session principal from `access.session` (POST); v3.3 adds wallet execution */
  access?: { selfService: boolean; session: string; publicExecution?: boolean; walletExecution?: boolean; note?: string;
    /** Gate D: deployments, order signer and runner are configured (independent of the public gate) */ executionReady?: boolean;
    /** Gate D: execution routes (runs, wallet attempts, orders) accept only the operator's admin token — the mainnet acceptance runs in this state */ operatorAcceptance?: boolean };
  /** order limits (v3.3 §2): 18-decimal native units; the dialog mirrors these rules before the server sees the body */
  orders?: { minNativeAtomic: string; maxNativeAtomic: string; stepNativeAtomic: string; defaultNativeAtomic: string; maxReferenceLength: number };
};
export type FundsKey = { role: string; address: string; balanceNativeAtomic: string | null; warnBelowNativeAtomic: string; low: boolean; note: string; /** the last successful reading, kept through RPC failures */ lastObserved?: { low: boolean; balanceNativeAtomic: string; at: string } | null };
export type FundsInfo = { checkedAt: string | null; intervalMs: number; low: boolean; keys: FundsKey[]; note: string };
export type FaucetInfo = { enabled: false; note?: string } | { enabled: true; amountNativeAtomic: string; perDay: number; usedToday: number; perAddressPer24h: number; sender: string | null; note?: string };
/** `pending` (202): the claim's one transaction was signed, recorded and handed to the node but is not confirmed yet ("sent, not yet confirmed"); `txHash` is its identity */
export type FaucetClaim = { ok: true; txHash: string; amountNativeAtomic: string; address: string; pending?: boolean; note?: string };
/** One money line of the cost statement (docs/PASSPORT.md §4): atomic strings, exact decimal rendering, receipt facts. */
export type BuyerRole = "project-runner" | "visitor-wallet" | "buyer";
export type MoneyLine = { nativeAtomic: string; usdc: string; gasUsed?: string; effectiveGasPriceNativeAtomic?: string; tx?: string | null; address?: string | null };
export type CostStatement = {
  costStatementVersion: string; unit: string; nativeDecimals: number; tokenDecimals: number; capturedAt?: string;
  /** 1.1 (docs/LIFECYCLE.md §9): `role` names the buyer (a project-funded run never reads "your wallet"); `complete` is false when a receipt that should exist is missing — the total is then a known subtotal a reader must not show as the cost. Both optional: 1.0 statements lack them. */
  buyer: { address: string; role?: BuyerRole; businessPrincipal: { nativeAtomic: string; usdc: string }; checkFee: { tokenAtomic: string; nativeAtomicEquivalent: string; usdc: string } | null; businessGas: MoneyLine | null; totalNativeAtomic: string; totalUsdc: string; complete?: boolean };
  operator: { feeRelay: MoneyLine | null; orderCreation: MoneyLine | null; totalNativeAtomic: string; totalUsdc: string; complete?: boolean };
  authorizedMaximum: { businessPrincipalNativeAtomic: string | null; checkFeeTokenAtomic: string | null; businessGasNativeAtomic: string | null };
  actual: { businessPrincipalNativeAtomic: string | null; checkFeeTokenAtomic: string | null; businessGasNativeAtomic: string | null };
  unresolvedReservation: { nativeAtomic: string; note?: string };
  sources: { feeTx: string | null; createOrderTx: string | null; businessTx: string | null }; notes: string[];
};
export type RecoveryStatus = "none" | "not-sent" | "confirmed" | "recovered-confirmed" | "recovered-from-event" | "reverted" | "not-mined" | "unresolved";
/** recovery.json of the passport: counters come from the recorded steps, never from preset copy. */
export type RecoverySummary = {
  recoveryVersion: string; attemptId: string; interrupted: boolean;
  counters: { ordersCreated: number; checkFeeAuthorizations: number; businessSignatures: number; broadcastsOfOriginalBytes: number; replacementSignatures: number };
  /** what recovery added beyond the original attempt (design §5 "New orders created: 0") */
  addedByRecovery?: { ordersCreated: number; checkFeeAuthorizations: number; businessSignatures: number; broadcastsOfOriginalBytes: number };
  originalTransaction: { hash: string | null; status: RecoveryStatus };
  reconciliation: { at: string; chainStatus: string; businessStatus: string; note: string | null }[];
};
export type ApprovalStatus = { revoked: boolean; validUntil: string | null; fetchedAt: string } | null;
export type RunResult = {
  fixture: Fixture; network: string; chainId: number; attemptId: string; orderId: string; merchant: string; intent: any; intentDigest: string; policy: any; policyDigest: string; requestId: string; serviceFeeTx: string | null;
  report: Report; reportDigest: string; simulation: { ok: boolean; error: string | null } | null; decision: { decision: string; reasons: string[]; decidedAt: string; [k: string]: unknown }; decisionDigest: string;
  finalValidation: any | null; plan: any | null; execution: { chainStatus: string; businessStatus: string; businessTxHash: string | null; signedTransactionHash: string | null; labels: string[]; [k: string]: unknown }; executionDigest: string;
  postcondition: any | null; steps: Step[]; durationMs: number;
  // added with the Payment Passport (v3.2): all optional so older recorded runs still render
  quote?: { amountTokenAtomic: string; payTo: string; expiresAt: string; [k: string]: unknown } | null; quoteDigest?: string | null;
  feeAuthorization?: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string } | null;
  approvalStatusAtValidation?: ApprovalStatus; costStatement?: CostStatement | null; reconciliation?: { at: string; note: string | null } | null;
};
/** docs/LIFECYCLE.md §8: the headline of a run follows the execution store, never the step log (AP33-06). */
export type OutcomeKind = "RUNNING" | "PAID" | "BROADCAST_UNRESOLVED" | "SIGNED_NOT_BROADCAST" | "NOT_MINED" | "SUPERSEDED" | "REVERTED" | "CONFIRMED_UNPAID" | "REVIEW_REQUIRED" | "BLOCKED" | "NOT_SIGNED" | "FAILED";
export type RunOutcome = { kind: OutcomeKind; text: string; source: "store" | "decision" | "state" };
/** the business transaction as the durable store knows it (runner runs); the same facts a wallet attempt carries */
export type BusinessExecution = { attemptId?: string; state: string; txHash: string | null; nonce: number | null; broadcastBlock: string | null; businessStatus?: string | null; businessTxHash?: string | null; block?: string | null; consumedBy: string | null; note: string | null; validUntil: string | null; updatedAt?: string };
export type RunOrder = { orderId: string; state: string; tx: string | null; block: string | null; payer: string; merchant: string; amountNativeAtomic: string; reference: string | null; paid: boolean | null };
export type Run = { runId: string; fixture: Fixture; state: "RUNNING" | "DONE" | "FAILED" | "RECONCILE_REQUIRED"; labels: string[]; steps: Step[]; createdAt: string; updatedAt: string; expected: string | null; headline: string | null; result: RunResult | null; recovery?: RecoverySummary | null;
  // v3.3 (docs/LIFECYCLE.md §8): all optional so older recorded runs still render
  executionMode?: "runner" | "wallet"; outcome?: RunOutcome | null; businessExecution?: BusinessExecution | null; order?: RunOrder | null; partial?: boolean; artifactsPresent?: string[] };
export type RunSummary = { runId: string; fixture: Fixture; state: string; labels: string[]; createdAt: string; updatedAt: string; decision: string | null; businessTxHash: string | null; businessStatus: string | null; serviceFeeTx: string | null; durationMs: number | null;
  // history columns (v3.2 P0): network, recorded money and passport availability; optional so older mocks and recordings still render
  network?: "mainnet" | "testnet"; chainId?: number; attemptId?: string | null; orderId?: string | null; chainStatus?: string | null;
  feeTokenAtomic?: string | null; orderAmountNativeAtomic?: string | null; businessPaidNativeAtomic?: string | null; passportAvailable?: boolean;
  executionMode?: "runner" | "wallet"; businessExecutionState?: string | null; outcome?: OutcomeKind | null };
/** POST /v1/demo/orders → 201 (docs/LIFECYCLE.md §8) */
export type OrderCreated = { orderId: string; tx: string; block: string; merchant: string; proxy: "MAIN" | "CHANGED"; payer: string; amountNativeAtomic: string; reference: string | null; baselineDigest: string | null; state: "CONFIRMED"; owner?: string };
export type OrderState = "PLANNED" | "SENT" | "CONFIRMED" | "UNKNOWN_CREATION" | "FAILED";
/** POST /v1/demo/orders → 202 ORDER_CREATION_PENDING (2026-10-09): the order's identity is recorded but its creation is not confirmed. It is
 *  reconciled from the chain (the same signed creation is re-sent while its window is open, never a second order); poll GET …/{id}, or recover. */
export type OrderPending = { pending: true; orderId: string; state: OrderState; tx: string | null; nextAction: string; reason?: string; error?: "ORDER_CREATION_PENDING"; code?: "ORDER_CREATION_PENDING";
  merchant: string; proxy: "MAIN" | "CHANGED"; payer: string; amountNativeAtomic: string; reference: string | null; owner?: string | null };
/** POST /v1/demo/orders → 502 ORDER_CREATION_FAILED names the order it concerns; the dialog folds it with the body it sent (the row stays for the record) */
export type OrderCreationFailure = { failed: true; orderId: string; state: OrderState; tx: string | null; reason: string; merchant: string; proxy: "MAIN" | "CHANGED"; payer: string; amountNativeAtomic: string; reference: string | null };
export type LinkedCheck = { requestId: string; state: string; createdAt: string; reportDigest: string | null; paymentState: string | null; serviceFeeTx: string | null; valueNativeAtomic: string };
export type LinkedAttempt = { attemptId: string; state: string; txHash: string | null; businessStatus: string | null; createdAt: string; updatedAt: string };
/** GET /v1/demo/orders[/{id}]: the owner's order with its live paid state, linked checks and attempts, and the next action */
export type OrderView = { orderId: string; owner: string | null; source: "developer" | "runner"; runId: string | null; payer: string; merchant: string; proxy: "MAIN" | "CHANGED" | null; amountNativeAtomic: string; reference: string | null;
  state: OrderState; tx: string | null; block: string | null; creation: { from: string | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null }; paid: boolean | null; paidCheckedAt: string | null; note: string | null;
  checks: LinkedCheck[]; attempts: LinkedAttempt[]; nextAction: string; createdAt: string; updatedAt: string };
export type AttemptState = "VALIDATED" | "REFUSED" | "BROADCAST_ATTEMPTED" | "NOT_SENT" | "CONFIRMED" | "REVERTED" | "MISMATCH" | "NOT_MINED" | "NOT_EXECUTED";
/** after-the-fact comparison of the wallet's transaction with the validated plan: a mismatch in to/data/value/chainId/type/from, deviations in wallet-set gas, fees and nonce */
export type Deviations = { mismatch: string[]; deviations: Record<string, { plan: string; actual: string }> };
/** docs/LIFECYCLE.md §10 item 1: recorded by POST …/{id}/prompt — `PROMPTED` right before the wallet is asked, `UNKNOWN_SUBMISSION` when it answered with
 *  something that is not a rejection. Either makes a VALIDATED attempt *uncertain*: the transaction may have been submitted, so no second prompt and no
 *  "nothing was sent" until the chain says so or the visitor states a rejection. */
export type PromptMarker = { state: "PROMPTED" | "UNKNOWN_SUBMISSION"; at: string; detail?: string | null };
/** `not-prompted` hands an untouched claim back (review of `0c0d406`, P1-1/P1-2): the holder states that it did not ask the wallet after all */
export type PromptEvent = "prompted" | "unknown-submission" | "not-prompted";
/** POST/GET /v1/wallet/attempts (docs/LIFECYCLE.md §8). The brief view (list) stops at `createdAt/updatedAt`; the full view adds the receipts. */
export type AttemptView = {
  attemptId: string; executionMode: "wallet"; state: AttemptState; requestId: string; orderId: string; merchant: string; payer: string; amountNativeAtomic: string; labels: string[];
  decision: string; decisionReasons: string[]; refusal: { stage: "decision" | "finalValidation"; reasons: string[]; decision?: string } | null; validUntil: string | null;
  /** §10 item 1; optional only because views recorded by an API without the route carry no key — read it as null */
  prompt?: PromptMarker | null;
  txHash: string | null; nonce: number | null; from: string | null; broadcastBlock: string | null; businessStatus: string | null; businessTxHash: string | null; block: string | null; note: string | null;
  deviations: Deviations | null; nextAction: string; passportAvailable: boolean; businessExecution: BusinessExecution; createdAt: string; updatedAt: string;
  // full view
  decisionReceipt?: any; decisionDigest?: string; finalValidation?: any | null; finalValidationDigest?: string | null; plan?: any | null; planDigest?: string | null; approvalStatusAtValidation?: ApprovalStatus;
  execution?: any; executionDigest?: string; postcondition?: any | null; receipt?: any | null; reconciliation?: { at: string; chainStatus: string; businessStatus: string; note: string | null }[]; steps?: Step[];
  recovery?: RecoverySummary | null; costStatement?: CostStatement | null; order?: any | null;
};
export type RunList = { runs: RunSummary[]; total?: number; limit?: number; offset?: number };
/** one row of the owner's check history (GET /v1/requests) */
export type CheckRow = { requestId: string; clientRequestId: string; state: string; createdAt: string; updatedAt: string; intentDigest: string; subject: string; orderId: string | null; valueNativeAtomic: string; reportDigest: string | null;
  payment: { state: string; backend: string; transaction: string | null; reason?: string | null } | null; passportAvailable: boolean };
export type BaselineRecord = { baselineDigest: string; baseline: BaselineCore; revoked: boolean };
/** POST /v1/demo/run: 202 new admission, 200 the run this key was already bound to, or a refusal that may carry a recorded sample. */
export type Admission = { runId?: string; poll?: string; admission?: "new" | "existing"; error?: string; reason?: string; sampleRunId?: string | null; __status: number };
/** A Payment Passport as the API serves it: the directory's files as one JSON document (docs/PASSPORT.md §1). */
export type PassportBundle = { passportBundleVersion: string; files: Record<string, string> };

export class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.reason ?? body?.error ?? `HTTP ${status}`); } }
/** The selected instance's base path ("" = root). Set by the network provider before any page effect runs. */
let apiBase = "";
export const setApiBase = (base: string) => { apiBase = base; };
export const getApiBase = () => apiBase;
export const apiPath = (path: string) => `${apiBase}${path}`;
/** Review of bf0c800 (P1): every operation that spans more than one request — a session and its call, a lost answer and its retry, a
 *  recovery — holds its OWN client bound to the instance it started on (`apiFor(base)`). There is no shared mutable "pinned base": two
 *  operations on different instances can never make each other use the wrong service, and a retry after a lost response goes exactly
 *  where the original request went. `api` is the client of the instance selected NOW, for one-shot reads by views (a view that outlives a
 *  switch is remounted by the app, so a late answer has nowhere to land). */
async function request<T>(base: string, path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body) headers["content-type"] = "application/json";
  if (init?.token) headers["authorization"] = `Bearer ${init.token}`;
  const r = await fetch(`${base}${path}`, { ...init, headers });
  const text = await r.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = { error: "NON_JSON", text: text.slice(0, 200) }; }
  if (!r.ok && r.status !== 402 && r.status !== 202) throw new ApiError(r.status, body);
  return { ...body, __status: r.status } as T;
}
function clientFor(baseOf: () => string) {
  const req = <T,>(path: string, init?: RequestInit & { token?: string }) => request<T>(baseOf(), path, init);
  return {
  /** the instance this client is bound to ("" = root); the current-instance client reports the selected base */
  get base() { return baseOf(); },

  network: () => req<NetworkInfo>("/v1/network"),
  runs: (limit = 20, offset = 0) => req<RunList>(`/v1/demo/runs?limit=${limit}&offset=${offset}`),
  run: (id: string) => req<Run>(`/v1/demo/runs/${id}`),
  /** the admission key is generated once per click and re-sent verbatim on retries: same key → the original run, never a second order */
  startRun: (fixture: Fixture, clientRunRequestId: string, opts: { interruptAfterBroadcast?: boolean } = {}) => req<Admission>("/v1/demo/run", { method: "POST", body: JSON.stringify(opts.interruptAfterBroadcast ? { fixture, clientRunRequestId, interruptAfterBroadcast: true } : { fixture, clientRunRequestId }) }),
  /** authorized, session-scoped reconciliation of ONE attempt from its original context (never a new purchase) */
  recoverRun: (id: string, clientRunRequestId: string) => req<Run>(`/v1/demo/runs/${id}/recover`, { method: "POST", body: JSON.stringify({ clientRunRequestId }) }),
  /** read-only export; 409 PASSPORT_NOT_READY while the run is still RUNNING */
  passport: (id: string) => req<PassportBundle>(`/v1/demo/runs/${id}/passport`),
  subject: (address: string, signal?: AbortSignal) => req<{ reportDigest: string; report: Report; supported: boolean; evidenceCount: number }>(`/v1/subjects/${address}`, { signal }),
  publicReports: () => req<{ reports: { reportDigest: string; subject: string; mode: string; createdAt: string }[] }>("/v1/public-reports"),
  publicReport: (digest: string) => req<{ reportDigest: string; report: Report; evidence: Evidence[] }>(`/v1/public-reports/${digest}`),
  evidence: () => req<{ files: { path: string; bytes: number }[] }>("/v1/evidence"),
  health: () => req<any>("/health/ready"),
  openapi: () => req<any>("/openapi.json"),
  /** the visitor's own order (v3.3 §2): payer, MAIN or CHANGED proxy, amount in 18-decimal native units, optional reference; the order-creator key pays its gas.
   *  400 INVALID_INPUT carries `field` and `reason`; the identity is durable before the creation transaction is sent. */
  createOrder: (body: { payer: string; proxy?: "MAIN" | "CHANGED"; amountNativeAtomic?: string; reference?: string | null }, token: string) => req<OrderCreated | OrderPending>("/v1/demo/orders", { method: "POST", body: JSON.stringify(body), token }),
  /** owner only, one per order every 3 s: one bounded reconciliation that may hand the node the IDENTICAL signed creation again; never a second order */
  recoverOrder: (orderId: string, token: string) => req<OrderView>(`/v1/demo/orders/${orderId}/recover`, { method: "POST", token }),
  /** the owner's orders with their live paid state, linked checks and attempts (reads only) */
  orders: (token: string) => req<{ orders: OrderView[] }>("/v1/demo/orders", { token }),
  order: (orderId: string, token: string) => req<OrderView>(`/v1/demo/orders/${orderId}`, { token }),
  // ---- wallet execution (v3.3 §3): the service validates and records; the wallet signs; nothing here sends
  /** 201 VALIDATED with the exact plan (persisted before any prompt); 409 VALIDATION_FAILED { reasons } or ORDER_* / CHECK_NOT_DELIVERED / ATTEMPT_OPEN */
  createAttempt: (body: { requestId: string; orderId: string; policy: unknown }, token: string) => req<AttemptView>("/v1/wallet/attempts", { method: "POST", body: JSON.stringify(body), token }),
  attempts: (token: string) => req<{ attempts: AttemptView[] }>("/v1/wallet/attempts", { token }),
  /** observe (chain reads only, never a send) */
  attempt: (id: string, token: string) => req<AttemptView>(`/v1/wallet/attempts/${id}`, { token }),
  /** the hash the wallet returned, reported right after eth_sendTransaction */
  attemptSent: (id: string, txHash: string, token: string) => req<AttemptView>(`/v1/wallet/attempts/${id}/sent`, { method: "POST", body: JSON.stringify({ txHash }), token }),
  /** §10 item 1: `prompted` right before eth_sendTransaction, `unknown-submission` when the wallet answered with anything but a rejection; the marker
   *  survives a page refresh on the server (409 ATTEMPT_NOT_OPEN unless the attempt is VALIDATED) */
  /** the prompt CLAIM (§10): `prompted` with this call's claimId is granted to the first caller only (409 PROMPT_CLAIMED otherwise, the attempt in the body);
   *  `unknown-submission` records the wallet's ambiguous answer; `not-prompted` hands an untouched claim back with its claimId */
  attemptPrompt: (id: string, event: PromptEvent, token: string, detail?: string | null, claimId?: string | null) => req<AttemptView>(`/v1/wallet/attempts/${id}/prompt`, { method: "POST", body: JSON.stringify({ event, ...(detail ? { detail } : {}), ...(claimId ? { claimId } : {}) }), token }),
  /** the wallet prompt was rejected (4001): NOT_SENT */
  attemptAbandon: (id: string, token: string) => req<AttemptView>(`/v1/wallet/attempts/${id}/abandon`, { method: "POST", token }),
  /** bounded reconciliation of THAT attempt now: the hash, the order state and the merchant's OrderPaid event; never re-signs or re-sends */
  attemptRecover: (id: string, token: string) => req<AttemptView>(`/v1/wallet/attempts/${id}/recover`, { method: "POST", token }),
  /** private passport (wallet-run); 409 PASSPORT_NOT_READY while the attempt waits for the wallet */
  attemptPassport: (id: string, token: string) => req<PassportBundle>(`/v1/wallet/attempts/${id}/passport`, { token }),
  /** anyone who visits: an anonymous session principal for this browser (201; 429 RATE_LIMITED after 10 new sessions per client per day) */
  session: () => req<{ principal: string; token: string; note?: string }>("/v1/session", { method: "POST" }),
  /** testnet only: 200 with the transaction, or 404 FAUCET_DISABLED / 429 FAUCET_COOLDOWN / 429 FAUCET_BUDGET_EXHAUSTED / 503 FAUCET_EMPTY / 503 FAUCET_FAILED */
  faucet: (address: string) => req<FaucetClaim>("/v1/faucet", { method: "POST", body: JSON.stringify({ address }) }),
  preflight: (intent: unknown, token: string, payment?: unknown) => req<any>("/v1/preflight", { method: "POST", body: JSON.stringify(payment ? { intent, payment } : { intent }), token }),
  request: (id: string, token: string) => req<any>(`/v1/requests/${id}`, { token }),
  /** the owner's check history: read-only, nothing is reconciled by listing */
  requests: (token: string) => req<{ requests: CheckRow[] }>("/v1/requests", { token }),
  /** authenticated act-mode recovery of ONE accepted fee authorization (may re-send; one authorization nonce cannot pay twice) */
  recoverRequest: (id: string, token: string) => req<any>(`/v1/requests/${id}/recover`, { method: "POST", token }),
  /** the owner's private passport of a paid check (no signature inside) */
  requestPassport: (id: string, token: string) => req<PassportBundle>(`/v1/requests/${id}/passport`, { token }),
  baseline: (digest: string, token: string) => req<BaselineRecord>(`/v1/baselines/${digest}`, { token }),
  };
}
export type ApiClient = ReturnType<typeof clientFor>;
/** the client of the instance selected now (one-shot reads by views) */
export const api: ApiClient = clientFor(() => apiBase);
/** an immutable client for ONE operation: bound to `base` for every request it makes, whatever the visitor selects meanwhile */
export const apiFor = (base: string): ApiClient => clientFor(() => base);
/** a public run's passport is a plain download link (same origin, content-disposition: attachment) */
export const passportUrl = (runId: string) => apiPath(`/v1/demo/runs/${runId}/passport`);
export const explorerTx = (n: NetworkInfo | null | undefined, h: string) => `${n?.explorer ?? "https://explorer.arc.io"}/tx/${h}`;
export const explorerAddr = (n: NetworkInfo | null | undefined, a: string) => `${n?.explorer ?? "https://explorer.arc.io"}/address/${a}`;
