import { useMemo, useState } from "react";
import { usePreview, useStatus, useTwin } from "../api/queries";
import type { FileAnalysis, PreviewStripe, ScenarioPreview, StripeReport } from "../api/schemas";
import { formatTime } from "../lib/format";
import { classifyPreviewFile, explainStripe, outcomeMeta, samePlacement } from "../lib/outcomes";
import { shardStatusMeta } from "../lib/status";
import { useUi } from "../state/ui";
import { Empty, ErrorPanel, FileStatusBadge, KV, Loading, cx } from "../components/common/ui";

const PAGE = 200;

/**
 * Precise per-stripe view, shown in the bottom dock. Actual shard states come
 * from the verified Twin (`/api/twin?shards=true`). Hypothetical outcomes come
 * from the preview response; the only client-side step is marking which valid
 * shards sit on a proposed node, which is the backend's own failure model.
 */
export default function StripeMatrix() {
  const ui = useUi();
  const twin = useTwin(true);
  const status = useStatus();
  const sig = useMemo(
    () => (status.data?.nodes.map((n) => `${n.node_id}:${n.up ? 1 : 0}`).join(",") ?? "") + "|" + (twin.data?.snapshot.fingerprint ?? ""),
    [status.data, twin.data],
  );
  const preview = usePreview(ui.hypothetical, sig);
  const [limit, setLimit] = useState(PAGE);

  if (!twin.data && ui.experiment.phase === "running")
    return (
      <div role="status" className="p-3 text-xs text-experiment">
        ACTUAL — CLUSTER MODIFIED · experiment running. No verified snapshot was loaded before the run, and shard states are not observed until it returns.
      </div>
    );
  if (twin.isLoading) return <div className="p-3"><Loading label="Verifying every shard" /></div>;
  if (!twin.data) return <div className="p-3"><ErrorPanel error={twin.error} onRetry={() => void twin.refetch()} /></div>;
  const files = twin.data.files;
  if (files.length === 0) return <div className="p-3"><Empty>No files stored yet. Upload one in the Storage Explorer.</Empty></div>;

  // While a real experiment runs, the preview no longer describes anything and the
  // Twin snapshot predates the run, so neither may be shown as current state.
  const expRunning = ui.experiment.phase === "running";
  const hypo = new Set(expRunning ? [] : ui.hypothetical);
  const previewReady = !expRunning && !!preview.data && preview.settled && preview.data.nodes.join(",") === ui.hypothetical.join(",") && hypo.size > 0;
  const p: ScenarioPreview | undefined = previewReady ? preview.data : undefined;
  // Default to the selected file, else the first file the preview affects.
  const file = files.find((f) => f.file_id === ui.selectedFile) ?? files.find((f) => p?.files.some((x) => x.file_id === f.file_id)) ?? files[0]!;
  const pFile = p?.files.find((f) => f.file_id === file.file_id);
  const pStripes = new Map<number, PreviewStripe>((pFile?.stripes ?? []).map((s) => [s.chunk_index, s]));
  const maxN = Math.max(...file.stripes.map((s) => s.n), 0);
  const selected = file.stripes.find((s) => s.chunk_index === ui.selectedStripe) ?? null;
  const same = samePlacement(p, twin.data);
  const outcome = p ? (pFile ? classifyPreviewFile(pFile, file).outcome : "unaffected") : null;

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
          <label className="label" htmlFor="matrix-file">File</label>
          <select
            id="matrix-file"
            className="input py-0.5 text-xs"
            value={file.file_id}
            onChange={(e) => {
              ui.selectFile(e.target.value);
              setLimit(PAGE);
            }}
          >
            {files.map((f) => (
              <option key={f.file_id} value={f.file_id}>
                {f.name} ({f.coding.join(",")}, {f.stripe_count} stripes)
              </option>
            ))}
          </select>
          <FileStatusBadge status={file.status} />
          {hypo.size > 0 && (
            <span className="chip border-dashed border-preview text-preview">
              PREVIEW {ui.hypothetical.join(", ")}
              {!previewReady && " · waiting for backend"}
            </span>
          )}
          {outcome && (
            <span className={cx("text-2xs", outcomeMeta[outcome].cls)} title={outcomeMeta[outcome].help}>
              {outcomeMeta[outcome].glyph} {outcomeMeta[outcome].label}
            </span>
          )}
          <span className="ml-auto text-2xs text-faint">verified snapshot {formatTime(twin.data.snapshot.taken_at)}</span>
        </div>
        {expRunning && (
          <div role="status" className="border-b border-experiment/60 bg-experiment/10 px-3 py-1 text-2xs text-experiment">
            ACTUAL — CLUSTER MODIFIED · experiment running. This table is the snapshot taken before the run ({formatTime(twin.data.snapshot.taken_at)}), not current
            state. The preview is hidden; shard states are not observed until the run returns.
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="table-head px-2 py-1">Stripe</th>
                {Array.from({ length: maxN }, (_, i) => (
                  <th key={i} className="table-head px-1 py-1 text-center">
                    shard {i}
                  </th>
                ))}
                <th className="table-head px-2 py-1 text-right">Now · valid / k</th>
                <th className="table-head px-2 py-1 text-right">If failed · valid / k</th>
              </tr>
            </thead>
            <tbody>
              {file.stripes.slice(0, limit).map((st) => (
                <MatrixRow
                  key={st.chunk_index}
                  st={st}
                  maxN={maxN}
                  hypo={hypo}
                  p={pStripes.get(st.chunk_index)}
                  previewReady={previewReady}
                  selected={ui.selectedStripe === st.chunk_index}
                  onSelect={() => {
                    if (ui.selectedFile !== file.file_id) ui.selectFile(file.file_id);
                    ui.selectStripe(st.chunk_index);
                  }}
                  onShard={(i) => ui.selectShard({ fileId: file.file_id, chunk: st.chunk_index, shard: i })}
                  stale={expRunning}
                />
              ))}
            </tbody>
          </table>
          {file.stripes.length > limit && (
            <div className="p-2">
              <button className="btn-ghost" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, file.stripes.length - limit)} more of {file.stripes.length - limit} remaining stripes
              </button>
            </div>
          )}
        </div>
        <MatrixLegend />
      </div>
      <div className="w-full shrink-0 overflow-auto border-line p-2 max-lg:border-t lg:w-96 lg:border-l">
        <StripeExplanation file={file} st={selected} p={selected ? pStripes.get(selected.chunk_index) : undefined} previewReady={previewReady} same={same} />
      </div>
    </div>
  );
}

function MatrixRow({
  st,
  maxN,
  hypo,
  p,
  previewReady,
  selected,
  onSelect,
  onShard,
  stale,
}: {
  st: StripeReport;
  maxN: number;
  hypo: Set<string>;
  p: PreviewStripe | undefined;
  previewReady: boolean;
  selected: boolean;
  onSelect: () => void;
  onShard: (i: number) => void;
  stale: boolean;
}) {
  const shards = [...(st.shards ?? [])].sort((a, b) => a.shard_index - b.shard_index);
  return (
    <tr
      className={cx("row-hover", selected && "bg-raised", stale && "opacity-50")}
      onClick={onSelect}
      tabIndex={0}
      aria-selected={selected}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect())}
    >
      <td className="border-b border-line px-2 py-0.5 font-mono text-muted">#{st.chunk_index}</td>
      {Array.from({ length: maxN }, (_, i) => {
        const s = shards.find((x) => x.shard_index === i);
        if (!s) return <td key={i} className="border-b border-line" />;
        const meta = shardStatusMeta[s.status];
        const hypoLost = meta.valid && hypo.has(s.node_id) && previewReady;
        return (
          <td key={i} className="border-b border-line px-0.5 py-0.5 text-center">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onShard(i);
              }}
              aria-label={`Shard ${st.chunk_index}:${i} on ${s.node_id}, ${meta.label}`}
              className={cx(
                "inline-flex min-w-[3.4rem] items-center justify-center gap-1 rounded-sm border px-1 font-mono text-2xs hover:brightness-125",
                hypoLost ? "border-dashed border-preview bg-preview/10 text-preview" : "",
              )}
              style={hypoLost ? undefined : { borderColor: `${meta.color}55`, color: meta.color, background: `${meta.color}12` }}
              title={`shard ${i} on ${s.node_id}: ${meta.label}${hypoLost ? " · lost if the proposed nodes fail (PREVIEW)" : ""}${i >= st.k ? " · parity" : " · data"}`}
            >
              {hypoLost ? "◌" : meta.glyph} {s.node_id}
            </button>
          </td>
        );
      })}
      <td className={cx("border-b border-line px-2 py-0.5 text-right font-mono", st.recoverable ? "text-ink" : "text-lost")}>
        {st.valid} / {st.k} {st.recoverable ? "✓" : "✕"}
      </td>
      <td className="border-b border-line px-2 py-0.5 text-right font-mono">
        {!previewReady ? (
          <span className="text-faint">—</span>
        ) : p ? (
          <span className={p.recoverable_after ? "text-preview" : "text-lost"}>
            {p.valid_after} / {p.k} {p.recoverable_after ? "✓" : "✕ LOST"}
          </span>
        ) : (
          <span className="text-faint">unaffected</span>
        )}
      </td>
    </tr>
  );
}

function StripeExplanation({
  file,
  st,
  p,
  previewReady,
  same,
}: {
  file: FileAnalysis;
  st: StripeReport | null;
  p: PreviewStripe | undefined;
  previewReady: boolean;
  same: boolean;
}) {
  if (!st)
    return (
      <div className="space-y-1 text-xs">
        <div className="label">Why</div>
        <p className="text-muted">Select a stripe row to see why it is or is not recoverable. Reconstruction needs any k of n shards.</p>
        <p className="text-2xs text-faint">{file.explanation}</p>
      </div>
    );
  const why = p ? explainStripe(file.name, p, st, same) : null;
  return (
    <div className="space-y-2 text-xs">
      <div>
        <div className="label mb-0.5">Stripe {st.chunk_index} · LIVE</div>
        <p className={st.recoverable ? "text-ink" : "text-lost"}>
          Stripe {st.chunk_index} of {file.name} has {st.valid} valid shard{st.valid === 1 ? "" : "s"} of {st.n}; {st.k} {st.k === 1 ? "is" : "are"}{" "}
          required to reconstruct.
        </p>
        <p className="font-mono text-2xs text-faint">
          {st.valid} ≥ {st.k}? {st.recoverable ? `yes → recoverable with ${st.margin} to spare` : "no → not recoverable"}
        </p>
        <dl className="mt-1 text-2xs">
          <KV k="Coding">{st.k}+{st.m} (n={st.n})</KV>
          <KV k="Fewest node failures to lose it">{st.min_node_failures_to_lose ?? "—"}</KV>
          <KV k="Valid shards per node" mono>
            {Object.entries(st.valid_shards_per_node).map(([n, c]) => `${n}×${c}`).join("  ") || "—"}
          </KV>
        </dl>
      </div>
      {previewReady && (
        <div className="hypo rounded-sm p-2">
          <div className="label mb-0.5 text-preview">If the proposed nodes fail · PREVIEW</div>
          {why ? (
            <>
              <p className={why.recoverable ? "text-ink" : "text-lost"}>{why.headline}</p>
              {why.placement ? (
                <p className="text-muted">{why.placement}</p>
              ) : (
                <p className="text-2xs text-faint">Shard indices: not shown (the Twin snapshot is not the one this preview used).</p>
              )}
              <p className="font-mono text-2xs text-faint">{why.arithmetic}</p>
            </>
          ) : (
            <p className="text-muted">
              Unaffected: none of this stripe's valid shards are on the proposed nodes, so it keeps {st.valid} / {st.k}.
            </p>
          )}
          <p className="mt-1 text-2xs text-faint">Hypothetical. No node has been stopped.</p>
        </div>
      )}
    </div>
  );
}

function MatrixLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1 text-2xs text-muted">
      {(Object.keys(shardStatusMeta) as (keyof typeof shardStatusMeta)[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span style={{ color: shardStatusMeta[k].color }}>{shardStatusMeta[k].glyph}</span>
          {k}
        </span>
      ))}
      <span className="inline-flex items-center gap-1 text-preview">
        <span className="rounded-sm border border-dashed border-preview px-1">◌</span> lost-hypothetical (preview only)
      </span>
      <span className="text-faint">shards 0…k−1 are data, the rest parity</span>
    </div>
  );
}
