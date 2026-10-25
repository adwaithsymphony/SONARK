import { Box, Crosshair, Eye, Grid2x2, ImageDown, Info, Layers, Maximize, Minimize, RotateCcw, Tag, Waypoints } from "lucide-react";
import { Component, Suspense, lazy, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useFileDetail, useStatus, useTwin } from "../../api/queries";
import { shardStatusMeta } from "../../lib/status";
import { useObserved } from "../../state/observed";
import { useMode, useUi, type Mode } from "../../state/ui";
import { color } from "../../theme/tokens";
import { ErrorPanel, Freshness, Loading, Segmented, cx } from "../common/ui";
import { useModeCopy } from "../frame/Frame";
import { hasWebGL, useStageModel } from "./model";
import { useNarrow } from "../../lib/useNarrow";
import type { NodeSummary } from "./Stage3D";
import Topology2D from "./Topology2D";

const Stage3D = lazy(() => import("./Stage3D"));

class GLBoundary extends Component<{ fallback: (e: unknown) => ReactNode; children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export default function ClusterStage({ compact }: { compact?: boolean }) {
  const ui = useUi();
  const mode = useMode();
  const status = useStatus();
  const twin = useTwin(ui.view === "twin");
  const detail = useFileDetail(ui.selectedFile, true);
  const webgl = useMemo(hasWebGL, []);

  // Placement for the selected file: verified file detail first, otherwise the
  // verified twin (both carry per-shard state). Nothing is drawn without either.
  const twinFile = twin.data?.files.find((f) => f.file_id === ui.selectedFile);
  const analysis = detail.data?.protection ?? twinFile;
  const verified = detail.data ? detail.data.snapshot_verified : twinFile ? twin.data!.snapshot.verified : null;
  const model = useStageModel(status.data, ui.selectedFile ? analysis : undefined, verified);

  // While a real experiment runs, its targets are drawn as targets, not as proposals.
  const hypothetical = useMemo(
    () => new Set(ui.experiment.phase === "running" ? [] : ui.hypothetical),
    [ui.hypothetical, ui.experiment.phase],
  );
  const targets = useMemo(
    () => new Set(ui.experiment.phase === "running" ? ui.experiment.nodes : []),
    [ui.experiment],
  );
  const onNodeClick = useCallback(
    (id: string) => {
      const s = useUi.getState();
      if (s.experiment.phase === "running") return;
      if (s.view === "twin") s.toggleHypothetical(id);
      s.selectNode(s.selectedNode === id && s.view !== "twin" ? null : id);
    },
    [],
  );

  // Per-node shard state from the verified Twin snapshot (backend), for hover summaries.
  const summaries = useMemo(() => {
    const m = new Map<string, NodeSummary>();
    if (!twin.data) return m;
    const files = new Map<string, Set<string>>();
    for (const f of twin.data.files)
      for (const st of f.stripes)
        for (const sh of st.shards ?? []) {
          const e = m.get(sh.node_id) ?? { counts: {}, files: 0, takenAt: twin.data.snapshot.taken_at };
          e.counts[sh.status] = (e.counts[sh.status] ?? 0) + 1;
          m.set(sh.node_id, e);
          const fs = files.get(sh.node_id) ?? new Set<string>();
          fs.add(f.file_id);
          files.set(sh.node_id, fs);
        }
    for (const [id, e] of m) e.files = files.get(id)?.size ?? 0;
    return m;
  }, [twin.data]);
  const lastSeenUp = useObserved((s) => s.lastSeenUp);
  const modeCopy = useModeCopy(mode);
  const exportFn = useRef<(() => void) | null>(null);
  const [canExport, setCanExport] = useState(false);
  const onExportReady = useCallback((fn: (() => void) | null) => {
    exportFn.current = fn;
    setCanExport(!!fn);
  }, []);

  const onShardClick = useCallback((sh: { chunk: number; shard: number }) => {
    const st = useUi.getState();
    if (!st.selectedFile) return;
    st.selectShard({ fileId: st.selectedFile, chunk: sh.chunk, shard: sh.shard });
    st.setInspectorOpen(true);
  }, []);

  const narrow = useNarrow();
  const kind = webgl ? ui.stage : "2d";
  const props = {
    model,
    selectedNode: ui.selectedNode,
    hypothetical,
    experimentTargets: targets,
    layers: ui.layers,
    cameraToken: ui.cameraToken,
    focusToken: ui.focusToken,
    onNodeClick,
    lastSeenUp,
    summaries,
    modeCopy,
    onExportReady,
    onShardClick,
  };

  const frame =
    mode === "PREVIEW" ? "border-2 border-dashed border-preview/60" : mode === "EXPERIMENT" ? "border-2 border-experiment/70" : "border border-line";

  // Spec 4.1: below 768 px the spatial stage is replaced by a list.
  if (narrow)
    return (
      <div className={cx("h-full overflow-auto rounded-md bg-bg", frame)}>
        <NodeList model={model} hypothetical={hypothetical} targets={targets} selected={ui.selectedNode} onClick={onNodeClick} />
        <StageBanner mode={mode} copy={modeCopy} />
      </div>
    );

  return (
    <div className={cx("relative h-full min-h-[260px] overflow-hidden rounded-md bg-bg", frame)}>
      {status.data ? (
        kind === "3d" ? (
          <GLBoundary
            fallback={(e) => (
              <>
                <Topology2D {...props} />
                <div className="absolute bottom-2 right-2 max-w-xs">
                  <ErrorPanel compact error={new Error(`3D renderer failed, showing 2D: ${String((e as Error)?.message ?? e)}`)} />
                </div>
              </>
            )}
          >
            <Suspense fallback={<div className="p-4"><Loading label="Loading 3D stage" /></div>}>
              <Stage3D {...props} />
            </Suspense>
          </GLBoundary>
        ) : (
          <div className="absolute inset-0 p-4">
            <Topology2D {...props} />
          </div>
        )
      ) : status.isError ? (
        <div className="absolute inset-x-4 top-16 z-20">
          <ErrorPanel error={status.error} onRetry={() => void status.refetch()} />
        </div>
      ) : (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <Loading label="Reading cluster status (a node that is down adds a few seconds per request)" />
        </div>
      )}

      {kind === "3d" && <div className="stage-vignette pointer-events-none absolute inset-0 z-10" aria-hidden />}
      <StageBanner mode={mode} copy={modeCopy} />

      <div className="pointer-events-none absolute left-2 top-2 z-30 flex flex-col gap-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded border border-line bg-surface/90 p-1 backdrop-blur">
          <Segmented
            label="Renderer"
            value={kind}
            onChange={(v) => ui.setStage(v)}
            options={[
              { value: "3d", label: <span className="inline-flex items-center gap-1"><Box className="h-3 w-3" />3D</span>, title: webgl ? "3D stage" : "WebGL unavailable" },
              { value: "2d", label: <span className="inline-flex items-center gap-1"><Grid2x2 className="h-3 w-3" />2D</span>, title: "Precise 2D topology" },
            ]}
          />
          <span className="mx-0.5 h-4 w-px bg-line" />
          <LayerToggle on={ui.layers.labels} onClick={() => ui.toggleLayer("labels")} label="Labels" icon={<Tag className="h-3.5 w-3.5" />} />
          <LayerToggle on={ui.layers.shards} onClick={() => ui.toggleLayer("shards")} label="Shard markers" icon={<Layers className="h-3.5 w-3.5" />} />
          <LayerToggle on={ui.layers.placement} onClick={() => ui.toggleLayer("placement")} label="Placement lines" icon={<Waypoints className="h-3.5 w-3.5" />} />
          {kind === "3d" && (
            <>
              <span className="mx-0.5 h-4 w-px bg-line" />
              <button className="icon-btn" onClick={ui.resetCamera} aria-label="Reset camera" title="Reset camera">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button className="icon-btn" onClick={ui.focusSelection} disabled={!ui.selectedNode} aria-label="Focus selected node" title="Focus selected node">
                <Crosshair className="h-3.5 w-3.5" />
              </button>
              <button
                className="icon-btn"
                onClick={() => exportFn.current?.()}
                disabled={!canExport}
                aria-label="Export PNG"
                title="Export the current view as PNG (labels and mode included)"
              >
                <ImageDown className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {!compact && (
            <button className="icon-btn" onClick={() => ui.setKiosk(!ui.kiosk)} aria-label={ui.kiosk ? "Exit kiosk mode" : "Kiosk mode"} title={ui.kiosk ? "Exit kiosk mode" : "Kiosk mode"}>
              {ui.kiosk ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        {!webgl && <div className="pointer-events-auto chip border-degraded/50 bg-surface text-degraded">WebGL unavailable · 2D topology</div>}
        {ui.selectedFile && model.shards.length === 0 && (detail.isLoading || detail.isFetching) && (
          <div className="pointer-events-auto chip bg-surface text-muted">loading placement…</div>
        )}
        {ui.selectedFile && model.shards.length > 0 && (
          <div className="pointer-events-auto chip bg-surface text-muted" title="Where the placement data came from">
            <Eye className="h-3 w-3" /> {model.fileName}: {model.shards.length} shards on {model.hostNodes.size} nodes ·{" "}
            {model.placementSource === "verified" ? "hash-verified" : "unverified"}
          </div>
        )}
      </div>

      <div className="absolute right-2 top-2 z-30 rounded bg-surface/80 px-1.5 py-0.5 max-sm:top-12">
        <Freshness updatedAt={status.dataUpdatedAt} isError={status.isError} />
      </div>
      <Legend />
    </div>
  );
}

/** Accessible list equivalent of the stage, used below 768 px. */
function NodeList({
  model,
  hypothetical,
  targets,
  selected,
  onClick,
}: {
  model: ReturnType<typeof useStageModel>;
  hypothetical: Set<string>;
  targets: Set<string>;
  selected: string | null;
  onClick: (id: string) => void;
}) {
  if (!model.nodes.length) return <div className="p-3"><Loading label="Reading cluster status" /></div>;
  const perNode = new Map<string, number>();
  for (const sh of model.shards) perNode.set(sh.node, (perNode.get(sh.node) ?? 0) + 1);
  return (
    <ul className="divide-y divide-line" aria-label="Nodes">
      <li className="px-3 py-1.5 text-2xs text-faint">Simplified, read-only view below 768 px. Widen the window for the spatial stage and actions.</li>
      {model.nodes.map((n) => {
        const hypo = hypothetical.has(n.id);
        const target = targets.has(n.id);
        const word = hypo ? "PROPOSED FAILURE" : target ? "EXPERIMENT TARGET" : n.state === "up" ? "ONLINE" : "OFFLINE";
        const cls = hypo ? "text-preview" : target ? "text-experiment" : n.state === "up" ? "text-live" : "text-lost";
        return (
          <li key={n.id}>
            <button
              className={cx("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised", selected === n.id && "bg-raised")}
              aria-pressed={selected === n.id}
              onClick={() => onClick(n.id)}
            >
              <span className="font-mono text-sm text-ink">{n.id}</span>
              <span className={cx("font-mono text-2xs", cls)}>{word}</span>
              <span className="ml-auto font-mono text-2xs text-muted">
                {n.shards} shards{perNode.get(n.id) ? ` · ${perNode.get(n.id)} of ${model.fileName}` : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function LayerToggle({ on, onClick, label, icon }: { on: boolean; onClick: () => void; label: string; icon: ReactNode }) {
  return (
    <button className={cx("icon-btn", on && "bg-raised text-ink")} aria-pressed={on} onClick={onClick} title={label} aria-label={label}>
      {icon}
    </button>
  );
}

/** Mode label on the stage frame (spec 4.2), with the exact copy. */
function StageBanner({ mode, copy }: { mode: Mode; copy: string }) {
  const exp = useUi((s) => s.experiment);
  const hypo = useUi((s) => s.hypothetical);
  let detail: string | null = null;
  let cls = "";
  if (mode === "PREVIEW") {
    detail = `proposed failure of ${hypo.join(", ")} · no node has been stopped`;
    cls = "hypo text-preview";
  } else if (mode === "EXPERIMENT") {
    cls = "border border-experiment/70 bg-surface text-experiment";
    if (exp.phase === "running") detail = `stopping ${exp.nodes.join(", ")} · node states are not observed until the run returns`;
    else if (exp.phase === "done")
      detail = `${exp.report.run_id} stopped ${exp.report.nodes.join(", ")} · ${
        exp.report.restore_errors.length ? `restore errors: ${exp.report.restore_errors.length}` : "backend reports nodes restored"
      }`;
    else if (exp.phase === "failed") detail = `request for ${exp.nodes.join(", ")} returned no report`;
  }
  if (!detail) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-2">
      <div className={cx("max-w-full rounded-sm px-3 py-1 text-center text-xs", cls)} role="status">
        <span className="font-mono font-semibold tracking-[0.08em]">{copy}</span>
        <span className="opacity-80"> · {detail}</span>
      </div>
    </div>
  );
}

function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute bottom-2 left-2 z-30 max-w-[17rem]">
      <button className="btn-ghost bg-surface/90" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Info className="h-3.5 w-3.5" /> Legend
      </button>
      {open && (
        <div className="mt-1 space-y-2 rounded border border-line bg-surface/95 p-2 text-2xs text-muted backdrop-blur">
          <div>
            <div className="label mb-1">Node</div>
            <Row sw={<span className="h-2.5 w-2.5 rotate-45" style={{ background: color.live }} />}>ONLINE (observed up)</Row>
            <Row sw={<span className="h-3 w-3 rounded-full border-2 border-r-transparent" style={{ borderColor: color.lost }} />}>
              OFFLINE (observed stopped or unreachable): broken red ring
            </Row>
            <Row sw={<span className="h-3 w-3 rounded-full border border-info" />}>Selected (thin ring + corner brackets)</Row>
            <Row sw={<span className="h-3 w-3 rounded-full border-2 border-dashed opacity-60" style={{ borderColor: color.preview }} />}>
              PROPOSED FAILURE: ghosted, violet, PREVIEW only
            </Row>
            <Row sw={<span className="h-3 w-3 rounded-full border-2" style={{ borderColor: color.experiment }} />}>EXPERIMENT TARGET</Row>
            <div className="mt-1">Positions identify nodes in sorted id order; they do not show network distance. No zones are reported.</div>
          </div>
          <div>
            <div className="label mb-1">Shards of selected file</div>
            {(Object.keys(shardStatusMeta) as (keyof typeof shardStatusMeta)[]).map((s) => (
              <Row key={s} sw={<span className="h-2.5 w-2.5" style={{ background: shardStatusMeta[s].color }} />}>
                {shardStatusMeta[s].label}
              </Row>
            ))}
            <div className="mt-1">Lines join the selected file to the nodes holding its shards (from metadata). No other lines are drawn.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ sw, children }: { sw: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-px">
      <span className="flex w-3 justify-center">{sw}</span>
      <span>{children}</span>
    </div>
  );
}
