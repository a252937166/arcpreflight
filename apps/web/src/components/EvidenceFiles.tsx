// Published evidence files as folders (review of 2026-10-10): each folder is a collapsed group with its count and size, a passport and its
// anchors share one row, long folders grow eight rows at a time, and one filter narrows every folder at once. Paths stay exact in the link
// and the title; the row shows the file name only.
import { useMemo, useState } from "react";
import { filterEvidenceGroups, formatBytes, groupEvidenceFiles, limited, LIST_PAGE, type EvidenceFile } from "../lib/evidenceFiles";
import { ShowMore } from "./ShowMore";

export function EvidenceFiles({ files, href }: { files: EvidenceFile[]; href: (path: string) => string }) {
  const [filter, setFilter] = useState("");
  const [limits, setLimits] = useState<Record<string, number>>({}); // rows shown per folder
  const groups = useMemo(() => groupEvidenceFiles(files), [files]);
  const visible = useMemo(() => filterEvidenceGroups(groups, filter), [groups, filter]);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const matching = visible.reduce((n, g) => n + g.files, 0);
  if (files.length === 0) return <p className="dim small">none published</p>;
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="evidence-files">
      <div className="row between" style={{ alignItems: "baseline" }}>
        <span className="tiny dim">{`${files.length} files · ${formatBytes(total)} · ${groups.length} folder${groups.length === 1 ? "" : "s"}${filter ? ` · ${matching} match${matching === 1 ? "" : "es"}` : ""}`}</span>
        <input className="input mono" style={{ maxWidth: 260, padding: "6px 0", fontSize: "0.8rem" }} placeholder="filter · e.g. 2026-10-10 wallet" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="filter the published files" />
      </div>
      {visible.length === 0 ? <p className="dim small">{`no file matches "${filter}"`}</p> : visible.map((g) => {
        const limit = limits[g.dir] ?? LIST_PAGE; const { shown } = limited(g.rows, limit);
        return (
          <details key={g.dir} className="filegroup" open={!!filter || g.dir === ""} data-testid="evidence-folder" data-dir={g.dir}>
            <summary><span className="mono small">{g.label}</span><span className="tiny dim">{`${g.files} file${g.files === 1 ? "" : "s"} · ${formatBytes(g.bytes)}`}</span></summary>
            <div className="filelist" role="list">
              {shown.map((r) => (
                <div key={r.path} className="filerow" role="listitem">
                  <a className="name" href={href(r.path)} target="_blank" rel="noreferrer" title={r.path}>{r.name}</a>
                  <span className="size">{formatBytes(r.bytes)}</span>
                  <span className="extra">{r.anchors ? <a className="tiny" href={href(r.anchors.path)} target="_blank" rel="noreferrer" title={r.anchors.path}>anchors</a> : null}</span>
                </div>
              ))}
            </div>
            <ShowMore shown={shown.length} total={g.rows.length} onMore={() => setLimits((l) => ({ ...l, [g.dir]: limit + LIST_PAGE }))} noun="files" testId={`more:${g.dir || "root"}`} />
          </details>
        );
      })}
    </div>
  );
}
