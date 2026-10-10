// Read-only view of the plan ledger for a network: what every step has committed across all its invocations, what is still pending, the
// carried baselines and the remaining budget. Used by `ops/mainnet-cutover.sh preflight`; writes nothing.
//   ARC_NET=mainnet pnpm exec tsx scripts/lib/plan-status.ts     (PLAN_ID overrides the default Gate D plan)
import { openPlan, planIdFor } from "./plan-ledger.js";
const net = process.env.ARC_NET ?? "mainnet";
const root = process.env.ARCPREFLIGHT_ROOT ?? process.cwd();
const id = planIdFor(net);
if (!id) { console.log(`no plan ledger applies to ${net} (set PLAN_ID for a rehearsal)`); process.exit(0); }
const book = openPlan(root, net, { write: false });
for (const l of book!.lines()) console.log(l);
