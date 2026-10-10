import { describe, expect, it } from "vitest";
import { opId, parseReference, refName, skeleton } from "../src/lib/openapi";

// The API reference's model (2026-10-10): the instance's OpenAPI document grouped for a reader, with schemas rendered as skeletons.
const DOC = {
  openapi: "3.0.3", info: { title: "ArcPreflight API", version: "abc1234", description: "profile=SUBMISSION_RESTRICTED; network=eip155:5042002. Self-service is open." },
  paths: {
    "/health/live": { get: { summary: "process liveness" } },
    "/v1/network": { get: { summary: "the instance", responses: { 200: { description: "now", content: { "application/json": { schema: { $ref: "#/components/schemas/Network" } } } } } } },
    "/v1/session": { post: { summary: "a token", responses: { 429: { description: "too many" }, 201: { description: "created", content: { "application/json": { schema: { type: "object", properties: { principal: { type: "string" }, token: { type: "string", description: "keep it private" } }, required: ["principal", "token"] } } } } } } },
    "/v1/demo/orders/{orderId}": { get: { summary: "one order", security: [{ bearer: [] }], responses: { 200: { description: "the order" } } } },
    "/v1/wallet/attempts": { post: { summary: "validate", security: [{ bearer: [] }], parameters: [{ name: "limit", in: "query", schema: { type: "integer" }, description: "rows" }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { requestId: { type: "string" }, policy: { type: "object" }, mode: { type: "string", enum: ["EOA", "SMART"] }, ids: { type: "array", items: { type: "string", format: "0x 32-byte hex" } } }, required: ["requestId", "policy"] } } } } } },
    "/v1/evidence/{path}": { get: { summary: "a file" } },
  },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, schemas: { Network: { type: "object", properties: { network: { type: "string", enum: ["mainnet", "testnet"] }, nested: { $ref: "#/components/schemas/Network" } } } } },
};
describe("the API reference model", () => {
  it("groups operations in a reader's order, keeps document order inside a group, flags bearer routes, implies path parameters and sorts responses", () => {
    const ref = parseReference(DOC);
    expect([ref.title, ref.version, ref.profile, ref.network, ref.note, ref.operations]).toEqual(["ArcPreflight API", "abc1234", "SUBMISSION_RESTRICTED", "eip155:5042002", "Self-service is open.", 6]);
    expect(ref.groups.map((g) => [g.id, g.operations.map((o) => `${o.method} ${o.path}`)])).toEqual([
      ["public", ["GET /v1/network", "GET /v1/evidence/{path}"]], ["session", ["POST /v1/session"]], ["orders", ["GET /v1/demo/orders/{orderId}"]], ["attempts", ["POST /v1/wallet/attempts"]], ["health", ["GET /health/live"]]]);
    const order = ref.groups[2].operations[0]; expect(order.secured).toBe(true); expect(order.parameters).toEqual([{ name: "orderId", in: "path", required: true, description: "", schema: { type: "string" } }]); // implied from the template
    const session = ref.groups[1].operations[0]; expect(session.secured).toBe(false); expect(session.responses.map((r) => r.status)).toEqual(["201", "429"]); expect(session.requestBody).toBeNull();
    const attempt = ref.groups[3].operations[0]; expect(attempt.parameters.map((p) => [p.name, p.in, p.required])).toEqual([["limit", "query", false]]); expect(attempt.requestRequired).toBe(true);
    expect(order.id).toBe("op-get-v1-demo-orders-orderId"); expect(opId("post", "/v1/wallet/attempts/{attemptId}/sent")).toBe("op-post-v1-wallet-attempts-attemptId-sent");
    expect(ref.schemas.map((s) => [s.name, s.id, s.keys])).toEqual([["Network", "schema-Network", ["network", "nested"]]]); // the components, rendered once
    expect(refName({ $ref: "#/components/schemas/Network" })).toBe("Network"); expect(refName({ type: "object" })).toBeNull();
  });
  it("renders a schema as a readable skeleton: required and optional keys, enums, arrays, formats, descriptions as comments, references resolved and recursion bounded", () => {
    const attempt = parseReference(DOC).groups[3].operations[0];
    expect(skeleton(DOC, attempt.requestBody)).toBe(`{\n  "requestId": string\n  "policy": { }\n  "mode?": "EOA" | "SMART"\n  "ids?": [ string (0x 32-byte hex) ]\n}`);
    const session = parseReference(DOC).groups[1].operations[0];
    expect(skeleton(DOC, session.responses[0].schema)).toBe(`{\n  "principal": string\n  "token": string  // keep it private\n}`);
    const net = skeleton(DOC, { $ref: "#/components/schemas/Network" });
    expect(net.startsWith(`{\n  "network?": "mainnet" | "testnet"\n  "nested?": {`)).toBe(true); expect(net).toContain("{ … }"); // the self-reference stops at depth 4
    expect(skeleton(DOC, { $ref: "#/components/schemas/Missing" })).toBe("any"); expect(skeleton(DOC, null)).toBe("…");
  });
});
