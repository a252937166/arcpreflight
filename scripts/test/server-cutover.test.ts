// Run the real shell scripts against an isolated fake host: no network, real keys or system services.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const db = "/opt/arcpreflight/data/arcpreflight-testnet-v33.sqlite";
const release = "review123";
let root: string;
const remote = (path: string) => join(root, "remote", path);
function put(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }

// Every potentially external command resolves here. SSH runs the script's actual remote shell body,
// with remote absolute paths mapped into this test's temp directory and the same fake PATH.
const command = String.raw`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const env = process.env, args = process.argv.slice(2), name = path.basename(process.argv[1]);
const log = (event) => fs.appendFileSync(env.EVENTS, event + "\n");
const map = (text) => text.replace(/\/opt\/arcpreflight|\/etc\/systemd\/system|\/etc\/nginx|\/var\/www\/arcpreflight/g, (p) => env.FAKE_REMOTE + p);
const fail = () => process.exit(1);
log(name + " " + args.join(" "));
switch (name) {
  case "git": if (args[0] === "log") process.stdout.write("review123\n"); break;
  case "pnpm": if (env.FAIL === "build") fail(); break;
  case "rsync": break;
  case "sleep": break;
  case "scp": {
    const operands = args.filter((a) => !a.startsWith("-")), from = operands[0], dest = operands[1];
    if (!dest.includes(":")) throw new Error("fake scp only supports local-to-fake-host copies");
    const target = map(dest.slice(dest.indexOf(":") + 1));
    if (!target.startsWith(env.FAKE_REMOTE + "/")) throw new Error("remote destination escaped sandbox");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = fs.readFileSync(from); fs.writeFileSync(target, target.endsWith(".env") ? map(bytes.toString()) : bytes);
    break;
  }
  case "ssh": {
    const rest = [...args]; while (rest[0] === "-o") rest.splice(0, 2); rest.shift();
    const stdin = rest[0] === "bash" && rest[1] === "-s";
    const script = map(stdin ? fs.readFileSync(0, "utf8") : rest.join(" "));
    const child = cp.spawnSync("/bin/bash", stdin ? rest.slice(1) : ["-c", script], { env, encoding: "utf8", ...(stdin ? { input: script } : {}) });
    process.stdout.write(child.stdout || ""); process.stderr.write(child.stderr || "");
    if (env.FAIL === "lost-ssh-answer" && script.includes("systemctl restart arcpreflight")) process.exit(255);
    process.exit(child.status ?? 1);
  }
  case "systemctl":
    if (args[0] === "restart" && args[1] === "arcpreflight-testnet" && env.FAIL === "testnet-restart") fail();
    if (args[0] === "reload" && args[1] === "nginx" && env.FAIL === "nginx-reload") fail();
    break;
  case "nginx": if (env.FAIL === "nginx-validation") fail(); break;
  case "sed": { // The host is Linux; macOS sed has a different -i interface.
    const replacement = args[1]?.match(/^s\/\^RELEASE_SHA=\.\*\/(RELEASE_SHA=[^/]+)\/$/)?.[1], target = args[2];
    if (args[0] !== "-i" || !replacement || !target.startsWith(env.FAKE_REMOTE + "/")) throw new Error("unexpected remote sed");
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/^RELEASE_SHA=.*$/m, replacement)); break;
  }
  case "curl": {
    const url = args.find((a) => /^https?:/.test(a));
    if (!url) throw new Error("fake curl needs an explicit URL");
    if (url.endsWith("/health/live")) { process.stdout.write('{"ok":true}'); break; }
    if (url.endsWith("/v1/session")) { process.stdout.write('{"token":"fake-session"}'); break; }
    if (/\/v1\/(demo\/(run|orders)|wallet\/attempts)$/.test(url)) { process.stdout.write('{"error":"EXECUTION_GATED"}\n503'); break; }
    if (!url.endsWith("/v1/network")) throw new Error("unexpected fake URL " + url);
    const testnet = url.includes("/testnet/"), prefix = testnet ? "testnet" : "mainnet";
    const d = { chainId: testnet ? 5042002 : 5042, network: prefix, caip2: testnet ? "eip155:5042002" : "eip155:5042", release: "review123",
      accounts: { orderSignerRole: "order-creator", adminKeyInProcess: false },
      access: { publicExecution: testnet, operatorAcceptance: true, executionReady: true }, fixtures: [] };
    if (env.FAIL === prefix + "-chain") d.chainId = 1;
    if (env.FAIL === prefix + "-release") d.release = "stale";
    if (env.FAIL === prefix + "-gate") d.access.publicExecution = !testnet;
    process.stdout.write(JSON.stringify(d)); break;
  }
  default: throw new Error("unhandled fake command " + name);
}
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arcpf-server-cutover-"));
  for (const script of ["deploy.sh", "mainnet-cutover.sh"]) {
    const target = join(root, "ops", script); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, "ops", script), target); chmodSync(target, 0o755);
  }
  for (const name of ["git", "pnpm", "ssh", "scp", "rsync", "curl", "systemctl", "nginx", "sleep", "sed"]) {
    const target = join(root, "bin", name); put(target, `#!${process.execPath}\n${command}`); chmodSync(target, 0o755);
  }
  const env = "ARC_NET=testnet\nRELEASE_SHA=old\nDB_PATH=" + db + "\nPUBLIC_EXECUTION=1\nMAINNET_VERIFIED=1\n";
  put(join(root, "keys/env.server"), env); put(join(root, "keys/env.server-testnet"), env);
  put(join(root, "keys/order-creator.json"), '{"address":"0x1111111111111111111111111111111111111111"}');
  put(join(root, "fixtures/deployments-mainnet.json"), JSON.stringify({ proxies: { MAIN: { address: "0x1111111111111111111111111111111111111111" }, CHANGED: { address: "0x2222222222222222222222222222222222222222" } } }));
  put(join(root, "ops/arcpreflight-testnet.service"), "fake service\n"); put(join(root, "ops/nginx-arcpreflight.conf"), "fake nginx\n");
  put(remote("/opt/arcpreflight/arcpreflight.env"), env.replace(db, remote(db)));
  put(remote("/opt/arcpreflight/arcpreflight-testnet.env"), env.replace(db, remote(db)));
  put(remote("/opt/arcpreflight/keys/deployer-admin.json"), "fake old deployer key\n");
  put(remote(db), "existing testnet database: preserve these bytes\n");
  put(join(root, "events"), ""); mkdirSync(join(root, "tmp"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(script: string, args: string[], fail = "") {
  const child = spawn("/bin/bash", [join(root, "ops", script), ...args], {
    cwd: root,
    env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, HOST: "fake-host", API: "https://fake.invalid", CUTOVER_GO: "server", FAIL: fail,
      FAKE_REMOTE: join(root, "remote"), EVENTS: join(root, "events"), TMPDIR: join(root, "tmp") },
  });
  let out = ""; child.stdout.on("data", (bytes) => { out += bytes; }); child.stderr.on("data", (bytes) => { out += bytes; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const status = await new Promise<number | null>((done, reject) => { child.on("error", reject); child.on("close", done); }).finally(() => clearTimeout(timeout));
  expect(status, "shell harness timed out or was killed").not.toBeNull();
  return { status, out, events: readFileSync(join(root, "events"), "utf8").split("\n").filter(Boolean) };
}
function stoppedAfterRestart(events: string[]) {
  const restarted = events.indexOf("systemctl restart arcpreflight");
  expect(restarted).toBeGreaterThan(-1);
  expect(events.slice(restarted + 1)).toContain("systemctl stop arcpreflight");
}

describe("server deployment and mainnet cutover fail closed", { timeout: 15_000 }, () => {
  it("build-only builds both bundles without any remote action", async () => {
    const r = await run("deploy.sh", ["fake-host", "--build-only"]);
    expect(r.status, r.out).toBe(0);
    expect(r.events.filter((e) => e.startsWith("pnpm "))).toHaveLength(2);
    expect(r.events.some((e) => /^(ssh|scp|rsync|systemctl|nginx|curl) /.test(e))).toBe(false);
    expect(r.out).not.toContain("deployed ");
  });
  it.each(["testnet-restart", "nginx-validation", "nginx-reload"])("deploy: %s is a failed deployment, with no false success", async (fail) => {
    const r = await run("deploy.sh", ["fake-host"], fail);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).not.toContain("deployed " + release);
    expect(r.events).toContain("systemctl restart arcpreflight");
  });
  it("a failed build leaves both remote environments and services untouched", async () => {
    const before = readFileSync(remote("/opt/arcpreflight/arcpreflight.env"), "utf8");
    const r = await run("mainnet-cutover.sh", ["server"], "build");
    expect(r.status, r.out).not.toBe(0);
    expect(r.events.some((e) => /^(ssh|scp|rsync|systemctl) /.test(e))).toBe(false);
    expect(readFileSync(remote("/opt/arcpreflight/arcpreflight.env"), "utf8")).toBe(before);
  });
  it.each(["testnet-restart", "nginx-validation", "nginx-reload", "lost-ssh-answer"])("cutover: %s after root restarts stops root before returning failure", async (fail) => {
    const r = await run("mainnet-cutover.sh", ["server"], fail);
    expect(r.status, r.out).not.toBe(0);
    stoppedAfterRestart(r.events);
    expect(r.out).toContain("the mainnet service was stopped");
  });
  it.each(["mainnet-chain", "mainnet-release", "mainnet-gate", "testnet-chain", "testnet-release", "testnet-gate"])("cutover: %s cannot pass identity and gate verification", async (fail) => {
    const r = await run("mainnet-cutover.sh", ["server"], fail);
    expect(r.status, r.out).not.toBe(0);
    stoppedAfterRestart(r.events);
  });
  it("a missing existing testnet database prevents remote mutation", async () => {
    rmSync(remote(db));
    const r = await run("mainnet-cutover.sh", ["server"]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.events.some((e) => /^(scp|rsync|systemctl) /.test(e))).toBe(false);
    expect(r.out).toContain("existing testnet database is missing");
  });
  it("successful cutover preserves the testnet database and verifies both instances", async () => {
    const before = readFileSync(remote(db), "utf8");
    const r = await run("mainnet-cutover.sh", ["server"]);
    expect(r.status, r.out).toBe(0);
    expect(r.events.filter((e) => e.startsWith("pnpm "))).toHaveLength(2);
    const lastBuild = Math.max(...r.events.map((e, i) => e.startsWith("pnpm ") ? i : -1));
    expect(r.events.findIndex((e) => e.startsWith("ssh "))).toBeGreaterThan(lastBuild);
    expect(r.events).toContain("systemctl restart arcpreflight-testnet");
    expect(r.events.slice(r.events.indexOf("systemctl restart arcpreflight") + 1)).not.toContain("systemctl stop arcpreflight");
    expect(r.out).toContain("gate closed"); expect(r.out).toContain("testnet instance:");
    expect(readFileSync(remote(db), "utf8")).toBe(before);
    expect(readFileSync(remote("/opt/arcpreflight/arcpreflight-testnet.env"), "utf8")).toContain("DB_PATH=" + remote(db));
    const mainnetEnv = readFileSync(remote("/opt/arcpreflight/arcpreflight.env"), "utf8");
    expect(mainnetEnv).toContain("ARC_NET=mainnet\n"); expect(mainnetEnv).toContain("PUBLIC_EXECUTION=0\n");
    expect(mainnetEnv).not.toContain("MAINNET_VERIFIED=");
    expect(existsSync(remote("/opt/arcpreflight/keys/deployer-admin.json"))).toBe(false);
  });
});
