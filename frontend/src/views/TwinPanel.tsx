import { ChevronDown, ChevronRight, FileCheck2, RefreshCw, Table2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { usePreview, useScenarios, useStatus, useTwin } from "../api/queries";
import type { PreviewFile, ScenarioPreview, Twin } from "../api/schemas";
import { formatMs, formatTime, formatTolerance, plural } from "../lib/format";
import { classifyPreviewFile, explainStripe, outcomeMeta, samePlacement, survivability, type PreviewOutcome } from "../lib/outcomes";
import { nodeState, nodeStateMeta } from "../lib/status";
import { useUi } from "../state/ui";
import { Empty, ErrorPanel, FileStatusBadge, Freshness, KV, Loading, cx } from "../components/common/ui";
import ExperimentControl from "./Experiment";

type StepState = "done" | "current" | "pending";

/** Inspector content for the Survival Twin view: a vertical stepper (spec 6.D). */
export default function TwinPanel() {
  const ui = useUi();
  const twin = useTwin(true);
  const status = useStatus();
  const scenarios = useScenarios();
  const sig = useMemo(
    () => (status.data?.nodes.map((n) => `${n.node_id}:${n.up ? 1 : 0}`).join(",") ?? "") + "|" + (twin.data?.snapshot.fingerprint ?? ""),
    [status.data, twin.data],
  );
  const preview = usePreview(ui.hypothetical, sig);
  const ready = preview.data && preview.settled && preview.data.nodes.join(",") === ui.hypothetical.join(",") ? preview.data : undefined;
  const executable = ready && !preview.isFetching ? ready : undefined;
  const exp = ui.experiment;
  const latestRun = exp.phase === "done" ? exp.report.run_id : scenarios.data?.scenarios[0]?.run_id;

  const hasHypo = ui.hypothetical.length > 0;
  const expActive = exp.phase !== "idle";
  const states: StepState[] = [
    twin.data ? "done" : "current",
    hasHypo ? "done" : "current",
    ready ? "done" : hasHypo ? "current" : "pending",
    twin.data ? "done" : "pending",
    exp.phase === "done" ? "done" : ready ? "current" : "pending",
    exp.phase === "done" ? "done" : exp.phase === "running" ? "current" : "pending",
    exp.phase === "done" ? "current" : "pending",
  ];

  return (
    <div>
      <p className="editorial mb-3 text-xl leading-7">Will this data survive, and can we prove it?</p>
      <ol className="relative" aria-label="Survival Twin steps">
        <Step n={1} title="Current survivability" state={states[0]!} defaultOpen open={expActive ? false : undefined}>
          <Current
            twin={twin.data}
            loading={twin.isLoading}
            error={twin.error}
            isError={twin.isError}
            updatedAt={twin.dataUpdatedAt}
            fetching={twin.isFetching}
            refetch={() => void twin.refetch()}
          />
        </Step>

        <Step n={2} title="Select hypothetical failures" state={states[1]!} defaultOpen open={expActive ? false : undefined}>
          <NodePicker />
        </Step>

        <Step n={3} title="Preview impact" state={states[2]!} defaultOpen open={expActive ? false : hasHypo || undefined} hypo>
          {!hasHypo ? (
            <Empty>Select one or more nodes to ask the backend what would happen.</Empty>
          ) : ready ? (
            <PreviewResult p={ready} fetching={preview.isFetching} twin={twin.data} />
          ) : preview.isError && preview.settled ? (
            <ErrorPanel error={preview.error} onRetry={() => void preview.refetch()} />
          ) : (
            <Loading label={`Asking the backend about ${ui.hypothetical.join(", ")}`} />
          )}
        </Step>

        <Step n={4} title="Minimal failure combinations" state={states[3]!}>
          {twin.data ? <LossSets twin={twin.data} /> : <Loading />}
        </Step>

        <Step n={5} title="Execute controlled scenario" state={states[4]!} defaultOpen={!!ready || expActive} open={expActive || undefined}>
          <ExperimentControl preview={executable} />
        </Step>

        <Step n={6} title="Observe the actual run" state={states[5]!} open={expActive || undefined}>
          <Observe />
        </Step>

        <Step n={7} title="Verify and inspect evidence" state={states[6]!} open={exp.phase === "done" || undefined} last>
          {latestRun ? (
            <div className="space-y-1 text-xs">
              <p className="text-muted">
                {exp.phase === "done" ? "This run's report" : "The most recent stored report"} compares the prediction with the observed result and
                both SHA-256 values.
              </p>
              <button
                className="btn-primary"
                onClick={() => {
                  ui.selectRun(latestRun);
                  ui.setView("lab");
                }}
              >
                <FileCheck2 className="h-3.5 w-3.5" /> Open Proof of Survival · <span className="font-mono">{latestRun}</span>
              </button>
            </div>
          ) : (
            <Empty>No scenario has been run yet, so there is no evidence to inspect.</Empty>
          )}
        </Step>
      </ol>
    </div>
  );
}

function Step({
  n,
  title,
  state,
  children,
  defaultOpen,
  open: forced,
  hypo,
  last,
}: {
  n: number;
  title: string;
  state: StepState;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  hypo?: boolean;
  last?: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? forced ?? !!defaultOpen;
  const dot = state === "done" ? "border-live bg-live/15 text-live" : state === "current" ? "border-info text-info" : "border-line-strong text-faint";
  return (
    <li className="relative pl-8">
      {!last && <span className="absolute bottom-0 left-[11px] top-7 w-px bg-line" aria-hidden />}
      <span className={cx("absolute left-0 top-1 flex h-6 w-6 items-center justify-center rounded-full border font-mono text-2xs", dot)} aria-hidden>
        {state === "done" ? "✓" : n}
      </span>
      <button className="flex w-full items-center gap-2 py-1.5 text-left" aria-expanded={open} onClick={() => setUserOpen(!open)}>
        <span className={cx("text-sm font-medium", state === "pending" ? "text-muted" : "text-ink")}>
          {n} · {title}
        </span>
        <span className="sr-only">({state})</span>
        <span className="ml-auto text-faint">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
      </button>
      {open && <div className={cx("mb-3 rounded-md p-2.5", hypo ? "hypo" : "border border-line bg-surface")}>{children}</div>}
    </li>
  );
}

function Current({
  twin,
  loading,
  error,
  isError,
  updatedAt,
  fetching,
  refetch,
}: {
  twin: Twin | undefined;
  loading: boolean;
  error: unknown;
  isError: boolean;
  updatedAt: number;
  fetching: boolean;
  refetch: () => void;
}) {
  if (loading) return <Loading label="Verifying every shard (GET /api/twin)" />;
  if (!twin) return <ErrorPanel error={error} onRetry={refetch} />;
  const s = survivability(twin);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs font-semibold tracking-[0.12em] text-live">LIVE</span>
        <span className="text-2xs text-faint">verified snapshot {formatTime(twin.snapshot.taken_at)}</span>
        <span className="ml-auto flex items-center gap-1">
          <Freshness updatedAt={updatedAt} isError={isError} isFetching={fetching} />
          <button className="icon-btn" onClick={refetch} disabled={fetching} aria-label="Re-verify now" title="Re-verify now">
            <RefreshCw className={cx("h-3.5 w-3.5", fetching && "animate-spin motion-reduce:animate-none")} />
          </button>
        </span>
      </div>
      {s.total === 0 ? (
        <p className="text-sm text-muted">No files are stored, so nothing can be lost.</p>
      ) : (
        <p className="text-sm">
          Under the current placement, <b className="text-healthy">{plural(s.surviveAnySingle, "file")}</b> survive any single node failure;{" "}
          <b className={s.notSingle ? "text-lost" : "text-muted"}>{s.notSingle}</b> do not.
        </p>
      )}
      {s.total > 0 && (
        <table className="w-full text-xs">
          <caption className="label mb-1 text-left">Files by guaranteed tolerance (backend fault_tolerance)</caption>
          <tbody>
            {s.byTolerance.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className={cx("py-0.5", r.key === "lost" ? "text-lost" : r.key === "t0" ? "text-at-risk" : "text-ink")}>{r.label}</td>
                <td className="py-0.5 text-right font-mono">{r.files}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-2xs text-faint">
        Loss combinations per number of failed nodes: not reported by the backend. Smallest fatal set across all files:{" "}
        {twin.summary.smallest_loss_set_size ?? "—"} node(s).
        {twin.timing_ms && ` Measured: observe ${formatMs(twin.timing_ms.observe)}, analyze ${formatMs(twin.timing_ms.analyze)}.`}
      </p>
    </div>
  );
}

function NodePicker() {
  const ui = useUi();
  const status = useStatus();
  if (!status.data) return <Loading />;
  const running = ui.experiment.phase === "running";
  return (
    <div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Hypothetical node failures">
        {status.data.nodes.map((n) => {
          const on = ui.hypothetical.includes(n.node_id);
          const st = nodeState(n);
          return (
            <label
              key={n.node_id}
              className={cx(
                "flex cursor-pointer items-center gap-1.5 rounded-sm border px-1.5 py-1 text-xs",
                on ? "border-dashed border-preview bg-preview/10 text-preview" : "border-line hover:border-line-strong",
              )}
            >
              <input type="checkbox" className="accent-[#B7A6FF]" checked={on} disabled={running} onChange={() => ui.toggleHypothetical(n.node_id)} />
              <span className="font-mono">{n.node_id}</span>
              <span className={cx("ml-auto text-2xs", nodeStateMeta[st].cls)} title={`Observed: ${nodeStateMeta[st].label}`}>
                {st === "up" ? "up" : "down"}
              </span>
            </label>
          );
        })}
      </div>
      {ui.hypothetical.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {ui.hypothetical.map((id) => (
            <span key={id} className="chip border-dashed border-preview text-preview">
              {id}
              <button aria-label={`Remove ${id}`} onClick={() => ui.toggleHypothetical(id)} disabled={running}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button className="btn-ghost ml-auto py-0.5" onClick={() => ui.setHypothetical([])} disabled={running}>
            Clear
          </button>
        </div>
      )}
      <p className="mt-2 text-2xs text-faint">Click nodes on the stage or tick them here. Nothing is stopped.</p>
    </div>
  );
}

function LossSets({ twin }: { twin: Twin }) {
  const ui = useUi();
  const names = useMemo(() => new Map(twin.files.map((f) => [f.file_id, f.name])), [twin.files]);
  const sets = twin.cluster_minimal_loss_sets;
  return (
    <div>
      <p className="mb-1 text-2xs text-muted">
        Computed by the backend from actual placement · snapshot {formatTime(twin.snapshot.taken_at)}. The smallest node sets that destroy at least
        one file. Click one to preview it.
      </p>
      {sets.length === 0 ? (
        <Empty>No node combination can destroy any file.</Empty>
      ) : (
        <ul className="max-h-56 space-y-px overflow-auto">
          {sets.map((s) => (
            <li key={s.nodes.join(",")}>
              <button className="grid w-full grid-cols-[auto_1fr] gap-2 rounded-sm px-1 py-0.5 text-left text-2xs hover:bg-raised" onClick={() => ui.setHypothetical(s.nodes)}>
                <span className="font-mono text-preview">{s.nodes.length ? `{${s.nodes.join(", ")}}` : "∅"}</span>
                <span className="truncate text-muted">→ loses {s.files_lost.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {twin.cluster_minimal_loss_sets_truncated && (
        <p className="mt-1 text-2xs text-degraded">Truncated by the backend: {sets.length} of {twin.cluster_minimal_loss_sets_total} shown.</p>
      )}
      {!twin.enumeration_complete && (
        <p className="mt-1 text-2xs text-degraded">The backend hit its enumeration cap; this list may be incomplete. Tolerances remain exact.</p>
      )}
      <p className="mt-1 text-2xs text-faint">Per-file combinations are in each file's inspector.</p>
    </div>
  );
}

function rank(o: PreviewOutcome) {
  return ["unrecoverable", "already_unrecoverable", "zero_margin", "reduced_redundancy", "unaffected"].indexOf(o);
}

function PreviewResult({ p, fetching, twin }: { p: ScenarioPreview; fetching: boolean; twin: Twin | undefined }) {
  const ui = useUi();
  const s = p.summary;
  const same = samePlacement(p, twin);
  const affectedIds = new Set(p.files.map((f) => f.file_id));
  const unaffected = (twin?.files ?? []).filter((f) => !affectedIds.has(f.file_id));
  const classified = p.files
    .map((f) => ({ f, c: classifyPreviewFile(f, twin?.files.find((t) => t.file_id === f.file_id)) }))
    .sort((a, b) => rank(a.c.outcome) - rank(b.c.outcome));
  const counts = new Map<PreviewOutcome, number>();
  for (const { c } of classified) counts.set(c.outcome, (counts.get(c.outcome) ?? 0) + 1);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 text-2xs text-preview">
        <span className="font-mono font-semibold tracking-[0.1em]">PREVIEW — no node has been stopped.</span>
        {fetching && <span className="ml-auto text-faint">updating…</span>}
      </div>
      <div className={cx("rounded-sm p-2", s.data_loss_predicted ? "bg-lost/10 text-lost" : "bg-healthy/10 text-healthy")}>
        {s.data_loss_predicted
          ? `Predicted data loss: ${plural(s.files_newly_lost, "file")} would become unrecoverable.`
          : `No new data loss predicted: ${s.files_affected - s.files_lost_after} affected file(s) survive.`}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs" aria-label="Predicted outcomes">
        {(["unrecoverable", "already_unrecoverable", "zero_margin", "reduced_redundancy"] as const).map((o) =>
          counts.get(o) ? (
            <li key={o} className={outcomeMeta[o].cls}>
              {outcomeMeta[o].glyph} {counts.get(o)} {outcomeMeta[o].label.toLowerCase()}
            </li>
          ) : null,
        )}
        <li className="text-muted">
          {outcomeMeta.unaffected.glyph} {s.files_unaffected} unaffected
        </li>
      </ul>
      <ul className="space-y-1">
        {classified.map(({ f, c }) => (
          <PreviewFileRow key={f.file_id} f={f} outcome={c.outcome} tightest={c.tightest} complete={c.complete} twin={twin} same={same} />
        ))}
        {unaffected.map((f) => (
          <li key={f.file_id} className="flex items-center gap-2 rounded-sm border border-dashed border-preview/25 px-2 py-1 text-xs text-muted">
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span title={outcomeMeta.unaffected.help}>
              {outcomeMeta.unaffected.glyph} {outcomeMeta.unaffected.label}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-2xs text-muted">{p.explanation}</p>
      <dl className="text-2xs">
        <KV k="Scenario ID" mono>{p.scenario_id}</KV>
        <KV k="Snapshot">{formatTime(p.snapshot.taken_at)} · {p.snapshot.verified ? "hash-verified" : "unverified"}</KV>
        {p.nodes_already_down.length > 0 && <KV k="Already down">{p.nodes_already_down.join(", ")}</KV>}
        {!same && twin && (
          <KV k="Note">
            <span className="text-degraded">The Twin snapshot differs from this preview; shard indices are omitted until both refresh.</span>
          </KV>
        )}
      </dl>
      {p.note && <p className="text-2xs text-degraded">{p.note}</p>}
      <button className="btn-preview" onClick={() => ui.openMatrix()}>
        <Table2 className="h-3.5 w-3.5" /> Open stripe matrix
      </button>
    </div>
  );
}

function PreviewFileRow({
  f,
  outcome,
  tightest,
  complete,
  twin,
  same,
}: {
  f: PreviewFile;
  outcome: PreviewOutcome;
  tightest: number | null;
  complete: boolean;
  twin: Twin | undefined;
  same: boolean;
}) {
  const [open, setOpen] = useState(outcome === "unrecoverable" || outcome === "zero_margin");
  const ui = useUi();
  const meta = outcomeMeta[outcome];
  const twinFile = twin?.files.find((t) => t.file_id === f.file_id);
  // Explain the stripes that decide the outcome first: lost ones, then the tightest.
  const ordered = [...f.stripes].sort((a, b) => a.valid_after - a.k - (b.valid_after - b.k));
  return (
    <li className="rounded-sm border border-dashed border-preview/40">
      <button className="flex w-full items-center gap-2 px-2 py-1 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-xs">{f.name}</span>
        <span className={cx("shrink-0 text-2xs", meta.cls)} title={meta.help}>
          {meta.glyph} {meta.label}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-dashed border-preview/30 px-2 py-1.5 text-2xs">
          <div className="flex flex-wrap items-center gap-1 text-muted">
            Status <FileStatusBadge status={f.status_before} /> → <FileStatusBadge status={f.status_after} /> · tolerance after:{" "}
            {f.fault_tolerance_after !== null && f.fault_tolerance_after < 0 ? "none: unrecoverable after this failure" : formatTolerance(f.fault_tolerance_after)}
          </div>
          <p className="text-muted">{f.explanation}</p>
          {outcome === "zero_margin" && tightest !== null && !f.stripes.some((s) => s.chunk_index === tightest) && (
            <p className="text-at-risk">Stripe {tightest} is not affected by this proposal but already has exactly k valid shards (verified Twin).</p>
          )}
          {!complete && <p className="text-faint">Unaffected stripes were not loaded from the Twin; the outcome uses affected stripes only.</p>}
          <div className="label pt-1">Why · reconstruction needs any k of n shards</div>
          <ul className="space-y-1.5">
            {ordered.slice(0, 8).map((s) => {
              const w = explainStripe(f.name, s, twinFile?.stripes.find((t) => t.chunk_index === s.chunk_index), same);
              return (
                <li key={s.chunk_index}>
                  <button
                    className="w-full rounded-sm px-1 py-0.5 text-left hover:bg-raised"
                    onClick={() => {
                      ui.selectFile(f.file_id);
                      ui.selectStripe(s.chunk_index);
                      ui.openMatrix();
                    }}
                    title="Show this stripe in the matrix"
                  >
                    <div className={w.recoverable ? "text-ink" : "text-lost"}>{w.headline}</div>
                    {w.placement && <div className="text-muted">{w.placement}</div>}
                    <div className="font-mono text-faint">{w.arithmetic}</div>
                  </button>
                </li>
              );
            })}
          </ul>
          {f.stripes.length > 8 && <p className="text-faint">+{f.stripes.length - 8} more affected stripes in the stripe matrix.</p>}
        </div>
      )}
    </li>
  );
}

function Observe() {
  const exp = useUi((s) => s.experiment);
  if (exp.phase === "idle") return <Empty>No experiment is running. Nothing here is simulated.</Empty>;
  if (exp.phase === "running")
    return (
      <p className="text-xs text-muted">
        The backend runs the whole scenario in one request and reports no intermediate events, so no progress is shown. Its recorded timeline appears
        here when the run returns.
      </p>
    );
  if (exp.phase === "failed") return <p className="text-xs text-muted">No report was returned, so there is no observed timeline. See step 5.</p>;
  return (
    <ol className="space-y-0.5 font-mono text-2xs" aria-label="Backend timeline">
      {exp.report.timeline.map((t, i) => {
        const { ts, action, ...rest } = t;
        return (
          <li key={i} className="grid grid-cols-[6.5rem_1fr] gap-2">
            <span className="text-faint">{formatTime(ts)}</span>
            <span>
              <span className="text-ink">{action}</span>{" "}
              <span className="text-muted">{Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
