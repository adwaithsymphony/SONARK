import { Check, Copy, Link2, Map as MapIcon, Table2, X } from "lucide-react";
import { useState } from "react";
import { useEvents, useFileDetail, useTwin } from "../../api/queries";
import type { SonarkEvent } from "../../api/schemas";
import { formatDateTime, formatTime } from "../../lib/format";
import { shardStatusMeta } from "../../lib/status";
import { useUi, type ShardRef } from "../../state/ui";
import { Empty, ErrorPanel, KV, Loading, Panel } from "../common/ui";

/** Same naming scheme as sonark/metadata.py shard_id(). */
export const shardId = (fileId: string, chunk: number, shard: number) =>
  `${fileId}-${String(chunk).padStart(6, "0")}-${String(shard).padStart(3, "0")}`;

export function eventRunId(e: SonarkEvent): string | null {
  const d = e.detail as { run_id?: unknown } | null;
  return d && typeof d === "object" && typeof d.run_id === "string" ? d.run_id : null;
}

export function eventNodes(e: SonarkEvent): string[] {
  const d = e.detail as { nodes?: unknown } | null;
  const fromDetail = d && typeof d === "object" && Array.isArray(d.nodes) ? (d.nodes as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return [...new Set([...(e.node_id ? [e.node_id] : []), ...fromDetail])];
}

/** Shard inspector (spec 5.2 "Select a shard"). State comes from a verified snapshot. */
export function ShardInspector({ s }: { s: ShardRef }) {
  const ui = useUi();
  const detail = useFileDetail(s.fileId, true);
  const twin = useTwin(false);
  const twinFile = twin.data?.files.find((f) => f.file_id === s.fileId);
  const analysis = detail.data?.protection ?? twinFile;
  const stripe = analysis?.stripes.find((x) => x.chunk_index === s.chunk);
  const shard = stripe?.shards?.find((x) => x.shard_index === s.shard);
  const source = detail.data ? `verified file detail · ${formatTime(detail.dataUpdatedAt)}` : twinFile ? `verified Twin · ${formatTime(twin.data!.snapshot.taken_at)}` : null;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="label">Shard</div>
          <div className="font-mono text-lg text-ink">
            {s.chunk}:{s.shard}
          </div>
          <div className="truncate text-xs text-muted">{analysis?.name ?? s.fileId}</div>
        </div>
        <button className="icon-btn" aria-label="Close shard" onClick={() => ui.selectShard(null)}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {!analysis && (detail.isLoading ? <Loading label="Verifying this file's shards" /> : <ErrorPanel error={detail.error} />)}
      {analysis && !shard && <Empty>This shard is not in the current placement (the file may have changed).</Empty>}
      {analysis && stripe && shard && (
        <>
          <dl>
            <KV k="File" mono>{s.fileId}</KV>
            <KV k="Stripe">{s.chunk} · {stripe.k}+{stripe.m}</KV>
            <KV k="Index">
              {s.shard} · {s.shard < stripe.k ? "data shard" : "parity shard"}
            </KV>
            <KV k="Host node">
              <button className="font-mono text-live hover:underline" onClick={() => ui.selectNode(shard.node_id)}>
                {shard.node_id}
              </button>
            </KV>
            <KV k="State">
              <span style={{ color: shardStatusMeta[shard.status].color }}>
                {shardStatusMeta[shard.status].glyph} {shardStatusMeta[shard.status].label}
              </span>
            </KV>
            <KV k="Validity">{shardStatusMeta[shard.status].valid ? "counts towards the k needed" : "does not count towards k"}</KV>
            <KV k="Shard ID" mono>{shardId(s.fileId, s.chunk, s.shard)}</KV>
            <KV k="Checksum">
              <span className="text-faint">not reported: the API does not expose per-shard SHA-256 (it is checked server-side)</span>
            </KV>
            <KV k="Source">{source}</KV>
          </dl>
          <Panel title="Its stripe">
            <p className="text-xs">
              {stripe.valid} valid of {stripe.n}; {stripe.k} required. {stripe.valid >= stripe.k ? `${stripe.margin} to spare.` : "Not recoverable."}
            </p>
          </Panel>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => { ui.setView("cluster"); ui.selectFile(s.fileId); }}>
              <MapIcon className="h-3.5 w-3.5" /> Show file on stage
            </button>
            <button className="btn-ghost" onClick={() => { ui.selectShard(s); ui.openMatrix(); }}>
              <Table2 className="h-3.5 w-3.5" /> Stripe matrix
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Event detail (spec 6.I): full payload, linked entities, related events. */
export function EventInspector({ e }: { e: SonarkEvent }) {
  const ui = useUi();
  const [copied, setCopied] = useState(false);
  const run = eventRunId(e);
  const nodes = eventNodes(e);
  const payload = JSON.stringify(e, null, 2);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="label">Event</div>
          <div className="font-mono text-lg text-ink">{e.kind}</div>
          <div className="font-mono text-2xs text-faint">{formatDateTime(e.ts)}</div>
        </div>
        <button className="icon-btn" aria-label="Close event" onClick={() => ui.selectEvent(null)}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <dl>
        <KV k="Operation ID">
          {run ? (
            <button className="font-mono text-experiment hover:underline" onClick={() => { ui.selectRun(run); ui.setView("lab"); }}>
              {run}
            </button>
          ) : (
            <span className="text-faint">not reported (only scenario events carry a run id)</span>
          )}
        </KV>
        <KV k="Nodes">
          {nodes.length ? nodes.map((n) => (
            <button key={n} className="mr-2 font-mono text-live hover:underline" onClick={() => ui.selectNode(n)}>{n}</button>
          )) : <span className="text-faint">—</span>}
        </KV>
        <KV k="File">
          {e.file_id ? (
            <button className="font-mono text-live hover:underline" onClick={() => ui.selectFile(e.file_id)}>{e.file_id.slice(0, 12)}</button>
          ) : (
            <span className="text-faint">—</span>
          )}
        </KV>
        <KV k="Chunk / shard">
          {e.file_id && e.chunk_index !== null && e.shard_index !== null ? (
            <button className="font-mono text-live hover:underline" onClick={() => ui.selectShard({ fileId: e.file_id!, chunk: e.chunk_index!, shard: e.shard_index! })}>
              {e.chunk_index}:{e.shard_index}
            </button>
          ) : (
            <span className="font-mono text-faint">{e.chunk_index ?? "—"}/{e.shard_index ?? "—"}</span>
          )}
        </KV>
      </dl>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="label">Full payload</span>
          <button
            className="btn-ghost ml-auto py-0.5"
            onClick={() => void navigator.clipboard?.writeText(payload).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy JSON
          </button>
        </div>
        <pre className="max-h-72 overflow-auto rounded-sm border border-line bg-bg p-2 font-mono text-2xs text-ink">{payload}</pre>
      </div>
      <div className="flex flex-wrap gap-2">
        {(e.file_id || nodes[0] || run) && (
          <button
            className="btn-ghost"
            onClick={() => {
              ui.setEventFilter(run ?? e.file_id ?? nodes[0] ?? "");
              ui.setView("events");
            }}
          >
            <Link2 className="h-3.5 w-3.5" /> Show related events
          </button>
        )}
      </div>
    </div>
  );
}

/** Event rows that mention a node or file, newest first (the latest 200 the API returns). */
export function RelatedEventList({ match, empty }: { match: (e: SonarkEvent) => boolean; empty: string }) {
  const events = useEvents(false);
  const ui = useUi();
  if (!events.data) return events.isError ? <ErrorPanel compact error={events.error} /> : <Loading />;
  const rows = events.data.events.filter(match).slice(0, 12);
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="space-y-px font-mono text-2xs">
      {rows.map((e, i) => (
        <li key={i}>
          <button className="grid w-full grid-cols-[7.5rem_7rem_1fr] gap-2 rounded-sm px-1 text-left hover:bg-raised" onClick={() => ui.selectEvent(e)}>
            <span className="text-faint">{formatDateTime(e.ts).slice(5)}</span>
            <span className="text-ink">{e.kind}</span>
            <span className="truncate text-muted">{typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Client-side export of the events currently loaded and filtered on this page. */
export function exportEvents(rows: SonarkEvent[], format: "json" | "csv") {
  const stamp = new Date().toISOString();
  let text: string;
  if (format === "json") {
    text = JSON.stringify({ exported_by: "SONARK frontend (GET /api/events, filtered in the browser)", exported_at: stamp, events: rows }, null, 2);
  } else {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cols = ["ts", "kind", "node_id", "file_id", "chunk_index", "shard_index", "detail"] as const;
    text = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
  }
  const url = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json" : "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `sonark-events-${stamp.replace(/[:.]/g, "-")}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return text;
}
