import { digest } from "./canonical.js";
import * as T from "./types.js";

// Each digest covers the full validated core object (spec §7.1). Validation happens before hashing so that
// a malformed object can never produce a "valid-looking" digest.
export const intentDigest = (v: unknown) => digest("intent", T.SCHEMA_VERSION, T.IntentCore.parse(v));
export const reportDigest = (v: unknown) => digest("report", T.SCHEMA_VERSION, T.ReportCore.parse(v));
export const policyDigest = (v: unknown) => digest("policy", T.SCHEMA_VERSION, T.PolicyCore.parse(v));
export const baselineDigest = (v: unknown) => digest("baseline", T.SCHEMA_VERSION, T.BaselineCore.parse(v));
export const decisionDigest = (v: unknown) => digest("decision", T.SCHEMA_VERSION, T.DecisionReceipt.parse(v));
export const transactionPlanDigest = (v: unknown) => digest("transactionPlan", T.SCHEMA_VERSION, T.TransactionPlan.parse(v));
export const finalValidationDigest = (v: unknown) => digest("finalValidation", T.SCHEMA_VERSION, T.FinalValidationReceipt.parse(v));
export const executionDigest = (v: unknown) => digest("execution", T.SCHEMA_VERSION, T.ExecutionReceipt.parse(v));
export const quoteDigest = (v: unknown) => digest("quote", T.SCHEMA_VERSION, T.QuoteCore.parse(v));
