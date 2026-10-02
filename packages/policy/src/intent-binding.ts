// INTENT_BINDING + AMOUNT_SEMANTICS: compare the exact candidate call with the independently approved business
// expectation (spec v1.4 §5.2). Deterministic; never derives the expectation from the calldata itself.
import { decodeFunctionData, encodeFunctionData, parseAbi, getAddress } from "viem";
import type { IntentCore } from "@arcpreflight/schema";

export const DEMO_MERCHANT_ABI = parseAbi(["function pay(bytes32 orderId) payable"]);
export const USDC_ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
export const PAY_SELECTOR = "0x" + encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: ["0x" + "00".repeat(32) as `0x${string}`] }).slice(2, 10);

export type CheckResult = { id: string; outcome: "PASS" | "BLOCKED" | "REVIEW_REQUIRED"; reasons: string[] };

export function checkIntentBinding(intent: IntentCore): CheckResult {
  const reasons: string[] = [];
  const be = intent.businessExpectation;
  if (be.action === "MERCHANT_PAY") {
    if (be.asset !== "ARC_NATIVE_USDC") reasons.push("MERCHANT_PAY requires ARC_NATIVE_USDC");
    if (getAddress(intent.to) !== getAddress(be.recipient)) reasons.push(`target ${intent.to} != approved merchant ${be.recipient}`);
    let decoded: { functionName: string; args: readonly unknown[] } | null = null;
    try { decoded = decodeFunctionData({ abi: DEMO_MERCHANT_ABI, data: intent.data as `0x${string}` }) as any; } catch { decoded = null; }
    if (!decoded || decoded.functionName !== "pay") reasons.push("calldata is not DemoMerchant.pay(bytes32)");
    else if ((decoded.args[0] as string).toLowerCase() !== be.orderId.toLowerCase()) reasons.push(`orderId in calldata ${decoded.args[0]} != approved order ${be.orderId}`);
    // AMOUNT_SEMANTICS (native 18-dec path): value must equal the approved amount exactly.
    if (intent.valueNativeAtomic !== be.amountNativeAtomic) {
      const v = BigInt(intent.valueNativeAtomic), a = BigInt(be.amountNativeAtomic);
      const looksLike6Dec = a % 10n ** 12n === 0n && v === a / 10n ** 12n;
      reasons.push(looksLike6Dec
        ? `AMOUNT_UNIT_MISMATCH: value ${v} equals the 6-decimal ERC-20 encoding of ${a} native atomic units (0.0${""}5 USDC must be ${a} on the native path)`
        : `AMOUNT_MISMATCH: value ${v} != approved ${a}`);
    }
  } else {
    // SUPPORTED_USDC_TRANSFER (disabled by default in SUBMISSION_RESTRICTED; checks kept so the rejection path is testable)
    if (getAddress(intent.to) !== getAddress(be.tokenAddress)) reasons.push("ERC-20 transfer target must be the USDC token contract");
    if (intent.valueNativeAtomic !== "0") reasons.push("ERC-20 transfer must carry zero native value");
    let decoded: { functionName: string; args: readonly unknown[] } | null = null;
    try { decoded = decodeFunctionData({ abi: USDC_ERC20_ABI, data: intent.data as `0x${string}` }) as any; } catch { decoded = null; }
    if (!decoded || decoded.functionName !== "transfer") reasons.push("calldata is not transfer(address,uint256)");
    else {
      if (getAddress(decoded.args[0] as string) !== getAddress(be.recipient)) reasons.push("transfer recipient != approved recipient");
      if ((decoded.args[1] as bigint).toString() !== be.amountTokenAtomic) reasons.push("transfer amount != approved amountTokenAtomic (6-dec)");
    }
  }
  return { id: "INTENT_BINDING", outcome: reasons.length ? "BLOCKED" : "PASS", reasons };
}
