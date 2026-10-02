// Generate project-owned keys (never the user's personal wallets). Output: keys/*.json (chmod 600), addresses printed.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
const roles = ["deployer-admin", "merchant-payto", "demo-runner"];
mkdirSync("keys", { recursive: true });
for (const role of roles) {
  const f = `keys/${role}.json`;
  if (existsSync(f)) { console.log(`${role}: exists, skip`); continue; }
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  writeFileSync(f, JSON.stringify({ role, address: acct.address, privateKey: pk, createdAtUTC: new Date().toISOString() }, null, 2));
  chmodSync(f, 0o600);
  console.log(`${role}: ${acct.address}`);
}
