// The API reference (2026-10-10): this instance's OpenAPI document, read live and laid out for a developer — an index of groups on the
// left, one card per operation on the right with the method, the path, who may call it, the parameters, the request body and the
// responses as readable skeletons. The raw document stays one link away for machines.
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { api, apiPath } from "../lib/api";
import { netName } from "../lib/network";
import { parseReference, refName, schemaId, skeleton, type NamedSchema, type Operation, type Reference as Ref, type Schema } from "../lib/openapi";
import { describeError, type Described } from "../lib/errors";

const HUE: Record<string, string> = { GET: "var(--mint)", POST: "var(--sky)", PUT: "var(--violet)", PATCH: "var(--violet)", DELETE: "var(--rose)" };
const hue = (m: string): CSSProperties => ({ "--m": HUE[m] ?? "var(--ink-2)" } as CSSProperties);

/** a referenced schema is a link to the schemas section (rendered once, below); one of several referenced schemas (a `oneOf` answer) is the links
 *  joined by "or"; an inline schema is shown as its skeleton */
function Shape({ doc, schema }: { doc: any; schema: Schema }) {
  const name = refName(schema);
  if (name) return <a className="schema-link" href={`#${schemaId(name)}`}>{name}</a>;
  const alternatives: Schema[] | null = Array.isArray(schema?.oneOf) ? schema.oneOf : Array.isArray(schema?.anyOf) ? schema.anyOf : null;
  const names = alternatives?.map((x) => refName(x));
  if (names && names.length > 0 && names.every((n) => n)) return <span className="schema-links">{names.map((n, i) => <span key={n}>{i > 0 && <span className="muted"> or </span>}<a className="schema-link" href={`#${schemaId(n!)}`}>{n}</a></span>)}</span>;
  return <pre className="skeleton">{skeleton(doc, schema)}</pre>;
}
function SchemaCard({ s, doc }: { s: NamedSchema; doc: any }) {
  return (
    <details id={s.id} className="schema">
      <summary><span className="schema-name">{s.name}</span><span className="schema-keys">{s.keys.slice(0, 9).join(" · ")}{s.keys.length > 9 ? " · …" : ""}</span></summary>
      {s.description && <p className="muted" style={{ margin: "10px 0" }}>{s.description}</p>}
      <pre className="skeleton">{skeleton(doc, s.schema)}</pre>
    </details>
  );
}
/** the first clause of a summary, for the collapsed row */
const brief = (s: string) => { const cut = s.split(/;| — /)[0].trim(); return cut.length > 110 ? `${cut.slice(0, 107).trimEnd()}…` : cut; };
function OperationCard({ op, doc, origin }: { op: Operation; doc: any; origin: string }) {
  const short = brief(op.summary);
  return (
    <details id={op.id} className="op" style={hue(op.method)}>
      <summary className="op-head">
        <span className="method">{op.method}</span>
        <code className="op-path">{op.path}</code>
        {op.secured ? <span className="chip info" title="send Authorization: Bearer <token> from POST /v1/session">bearer</span> : <span className="chip" title="no token needed">open</span>}
        {short && <span className="op-brief">{short}</span>}
      </summary>
      {op.summary && op.summary !== short && <p className="op-summary">{op.summary}</p>}
      {op.description && <p className="op-desc">{op.description}</p>}
      {op.parameters.length > 0 && (
        <table className="params"><thead><tr><th>Parameter</th><th>In</th><th>Type</th><th>Notes</th></tr></thead>
          <tbody>{op.parameters.map((p) => <tr key={`${p.in}-${p.name}`}><td><code>{p.name}</code>{p.required && <span className="req" title="required">*</span>}</td><td>{p.in}</td><td><code>{p.schema ? skeleton(doc, p.schema) : "string"}</code></td><td>{p.description}</td></tr>)}</tbody></table>
      )}
      {op.requestBody && <div className="op-block"><h4>Request body{op.requestRequired ? "" : " (optional)"}</h4><Shape doc={doc} schema={op.requestBody} /></div>}
      {op.responses.length > 0 && (
        <div className="op-block"><h4>Responses</h4>
          <ul className="responses">{op.responses.map((r) => <li key={r.status}><span className={`status s${r.status[0]}`}>{r.status}</span><div className="resp-body"><span>{r.description}</span>{r.schema && <Shape doc={doc} schema={r.schema} />}</div></li>)}</ul>
        </div>
      )}
      <p className="tiny dim op-url">{`${origin}${op.path}`}</p>
    </details>
  );
}

export default function Reference() {
  const { net, base = "", link = (to: string) => to } = useNet();
  const origin = `${(globalThis as { location?: { origin?: string } }).location?.origin ?? ""}${base}`;
  const [doc, setDoc] = useState<any>(null); const [err, setErr] = useState<Described | null>(null);
  useEffect(() => { let alive = true; setDoc(null); setErr(null); api.openapi().then((d) => { if (alive) setDoc(d); }).catch((e) => { if (alive) setErr(describeError(e)); }); return () => { alive = false; }; }, [base]);
  const ref: Ref | null = doc ? parseReference(doc) : null;
  // a link to an operation or a schema opens it: a closed <details> cannot be scrolled into view by the hash alone
  useEffect(() => {
    if (!doc) return;
    const open = () => { const hash = (globalThis as { location?: { hash?: string } }).location?.hash ?? ""; if (!/^#(op|schema)-/.test(hash)) return; const el = document.getElementById(hash.slice(1)) as HTMLDetailsElement | null; if (el) { el.open = true; el.scrollIntoView(); } };
    open(); const w = globalThis as { addEventListener?: Window["addEventListener"]; removeEventListener?: Window["removeEventListener"] };
    w.addEventListener?.("hashchange", open); return () => w.removeEventListener?.("hashchange", open);
  }, [doc]);
  return (
    <div className="ref-page">
      <section className="section" style={{ paddingBottom: 28 }}>
        <div className="container stack" style={{ gap: 16 }}>
          <p className="kicker">API reference · {netName(net?.network)}</p>
          <h1>Every route, as this instance serves it.</h1>
          <p className="lead">Read live from <code>{origin}/openapi.json</code>{ref ? ` — ${ref.operations} operations, release ${ref.version}` : ""}. Owned routes take <code>Authorization: Bearer</code> with the token from <code>POST /v1/session</code>; the rest need nothing.</p>
          <div className="row">
            <a href={apiPath("/openapi.json")} target="_blank" rel="noreferrer" className="btn sm">Raw document (JSON)</a>
            <Link to={link("/integrate")} className="btn sm ghost">How to use the API</Link>
          </div>
        </div>
      </section>
      <section className="section-tight">
        <div className="container">
          {err && <div className="banner bad" role="alert">The reference could not be read: {err.text}</div>}
          {!doc && !err && <p className="muted">Reading the document…</p>}
          {ref && (
            <div className="ref-layout">
              <nav className="ref-index" aria-label="routes">
                {ref.groups.map((g) => (
                  <div key={g.id} className="ref-index-group">
                    <a className="ref-index-title" href={`#group-${g.id}`}>{g.title}</a>
                    <ul>{g.operations.map((op) => <li key={op.id}><a href={`#${op.id}`}><span className="method sm" style={hue(op.method)}>{op.method}</span><code>{op.path.replace(/^\/v1/, "")}</code></a></li>)}</ul>
                  </div>
                ))}
                {ref.schemas.length > 0 && <div className="ref-index-group"><a className="ref-index-title" href="#schemas">Schemas</a><ul>{ref.schemas.map((s) => <li key={s.id}><a href={`#${s.id}`}><code>{s.name}</code></a></li>)}</ul></div>}
              </nav>
              <div className="ref-main">
                {ref.groups.map((g) => (
                  <section key={g.id} id={`group-${g.id}`} className="ref-group" tabIndex={-1}>
                    <div className="ref-group-head"><h2>{g.title}</h2>{g.blurb && <p className="muted">{g.blurb}</p>}</div>
                    {g.operations.map((op) => <OperationCard key={op.id} op={op} doc={doc} origin={origin} />)}
                  </section>
                ))}
                {ref.schemas.length > 0 && (
                  <section id="schemas" className="ref-group" tabIndex={-1}>
                    <div className="ref-group-head"><h2>Schemas</h2><p className="muted">The shapes the routes above refer to. Open one to read its keys and types.</p></div>
                    <div className="schemas">{ref.schemas.map((s) => <SchemaCard key={s.id} s={s} doc={doc} />)}</div>
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
