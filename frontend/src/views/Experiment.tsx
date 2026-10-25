import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileCheck2, FlaskConical, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../api/client";
import { api } from "../api/endpoints";
import { qk, useHealth, useInvalidateCluster, useStatus } from "../api/queries";
import type { ScenarioPreview, ScenarioReport } from "../api/schemas";
import { useUi } from "../state/ui";
import { FactChip } from "../components/evidence/Evidence";
import { NARROW_REASON, useNarrow } from "../lib/useNarrow";
import { ConfirmDialog, ErrorPanel, Outcome, Panel, Segmented, cx } from "../components/common/ui";

/** Why this preview cannot be executed, from backend-reported facts only. */
export function blockers(
  p: ScenarioPreview,
  nodeControl: boolean | undefined,
  readOnly: boolean | undefined,
  nodes: { node_id: string; managed: boolean; running: boolean | null }[] | undefined,
): string[] {
  const out: string[] = [];
  if (readOnly) out.push("The API is in read-only remote mode.");
  if (nodeControl === false) out.push("The API was started without --manage, so it cannot stop nodes.");
  if (!p.snapshot.verified) out.push("The preview used an unverified snapshot.");
  for (const id of p.nodes) {
    const n = nodes?.find((x) => x.node_id === id);
    if (n && !n.managed) out.push(`${id} is not managed by this server.`);
    else if (n && n.running === false) out.push(`${id} is already stopped. Start it before running a scenario.`);
  }
  if (out.length === 0 && !p.executable) out.push("The backend reports this scenario is not executable.");
  return out;
}

/**
 * True only when the backend rejected the request before stopping any node:
 * validation (400/404/415), confirmation (428), busy (503 busy) and pre-run
 * conflicts (409). The one 409 raised after nodes were stopped ("still
 * answering after stop") is not counted as a refusal.
 */
export function refusedBeforeStopping(e: unknown): boolean {
  if (!(e instanceof ApiRequestError)) return false;
  if (e.status === 409) return !/still answering after stop/.test(e.message);
  if (e.status === 503) return e.code === "busy";
  return [400, 403, 404, 411, 413, 415, 428].includes(e.status);
}

export function countRecovered(r: ScenarioReport) {
  const results = Object.values(r.outage_results);
  return {
    total: results.length,
    predicted: results.filter((x) => x.predicted_recoverable).length,
    actual: results.filter((x) => x.actual_recoverable).length,
    sha: results.filter((x) => x.sha256_match).length,
  };
}

export default function ExperimentControl({ preview }: { preview: ScenarioPreview | undefined }) {
  const ui = useUi();
  const health = useHealth();
  const status = useStatus();
  const qc = useQueryClient();
  const invalidate = useInvalidateCluster();
  const [dialog, setDialog] = useState(false);
  const [mode, setMode] = useState<"restart" | "replace">("restart");
  const inFlight = useRef(false);
  const narrow = useNarrow();
  const exp = ui.experiment;

  const lossPredicted = preview ? Object.values(preview.predictions).some((v) => !v) : false;
  useEffect(() => {
    if (lossPredicted && mode === "replace") setMode("restart");
  }, [lossPredicted, mode]);

  const run = async (p: ScenarioPreview) => {
    if (inFlight.current || useUi.getState().experiment.phase === "running") return; // no double submit
    inFlight.current = true;
    setDialog(false);
    ui.setExperiment({ phase: "running", nodes: p.nodes, mode, scenarioId: p.scenario_id, startedAt: Date.now() });
    try {
      const report = await api.execute(p.nodes, p.scenario_id, mode);
      qc.setQueryData(qk.scenario(report.run_id), report);
      useUi.getState().setExperiment({ phase: "done", report, finishedAt: Date.now() });
      useUi.getState().selectRun(report.run_id);
      useUi.getState().setHypothetical([]);
    } catch (error) {
      useUi.getState().setExperiment({ phase: "failed", nodes: p.nodes, error, finishedAt: Date.now(), modified: refusedBeforeStopping(error) ? false : null });
    } finally {
      inFlight.current = false;
      void invalidate();
    }
  };

  if (exp.phase === "running") return <RunningCard nodes={exp.nodes} mode={exp.mode} scenarioId={exp.scenarioId} startedAt={exp.startedAt} />;
  if (exp.phase === "done") return <DoneCard report={exp.report} />;

  const block = preview ? blockers(preview, health.data?.node_control, health.data?.read_only, status.data?.nodes) : [];
  if (narrow && preview) block.push(NARROW_REASON);
  const unrecoverable = preview?.files.filter((f) => !f.recoverable_after) ?? [];
  const phrase = preview?.nodes.join(" ") ?? "";

  return (
    <Panel title="Controlled experiment (real)" className="experiment-frame">
      {exp.phase === "failed" && <FailedNotice error={exp.error} nodes={exp.nodes} />}
      {!preview ? (
        <p className="text-sm text-faint">An experiment needs a fresh preview first. It is executed with that preview's scenario ID.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-muted">
            Really stops <b className="text-experiment">{preview.nodes.join(", ")}</b>, reads every file back and hashes it, restores the
            nodes, repairs, and verifies. Takes several seconds; the API answers nothing else meanwhile.
          </p>
          {block.length > 0 && (
            <ul className="space-y-0.5 text-2xs text-degraded">
              {block.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
          )}
          <button className="btn-danger" disabled={block.length > 0} onClick={() => setDialog(true)}>
            <FlaskConical className="h-3.5 w-3.5" /> Prepare experiment…
          </button>
        </div>
      )}

      {preview && (
        <ConfirmDialog
          open={dialog}
          title="Run a real controlled failure"
          phrase={phrase}
          confirmLabel={`Stop ${preview.nodes.join(", ")} now`}
          onCancel={() => setDialog(false)}
          onConfirm={() => void run(preview)}
        >
          <FactChip kind="awaiting_confirmation" />
          <p className="font-medium text-experiment">This will actually stop these nodes.</p>
          <div className="rounded border border-experiment/50 bg-experiment/5 p-2">
            <div className="label mb-1 text-experiment">Nodes that will be stopped</div>
            <div className="font-mono text-ink">{preview.nodes.join(", ")}</div>
          </div>
          <div>
            <div className="label mb-1">
              Previewed impact · scenario <span className="font-mono normal-case tracking-normal text-muted">{preview.scenario_id}</span>
            </div>
            <p className="text-muted">{preview.explanation}</p>
          </div>
          {unrecoverable.length > 0 ? (
            <div className="rounded border border-lost/50 bg-lost/5 p-2">
              <div className="flex items-center gap-1 font-medium text-lost">
                <AlertTriangle className="h-4 w-4" /> Predicted unrecoverable during the outage
              </div>
              <ul className="mt-1 list-disc pl-5 text-muted">
                {unrecoverable.map((f) => (
                  <li key={f.file_id}>{f.name}</li>
                ))}
              </ul>
              <p className="mt-1 text-2xs text-muted">In restart mode the nodes come back with their data, so these files are expected to be readable again afterwards. The run reports what actually happens.</p>
            </div>
          ) : (
            <p className="text-healthy">No file is predicted to become unrecoverable.</p>
          )}
          <div>
            <div className="label mb-1">Restore mode</div>
            <Segmented
              label="Restore mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "restart", label: "restart: keep node data" },
                { value: "replace", label: "replace: bring nodes back empty", title: lossPredicted ? "Refused by the backend when loss is predicted" : undefined },
              ]}
            />
            {mode === "replace" && <p className="mt-1 text-2xs text-experiment">The nodes' data directories are wiped and repair must rebuild their shards. The backend falls back to restart if any file fails to read.</p>}
            {lossPredicted && <p className="mt-1 text-2xs text-faint">Replace is unavailable: the backend refuses it when loss is predicted.</p>}
          </div>
          {lossPredicted && mode === "replace" && <p className="text-lost">Replace mode is not allowed for this scenario.</p>}
        </ConfirmDialog>
      )}
    </Panel>
  );
}

function RunningCard({ nodes, mode, scenarioId, startedAt }: { nodes: string[]; mode: string; scenarioId: string; startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return (
    <Panel title="Experiment running" className="experiment-frame">
      <div role="status" aria-live="polite" className="space-y-2 text-sm">
        <FactChip kind="in_progress" />
        <div className="flex items-center gap-2 text-experiment">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          Stopping {nodes.join(", ")} ({mode}) · {((now - startedAt) / 1000).toFixed(1)} s elapsed
        </div>
        <p className="text-muted">
          The backend runs the whole scenario in one request: stop, read and hash every file, restore, repair, verify. It reports no
          progress until it finishes, so no intermediate steps are shown. Status polling is paused.
        </p>
        <p className="font-mono text-2xs text-faint">confirm = {scenarioId}</p>
      </div>
    </Panel>
  );
}

function DoneCard({ report }: { report: ScenarioReport }) {
  const ui = useUi();
  const c = countRecovered(report);
  return (
    <Panel title="Experiment result (backend report)" className="experiment-frame">
      <div className="space-y-2 text-sm">
        <div className={cx("rounded p-2 font-medium", report.prediction_matched ? "bg-healthy/10 text-healthy" : "bg-lost/10 text-lost")}>
          Prediction {report.prediction_matched ? "matched reality" : `did not match for ${report.mismatches.length} file(s)`}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted">Predicted recoverable</dt>
          <dd>{c.predicted}/{c.total}</dd>
          <dt className="text-muted">Reconstructed + SHA-256 match</dt>
          <dd>{c.actual}/{c.total}</dd>
          <dt className="text-muted">Repair</dt>
          <dd>rebuilt {report.repair.repaired} · unrepaired {report.repair.unrepaired}</dd>
          <dt className="text-muted">Verification scrub</dt>
          <dd><Outcome value={report.verification.healthy} yes="healthy" no="not healthy" /></dd>
          <dt className="text-muted">Final readback</dt>
          <dd><Outcome value={report.all_files_intact_after} yes="all intact" no="not all intact" /></dd>
          {report.restore_errors.length > 0 && (
            <>
              <dt className="text-lost">Restore errors</dt>
              <dd className="text-lost">{report.restore_errors.join("; ")}</dd>
            </>
          )}
        </dl>
        <p className="text-2xs text-muted">{report.summary}</p>
        <div className="flex gap-2">
          <button
            className="btn-primary"
            onClick={() => {
              ui.selectRun(report.run_id);
              ui.setView("lab");
            }}
          >
            <FileCheck2 className="h-3.5 w-3.5" /> Open Proof of Survival
          </button>
          <button className="btn-ghost" onClick={() => ui.setExperiment({ phase: "idle" })}>
            Back to LIVE
          </button>
        </div>
      </div>
    </Panel>
  );
}

function FailedNotice({ error, nodes }: { error: unknown; nodes: string[] }) {
  const ui = useUi();
  const qc = useQueryClient();
  const is428 = error instanceof ApiRequestError && error.status === 428;
  return (
    <div className="mb-3 space-y-2">
      <ErrorPanel error={error} />
      {is428 && (
        <p className="text-sm text-muted">
          The shard state changed after the preview (the backend now expects <code className="font-mono">{error.expectedConfirm}</code>).
          Nothing was stopped. Review a fresh preview before running it.
        </p>
      )}
      {error instanceof ApiRequestError && error.status === 409 && <p className="text-sm text-muted">The backend refused the run; nothing was stopped.</p>}
      {!(error instanceof ApiRequestError) && (
        <p className="text-sm text-degraded">
          No report was received. The outcome on the server is unknown: check Scenario history and the node states before trying again.
        </p>
      )}
      <button
        className="btn-preview"
        onClick={() => {
          ui.setExperiment({ phase: "idle" });
          ui.setHypothetical(nodes);
          void qc.invalidateQueries({ queryKey: ["preview"] });
        }}
      >
        Preview {nodes.join(", ")} again
      </button>
    </div>
  );
}
