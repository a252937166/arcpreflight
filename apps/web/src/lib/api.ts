// Thin typed client for the ArcPreflight API (same origin; Vite proxies /v1 in dev).
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
export type NetworkInfo = {
  network: "mainnet" | "testnet"; chainId: number; caip2: string; rpc: string; explorer: string; usdc: string; profile: string; release: string; priceTokenAtomic: string; supportedTargets: string[];
  head: string | null;
  accounts: { deployerAdmin: string | null; demoRunner: string | null; merchantPayTo: string | null };
  deployments: { implA: any; implB: any; proxies: any; deployedAtUTC: string; compiler: any } | null;
  fixtures: FixtureInfo[];
  budget: { maxRunsPerDay: number; usedToday: number; clientCooldownSeconds: number; amountNativeAtomic: string; activeRun: string | null };
};
export type RunResult = {
  fixture: Fixture; network: string; chainId: number; attemptId: string; orderId: string; merchant: string; intent: any; intentDigest: string; policy: any; policyDigest: string; requestId: string; serviceFeeTx: string | null;
  report: Report; reportDigest: string; simulation: { ok: boolean; error: string | null } | null; decision: { decision: string; reasons: string[]; decidedAt: string; [k: string]: unknown }; decisionDigest: string;
  finalValidation: any | null; plan: any | null; execution: { chainStatus: string; businessStatus: string; businessTxHash: string | null; signedTransactionHash: string | null; labels: string[]; [k: string]: unknown }; executionDigest: string;
  postcondition: any | null; steps: Step[]; durationMs: number;
};
export type Run = { runId: string; fixture: Fixture; state: "RUNNING" | "DONE" | "FAILED"; labels: string[]; steps: Step[]; createdAt: string; updatedAt: string; expected: string | null; headline: string | null; result: RunResult | null };
export type RunSummary = { runId: string; fixture: Fixture; state: string; labels: string[]; createdAt: string; updatedAt: string; decision: string | null; businessTxHash: string | null; businessStatus: string | null; serviceFeeTx: string | null; durationMs: number | null };

export class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.reason ?? body?.error ?? `HTTP ${status}`); } }
async function req<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body) headers["content-type"] = "application/json";
  if (init?.token) headers["authorization"] = `Bearer ${init.token}`;
  const r = await fetch(path, { ...init, headers });
  const text = await r.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = { error: "NON_JSON", text: text.slice(0, 200) }; }
  if (!r.ok && r.status !== 402 && r.status !== 202) throw new ApiError(r.status, body);
  return { ...body, __status: r.status } as T;
}
export const api = {
  network: () => req<NetworkInfo>("/v1/network"),
  runs: (limit = 20) => req<{ runs: RunSummary[] }>(`/v1/demo/runs?limit=${limit}`),
  run: (id: string) => req<Run>(`/v1/demo/runs/${id}`),
  startRun: (fixture: Fixture) => req<{ runId?: string; error?: string; reason?: string; sampleRunId?: string | null; __status: number }>("/v1/demo/run", { method: "POST", body: JSON.stringify({ fixture }) }),
  subject: (address: string) => req<{ reportDigest: string; report: Report; supported: boolean; evidenceCount: number }>(`/v1/subjects/${address}`),
  publicReports: () => req<{ reports: { reportDigest: string; subject: string; mode: string; createdAt: string }[] }>("/v1/public-reports"),
  publicReport: (digest: string) => req<{ reportDigest: string; report: Report; evidence: Evidence[] }>(`/v1/public-reports/${digest}`),
  evidence: () => req<{ files: { path: string; bytes: number }[] }>("/v1/evidence"),
  health: () => req<any>("/health/ready"),
  openapi: () => req<any>("/openapi.json"),
  createOrder: (payer: string, token: string) => req<any>("/v1/demo/orders", { method: "POST", body: JSON.stringify({ payer }), token }),
  preflight: (intent: unknown, token: string, payment?: unknown) => req<any>("/v1/preflight", { method: "POST", body: JSON.stringify(payment ? { intent, payment } : { intent }), token }),
  request: (id: string, token: string) => req<any>(`/v1/requests/${id}`, { token }),
};
export const explorerTx = (n: NetworkInfo | null | undefined, h: string) => `${n?.explorer ?? "https://explorer.arc.io"}/tx/${h}`;
export const explorerAddr = (n: NetworkInfo | null | undefined, a: string) => `${n?.explorer ?? "https://explorer.arc.io"}/address/${a}`;
