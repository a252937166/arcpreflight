# Real-wallet acceptance checklist (AP33-30)

Automation drives an injected EIP-1193 test wallet with fault modes (`apps/web/src/testWallet.ts`, dev builds only). A real
extension must be exercised by a person once per release on the public site. Record the release SHA, the wallet (name,
version), the network, and the observed copy for each row. "Pass" means the page said what happened and offered only the
listed next actions; no row may end in a second signing prompt the visitor did not ask for.

| # | Scenario | How | Expected on the page |
|---|---|---|---|
| 1 | Connect, auto chain switch | Connect on Arc mainnet root; switch the site to Arc testnet | the wallet is asked once to switch (or add) Arc testnet; the header chip shows the wallet on the right chain; refusal (4001) leaves "Switch to Arc testnet" in the menu |
| 2 | Reconnect after refresh | Reload with the wallet connected | still connected; no prompt; My workflow restored for the same account |
| 3 | Account switching mid-workflow | Create an order with account A, switch to B in the extension | the visible workflow resets to step 1 for B; A's order appears under "other wallets in this browser"; nothing is relabelled as B's |
| 4 | Wrong network at prompt time | Validate an attempt, switch the extension to another chain, press execute | no transaction prompt; the page says the wallet is on chain X and the plan is for Arc testnet; the attempt stays validated for abandon/recover |
| 5 | Rejected fee signature | Reject the EIP-712 prompt | "nothing was bought"; a new quote can be requested; no charge |
| 6 | Rejected transaction | Reject `eth_sendTransaction` | attempt `NOT_SENT`, order unpaid, "nothing was sent"; execute is available again only after a new validation |
| 7 | Ambiguous submission | Press execute, then close the extension popup or lose connectivity before the hash arrives | "the transaction may have been submitted — reconciling"; no second prompt; ends CONFIRMED (if it went out) or stays validated with "I rejected it — abandon" |
| 8 | Refresh mid-prompt | Reload the page while the transaction prompt is open | after reload the attempt is listed under My workflow as validated with continue / abandon / recover |
| 9 | Expired report | Buy a report, wait past the usable window, press execute | execute is disabled with the expiry sentence; "Re-run the check (0.01 USDC)" is offered; nothing is sent |
| 10 | Insufficient funds | Use a wallet below fee + amount + gas | buy/execute disabled with "your wallet holds X; this step needs ≥ Y"; the faucet card appears on testnet |
| 11 | Delayed RPC | Throttle the network in devtools | polling continues; the attempt shows "waiting for the receipt"; recover reads only |
| 12 | Verification states | Verify a tampered bundle on `/verify` | red FAIL state with the failing finding; never a green banner |
| 13 | Two tabs, one attempt (review of `0c0d406`) | Open the Developer page in two tabs; in tab A execute and leave the wallet prompt open; in tab B reload or try to continue the same attempt | tab B never opens a second prompt: it reads "submission uncertain", reconciles (recover, then observe) and offers only Recover and "I rejected it — abandon"; the wallet shows one prompt in total |
| 14 | Network switched after the claim (review of `0c0d406`) | Click Execute, then switch the wallet's network before confirming | either the page refuses before the prompt ("on chain …; the plan was validated for chain …") and the attempt stays a plain validated attempt, or the wallet itself refuses the request's `chainId`; never a transaction on the other network |

Observed results belong in `docs/ACCEPTANCE.md` §11 (AP33-30) with the date and the wallet used.

## Session for release `78c8dc2` (Gate D precondition)

Where: `https://arcpreflight.axiqo.xyz/developer` — the root is the public **Arc testnet** preview until the mainnet cutover, so row 1
reads "connect while the wallet is on another network; the site asks once to switch to (or add) Arc testnet". Everything else as above.

Before you start: Chrome with MetaMask or OKX Wallet, one account with Arc testnet USDC (or claim 0.2 from the wallet menu), a second
account in the same extension for row 3. Note the extension's version (extension menu → About / Settings).

Order that keeps prompts to a minimum: 1, 2, 10 (before funding, if the account is empty), 5, 9, 4, 14, 6, 7, 8, 13, 11, 3, 12.

What to send back: the wallet name and version, the address used, the time window, and per row "pass" or "fail" with what the page
said (a screenshot for any fail). The operator then runs `ops/wallet-evidence.sh <address> <start time>`, which reads — read-only —
what the server recorded for that address (orders, paid checks, attempts with their prompt markers, states and hashes), and records the
result under AP33-30 with the release, the wallet version and every row.
