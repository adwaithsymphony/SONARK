/**
 * Evidence views of a stored scenario report (GET /api/scenarios/{run_id}).
 * Every stage, fact and verdict is derived from fields the backend wrote
 * (see sonark/scenario.py). Where the backend records nothing, the result
 * says "not reported" instead of inventing a value or a timestamp.
 */
import type { OutageResult, ScenarioReport, TimelineStep } from "../api/schemas";
import { formatDateTime } from "./format";

export type StageState = "succeeded" | "failed" | "partial" | "not_reported" | "not_reached";

export interface RecoveryStage {
  n: number;
  title: string;
  state: StageState;
  /** backend timestamp for the stage, or null when none was recorded */
  ts: string | null;
  summary: string;
  /** backend timeline actions / report fields this stage was read from */
  source: string;
  details: { label: string; value: string; state?: StageState }[];
}

const steps = (r: ScenarioReport, action: string): TimelineStep[] => r.timeline.filter((t) => t.action === action);
const field = <T>(t: TimelineStep | undefined, k: string): T | undefined => (t ? (t as Record<string, unknown>)[k] as T : undefined);

export function fileVerdict(o: OutageResult): { label: string; state: StageState } {
  if (o.error !== null || o.sha256_actual === null) return { label: "NOT RECONSTRUCTED", state: "failed" };
  if (o.sha256_match) return { label: o.reconstructed_chunks > 0 ? "RECONSTRUCTED · VERIFIED" : "READ · VERIFIED", state: "succeeded" };
  return { label: "RECONSTRUCTED · INTEGRITY FAILED", state: "failed" };
}

/** The nine stages of spec 6.F, mapped onto what the backend actually records. */
export function recoveryStages(r: ScenarioReport): RecoveryStage[] {
  const files = Object.entries(r.outage_results);
  const name = (fid: string) => r.initial_state.files[fid]?.name ?? fid.slice(0, 8);
  const downCheck = steps(r, "verified_nodes_down")[0];
  const retrieval = steps(r, "retrieval_attempted")[0];
  const downgraded = steps(r, "replace_downgraded")[0];
  const restored = steps(r, "node_restored");
  const restoreFailed = steps(r, "node_restore_failed");
  const repair = steps(r, "repair_ran")[0];
  const verify = steps(r, "verification_scrub")[0];
  const readback = steps(r, "final_readback")[0];
  const stopped = steps(r, "node_stopped");

  const stillUp = field<string[]>(downCheck, "still_up") ?? [];
  const decoded = files.filter(([, o]) => o.error === null);
  const failedDecode = files.filter(([, o]) => o.error !== null);
  const checked = files.filter(([, o]) => o.sha256_actual !== null);
  const mismatched = checked.filter(([, o]) => !o.sha256_match);

  const stages: RecoveryStage[] = [
    {
      n: 1,
      title: "Node failure detected",
      state: !downCheck ? "not_reached" : stillUp.length ? "failed" : "succeeded",
      ts: downCheck?.ts ?? null,
      summary: !downCheck
        ? "No down-check was recorded."
        : stillUp.length
          ? `Still answering after stop: ${stillUp.join(", ")}`
          : `Backend confirmed ${r.nodes.join(", ")} no longer answer health checks.`,
      source: "timeline: node_stopped, verified_nodes_down",
      details: stopped.map((t) => ({ label: `stopped ${String(field(t, "node_id"))}`, value: formatDateTime(t.ts) })),
    },
    {
      n: 2,
      title: "File retrieval initiated",
      state: retrieval ? "not_reported" : "not_reached",
      ts: null,
      summary: retrieval
        ? "Reads began after the down-check; the backend records no separate start time for retrieval."
        : "No retrieval was recorded.",
      source: "not recorded by the backend",
      details: [],
    },
    {
      n: 3,
      title: "Surviving shards located",
      state: retrieval ? "partial" : "not_reached",
      ts: null,
      summary: "The backend reports shard problems per file, not the list of surviving shards or their nodes.",
      source: "outage_results[].shard_issues",
      details: files.map(([fid, o]) => ({
        label: name(fid),
        value: Object.entries(o.shard_issues).map(([k, v]) => `${k}×${v}`).join(" ") || "no shard issues reported",
      })),
    },
    {
      n: 4,
      title: "Reconstruction attempted",
      state: !retrieval ? "not_reached" : failedDecode.length === 0 ? "succeeded" : "failed",
      ts: retrieval?.ts ?? null,
      summary: retrieval
        ? `${decoded.length}/${files.length} file(s) decoded; ${failedDecode.length} could not be (timestamp is when retrieval finished). Per-stripe progress is not reported.`
        : "Not reached.",
      source: "outage_results[].error, reconstructed_chunks; timeline: retrieval_attempted",
      details: files.map(([fid, o]) => ({
        label: name(fid),
        value: o.error ? `failed: ${o.error}` : `decoded · ${o.reconstructed_chunks} chunk(s) rebuilt from parity · read ${o.elapsed_ms} ms`,
        state: o.error ? "failed" : "succeeded",
      })),
    },
    {
      n: 5,
      title: "SHA-256 checked against original",
      state: !retrieval ? "not_reached" : mismatched.length ? "failed" : checked.length === files.length ? "succeeded" : checked.length ? "partial" : "not_reached",
      ts: retrieval?.ts ?? null,
      summary: !retrieval
        ? "Not reached."
        : checked.length === 0
          ? `No file was recovered, so there was nothing to hash (${files.length} file(s)).`
          : `${checked.length - mismatched.length}/${checked.length} decoded file(s) match the original hash${
              files.length > checked.length ? `; ${files.length - checked.length} had nothing to hash` : ""
            }.`,
      source: "outage_results[].sha256_expected, sha256_actual, sha256_match",
      details: files.map(([fid, o]) => ({ label: name(fid), value: fileVerdict(o).label, state: fileVerdict(o).state })),
    },
    {
      n: 6,
      title: "Recovery outcome recorded",
      state: retrieval ? (r.prediction_matched ? "succeeded" : "failed") : "not_reached",
      ts: retrieval?.ts ?? null,
      summary: retrieval
        ? `Recovered ${String(field(retrieval, "recovered") ?? "—")}/${String(field(retrieval, "files") ?? files.length)} · prediction ${r.prediction_matched ? "matched" : `did not match for ${r.mismatches.length} file(s)`}${
            downgraded ? ` · replace downgraded to restart: ${String(field(downgraded, "reason"))}` : ""
          }`
        : "Not reached.",
      source: "timeline: retrieval_attempted, replace_downgraded; prediction_matched, mismatches",
      details: [],
    },
    {
      n: 7,
      title: "Nodes restored",
      state: restoreFailed.length || r.restore_errors.length ? "failed" : restored.length ? "succeeded" : "not_reached",
      ts: restored.at(-1)?.ts ?? restoreFailed.at(-1)?.ts ?? null,
      summary: restoreFailed.length || r.restore_errors.length
        ? `Restore errors: ${r.restore_errors.join("; ")}`
        : `${restored.length}/${r.nodes.length} node(s) restarted (${r.restore_mode}).`,
      source: "timeline: node_restored, node_restore_failed; restore_errors",
      details: [
        ...restored.map((t) => ({ label: String(field(t, "node_id")), value: `${formatDateTime(t.ts)}${field(t, "wiped") ? " · data wiped (replace)" : ""}`, state: "succeeded" as StageState })),
        ...restoreFailed.map((t) => ({ label: String(field(t, "node_id")), value: String(field(t, "error")), state: "failed" as StageState })),
      ],
    },
    {
      n: 8,
      title: "Repair performed",
      state: !repair ? "not_reached" : r.repair.unrepaired === 0 ? "succeeded" : "failed",
      ts: repair?.ts ?? null,
      summary: repair
        ? `Backend rebuilt ${r.repair.repaired} shard(s); ${r.repair.unrepaired} could not be repaired; ${r.repair.issues} issue(s) found while scanning ${r.repair.shards_checked} shards.`
        : "Not reached.",
      source: "timeline: repair_ran; repair",
      details: r.repair.details.slice(0, 50).map((d) => ({
        label: `${name(d.file_id)} c${d.chunk_index}/s${d.shard_index} @${d.node_id}`,
        value: `${d.kind} → ${d.resolution || "no resolution"}`,
      })),
    },
    {
      n: 9,
      title: "Post-repair integrity checked",
      state: !verify ? "not_reached" : r.verification.healthy && r.all_files_intact_after ? "succeeded" : "failed",
      ts: readback?.ts ?? verify?.ts ?? null,
      summary: verify
        ? `Verification scrub ${r.verification.healthy ? "healthy" : "NOT healthy"} (${r.verification.issues} issue(s), ${r.verification.lost_chunks.length} lost chunk(s)); final readback ${
            r.all_files_intact_after ? "all files intact" : "NOT all intact"
          }.`
        : "Not reached.",
      source: "timeline: verification_scrub, final_readback; verification, final_integrity",
      details: Object.entries(r.final_integrity).map(([fid, f]) => ({
        label: name(fid),
        value: f.recovered && f.sha256_match ? "intact (SHA-256 match)" : `not intact${f.error ? `: ${f.error}` : ""}`,
        state: f.recovered && f.sha256_match ? "succeeded" : "failed",
      })),
    },
  ];
  return stages;
}

export type FactKind =
  | "hypothetical_preview"
  | "confirmed"
  | "experiment_executed"
  | "observed_failure"
  | "reconstruction_succeeded"
  | "reconstruction_failed"
  | "verified_recovery"
  | "integrity_failed"
  | "repair_completed"
  | "repair_incomplete";

export interface LedgerFact {
  kind: FactKind;
  detail: string;
  source: string;
}

/**
 * Scenario state ledger (spec 6.E): one row per fact. A run can carry several,
 * e.g. reconstruction succeeded for some files and failed for others.
 */
export function ledger(r: ScenarioReport): LedgerFact[] {
  const files = Object.values(r.outage_results);
  const decoded = files.filter((o) => o.error === null);
  const failed = files.filter((o) => o.error !== null);
  const verified = files.filter((o) => o.sha256_actual !== null && o.sha256_match);
  const mismatch = files.filter((o) => o.sha256_actual !== null && !o.sha256_match);
  const down = steps(r, "verified_nodes_down")[0];
  const out: LedgerFact[] = [
    { kind: "hypothetical_preview", detail: r.prediction.explanation, source: "prediction" },
    { kind: "confirmed", detail: `Executed with confirmation ${r.scenario_id}`, source: "scenario_id" },
    { kind: "experiment_executed", detail: `${formatDateTime(r.started_at)} → ${formatDateTime(r.finished_at)} · mode ${r.mode}${r.restore_mode !== r.mode ? ` (restored as ${r.restore_mode})` : ""}`, source: "started_at, finished_at" },
  ];
  if (down && (field<string[]>(down, "still_up") ?? []).length === 0)
    out.push({ kind: "observed_failure", detail: `${r.nodes.join(", ")} confirmed not answering at ${formatDateTime(down.ts)}`, source: "timeline: verified_nodes_down" });
  if (decoded.length) out.push({ kind: "reconstruction_succeeded", detail: `${decoded.length}/${files.length} file(s) decoded`, source: "outage_results[].error" });
  if (failed.length) out.push({ kind: "reconstruction_failed", detail: `${failed.length}/${files.length} file(s) could not be decoded`, source: "outage_results[].error" });
  if (verified.length) out.push({ kind: "verified_recovery", detail: `${verified.length} file(s) hash-identical to the original`, source: "outage_results[].sha256_match" });
  if (mismatch.length) out.push({ kind: "integrity_failed", detail: `${mismatch.length} decoded file(s) did not match the original hash`, source: "outage_results[].sha256_match" });
  out.push(
    r.repair.unrepaired === 0 && r.verification.healthy
      ? { kind: "repair_completed", detail: `${r.repair.repaired} shard(s) rebuilt; verification scrub healthy`, source: "repair, verification" }
      : { kind: "repair_incomplete", detail: `${r.repair.unrepaired} unrepaired; verification ${r.verification.healthy ? "healthy" : "not healthy"}`, source: "repair, verification" },
  );
  return out;
}

export interface DiffSegment {
  text: string;
  same: boolean;
}

/** Character-level comparison of two hex digests, for aligned display. */
export function hashDiff(expected: string, actual: string): { a: DiffSegment[]; b: DiffSegment[]; firstDiff: number | null } {
  const len = Math.max(expected.length, actual.length);
  const a: DiffSegment[] = [];
  const b: DiffSegment[] = [];
  let firstDiff: number | null = null;
  const push = (arr: DiffSegment[], ch: string, same: boolean) => {
    const last = arr.at(-1);
    if (last && last.same === same) last.text += ch;
    else arr.push({ text: ch, same });
  };
  for (let i = 0; i < len; i++) {
    const x = expected[i] ?? "";
    const y = actual[i] ?? "";
    const same = x === y;
    if (!same && firstDiff === null) firstDiff = i;
    if (x) push(a, x, same);
    if (y) push(b, y, same);
  }
  return { a, b, firstDiff };
}
