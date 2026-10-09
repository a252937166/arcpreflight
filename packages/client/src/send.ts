// Re-sending the IDENTICAL signed bytes (Gate D, 2026-10-09): the public Arc RPC sometimes routes eth_sendRawTransaction to a pool node
// that refuses it ("method does not exist / is not available"). The same signed transaction may be handed to the node again — it has one
// hash and one nonce, so it can never pay or create twice. Used by the business transaction (inside its validation window), the order
// creation and the order reconciliation. Never a different transaction.
import type { Hex } from "viem";

/** Hands the same signed bytes to the node up to `maxAttempts` times while `inWindow()` holds (checked with a fresh clock before every
 *  retry). Returns whether a node acknowledged them. "already known" counts as acknowledged; definitive rejections end the attempts. */
export const SEND_ATTEMPTS = 3;
export type RawSender = { sendRawTransaction(a: { serializedTransaction: Hex }): Promise<unknown> };
const DEFINITIVE_SEND_ERROR = /nonce too low|insufficient funds|underpriced|intrinsic gas|exceeds block gas limit|invalid sender|chain ?id/i;
/** true when the node refused these bytes for a reason that retrying the same bytes cannot change (nothing entered its pool) */
export const isDefinitiveSendError = (message: string | null | undefined) => !!message && DEFINITIVE_SEND_ERROR.test(message);
export async function sendIdentical(client: RawSender, raw: Hex, inWindow: () => boolean, maxAttempts = SEND_ATTEMPTS, pauseMs = 400,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<{ accepted: boolean; sendError: string | null; attempts: number }> {
  let sendError: string | null = null, attempts = 0;
  while (attempts < maxAttempts) {
    if (attempts > 0) { await sleep(pauseMs); if (!inWindow()) break; } // never after the window
    attempts++;
    try { await client.sendRawTransaction({ serializedTransaction: raw }); return { accepted: true, sendError: null, attempts }; }
    catch (e: any) {
      sendError = String(e?.shortMessage ?? e?.message ?? e).slice(0, 160);
      if (/already known|known transaction|already imported/i.test(sendError)) return { accepted: true, sendError, attempts };
      if (DEFINITIVE_SEND_ERROR.test(sendError)) break;
    }
  }
  return { accepted: false, sendError, attempts };
}
