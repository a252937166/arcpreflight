# Verify this Payment Passport

This directory (or its single-file bundle) is a read-only evidence export of one ArcPreflight workflow on eip155:5042002.
It grants nothing: no signing authority, no raw transactions, no authorization signatures, no right to reuse a receipt.

Run the independent verifier in a clean process, without any ArcPreflight API, token or key:

    pnpm exec tsx packages/verifier/src/cli.ts <passport-dir-or-bundle.json> --rpc <arc rpc url> --anchors anchors.json
    # equivalent: pnpm -C packages/verifier verify <passport> --rpc <url> --anchors anchors.json
    #         or: node packages/verifier/bin/arcpreflight-verify.mjs <passport> --rpc <url> --anchors anchors.json

- `--rpc` is an explicitly configured Arc RPC (chain 5042002). Without it the online findings are UNVERIFIED.
- `--anchors` is a JSON file `{ "baselineDigests": ["0x…"], "policyDigests": ["0x…"] }` holding the approval digests you
  retained through a trusted channel. Without it APPROVAL_SOURCE is UNVERIFIED: a passport cannot vouch for its own approval.

The verifier prints one line per finding (PASS, FAIL, UNVERIFIED or NOT_EVALUATED) and never a single overall "PASS".
CURRENT_ELIGIBILITY is always NOT_EVALUATED: whether a new payment may execute now is a present-time question that
historical success never answers. A transaction hash is not proof of service delivery, and a contract balance is not proof
that this order was paid; the ORDER_OUTCOME finding reads the order itself at the receipt's block.

Execution mode: runner. The business transaction was signed by the project runner from the validated plan; TRANSACTION_PLAN_AGREEMENT requires every serialized field to match that plan.

Files under evidence/chain/ were captured from the exporter's RPC at export time and are labelled captures, not pinned
evidence; the verifier re-fetches what it needs. The fee transaction's calldata is not included (it carries the buyer's
authorization signature); the verifier fetches it from the chain when it needs it.
