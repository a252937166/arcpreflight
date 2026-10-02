import { describe, it, expect } from "vitest";
import { canonicalize, digest } from "../src/canonical.js";

describe("JCS canonicalize (RFC 8785 subset)", () => {
  it("sorts keys by UTF-16 code units and strips whitespace", () => {
    expect(canonicalize({ b: 1, a: "x", "aa": null })).toBe('{"a":"x","aa":null,"b":1}');
  });
  it("matches RFC 8785 §3.2.3 key ordering example", () => {
    const input = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    const out = canonicalize(input);
    const keysInOrder = [...out.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse('"' + m[1] + '"'));
    expect(keysInOrder).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
  });
  it("rejects bigint and undefined", () => {
    expect(() => canonicalize({ a: 1n })).toThrow();
    expect(() => canonicalize({ a: undefined })).toThrow();
  });
  it("digest is deterministic regardless of key order", () => {
    const a = digest("intent", "1.0", { x: "1", y: ["a", "b"] });
    const b = digest("intent", "1.0", { y: ["a", "b"], x: "1" });
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("digest changes with kind or schemaVersion", () => {
    expect(digest("intent", "1.0", { x: "1" })).not.toBe(digest("report", "1.0", { x: "1" }));
    expect(digest("intent", "1.0", { x: "1" })).not.toBe(digest("intent", "1.1", { x: "1" }));
  });
});
