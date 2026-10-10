// The API reference page's model (2026-10-10): the instance's own OpenAPI document, grouped for a reader and rendered as skeletons a
// developer can scan — method, path, summary, who may call it, parameters, the request body and the responses, whatever the document
// carries. Pure functions; the page fetches GET /openapi.json and hands the document here.
export type Schema = Record<string, any>;
export type Param = { name: string; in: string; required: boolean; description: string; schema: Schema | null };
export type Response = { status: string; description: string; schema: Schema | null };
export type Operation = { id: string; method: string; path: string; summary: string; description: string; secured: boolean; auth: string[]; parameters: Param[]; requestBody: Schema | null; requestRequired: boolean; responses: Response[] };
export type Group = { id: string; title: string; blurb: string; operations: Operation[] };
export type NamedSchema = { name: string; id: string; description: string; keys: string[]; schema: Schema };
export type Reference = { title: string; version: string; profile: string | null; network: string | null; note: string; groups: Group[]; operations: number; schemas: NamedSchema[] };

const GROUPS: { id: string; title: string; blurb: string; test: (path: string) => boolean }[] = [
  { id: "public", title: "Network and public reads", blurb: "No token. The instance, the curated samples, every demo run and every published file.", test: (p) => /^\/v1\/(network|subjects|public-reports|evidence)/.test(p) },
  { id: "session", title: "Sessions and faucet", blurb: "An anonymous bearer token for everything you own; testnet funds for a wallet.", test: (p) => /^\/v1\/(session|faucet)/.test(p) },
  { id: "orders", title: "Orders", blurb: "Your orders on the demo merchant, read back until their creation is confirmed.", test: (p) => p.startsWith("/v1/demo/orders") },
  { id: "checks", title: "Checks over x402", blurb: "The quote, the paid report, the approved baseline, and recovery of a fee that is still settling.", test: (p) => /^\/v1\/(preflight|requests|baselines)/.test(p) },
  { id: "attempts", title: "Wallet attempts", blurb: "Validation before the prompt, the exclusive claim, the hash, reconciliation, the passport.", test: (p) => p.startsWith("/v1/wallet/attempts") },
  { id: "demo", title: "Live demo runs", blurb: "The project's own runner pays a fixed scenario; the run is public and recoverable.", test: (p) => /^\/v1\/demo\/run/.test(p) },
  { id: "health", title: "Health", blurb: "Liveness and readiness of this instance.", test: (p) => p.startsWith("/health") },
];
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;
export const opId = (method: string, path: string) => `op-${method}-${path.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/** the name a `$ref` points at, or null for an inline schema */
export const refName = (schema: Schema | null | undefined): string | null => (schema && typeof schema.$ref === "string" ? /^#\/components\/schemas\/([^/]+)$/.exec(schema.$ref)?.[1] ?? null : null);
export const schemaId = (name: string) => `schema-${name.replace(/[^a-zA-Z0-9]+/g, "-")}`;
/** `#/components/schemas/Name` → the schema; anything else → the input */
export function resolve(doc: any, schema: Schema | null | undefined): Schema | null {
  if (!schema || typeof schema !== "object") return null;
  if (typeof schema.$ref === "string") { const m = /^#\/components\/schemas\/([^/]+)$/.exec(schema.$ref); const s = m ? doc?.components?.schemas?.[m[1]] : null; return s ? { ...s, title: s.title ?? m![1] } : { description: `see ${schema.$ref}` }; }
  return schema;
}
const typeOf = (s: Schema): string => {
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type ?? (s.properties ? "object" : s.items ? "array" : "any");
  return s.format ? `${t} (${s.format})` : t;
};
/** A skeleton of the schema a developer can read like JSON: keys with their types, optional keys marked `?`, enums spelled out,
 *  descriptions as trailing comments. Depth-limited; references resolved against the document's components. */
export function skeleton(doc: any, schema: Schema | null | undefined, depth = 0): string {
  const s = resolve(doc, schema); if (!s) return "…";
  const pad = "  ".repeat(depth);
  const comment = (d: unknown) => (typeof d === "string" && d.length <= 90 ? `  // ${d}` : "");
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return (s.oneOf ?? s.anyOf).map((x: Schema) => skeleton(doc, x, depth)).join(`\n${pad}| `);
  if (s.allOf) return skeleton(doc, Object.assign({}, ...s.allOf.map((x: Schema) => resolve(doc, x) ?? {})), depth);
  if (s.type === "array" || s.items) return `[ ${skeleton(doc, s.items, depth)} ]`;
  if (s.type === "object" || s.properties || s.additionalProperties) {
    if (depth >= 4) return "{ … }";
    const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
    const entries = Object.entries<Schema>(s.properties ?? {});
    if (!entries.length) return s.additionalProperties ? `{ [key: string]: ${skeleton(doc, s.additionalProperties === true ? { type: "any" } : s.additionalProperties, depth + 1)} }` : "{ }";
    const lines = entries.map(([k, v]) => { const r = resolve(doc, v) ?? {}; return `${pad}  "${k}${required.has(k) ? "" : "?"}": ${skeleton(doc, r, depth + 1)}${comment(r.description)}`; });
    return `{\n${lines.join("\n")}\n${pad}}`;
  }
  return typeOf(s);
}
/** path template parameters not declared by the operation: `{orderId}` → a required string path parameter */
const impliedParams = (path: string, declared: Param[]): Param[] => Array.from(path.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]).filter((n) => !declared.some((p) => p.name === n && p.in === "path")).map((name) => ({ name, in: "path", required: true, description: "", schema: { type: "string" } }));

/** The document as a reader's reference: groups in a fixed order, operations in document order, every field the document carries. */
export function parseReference(doc: any): Reference {
  const info = doc?.info ?? {}; const desc = String(info.description ?? "");
  const profile = /profile=([^;.\s]+)/.exec(desc)?.[1] ?? null; const network = /network=([^;.\s]+)/.exec(desc)?.[1] ?? null;
  const note = desc.replace(/^profile=[^;.]+;\s*network=[^.]+\.\s*/, "").trim();
  const securityNames = Object.keys(doc?.components?.securitySchemes ?? {});
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries<any>(doc?.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]; if (!op) continue;
      const declared: Param[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => ({ name: String(p.name), in: String(p.in ?? "query"), required: !!p.required || p.in === "path", description: String(p.description ?? ""), schema: p.schema ?? null }));
      const auth = Array.isArray(op.security) ? op.security.flatMap((s: any) => Object.keys(s ?? {})).filter((n: string) => securityNames.includes(n) || true) : [];
      const content = op.requestBody?.content ?? {}; const bodySchema = content["application/json"]?.schema ?? Object.values<any>(content)[0]?.schema ?? null;
      const responses: Response[] = Object.entries<any>(op.responses ?? {}).map(([status, r]) => ({ status, description: String(r?.description ?? ""), schema: r?.content?.["application/json"]?.schema ?? null })).sort((a, b) => a.status.localeCompare(b.status));
      ops.push({ id: opId(method, path), method: method.toUpperCase(), path, summary: String(op.summary ?? ""), description: String(op.description ?? ""), secured: auth.length > 0, auth, parameters: [...declared, ...impliedParams(path, declared)], requestBody: bodySchema, requestRequired: op.requestBody?.required !== false && !!bodySchema, responses });
    }
  }
  const groups: Group[] = GROUPS.map((g) => ({ id: g.id, title: g.title, blurb: g.blurb, operations: ops.filter((o) => g.test(o.path)) })).filter((g) => g.operations.length);
  const rest = ops.filter((o) => !GROUPS.some((g) => g.test(o.path)));
  if (rest.length) groups.push({ id: "other", title: "Other routes", blurb: "", operations: rest });
  const schemas: NamedSchema[] = Object.entries<Schema>(doc?.components?.schemas ?? {}).map(([name, schema]) => ({ name, id: schemaId(name), description: String(schema?.description ?? ""), keys: Object.keys(schema?.properties ?? {}), schema }));
  return { title: String(info.title ?? "API"), version: String(info.version ?? ""), profile, network, note, groups, operations: ops.length, schemas };
}
