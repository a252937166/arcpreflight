#!/usr/bin/env node
// Thin launcher: the verifier is TypeScript; run it through tsx (a workspace devDependency) so `pnpm exec arcpreflight-verify …` works.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const cli = resolve(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.ts");
const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
