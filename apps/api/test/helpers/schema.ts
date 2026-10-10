// Real responses are validated against the document with ajv (the standard JSON-schema validator; OpenAPI 3.0's `nullable` is native to
// it: null passes only next to a `type`, and an enum must list null). `#/components/…` references resolve into the document, which is
// registered once per document object. Problems come back as "path: why" lines so a test can print them.
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
type Engine = { ajv: Ajv; compiled: WeakMap<object, ValidateFunction> };
const engines = new WeakMap<object, Engine>();
function engineFor(doc: any): Engine {
  let e = engines.get(doc);
  if (!e) { const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false }); ajv.addSchema({ components: doc.components }, "openapi"); e = { ajv, compiled: new WeakMap() }; engines.set(doc, e); }
  return e;
}
/** an inline schema's `#/components/…` references point into the registered document */
const rooted = (x: any): any => (Array.isArray(x) ? x.map(rooted) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `openapi${v}` : rooted(v)])) : x);
/** the compiled validator of a schema object (compiled once per object); compiling throws for a schema 3.0 cannot express, e.g. `nullable` without `type` */
export function compile(doc: any, schema: any): ValidateFunction {
  const e = engineFor(doc); let v = e.compiled.get(schema);
  if (!v) { v = e.ajv.compile(rooted(schema)); e.compiled.set(schema, v); }
  return v;
}
const line = (e: ErrorObject) => `$${e.instancePath}: ${e.message ?? e.keyword}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}${e.params?.allowedValues ? ` ${JSON.stringify(e.params.allowedValues)}` : ""}`;
/** the problems of a value against a schema, or [] */
export function problems(doc: any, schema: any, value: unknown): string[] { const v = compile(doc, schema); return v(value) ? [] : (v.errors ?? []).map(line); }
/** the schema of a route's response body */
export function responseSchema(doc: any, method: string, path: string, status: number | string): any {
  const r = doc.paths?.[path]?.[method.toLowerCase()]?.responses?.[String(status)]; return r?.content?.["application/json"]?.schema ?? null;
}
/** validate a real response body against the document: the problems, or [] */
export const check = (doc: any, method: string, path: string, status: number | string, body: unknown): string[] => { const s = responseSchema(doc, method, path, status); return s ? problems(doc, s, body) : [`${method} ${path} ${status}: no response schema`]; };
export const checkSchema = (doc: any, name: string, value: unknown): string[] => { const s = doc.components?.schemas?.[name]; return s ? problems(doc, s, value) : [`no schema ${name}`]; };
