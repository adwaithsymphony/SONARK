import { Download, Map as MapIcon, PanelRightClose, Play, Power, RefreshCw, Trash2, Waves, X } from "lucide-react";
import { useState } from "react";
import { useDeleteFile, useFileDetail, useFiles, useHealth, useNodeStart, useNodeStop, useStatus, useTwin } from "../../api/queries";
import type { FileStatus } from "../../api/schemas";
import { downloadAndVerify, type DownloadCheck } from "../../lib/download";
import { formatBytes, formatDateTime, formatTime, plural, formatTolerance } from "../../lib/format";
import { fileStatusMeta, nodeState, nodeStateMeta } from "../../lib/status";
import { useUi } from "../../state/ui";
import { ConfirmDialog, Empty, ErrorPanel, FileStatusBadge, Freshness, Hash, KV, Loading, Outcome, Panel, cx } from "../common/ui";
import TwinPanel from "../../views/TwinPanel";
import { NARROW_REASON, useNarrow } from "../../lib/useNarrow";
import { EventInspector, RelatedEventList, ShardInspector, eventNodes } from "./DetailInspectors";

export default function Inspector() {
  const ui = useUi();
  if (!ui.inspectorOpen) return null;
  let body;
  let title;
  if (ui.view === "twin") {
    title = "Survival Twin";
    body = (
      <>
        {ui.selectedShard && (
          <div className="mb-3 rounded-md border border-info/40 p-2">
            <ShardInspector s={ui.selectedShard} />
          </div>
        )}
        <TwinPanel />
      </>
    );
  } else if (ui.selectedEvent && ui.focus === "event") {
    title = "Event";
    body = <EventInspector e={ui.selectedEvent} />;
  } else if (ui.selectedShard && ui.focus === "shard") {
    title = "Shard";
    body = <ShardInspector s={ui.selectedShard} />;
  } else if (ui.selectedNode && ui.focus === "node") {
    title = "Node";
    body = <NodeInspector nodeId={ui.selectedNode} />;
  } else if (ui.selectedFile) {
    title = "File";
    body = <FileInspector fileId={ui.selectedFile} />;
  } else if (ui.selectedNode) {
    title = "Node";
    body = <NodeInspector nodeId={ui.selectedNode} />;
  } else {
    title = "Cluster";
    body = <ClusterSummary />;
  }
  return (
    <aside aria-label="Inspector" className={cx(
        "flex max-w-[100vw] shrink-0 flex-col border-l border-line bg-surface",
        ui.view === "twin" ? "w-[27.5rem]" : "w-[22.5rem]",
        // spec 4.1: below 1280 px the inspector is a slide-over drawer
        "max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-40 max-xl:shadow-2xl",
      )}>
      <div className="flex h-9 items-center gap-2 border-b border-line px-3">
        <span className="label">{title}</span>
        <div className="ml-auto flex items-center gap-1">
          {(ui.selectedFile || ui.selectedNode || ui.selectedShard || ui.selectedEvent) && ui.view !== "twin" && (
            <button className="icon-btn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => ui.clearSelection()}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <button className="icon-btn" aria-label="Collapse inspector" title="Collapse inspector" onClick={() => ui.setInspectorOpen(false)}>
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

export function ClusterSummary() {
  const status = useStatus();
  const files = useFiles();
  const twin = useTwin(false);
  const ui = useUi();
  if (status.isLoading) return <Loading label="Reading cluster status" />;
  if (!status.data) return <ErrorPanel error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  const down = s.nodes.filter((n) => !n.up);
  const counts: Record<FileStatus | "unknown", number> = { healthy: 0, degraded: 0, at_risk: 0, lost: 0, unknown: 0 };
  for (const f of files.data?.files ?? []) counts[f.status ?? "unknown"]++;
  const attention = (files.data?.files ?? [])
    .filter((f) => f.status && f.status !== "healthy")
    .sort((a, b) => fileStatusMeta[a.status!].rank - fileStatusMeta[b.status!].rank);

  return (
    <div className="space-y-3">
      {!ui.introSeen && (
        <div className="border-b border-line pb-3">
          <p className="editorial text-2xl leading-8">Can this storage be trusted?</p>
          <p className="mt-1 text-xs text-muted">
            Survival Twin predicts which node failures each file survives, then proves it with a real, confirmed experiment.
          </p>
          <button
            className="btn-primary mt-2"
            onClick={() => {
              ui.dismissIntro();
              ui.setView("twin");
            }}
          >
            <Waves className="h-3.5 w-3.5" /> Open Survival Twin
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className={cx("text-lg font-semibold", down.length ? "text-down" : "text-live")}>
          {status.isError && <span className="text-sm font-normal text-degraded">last seen: </span>}
          {s.nodes_up}/{s.nodes.length} nodes up
        </div>
        <Freshness updatedAt={status.dataUpdatedAt} isError={status.isError} isFetching={status.isFetching} />
      </div>
      <div className="text-sm text-muted">
        Default coding {s.k}+{s.m} · {plural(s.files, "file")} · {formatBytes(s.bytes)} stored
      </div>
      {down.length > 0 && (
        <div className="rounded border border-down/40 bg-down/5 p-2 text-sm">
          <span className="text-down">Offline:</span>{" "}
          {down.map((n) => (
            <button key={n.node_id} className="mr-2 font-mono text-ink underline-offset-2 hover:underline" onClick={() => ui.selectNode(n.node_id)}>
              {n.node_id}
            </button>
          ))}
        </div>
      )}

      <Panel title={`Needs attention (${attention.length + down.length})`}>
        {attention.length === 0 && down.length === 0 ? (
          <Empty>Nothing reported. All nodes answered and every file is healthy by the fast check.</Empty>
        ) : (
          <ul className="space-y-1">
            {attention.map((f) => (
              <li key={f.file_id}>
                <button className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-raised" onClick={() => ui.selectFile(f.file_id)}>
                  <FileStatusBadge status={f.status} />
                  <span className="truncate">{f.name}</span>
                  <span className="ml-auto font-mono text-2xs text-faint">tol {formatTolerance(f.fault_tolerance, true)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Protection (fast, unverified)" actions={<Freshness updatedAt={files.dataUpdatedAt} isError={files.isError} />}>
        {files.data ? (
          <>
            <div className="flex h-2 overflow-hidden rounded bg-bg" aria-hidden>
              {(["lost", "at_risk", "degraded", "healthy"] as const).map((k) =>
                counts[k] ? <div key={k} style={{ flex: counts[k], background: fileStatusMeta[k].color }} /> : null,
              )}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 text-sm">
              {(["healthy", "degraded", "at_risk", "lost"] as const).map((k) => (
                <KV key={k} k={<span className={fileStatusMeta[k].cls}>{fileStatusMeta[k].label}</span>}>
                  {counts[k]}
                </KV>
              ))}
            </dl>
            <p className="mt-2 text-2xs text-faint">
              From <code>/api/files</code>: node health only, shard hashes not checked. Corruption that no scrub has found yet is not
              visible here.
            </p>
          </>
        ) : files.isError ? (
          <ErrorPanel compact error={files.error} />
        ) : (
          <Loading />
        )}
      </Panel>

      <Panel title="Verified survivability" actions={<Freshness updatedAt={twin.dataUpdatedAt} isError={twin.isError} />}>
        {twin.data ? (
          <div className="space-y-1 text-sm">
            <KV k="Cluster tolerance">
              {twin.data.summary.cluster_fault_tolerance === null
                ? "— (no files)"
                : twin.data.summary.cluster_fault_tolerance < 0
                  ? "none: at least one file is already unrecoverable"
                  : `survives ${formatTolerance(twin.data.summary.cluster_fault_tolerance)}`}
            </KV>
            <KV k="Recoverable">
              {twin.data.summary.recoverable_files}/{twin.data.summary.files}
            </KV>
            <KV k="Snapshot">{formatTime(twin.data.snapshot.taken_at)} · hash-verified</KV>
            <button className="btn-ghost mt-1" onClick={() => ui.setView("twin")}>
              <Waves className="h-3.5 w-3.5" /> Open Survival Twin
            </button>
          </div>
        ) : twin.isFetching ? (
          <Loading label="Verifying every shard" />
        ) : twin.isError ? (
          <ErrorPanel compact error={twin.error} onRetry={() => void twin.refetch()} />
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-muted">
              Not run yet. A verified check reads and hashes every shard, and the API does nothing else while it runs, so it is not run
              automatically here.
            </p>
            <button className="btn-ghost" onClick={() => void twin.refetch()}>
              Verify now
            </button>
          </div>
        )}
      </Panel>

    </div>
  );
}

// ---------------------------------------------------------------------------

export function NodeInspector({ nodeId }: { nodeId: string }) {
  const status = useStatus();
  const health = useHealth();
  const twin = useTwin(false);
  const stop = useNodeStop();
  const start = useNodeStart();
  const ui = useUi();
  const [confirming, setConfirming] = useState(false);
  const n = status.data?.nodes.find((x) => x.node_id === nodeId);
  if (!status.data) return status.isError ? <ErrorPanel error={status.error} /> : <Loading />;
  if (!n) return <Empty>Node {nodeId} is not in the cluster status.</Empty>;
  const st = nodeState(n);
  const control = health.data?.node_control ?? false;
  const narrow = useNarrow();
  const readOnly = (health.data?.read_only ?? false) || narrow;
  const filesHere = (twin.data?.files ?? [])
    .map((f) => ({ f, count: f.stripes.reduce((a, s) => a + (s.valid_shards_per_node[nodeId] ?? 0), 0) }))
    .filter((x) => x.count > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-lg text-ink">{n.node_id}</span>
        <span className={cx("chip", nodeStateMeta[st].cls)}>{nodeStateMeta[st].label}</span>
        <span className="ml-auto">
          <Freshness updatedAt={status.dataUpdatedAt} isError={status.isError} />
        </span>
      </div>
      <dl>
        <KV k="URL" mono>{n.url}</KV>
        <KV k="Shards (metadata)">{n.shards}</KV>
        <KV k="Managed">{n.managed ? "yes — this server started it" : "no — cannot be stopped from the API"}</KV>
        <KV k="Process">{n.running === null ? "— (server has no node control)" : n.running ? `running · pid ${n.pid ?? "—"}` : "not running"}</KV>
      </dl>

      <dl>
        <KV k="Capacity used"><span className="text-faint">not reported by the API</span></KV>
        <KV k="Last heartbeat"><span className="text-faint">not reported (health is probed on each request)</span></KV>
      </dl>

      <Panel title="State history (event log)">
        <RelatedEventList
          match={(e) => eventNodes(e).includes(nodeId)}
          empty="No events mention this node in the latest 200."
        />
      </Panel>

      <Panel title="Valid shards held, by file">
        {twin.data ? (
          filesHere.length ? (
            <ul className="space-y-0.5 text-sm">
              {filesHere.map(({ f, count }) => (
                <li key={f.file_id}>
                  <button className="flex w-full gap-2 rounded px-1 text-left hover:bg-raised" onClick={() => ui.selectFile(f.file_id)}>
                    <span className="truncate">{f.name}</span>
                    <span className="ml-auto font-mono text-2xs text-muted">{count}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No valid shards on this node in the last verified snapshot.</Empty>
          )
        ) : (
          <Empty>Load the Survival Twin to see per-file placement (it reads every shard).</Empty>
        )}
        {twin.data && <p className="mt-1 text-2xs text-faint">Verified snapshot {formatTime(twin.data.snapshot.taken_at)}</p>}
      </Panel>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn-preview"
          onClick={() => {
            ui.setHypothetical([...ui.hypothetical, n.node_id]);
            ui.setView("twin");
          }}
        >
          <Waves className="h-3.5 w-3.5" /> What if {n.node_id} fails?
        </button>
        {n.managed && n.running && (
          <button className="btn-danger" disabled={!control || readOnly || stop.isPending} onClick={() => setConfirming(true)}>
            <Power className="h-3.5 w-3.5" /> Stop node
          </button>
        )}
        {n.managed && n.running === false && (
          <button className="btn-primary" disabled={readOnly || start.isPending} onClick={() => start.mutate(n.node_id)}>
            <Play className="h-3.5 w-3.5" /> {start.isPending ? "Starting…" : "Start node"}
          </button>
        )}
      </div>
      {!n.managed && <p className="text-2xs text-faint">Only nodes started by <code>serve --manage</code> can be stopped or started here.</p>}
      {stop.isError && <ErrorPanel compact error={stop.error} />}
      {start.isError && <ErrorPanel compact error={start.error} />}
      {stop.isSuccess && <p className="text-sm text-muted">Backend confirmed: {stop.data.node_id} running = {String(stop.data.running)}.</p>}
      {start.isSuccess && <p className="text-sm text-muted">Backend confirmed: {start.data.node_id} running = {String(start.data.running)}.</p>}

      <ConfirmDialog
        open={confirming}
        title={`Stop node ${n.node_id}?`}
        phrase={n.node_id}
        confirmLabel="Stop node"
        busy={stop.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => stop.mutate(n.node_id, { onSettled: () => setConfirming(false) })}
      >
        <p>
          This kills the real node process. Its shards become unavailable until you start it again. Files stay readable only if every
          stripe keeps at least k valid shards. Use <em>What if {n.node_id} fails?</em> first to check.
        </p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function FileInspector({ fileId }: { fileId: string }) {
  const detail = useFileDetail(fileId, true);
  const files = useFiles();
  const ui = useUi();
  const narrow = useNarrow();
  const del = useDeleteFile();
  const [dl, setDl] = useState<{ busy: boolean; result?: DownloadCheck; error?: unknown }>({ busy: false });
  const [deleting, setDeleting] = useState(false);
  const listed = files.data?.files.find((f) => f.file_id === fileId);

  if (detail.isLoading)
    return (
      <div>
        {listed && <div className="mb-2 font-medium">{listed.name}</div>}
        <Loading label="Verifying this file's shards" />
      </div>
    );
  if (!detail.data) return <ErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />;
  const f = detail.data;
  const p = f.protection;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 break-words text-base font-semibold">{f.name}</h3>
          <FileStatusBadge status={p.status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-2xs text-faint">
          {f.snapshot_verified ? "Hash-verified snapshot" : "Unverified snapshot"}
          <Freshness updatedAt={detail.dataUpdatedAt} isError={detail.isError} isFetching={detail.isFetching} />
        </div>
      </div>

      <dl>
        <KV k="File ID" mono>{f.file_id}</KV>
        <KV k="Size">{formatBytes(f.size)} ({f.size.toLocaleString()} B)</KV>
        <KV k="Coding">{p.coding.join(", ") || `${f.k}+${f.m}`} · {plural(f.chunk_count, "stripe")} of {formatBytes(f.chunk_size)}</KV>
        <KV k="Created">{formatDateTime(f.created_at)}</KV>
        <KV k="SHA-256"><Hash value={f.sha256} label="file SHA-256" /></KV>
      </dl>

      <Panel title="Protection">
        <dl>
          <KV k="Recoverable now"><Outcome value={p.recoverable} /></KV>
          <KV k="Fault tolerance">{p.fault_tolerance === null ? "— (empty file)" : formatTolerance(p.fault_tolerance)}</KV>
          <KV k="Design tolerance">{p.design_tolerance ?? "—"} (m)</KV>
          {p.placement_concentrated && (
            <KV k="Placement"><span className="text-at-risk">concentrated: a node holds several shards of one stripe</span></KV>
          )}
        </dl>
        <p className="mt-2 text-sm text-muted">{p.explanation}</p>
      </Panel>

      <Panel title={`Minimal failure sets (${p.minimal_loss_sets_total})`}>
        {p.minimal_loss_sets.length === 0 ? (
          <Empty>None: no node combination can lose this file.</Empty>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {p.minimal_loss_sets.map((s) => (
              <li key={s.nodes.join(",")}>
                <button
                  className="chip hover:border-preview hover:text-preview"
                  title={`Losing ${s.nodes.join(", ") || "nothing"} loses stripes ${s.stripes_lost.join(", ")}. Click to preview.`}
                  onClick={() => {
                    ui.setHypothetical(s.nodes);
                    ui.setView("twin");
                  }}
                >
                  {s.nodes.length ? `{${s.nodes.join(", ")}}` : "∅ (already lost)"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {p.minimal_loss_sets_truncated && <p className="mt-1 text-2xs text-degraded">List truncated by the backend: showing {p.minimal_loss_sets.length} of {p.minimal_loss_sets_total}.</p>}
        {!p.enumeration_complete && <p className="mt-1 text-2xs text-degraded">Enumeration hit the backend cap; listed sets may be incomplete (tolerance is still exact).</p>}
      </Panel>

      <Panel title="Stripes">
        <ul className="max-h-48 space-y-px overflow-auto font-mono text-2xs">
          {p.stripes.map((s) => (
            <li key={s.chunk_index}>
              <button
                className="grid w-full grid-cols-[3.5rem_1fr_auto] gap-2 rounded px-1 py-0.5 text-left hover:bg-raised"
                onClick={() => {
                  ui.selectStripe(s.chunk_index);
                  ui.setView("twin");
                  ui.openMatrix();
                }}
              >
                <span className="text-muted">chunk {s.chunk_index}</span>
                <span className="flex gap-px" aria-label={`${s.valid} of ${s.n} valid, ${s.k} needed`}>
                  {Array.from({ length: s.n }, (_, i) => (
                    <span key={i} className={cx("h-2.5 w-2.5", i < s.valid ? (i < s.k ? "bg-healthy/80" : "bg-healthy/40") : "bg-lost/70")} />
                  ))}
                </span>
                <span className={s.recoverable ? "text-muted" : "text-lost"}>
                  {s.valid}/{s.n} · k={s.k}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => { ui.setView("cluster"); ui.selectFile(f.file_id); }}>
          <MapIcon className="h-3.5 w-3.5" /> Show on stage
        </button>
        <button
          className="btn-preview"
          onClick={() => {
            ui.selectFile(f.file_id);
            ui.setView("twin");
            ui.openMatrix();
          }}
          title="Open the Survival Twin with this file in the stripe matrix"
        >
          <Waves className="h-3.5 w-3.5" /> Simulate failures for this file
        </button>
        <button
          className="btn-ghost"
          disabled={dl.busy}
          onClick={() => {
            setDl({ busy: true });
            downloadAndVerify(f.file_id, f.sha256, true, f.name).then(
              (result) => setDl({ busy: false, result }),
              (error) => setDl({ busy: false, error }),
            );
          }}
        >
          <Download className="h-3.5 w-3.5" /> {dl.busy ? "Downloading…" : "Download & verify"}
        </button>
        <button className="btn-ghost" onClick={() => void detail.refetch()} disabled={detail.isFetching}>
          <RefreshCw className={cx("h-3.5 w-3.5", detail.isFetching && "animate-spin motion-reduce:animate-none")} /> Re-verify
        </button>
        <button className="btn-ghost" onClick={() => setDeleting(true)} disabled={narrow} title={narrow ? NARROW_REASON : undefined}>
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>

      {dl.error !== undefined && <ErrorPanel compact error={dl.error} />}
      {dl.result && <DownloadResult r={dl.result} />}
      {detail.isError && <ErrorPanel compact error={detail.error} />}

      <Panel title="Events for this file">
        <RelatedEventList match={(e) => e.file_id === f.file_id} empty="No events for this file in the latest 200." />
      </Panel>

      <ConfirmDialog
        open={deleting}
        title={`Delete ${f.name}?`}
        phrase={f.name}
        confirmLabel="Delete permanently"
        busy={del.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          del.mutate(
            { ref: f.file_id, fileId: f.file_id },
            {
              onSuccess: () => {
                setDeleting(false);
                ui.selectFile(null);
              },
            },
          )
        }
      >
        <p>Deletes the file's metadata and shards. This cannot be undone.</p>
        <p className="font-mono text-2xs text-muted">DELETE /api/files/{f.file_id}?confirm={f.file_id}</p>
        {del.isError && <ErrorPanel compact error={del.error} />}
      </ConfirmDialog>
    </div>
  );
}

function DownloadResult({ r }: { r: DownloadCheck }) {
  return (
    <Panel title="Download check">
      <dl>
        <KV k="Bytes received">{r.bytes.toLocaleString()}</KV>
        <KV k="SHA-256 (browser)"><Hash value={r.sha256Browser} label="browser SHA-256" /></KV>
        <KV k="Matches stored hash">
          <Outcome value={r.match} why={r.sha256Browser === null ? "browser crypto unavailable" : "no reference hash"} />
        </KV>
        <KV k="Degraded read">{r.degraded === null ? "— (header missing)" : r.degraded ? "yes: some shards were bad or unreachable" : "no"}</KV>
        <KV k="Reconstructed chunks">{r.reconstructedChunks ?? "—"}</KV>
      </dl>
      <p className="mt-1 text-2xs text-faint">The browser hashed the bytes it received and compared them with the hash stored at upload.</p>
    </Panel>
  );
}

