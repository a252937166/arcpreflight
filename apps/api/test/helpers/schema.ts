// A validator for the subset of JSON Schema the OpenAPI document uses (type, nullable, enum, const, properties/required, additionalProperties,
// items, minItems/maxItems, $ref, allOf/oneOf/anyOf). Returns the problems as "path: why" lines so a test can print them.
export function problems(doc: any, schema: any, value: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (typeof schema.$ref === "string") { const name = schema.$ref.replace("#/components/schemas/", ""); const target = doc.components?.schemas?.[name]; return target ? problems(doc, target, value, path) : [`${path}: unresolved ${schema.$ref}`]; }
  if (value === null) return schema.nullable ? [] : [`${path}: null where ${describe(schema)} was declared`];
  if (Array.isArray(schema.allOf)) return schema.allOf.flatMap((s: any) => problems(doc, s, value, path));
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) { const alts = schema.oneOf ?? schema.anyOf; return alts.some((s: any) => problems(doc, s, value, path).length === 0) ? [] : [`${path}: matches none of ${alts.length} alternatives`]; }
  if (schema.const !== undefined && value !== schema.const) return [`${path}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`];
  const t = schema.type;
  if (t === "string" && typeof value !== "string") return [`${path}: ${typeof value} where string was declared`];
  if (t === "boolean" && typeof value !== "boolean") return [`${path}: ${typeof value} where boolean was declared`];
  if ((t === "integer" || t === "number") && typeof value !== "number") return [`${path}: ${typeof value} where ${t} was declared`];
  if (t === "integer" && typeof value === "number" && !Number.isInteger(value)) return [`${path}: ${value} is not an integer`];
  if (t === "array") { if (!Array.isArray(value)) return [`${path}: ${typeof value} where array was declared`]; const out: string[] = []; if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`); if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`); return out.concat(value.flatMap((v, i) => problems(doc, schema.items, v, `${path}[${i}]`))); }
  if (t === "object" || schema.properties) {
    if (typeof value !== "object" || Array.isArray(value)) return [`${path}: ${Array.isArray(value) ? "array" : typeof value} where object was declared`];
    const v = value as Record<string, unknown>; const props = schema.properties ?? {}; const out: string[] = [];
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`${path}.${k}: required key missing`);
    for (const [k, s] of Object.entries<any>(props)) if (k in v) out.push(...problems(doc, s, v[k], `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in props)) out.push(`${path}.${k}: key not allowed`);
    return out;
  }
  return [];
}
const describe = (s: any) => s.$ref ?? (s.enum ? `one of ${s.enum.join("|")}` : s.type ?? "a value");
/** the schema of a route's response body */
export function responseSchema(doc: any, method: string, path: string, status: number | string): any {
  const r = doc.paths?.[path]?.[method.toLowerCase()]?.responses?.[String(status)]; return r?.content?.["application/json"]?.schema ?? null;
}
/** validate a real response body against the document: the problems, or [] */
export const check = (doc: any, method: string, path: string, status: number | string, body: unknown): string[] => { const s = responseSchema(doc, method, path, status); return s ? problems(doc, s, body) : [`${method} ${path} ${status}: no response schema`]; };
export const checkSchema = (doc: any, name: string, value: unknown): string[] => problems(doc, { $ref: `#/components/schemas/${name}` }, value);
