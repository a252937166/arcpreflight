// viem's waitForTransactionReceipt gives up with TransactionReceiptNotFoundError within about a second when a node already serves the
// transaction but not yet its receipt — a load-balanced RPC whose nodes lag each other (shown by the delayed chain-RPC scenario on
// 2026-10-09: the runner recorded "outcome unknown" 4 s after a send whose receipt was only late). This waits until its own deadline
// instead: "receipt not found" is retried with the time left; every other error, a real timeout included, is thrown as before.
type ReceiptWaiter<R> = { waitForTransactionReceipt(a: { hash: `0x${string}`; timeout?: number }): Promise<R> };
export const isReceiptNotFound = (e: unknown): boolean => {
  const x = e as { name?: string; message?: string; shortMessage?: string } | null;
  return x?.name === "TransactionReceiptNotFoundError" || /receipt with hash .* could not be found|TransactionReceiptNotFound/i.test(String(x?.shortMessage ?? x?.message ?? e));
};
export async function waitForReceiptPatiently<R>(client: ReceiptWaiter<R>, hash: `0x${string}`, timeoutMs: number, pauseMs = 1500, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<R> {
  const deadline = now() + timeoutMs;
  for (let first = true; ; first = false) {
    try { return await client.waitForTransactionReceipt({ hash, timeout: first ? timeoutMs : Math.max(1000, deadline - now()) }); }
    catch (e) {
      if (!isReceiptNotFound(e) || now() + pauseMs >= deadline) throw e;
      await sleep(pauseMs);
    }
  }
}
