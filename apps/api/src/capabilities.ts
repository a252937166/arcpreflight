// Release capability labels (design v3.2 §19): every public claim about a capability carries one of four statuses. The labels
// describe where a capability has been exercised, not whether a button is visible. MAINNET_VERIFIED is set only by the operator
// (MAINNET_VERIFIED=1) after the mainnet acceptance evidence exists; a mainnet deployment without that evidence still reads
// IMPLEMENTED_TESTNET. LIVE_REQUEST / RECORDED_SAMPLE labels describe a different dimension (whether a shown run was live).
import { cfg } from "./config.js";

export const PASSPORT_VERSIONS = { version: "1.0", costStatementVersion: "1.1", recoveryVersion: "1.0", verificationProfileVersion: "1.0" } as const;
export type CapabilityStatus = "IMPLEMENTED_TESTNET" | "MAINNET_VERIFIED" | "PROPOSED" | "DISABLED";
export type Capability = { id: string; label: string; status: CapabilityStatus; note?: string };

const implemented = (id: string, label: string, note?: string): Capability => ({ id, label, status: cfg.net === "mainnet" && cfg.mainnetVerified ? "MAINNET_VERIFIED" : "IMPLEMENTED_TESTNET", ...(note ? { note } : {}) });
const disabled = (id: string, label: string, note: string): Capability => ({ id, label, status: "DISABLED", note });
const proposed = (id: string, label: string, note: string): Capability => ({ id, label, status: "PROPOSED", note });

export function capabilities(): Capability[] {
  return [
    implemented("approval-aware-checkout", "Approval-aware checkout: the exact call is bound to an independent order and an approved implementation", "a compatible upgrade stops business signing until a human approves the new implementation"),
    implemented("self-relayed-fee-settlement", "Check fee settled by the project's own EIP-3009 relayer (gas paid in USDC)", "proof of payment is AuthorizationUsed + Transfer from the USDC contract in one transaction"),
    implemented("business-execution-recovery", "Business-transaction recovery from the original context (persist → mark → broadcast → reconcile)", "never re-signs, never creates a new order or check; same-nonce replacements are identified where the node allows"),
    implemented("signer-account-verification", "Signer account path verified at the validation snapshot (eth_getCode) and every serialized field compared after signing"),
    implemented("admission-idempotency", "Run admission bound to a client key: a lost response returns the original run, never a second order"),
    implemented("read-routes-never-broadcast", "GET routes read chain facts only; broadcasts happen in the start-up pass, the recovery worker, the POST run gate and authorized recovery commands"),
    implemented("recovery-commands", "Authorized recovery commands: POST /v1/demo/runs/{id}/recover (admission key), POST /v1/requests/{id}/recover and POST /v1/wallet/attempts/{id}/recover (owner)"),
    implemented("payment-passport-export", "Payment Passport export (format 1.0): portable read-only evidence, no secrets", "GET /v1/demo/runs/{id}/passport (demo-run, runner mode); private variants for paid checks and wallet attempts (wallet-run, wallet mode)"),
    implemented("independent-verifier", "Independent verifier (packages/verifier): digests, anchors, fee attribution, plan agreement, order outcome, cost statement", "runs without application credentials against an explicitly configured Arc RPC"),
    implemented("cost-statement", "USDC cost statement separating buyer principal, check fee, business gas and operator gas"),
    implemented("monetary-caps", "Per-category daily monetary caps reserved atomically with the admission"),
    implemented("curated-object-observation", "Public read-only observation of a curated list of Arc/Circle contracts", "never decision-eligible"),
    implemented("wallet-execution", "Browser-wallet business execution with server-side final validation, durable attempts and after-the-fact plan comparison", "the visitor's wallet signs; the service never sees the bytes: to/data/value/chainId/type must match the validated plan, wallet-set gas/fees/nonce are recorded as deviations; recovery from the reported hash, the order state and OrderPaid"),
    implemented("order-identity-before-send", "Order identity persisted before the creation transaction is sent; interrupted creations reconciled from the chain, never replaced"),
    implemented("progressive-artefacts", "Every run artefact persisted as soon as it exists: a run interrupted after the broadcast still exports a complete passport"),
    implemented("labelled-interruption", "Live Demo interruption right after the broadcast, labelled as simulated, resolved by the recovery worker from the original context"),
    disabled("usdc-transfer-intent", "USDC_TRANSFER intent action", "422 UNSUPPORTED_ACTION; only MERCHANT_PAY on the supported template"),
    disabled("smart-account-executors", "Smart-account (ERC-1271/4337) and EIP-7702 buyers or executors", "policy and the signer check accept only a non-delegated EOA"),
    implemented("open-self-service", "Open self-service through anonymous browser sessions (POST /v1/session): orders, paid checks, wallet execution, recovery and private passports for every visitor", "sessions are bounded per client and day; no registration, no trial tokens"),
    proposed("memo", "Arc Memo attachments", "deferred until after the submission"),
    proposed("erc-8004-registration", "ERC-8004 identity registration", "deferred; non-blocking"),
    proposed("relay-marketplace", "Relay: hand-over of unfinished AI work with verified acceptance", "later, evidence-gated direction; not part of this release"),
    proposed("additional-merchant-templates", "Merchant adapters beyond DemoMerchant.pay(orderId)", "next milestone: one externally requested adapter"),
  ];
}
