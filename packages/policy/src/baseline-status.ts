import { getAddress } from "viem";
import { BaselineCore, baselineDigest as computeBaselineDigest, type IntentCore } from "@arcpreflight/schema";
import type { CheckResult } from "./intent-binding.js";

export type BaselineStatusInput = {
  intent: Pick<IntentCore, "chainId" | "to" | "data" | "baselineDigest">;
  baseline: BaselineCore | null;
  baselineDigest: string | null;
  baselineRevoked: boolean;
  now: Date;
};

/** An immutable content digest identifies an approval, but does not establish its scope or current validity. */
export function checkBaselineStatus(i: BaselineStatusInput): CheckResult {
  const reasons: string[] = [];
  if (!i.baseline || !i.baselineDigest) reasons.push("no approved baseline");
  else {
    const parsed = BaselineCore.safeParse(i.baseline);
    if (!parsed.success) reasons.push("approved baseline is malformed");
    else {
      const baseline = parsed.data;
      if (computeBaselineDigest(baseline) !== i.baselineDigest.toLowerCase()) reasons.push("baseline content digest != supplied baseline digest");
      if (i.baselineDigest.toLowerCase() !== i.intent.baselineDigest.toLowerCase()) reasons.push("intent.baselineDigest != supplied baseline digest");
      if (baseline.chainId !== i.intent.chainId || baseline.referenceSnapshot.chainId !== i.intent.chainId) reasons.push("baseline chain != intent chain");
      if (getAddress(baseline.subject) !== getAddress(i.intent.to)) reasons.push("baseline subject != intent target");
      if (!baseline.allowedSelectors.some((selector) => selector.toLowerCase() === i.intent.data.slice(0, 10).toLowerCase())) reasons.push("selector not approved by baseline.allowedSelectors");
      if (baseline.validUntil && new Date(baseline.validUntil) <= i.now) reasons.push("baseline expired");
    }
    if (i.baselineRevoked) reasons.push("baseline revoked");
  }
  return { id: "BASELINE_STATUS", outcome: reasons.length ? "REVIEW_REQUIRED" : "PASS", reasons };
}
