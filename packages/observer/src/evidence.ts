import { digest } from "@arcpreflight/schema";
import type { Snapshot } from "@arcpreflight/schema";

/** A raw RPC observation, canonicalized and content-addressed (spec §7.1: evidence objects are digested
 *  independently and referenced from ReportCore). All values are strings so JCS is unambiguous. */
export type RpcEvidence = {
  kind: "rpc";
  method: string;
  params: string[];          // JSON-encoded params, in order
  result: string | null;     // raw hex / JSON string result; null if the call errored
  error: string | null;      // error message if any
  snapshot: Snapshot;
  capturedAt: string;
};

export function evidenceDigest(e: RpcEvidence): `0x${string}` {
  return digest("evidence", "1.0", e);
}

export function makeEvidence(method: string, params: unknown[], snapshot: Snapshot, result: string | null, error: string | null): { evidence: RpcEvidence; digest: `0x${string}` } {
  const evidence: RpcEvidence = {
    kind: "rpc", method, params: params.map((p) => JSON.stringify(p)), result, error, snapshot,
    capturedAt: new Date().toISOString(),
  };
  return { evidence, digest: evidenceDigest(evidence) };
}
