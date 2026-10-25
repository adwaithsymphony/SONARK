import { Loader2, ScanSearch, Trash, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { useEvents, useFiles, useGc, useHealth, useRepair, useScrub, useStatus, useTwin } from "../api/queries";
import type { ScrubSummary } from "../api/schemas";
import { findingTypeLabel, findings, scanHistory, type Finding, type Severity } from "../lib/integrity";
import { formatDateTime, formatTime } from "../lib/format";
import { useFindings } from "../state/findings";
import { NARROW_REASON, useNarrow } from "../lib/useNarrow";
import { useUi } from "../state/ui";
import { ConfirmDialog, Empty, ErrorPanel, KV, Outcome, Panel, cx } from "../components/common/ui";

const severityMeta: Record<Severity, { label: string; glyph: string; cls: string }> = {
  data_loss: { label: "Data loss", glyph: "✕", cls: "text-lost" },
  redundancy_reduced: { label: "Redundancy reduced", glyph: "▲", cls: "text-degraded" },
  unavailable: { label: "Unavailable", glyph: "↓", cls: "text-muted" },
};

export default function IntegrityView() {
  const scrub = useScrub();
  const repair = useRepair();
  const gc = useGc();
  const health = useHealth();
  const events = useEvents(true);
  const lastFinding = useFindings();
  const [confirm, setConfirm] = useState<"repair" | "gc" | null>(null);
  const busy = scrub.isPending || repair.isPending || gc.isPending;
  const narrow = useNarrow();
  const readOnly = (health.data?.read_only ?? false) || narrow;
  const history = useMemo(() => scanHistory(events.data?.events ?? []), [events.data]);
  const last = lastFinding.last;

  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <Panel title="Integrity scan">
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => scrub.mutate(undefined, { onSuccess: (result) => lastFinding.set({ kind: "scrub", at: Date.now(), result }) })}
          >
            {scrub.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <ScanSearch className="h-3.5 w-3.5" />}
            {scrub.isPending ? "Scanning… (waiting for the backend)" : "Start scan · all files"}
          </button>
          <label className="flex items-center gap-1 text-2xs text-faint" title="POST /api/scrub scans every file; the API has no file or node scope">
            Scope
            <select className="input py-0.5 text-2xs" value="all" disabled>
              <option value="all">all files</option>
              <option>by file: not supported by the API</option>
              <option>by node: not supported by the API</option>
            </select>
          </label>
          <span className="text-2xs text-muted">Read-only: fetches every shard and checks its SHA-256. Changes nothing.</span>
          <span className="ml-auto text-2xs text-faint">
            Last scan in the event log: {history[0] ? <span className="font-mono">{formatDateTime(history[0].ts)}</span> : "none recorded"}
          </span>
        </div>
        {scrub.isError && <div className="mt-2"><ErrorPanel compact error={scrub.error} /></div>}
      </Panel>

      {last ? (
        <FindingsPanel
          title={last.kind === "repair" ? "Findings from the repair pass" : "Findings from the last scan"}
          scan={last.result}
          at={last.at}
        />
      ) : (
        <Empty>No scan has been run from this page yet. Shard corruption is found only by a scan or a verified read.</Empty>
      )}

      <Panel title="Repair">
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-danger" disabled={busy || readOnly} onClick={() => setConfirm("repair")}>
            <Wrench className="h-3.5 w-3.5" /> Repair…
          </button>
          <RepairState pending={repair.isPending} error={repair.error} confirmed={!!repair.data} />
          <button className="btn-ghost ml-auto" disabled={busy || readOnly} onClick={() => setConfirm("gc")}>
            <Trash className="h-3.5 w-3.5" /> Garbage collect…
          </button>
        </div>
        {readOnly && <p className="mt-2 text-2xs text-degraded">{narrow ? NARROW_REASON : "The API is read-only; repair and GC are disabled."}</p>}
        {repair.isError && <div className="mt-2"><ErrorPanel compact error={repair.error} /></div>}
        {gc.isError && <div className="mt-2"><ErrorPanel compact error={gc.error} /></div>}
        {gc.data && (
          <p className="mt-2 font-mono text-2xs text-muted">
            GC (backend): {Object.entries(gc.data.removed).map(([n, c]) => `${n} removed ${c}`).join(" · ")}
          </p>
        )}
        {repair.data && (
          <dl className="mt-3 grid gap-x-6 text-xs sm:grid-cols-2">
            <KV k="Rebuilt (backend)">{repair.data.repaired} shard(s) · unrepaired {repair.data.unrepaired}</KV>
            <KV k="Redundancy after repair">
              {repair.data.after.shards_checked - repair.data.after.issues}/{repair.data.after.shards_checked} shards valid
              <span className="text-faint"> (verification scrub)</span>
            </KV>
            <KV k="Post-repair integrity">
              <Outcome value={repair.data.after.healthy} yes="healthy" no="issues remain" /> · {repair.data.after.lost_chunks.length} lost chunk(s)
            </KV>
          </dl>
        )}
      </Panel>

      <Panel title={`Scan history (${history.length}, from the event log)`}>
        {history.length === 0 ? (
          <Empty>No scans in the latest 200 events.</Empty>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-[0.1em] text-faint">
                <th className="py-1">Time</th>
                <th>Kind</th>
                <th className="text-right">Files</th>
                <th className="text-right">Shards</th>
                <th className="text-right">Issues</th>
                <th className="text-right">Repaired</th>
                <th className="text-right">Lost</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {history.slice(0, 20).map((h, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-0.5 text-faint">{formatDateTime(h.ts)}</td>
                  <td>{h.repair === null ? <span className="text-faint" title={h.raw}>unparsed</span> : h.repair ? "repair pass" : "scan"}</td>
                  <td className="text-right">{h.files ?? "—"}</td>
                  <td className="text-right">{h.shards ?? "—"}</td>
                  <td className={cx("text-right", h.issues ? "text-degraded" : "")}>{h.issues ?? "—"}</td>
                  <td className="text-right">{h.repaired ?? "—"}</td>
                  <td className={cx("text-right", h.lost ? "text-lost" : "")}>{h.lost ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <ConfirmDialog
        open={confirm === "repair"}
        title="Repair stored data?"
        confirmLabel="Repair"
        busy={repair.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          repair.mutate(undefined, {
            onSuccess: (result) => lastFinding.set({ kind: "repair", at: Date.now(), result }),
            onSettled: () => setConfirm(null),
          })
        }
      >
        <p>
          Repair rewrites bad shards on the nodes. It sends <code className="font-mono">{'{"confirm": true}'}</code>. Nothing is shown as repaired until the
          backend reports it.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "gc"}
        title="Delete orphan shards?"
        confirmLabel="Run GC"
        busy={gc.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => gc.mutate(undefined, { onSettled: () => setConfirm(null) })}
      >
        <p>Deletes shards that no file references. Shards still placed by metadata are kept.</p>
      </ConfirmDialog>
    </div>
  );
}

function RepairState({ pending, error, confirmed }: { pending: boolean; error: unknown; confirmed: boolean }) {
  const steps = [
    { label: "Requested", on: pending || confirmed || !!error },
    { label: "Running on the backend", on: pending },
    { label: error ? "Failed" : "Backend-confirmed", on: confirmed || !!error },
  ];
  return (
    <ol className="flex items-center gap-1 text-2xs" aria-label="Repair state">
      {steps.map((s, i) => (
        <li key={s.label} className={cx("chip", s.on ? (error && i === 2 ? "border-lost/60 text-lost" : "border-info/60 text-info") : "text-faint")}>
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

export function FindingsPanel({ title, scan, at }: { title: string; scan: ScrubSummary; at: number }) {
  const twin = useTwin(false);
  const status = useStatus();
  const files = useFiles();
  const ui = useUi();
  const list: Finding[] = useMemo(
    () => findings(scan, (fid, c) => twin.data?.files.find((f) => f.file_id === fid)?.stripes.find((s) => s.chunk_index === c), status.data),
    [scan, twin.data, status.data],
  );
  const name = (fid: string) => files.data?.files.find((f) => f.file_id === fid)?.name ?? fid.slice(0, 8);
  return (
    <Panel title={title} bodyClass="p-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-xs">
        <Outcome value={scan.healthy} yes="healthy" no="issues found" />
        <span>{scan.files_checked} files · {scan.shards_checked} shards checked</span>
        <span>{scan.issues} issue(s)</span>
        {scan.repaired > 0 && <span>{scan.repaired} rebuilt</span>}
        {scan.lost_chunks.length > 0 && <span className="text-lost">{scan.lost_chunks.length} lost chunk(s)</span>}
        <span className="ml-auto text-2xs text-faint">reported {formatTime(at)} (when this page received the backend's result)</span>
      </div>
      {list.length === 0 ? (
        <div className="p-3"><Empty>No findings.</Empty></div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="table-head px-3 py-1.5">File</th>
                <th className="table-head px-2 py-1.5">Stripe:shard</th>
                <th className="table-head px-2 py-1.5">Node</th>
                <th className="table-head px-2 py-1.5">Finding</th>
                <th className="table-head px-2 py-1.5">Severity</th>
                <th className="table-head px-2 py-1.5">What repair can accomplish</th>
                <th className="table-head px-2 py-1.5">Backend resolution</th>
              </tr>
            </thead>
            <tbody>
              {list.map((f, i) => (
                <tr
                  key={i}
                  className="row-hover align-top"
                  tabIndex={0}
                  onClick={() => {
                    ui.selectShard({ fileId: f.fileId, chunk: f.chunk, shard: f.shard });
                    ui.setInspectorOpen(true);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && ui.selectShard({ fileId: f.fileId, chunk: f.chunk, shard: f.shard })}
                >
                  <td className="border-b border-line px-3 py-1">{name(f.fileId)}</td>
                  <td className="border-b border-line px-2 py-1 font-mono">{f.chunk}:{f.shard}</td>
                  <td className="border-b border-line px-2 py-1 font-mono">{f.node}</td>
                  <td className="border-b border-line px-2 py-1">{findingTypeLabel(f.type)}</td>
                  <td className={cx("border-b border-line px-2 py-1 whitespace-nowrap", severityMeta[f.severity].cls)}>
                    {severityMeta[f.severity].glyph} {severityMeta[f.severity].label}
                  </td>
                  <td className="border-b border-line px-2 py-1 text-muted">{f.outlook}</td>
                  <td className="border-b border-line px-2 py-1 font-mono text-2xs">{f.resolution || <span className="text-faint">— (scan only)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {scan.issues > scan.details.length && (
        <p className="px-3 py-1 text-2xs text-faint">The backend returns the first {scan.details.length} of {scan.issues} issues.</p>
      )}
      {twin.data && <p className="px-3 py-1 text-2xs text-faint">Intact-shard counts from the verified Twin snapshot {formatTime(twin.data.snapshot.taken_at)}.</p>}
    </Panel>
  );
}
