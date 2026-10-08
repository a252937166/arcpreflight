import { beforeEach, describe, expect, it, vi } from "vitest";

const c = vi.hoisted(() => ({ net: "mainnet" as "mainnet" | "testnet", supportedTargets: [] as string[] }));
vi.mock("../src/config.js", () => ({ cfg: c }));
import { curatedSubjects, isCuratedSubject } from "../src/subjects.js";

const USDC = "0x3600000000000000000000000000000000000000";
const GATEWAY = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const MAIN_PROXY = "0x00e393acdcd8cfbef4ab5d0f826bebd87bf4ae14";
const CHANGED_PROXY = "0x816ca9da6d3a316d9b4cff414890b07cbc95b399";

beforeEach(() => { c.net = "mainnet"; c.supportedTargets = [MAIN_PROXY, CHANGED_PROXY]; });

describe("curated observation subjects", () => {
  it("mainnet: the five external samples plus the configured fixture proxies", () => {
    const list = curatedSubjects();
    expect(list.filter((s) => s.kind === "external").map((s) => s.address)).toEqual([USDC, GATEWAY, "0xe2E5F173576B513d994073CCbDaCBE027d43DFe6", "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"]);
    expect(list.filter((s) => s.kind === "fixture").map((s) => s.address)).toEqual([MAIN_PROXY, CHANGED_PROXY]);
  });
  it("testnet: USDC and the fixtures only, so mainnet-only objects are refused there", () => {
    c.net = "testnet";
    expect(isCuratedSubject(USDC)).toBe(true);
    expect(isCuratedSubject(MAIN_PROXY)).toBe(true);
    expect(isCuratedSubject(GATEWAY)).toBe(false);
    expect(curatedSubjects()).toHaveLength(1 + c.supportedTargets.length);
  });
  it("with no fixtures configured only the external samples remain", () => {
    c.supportedTargets = [];
    expect(curatedSubjects().every((s) => s.kind === "external")).toBe(true);
  });
  it("matches case-insensitively and rejects near misses and the zero address", () => {
    expect(isCuratedSubject(GATEWAY.toLowerCase())).toBe(true);
    expect(isCuratedSubject(`0x${GATEWAY.slice(2).toUpperCase()}`)).toBe(true);
    expect(isCuratedSubject("0x77777777Dcc4d5A8B6E418Fd04D8997ef11000ef")).toBe(false);
    expect(isCuratedSubject("0x0000000000000000000000000000000000000000")).toBe(false);
  });
  it("lists an address once even when it is both an external sample and a configured target", () => {
    c.supportedTargets = [USDC];
    const matches = curatedSubjects().filter((s) => s.address.toLowerCase() === USDC);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("external");
  });
});
