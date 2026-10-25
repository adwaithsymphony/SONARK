import { ChevronDown, ChevronRight, Download, FlaskConical, Printer } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useEvents, useFiles, useHealth, useScenario, useScenarios } from "../api/queries";
import type { OutageResult, ScenarioReport, SonarkEvent } from "../api/schemas";
import { HashCompare, Ledger, RecoveryTimeline, stageMeta } from "../components/evidence/Evidence";
import { sha256Hex } from "../lib/download";
import { fileVerdict, ledger, recoveryStages } from "../lib/evidence";
import { durationMs, formatBytes, formatDateTime, formatMs, formatTime } from "../lib/format";
import { useUi } from "../state/ui";
import { Empty, ErrorPanel, Freshness, Hash, KV, Loading, Outcome, Panel, cx } from "../components/common/ui";
import { countRecovered } from "./Experiment";

export default function LabView() {
  const runs = useScenarios();
  const ui = useUi();
  const selected = ui.selectedRun ?? runs.data?.scenarios[0]?.run_id ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      <div className="flex w-full shrink-0 flex-col rounded-md border border-line bg-surface lg:w-72">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 className="label">Scenario history</h2>
          <span className="ml-auto"><Freshness updatedAt={runs.dataUpdatedAt} isError={runs.isError} /></span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {runs.isLoading ? (
            <div className="p-3"><Loading /></div>
          ) : !runs.data ? (
            <div className="p-3"><ErrorPanel error={runs.error} onRetry={() => void runs.refetch()} /></div>
          ) : runs.data.scenarios.length === 0 ? (
            <div className="p-3">
              <Empty>No scenarios have been run yet.</Empty>
              <button className="btn-preview" onClick={() => ui.setView("twin")}>
                <FlaskConical className="h-3.5 w-3.5" /> Go to Survival Twin
              </button>
            </div>
          ) : (
            <ul>
              {runs.data.scenarios.map((r) => (
                <li key={r.run_id}>
                  <button
                    onClick={() => ui.selectRun(r.run_id)}
                    aria-current={selected === r.run_id}
                    className={cx("w-full border-b border-line px-3 py-2 text-left hover:bg-raised", selected === r.run_id && "bg-raised")}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-ink">{r.nodes.join(", ")}</span>
                      <span className="chip text-muted">{r.mode}</span>
                      <span className={cx("ml-auto text-2xs", r.prediction_matched ? "text-healthy" : "text-lost")}>
                        {r.prediction_matched ? "✓ matched" : "✕ mismatch"}
                      </span>
                    </div>
                    <div className="mt-0.5 whitespace-nowrap font-mono text-2xs text-faint">{r.run_id}</div>
                    <div className="whitespace-nowrap font-mono text-2xs text-faint">{formatDateTime(r.ts)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {selected ? <Proof runId={selected} /> : <Empty>Select a scenario run.</Empty>}
      </div>
    </div>
  );
}

function Proof({ runId }: { runId: string }) {
  const q = useScenario(runId);
  if (q.isLoading) return <Loading label={`Loading report ${runId}`} />;
  if (!q.data) return <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />;
  return <ProofOfSurvival r={q.data} />;
}

export function ProofOfSurvival({ r }: { r: ScenarioReport }) {
  const c = countRecovered(r);
  const dur = durationMs(r.started_at, r.finished_at);
  const health = useHealth();
  const files = useFiles();
  const stages = useMemo(() => recoveryStages(r), [r]);
  const facts = useMemo(() => ledger(r), [r]);
  const [exportHash, setExportHash] = useState<{ sha: string | null; at: string } | null>(null);

  // The export is the backend report wrapped with who produced the file and when.
  const exportJson = async () => {
    const at = new Date().toISOString();
    const text = JSON.stringify(
      { exported_by: `SONARK frontend: unsigned export of GET /api/scenarios/${r.run_id}`, exported_at: at, report: r },
      null,
      2,
    );
    const sha = await sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer);
    setExportHash({ sha, at });
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sonark-${r.run_id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const ecFor = (fid: string) => {
    const f = files.data?.files.find((x) => x.file_id === fid);
    return f ? `${f.k}+${f.m}` : null;
  };

  return (
    <article className="proof-print space-y-3" aria-label={`Proof of Survival for ${r.run_id}`}>
      <header className="rounded-md border border-experiment/60 bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-2xs font-semibold tracking-[0.18em] text-experiment">EXPERIMENT · ACTUAL — CLUSTER WAS MODIFIED</span>
          <div className="no-print ml-auto flex flex-wrap gap-1">
            <button className="btn-ghost" onClick={() => void exportJson()} title="Download the backend report as JSON (frontend export, not signed)">
              <Download className="h-3.5 w-3.5" /> Export JSON
            </button>
            <button className="btn-ghost" onClick={() => window.print()} title="Print, or save as PDF from the print dialog (generated by your browser)">
              <Printer className="h-3.5 w-3.5" /> Print / PDF
            </button>
          </div>
        </div>
        <h2 className="editorial mt-2 text-4xl leading-[48px]">Proof of Survival</h2>
        <p className="mt-1 text-sm">
          Failed <span className="font-mono text-experiment">{r.nodes.join(", ")}</span> ({r.mode}
          {r.restore_mode !== r.mode && <span className="text-degraded"> → restored as {r.restore_mode}</span>}).{" "}
          <span className="text-muted">{r.summary}</span>
        </p>
        <dl className="mt-3 grid gap-x-6 text-2xs sm:grid-cols-2">
          <KV k="Scenario (confirmation)" mono>{r.scenario_id}</KV>
          <KV k="Run" mono>{r.run_id}</KV>
          <KV k="Executed">
            {formatDateTime(r.started_at)} → {formatTime(r.finished_at)}
          </KV>
          <KV k="Run duration">{dur === null ? "— not measured" : `${formatMs(dur)} (from report timestamps)`}</KV>
          <KV k="Operator">
            <span className="text-faint">— not reported (the API has no users)</span>
          </KV>
          <KV k="Cluster ID">
            <span className="text-faint">— not reported by the backend</span>
          </KV>
          <KV k="Backend version">
            {health.data ? (
              <>
                {health.data.version} <span className="text-faint">(server answering now; the report does not record it)</span>
              </>
            ) : (
              <span className="text-faint">— server not reachable</span>
            )}
          </KV>
          <KV k="Report source" mono>
            GET /api/scenarios/{r.run_id}
          </KV>
        </dl>
        {exportHash && (
          <div className="mt-2 rounded-sm border border-line p-2 text-2xs">
            <div className="text-muted">
              Exported at {formatDateTime(exportHash.at)}. SHA-256 of the exported file, computed by this browser. This is a checksum, not a signature.
            </div>
            <Hash value={exportHash.sha} label="export SHA-256" />
          </div>
        )}
      </header>

      <Panel title="State ledger · one row per recorded fact">
        <Ledger facts={facts} />
      </Panel>

      <Panel title="Configuration">
        <dl className="grid gap-x-6 text-xs sm:grid-cols-2">
          <KV k="Target nodes" mono>{r.nodes.join(", ")}</KV>
          <KV k="Mode">
            {r.mode}
            {r.restore_mode !== r.mode ? ` (restored as ${r.restore_mode})` : ""}
          </KV>
          <KV k="Nodes up before">{Object.entries(r.initial_state.nodes).map(([n, up]) => `${n}${up ? "" : " (down)"}`).join(", ")}</KV>
          <KV k="Files in scope">{c.total}</KV>
        </dl>
        <ul className="mt-2 grid gap-x-6 text-2xs sm:grid-cols-2">
          {Object.entries(r.initial_state.files).map(([fid, f]) => (
            <li key={fid} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="font-mono text-muted">{formatBytes(f.size)}</span>
              <span className="font-mono text-muted" title="Coding is not in the report; shown from current metadata when the file still exists">
                {ecFor(fid) ?? "EC —"}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Prediction vs reality, per file (during the outage)" bodyClass="p-0">
        <OutcomeTable r={r} />
      </Panel>

      <div className="grid gap-3 xl:grid-cols-[1.2fr_1fr]">
        <Panel title="Recovery and verification timeline">
          <RecoveryTimeline stages={stages} />
          <p className="mt-2 text-2xs text-faint">
            Stages map onto the steps the backend records. Stages it does not record are marked “not reported”, never filled in.
          </p>
        </Panel>
        <div className="space-y-3">
          <Panel title="Hashes · original vs recovered">
            <ul className="space-y-3">
              {Object.entries(r.outage_results).map(([fid, o]) => (
                <li key={fid}>
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    <VerdictChip o={o} />
                  </div>
                  <HashCompare expected={o.sha256_expected} actual={o.sha256_actual} />
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Final state (after restore and repair)">
            <dl className="text-xs">
              <KV k="Restore">
                {r.restore_errors.length ? <span className="text-lost">{r.restore_errors.join("; ")}</span> : `all ${r.nodes.length} node(s) restarted`}
              </KV>
              <KV k="Repair">
                rebuilt {r.repair.repaired} · unrepaired {r.repair.unrepaired} · {r.repair.shards_checked} shards scanned
              </KV>
              <KV k="Verification scrub">
                <Outcome value={r.verification.healthy} yes="healthy" no="not healthy" /> · {r.verification.shards_checked} shards · {r.verification.issues} issues
              </KV>
              <KV k="Final readback">
                <Outcome value={r.all_files_intact_after} yes="all files intact" no="not all files intact" />
              </KV>
              <KV k="Node state now">
                <span className="text-faint">see the stage (LIVE); the report records only the restore steps</span>
              </KV>
            </dl>
          </Panel>
        </div>
      </div>

      <RelatedEvents r={r} />
      <p className="text-2xs text-faint">
        Every value comes from the backend's stored report except where marked. Exports and prints are produced by this frontend and are not signed.
      </p>
    </article>
  );
}

function VerdictChip({ o }: { o: OutageResult }) {
  const v = fileVerdict(o);
  return (
    <span className={cx("chip border", stageMeta[v.state].cls)}>
      {stageMeta[v.state].glyph} {v.label}
    </span>
  );
}

function OutcomeTable({ r }: { r: ScenarioReport }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = Object.entries(r.outage_results);
  return (
    <div className="overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="table-head px-3 py-2">File</th>
            <th className="table-head px-2 py-2 text-preview">Predicted</th>
            <th className="table-head px-2 py-2">Retrieval</th>
            <th className="table-head px-2 py-2">Reconstruction</th>
            <th className="table-head px-2 py-2">Integrity (SHA-256)</th>
            <th className="table-head px-2 py-2">Match?</th>
            <th className="table-head px-2 py-2 text-right">Read time</th>
            <th className="table-head px-2 py-2">After repair</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([fid, o]) => {
            const fin = r.final_integrity[fid];
            const isOpen = open === fid;
            return (
              <Fragment key={fid}>
                <tr className="row-hover" onClick={() => setOpen(isOpen ? null : fid)} aria-expanded={isOpen}>
                  <td className="border-b border-line px-3 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      {isOpen ? <ChevronDown className="no-print h-3 w-3" /> : <ChevronRight className="no-print h-3 w-3" />}
                      {o.name}
                    </span>
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <span className="rounded-sm border border-dashed border-preview/60 px-1 text-preview">
                      {o.predicted_recoverable ? "recoverable" : "unrecoverable"}
                    </span>
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <Outcome value={o.error === null} yes={`${o.bytes_read.toLocaleString()} B read`} no="failed" />
                  </td>
                  <td className="border-b border-line px-2 py-1.5 font-mono">
                    {o.error !== null ? (
                      <span className="text-lost">not reconstructed</span>
                    ) : o.reconstructed_chunks > 0 ? (
                      `${o.reconstructed_chunks} chunk(s) rebuilt`
                    ) : (
                      "direct read (no rebuild needed)"
                    )}
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <VerdictChip o={o} />
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    {o.prediction_matched ? <span className="text-healthy">✓ match</span> : <span className="font-semibold text-lost">✕ MISMATCH</span>}
                  </td>
                  <td className="border-b border-line px-2 py-1.5 text-right font-mono">{formatMs(o.elapsed_ms)}</td>
                  <td className="border-b border-line px-2 py-1.5">
                    <Outcome value={fin ? fin.recovered && fin.sha256_match : null} yes="intact" no="not intact" why="not in report" />
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={8} className="border-b border-line bg-bg/60 px-4 py-2">
                      <HashCompare expected={o.sha256_expected} actual={o.sha256_actual} />
                      <dl className="mt-2">
                        <KV k="Shard issues" mono>
                          {Object.entries(o.shard_issues).map(([k, v]) => `${k}×${v}`).join(" ") || "none"}
                        </KV>
                        {o.error && (
                          <KV k="Decoder error">
                            <span className="font-mono text-2xs text-lost">{o.error}</span>
                          </KV>
                        )}
                        {!o.prediction_matched && (
                          <KV k="Mismatch">
                            <span className="text-lost">
                              Predicted {o.predicted_recoverable ? "recoverable" : "unrecoverable"}, observed {o.actual_recoverable ? "recoverable" : "unrecoverable"}.
                            </span>
                          </KV>
                        )}
                        {fin?.error && (
                          <KV k="Final readback error">
                            <span className="font-mono text-2xs text-lost">{fin.error}</span>
                          </KV>
                        )}
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RelatedEvents({ r }: { r: ScenarioReport }) {
  const events = useEvents(true);
  const related = useMemo(() => {
    const t0 = Date.parse(r.started_at) - 1000; // event timestamps have 1 s resolution
    const t1 = Date.parse(r.finished_at) + 1000;
    return (events.data?.events ?? []).filter((e: SonarkEvent) => {
      const d = e.detail as { run_id?: string } | null;
      if (d && typeof d === "object" && d.run_id === r.run_id) return true;
      const t = Date.parse(e.ts);
      return t >= t0 && t <= t1;
    });
  }, [events.data, r]);
  return (
    <Panel title="Event log during this run">
      {events.isLoading ? (
        <Loading />
      ) : related.length === 0 ? (
        <Empty>No matching events in the latest 200 (older runs may have scrolled out of the log window).</Empty>
      ) : (
        <ul className="space-y-0.5 font-mono text-2xs">
          {related.map((e, i) => (
            <li key={i} className="grid grid-cols-[5rem_8rem_1fr] gap-2">
              <span className="text-faint">{formatTime(e.ts)}</span>
              <span className="text-ink">{e.kind}</span>
              <span className="truncate text-muted">{typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
