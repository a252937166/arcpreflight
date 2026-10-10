import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { IntentCore, PolicyCore } from "@arcpreflight/schema";
import { Validator } from "@seriousme/openapi-schema-validator";
import { openapi } from "../src/openapi.js";
import { check, checkSchema, compile, problems } from "./helpers/schema.js";

// The OpenAPI document (2026-10-10): every reference resolves, every template parameter is declared, and real responses — captured from the
// public instance on 2026-10-10 (test/fixtures/live) and built by the API's own code in the other test files — validate against the schemas
// of their routes. The Intent and Policy schemas mirror the zod schemas in packages/schema field by field. Review of 199dd55: the document is
// also validated against the official OpenAPI 3.0 schema (@seriousme/openapi-schema-validator), so a keyword 3.0 lacks (`const`) cannot return.
const doc: any = openapi({ releaseSha: "test", profile: "SUBMISSION_RESTRICTED", caip2: "eip155:5042002" });
const live = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "fixtures/live", name), "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"];
describe("the document's structure", () => {
  it("every $ref resolves, every route has responses, every {param} is declared, every bearer route names the scheme", () => {
    const refs: string[] = []; const walk = (x: any) => { if (!x || typeof x !== "object") return; if (typeof x.$ref === "string") refs.push(x.$ref); for (const v of Object.values(x)) walk(v); }; walk(doc);
    expect(refs.length).toBeGreaterThan(40);
    for (const r of refs) expect(doc.components.schemas[r.replace("#/components/schemas/", "")], r).toBeDefined();
    for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) { const op = item[m]; if (!op) continue;
      expect(Object.keys(op.responses ?? {}).length, `${m} ${path}`).toBeGreaterThan(0);
      for (const p of path.match(/\{([^}]+)\}/g) ?? []) expect((op.parameters ?? []).some((x: any) => x.in === "path" && `{${x.name}}` === p), `${m} ${path} ${p}`).toBe(true);
      for (const sec of op.security ?? []) for (const name of Object.keys(sec)) expect(doc.components.securitySchemes[name], `${m} ${path} ${name}`).toBeDefined();
      if (op.requestBody) expect(op.requestBody.content["application/json"].schema, `${m} ${path} body`).toBeDefined();
    }
  });
  it("the Intent and Policy schemas carry exactly the zod schemas' keys, all required, nothing else allowed; a valid policy passes and a policy missing a field fails", () => {
    const zodKeys = (s: any) => Object.keys(s.shape);
    expect(doc.components.schemas.Policy.required).toEqual(zodKeys(PolicyCore)); expect(doc.components.schemas.Policy.additionalProperties).toBe(false);
    expect(doc.components.schemas.Intent.required).toEqual(zodKeys(IntentCore)); expect(doc.components.schemas.Intent.additionalProperties).toBe(false);
    const policy = { schemaVersion: "1.0", ownerPrincipal: "visitor:1", allowedSenders: ["0xA71138FF271DB9A18D2B216cAF13b830Eeab3FF2"], allowedTargets: ["0xa8eb51ef994567b84215981e8d1fe17cb8e42252"], allowedSelectors: ["0x8609cad1"], maxNativePaymentAtomic: "50000000000000000", maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000", maxReportAgeSeconds: 300, maxFinalValidationAgeSeconds: 120, requiredSignalIds: [], unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false };
    expect(PolicyCore.safeParse(policy).success).toBe(true); expect(checkSchema(doc, "Policy", policy)).toEqual([]);
    const { requiredSignalIds: _r, ...missing } = policy; expect(checkSchema(doc, "Policy", missing)).toEqual(["$: must have required property 'requiredSignalIds'"]);
    expect(checkSchema(doc, "Policy", { ...policy, allowedTransactionTypes: [1] })).toEqual(["$/allowedTransactionTypes/0: must be equal to one of the allowed values [2]"]);
    expect(checkSchema(doc, "Policy", { ...policy, extra: 1 })).toEqual(["$: must NOT have additional properties (extra)"]);
  });
});
describe("the document is valid OpenAPI 3.0.3 by the official schema", () => {
  it("passes the official OpenAPI 3.0 JSON schema, declares 3.0.3, and spells every fixed value as a one-value enum (3.0 has no `const`)", async () => {
    const validator = new Validator(); const copy = JSON.parse(JSON.stringify(doc));
    const r = await validator.validate(copy);
    expect(r.errors ?? []).toEqual([]); expect(r.valid).toBe(true); expect(validator.version).toBe("3.0"); expect(doc.openapi).toBe("3.0.3");
    const consts: string[] = []; const walk = (x: any, at: string) => { if (!x || typeof x !== "object") return; if (Object.hasOwn(x, "const")) consts.push(at); for (const [k, v] of Object.entries(x)) walk(v, `${at}.${k}`); }; walk(doc, "$");
    expect(consts).toEqual([]);
    expect(doc.components.schemas.Intent.properties.schemaVersion).toEqual({ type: "string", enum: ["1.0"] }); expect(doc.components.schemas.Policy.properties.allowAuthorizationList).toEqual({ type: "boolean", enum: [false] });
    expect(doc.components.schemas.Policy.properties.allowedTransactionTypes.items).toEqual({ type: "integer", enum: [2] });
  });
  it("a document with `const` is what the official schema rejects — the validator is not a rubber stamp", async () => {
    const copy = JSON.parse(JSON.stringify(doc)); copy.components.schemas.Intent.properties.schemaVersion = { type: "string", const: "1.0" };
    const r = await new Validator().validate(copy);
    expect(r.valid).toBe(false); expect(JSON.stringify(r.errors)).toContain("const");
  });
});
describe("nullable values the way OpenAPI 3.0 defines them (review of 0d14ad9)", () => {
  const nullables: { at: string; schema: any }[] = []; const walk = (x: any, at: string) => { if (!x || typeof x !== "object") return; if (x.nullable === true) nullables.push({ at, schema: x }); for (const [k, v] of Object.entries(x)) walk(v, `${at}.${k}`); }; walk(doc, "$");
  it("every nullable schema sits next to its own type, a nullable enum lists null, and no reference is wrapped in allOf + nullable", () => {
    expect(nullables.length).toBeGreaterThan(40);
    for (const { at, schema } of nullables) { expect(typeof schema.type, at).toBe("string"); expect(schema.allOf, at).toBeUndefined(); expect(schema.$ref, at).toBeUndefined(); if (Array.isArray(schema.enum)) expect(schema.enum, at).toContain(null); }
    const quote = doc.components.schemas.RequestStatus.properties.quote; expect(quote).toMatchObject({ type: "object", nullable: true, "x-ref": "Quote" }); expect(quote.properties).toEqual(doc.components.schemas.Quote.properties); expect(quote.required).toEqual(doc.components.schemas.Quote.required);
    expect(doc.components.schemas.Order.properties.proxy).toEqual({ type: "string", enum: ["MAIN", "CHANGED", null], nullable: true });
  });
  it("every request and response schema compiles under ajv, and null passes exactly where it is declared", () => {
    let compiled = 0;
    for (const item of Object.values<any>(doc.paths)) for (const op of Object.values<any>(item)) { const bodies = [op.requestBody?.content?.["application/json"]?.schema, ...Object.values<any>(op.responses ?? {}).map((r) => r.content?.["application/json"]?.schema)].filter(Boolean); for (const s of bodies) { compile(doc, s); compiled++; } }
    expect(compiled).toBeGreaterThan(60);
    const status = { requestId: "r", state: "PREPARING", payment: { state: "NOT_REQUESTED", paymentId: null, backend: null, transaction: null, reason: null }, quote: null, quoteExpired: null };
    expect(checkSchema(doc, "RequestStatus", status)).toEqual([]); // a request before its quote: the nullable Quote copy and the nullable backend enum take null
    expect(checkSchema(doc, "RequestStatus", { ...status, payment: { ...status.payment, backend: "paypal" } })).toEqual(['$/payment/backend: must be equal to one of the allowed values ["relay","circle",null]']);
    expect(checkSchema(doc, "RequestStatus", { ...status, quote: { requestId: "r" } })).toEqual(["$/quote: must have required property 'amountTokenAtomic'", "$/quote: must have required property 'payTo'"]); // the copy keeps the Quote's requirements
    expect(problems(doc, doc.components.schemas.Order.properties.proxy, null)).toEqual([]); expect(problems(doc, doc.components.schemas.Order.properties.proxy, "OTHER")).toHaveLength(1);
    expect(problems(doc, { type: "string", nullable: true, enum: ["a"] }, null)).toEqual(['$: must be equal to one of the allowed values ["a"]']); // what the review found: nullable alone does not extend an enum
    expect(() => compile(doc, { allOf: [{ $ref: "#/components/schemas/Quote" }], nullable: true })).toThrow(/nullable/); // and the old nullable reference is not a schema ajv accepts
  });
});
describe("real responses of the public instance (captured 2026-10-10) validate against their routes", () => {
  const cases: [string, string, string][] = [["get", "/health/live", "_health_live.json"], ["get", "/health/ready", "_health_ready.json"], ["get", "/v1/network", "_v1_network.json"], ["get", "/v1/demo/runs", "_v1_demo_runs_limit_2_offset_0.json"], ["get", "/v1/demo/runs/{runId}", "_v1_demo_run.json"], ["get", "/v1/evidence", "_v1_evidence.json"], ["get", "/v1/public-reports", "_v1_public-reports.json"], ["get", "/v1/faucet", "_v1_faucet.json"]];
  for (const [method, path, file] of cases) it(`${method.toUpperCase()} ${path} ← ${file}`, () => { expect(check(doc, method, path, 200, live(file))).toEqual([]); });
  it("the fixture set is the one the cases cover", () => { expect(readdirSync(resolve(__dirname, "fixtures/live")).sort()).toEqual(cases.map((c) => c[2]).sort()); });
  it("the validator (ajv): nulls where none are declared, wrong types and unknown enum values are reported with their paths", () => {
    expect(problems(doc, { $ref: "#/components/schemas/Error" }, { error: null })).toEqual(["$/error: must be string"]);
    expect(problems(doc, { type: "object", properties: { n: { type: "integer" } } }, { n: 1.5 })).toEqual(["$/n: must be integer"]);
    expect(problems(doc, { $ref: "#/components/schemas/RunSummary" }, { runId: "r", fixture: "APPROVED_PAYMENT", state: "LOST", labels: [], createdAt: "t", updatedAt: "t" })).toEqual(['$/state: must be equal to one of the allowed values ["RUNNING","DONE","FAILED","RECONCILE_REQUIRED"]']);
    // a oneOf answer (GET /v1/requests/{id} 200) is checked against each alternative: a body that is neither delivered nor a status is reported
    const read = doc.paths["/v1/requests/{requestId}"].get.responses[200].content["application/json"].schema; expect(read.oneOf.map((x: any) => x.$ref)).toEqual(["#/components/schemas/Delivered", "#/components/schemas/RequestStatus"]);
    expect(problems(doc, read, { requestId: "r", delivery: "DELIVERED", payment: { state: "COMPLETED" }, reportDigest: "0x", report: {} })).toEqual([]);
    expect(problems(doc, read, { requestId: "r", state: "WAITING_PAYMENT", payment: { state: "NOT_REQUESTED", paymentId: null, backend: null, transaction: null, reason: null }, quote: null, quoteExpired: null })).toEqual([]);
    expect(problems(doc, read, { requestId: "r", error: "PAYMENT_FAILED" })).toContain("$: must match exactly one schema in oneOf");
  });
});
