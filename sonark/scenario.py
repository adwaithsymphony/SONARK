"""Controlled failure scenarios: predict, break, retrieve, prove, restore, repair.

A scenario fails real node processes through the NodeSupervisor, then tries
to read every file back through the real read path (Reed-Solomon decode plus
SHA-256 checks), and compares the outcome with the Survival Twin prediction.

Safety rules
  * The caller must first preview the scenario and pass back its scenario_id
    as `confirm`. The id covers the node set and a fingerprint of the current
    shard state, so a stale confirmation (state changed since preview) fails.
  * Only nodes started by this process's supervisor can be failed.
  * mode="restart" brings nodes back with their data intact.
  * mode="replace" brings them back EMPTY, so redundancy must be rebuilt by
    repair. It is refused unless every file is predicted to survive, and it is
    downgraded to a restart if any file actually failed to read during the outage.
  * Nodes are always restored, even if the run raises.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from datetime import datetime, timezone

from .store import DataLossError, ReadReport, Sonark, SonarkError
from .supervisor import NodeSupervisor, NotManaged
from .twin import observe, preview

MODES = ("restart", "replace")


class ConfirmationRequired(SonarkError):
    def __init__(self, message: str, expected: str | None = None, preview: dict | None = None):
        super().__init__(message)
        self.expected = expected
        self.preview = preview


class ScenarioConflict(SonarkError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def read_and_hash(store: Sonark, file_id: str, expected: str) -> dict:
    """Read a file through the real read path and hash what came back."""
    start = time.perf_counter()
    report = ReadReport(store._resolve(file_id))
    h = hashlib.sha256()
    size = 0
    try:
        for data in store.iter_chunks(file_id, report):
            h.update(data)
            size += len(data)
    except DataLossError as e:
        return {"recovered": False, "error": str(e), "bytes_read": size,
                "sha256_actual": None, "sha256_match": False,
                "reconstructed_chunks": report.reconstructed_chunks,
                "shard_issues": _issue_counts(report),
                "elapsed_ms": round((time.perf_counter() - start) * 1000, 1)}
    actual = h.hexdigest()
    return {"recovered": actual == expected, "error": None, "bytes_read": size,
            "sha256_actual": actual, "sha256_match": actual == expected,
            "reconstructed_chunks": report.reconstructed_chunks,
            "shard_issues": _issue_counts(report),
            "elapsed_ms": round((time.perf_counter() - start) * 1000, 1)}


def _issue_counts(report: ReadReport) -> dict[str, int]:
    counts: dict[str, int] = {}
    for issue in report.issues:
        counts[issue.kind] = counts.get(issue.kind, 0) + 1
    return counts


def _scrub_summary(r) -> dict:
    return {"files_checked": r.files_checked, "shards_checked": r.shards_checked,
            "issues": len(r.issues), "repaired": r.repaired, "unrepaired": r.unrepaired,
            "lost_chunks": [{"file_id": f, "chunk_index": c} for f, c in r.lost_chunks],
            "healthy": r.healthy,
            "details": [{"file_id": i.file_id, "chunk_index": i.chunk_index,
                         "shard_index": i.shard_index, "node_id": i.node_id,
                         "kind": i.kind, "resolution": i.resolution} for i in r.issues[:200]]}


def run_scenario(store: Sonark, supervisor: NodeSupervisor, nodes: list[str],
                 confirm: str | None, mode: str = "restart") -> dict:
    nodes = sorted(set(nodes))
    if not nodes:
        raise SonarkError("scenario needs at least one node")
    if mode not in MODES:
        raise SonarkError(f"mode must be one of {MODES}")
    for nid in nodes:
        if nid not in store.clients:
            raise SonarkError(f"unknown node: {nid}")
        if not supervisor.managed(nid):
            raise NotManaged(f"{nid} is not managed by this server; cannot fail it")
        if not supervisor.running(nid):
            raise ScenarioConflict(f"{nid} is already stopped; restore it before a scenario")

    snap = observe(store, verify=True)
    prediction = preview(snap, nodes)
    if confirm != prediction["scenario_id"]:
        raise ConfirmationRequired(
            "confirmation required: preview this scenario and pass its scenario_id as "
            "'confirm'" + (" (cluster state changed since that preview)" if confirm else ""),
            expected=prediction["scenario_id"], preview=prediction)
    if mode == "replace" and not all(prediction["predictions"].values()):
        raise ScenarioConflict("mode 'replace' refused: the prediction says some files would "
                               "be lost, and wiping the nodes would make that permanent")

    run_id = "run-" + uuid.uuid4().hex[:12]
    timeline: list[dict] = []

    def step(action: str, **info) -> None:
        timeline.append({"ts": _now(), "action": action, **info})

    files = {f.file_id: f for f in snap.files}
    initial = {
        "nodes": dict(sorted(snap.nodes.items())),
        "files": {fid: {"name": f.name, "sha256": f.sha256, "size": f.size}
                  for fid, f in files.items()},
    }
    store.meta.log("scenario_start", detail=json.dumps(
        {"run_id": run_id, "scenario_id": prediction["scenario_id"],
         "nodes": nodes, "mode": mode}))
    step("recorded_initial_state", files=len(files))

    results: dict[str, dict] = {}
    restore_mode = mode
    restore_errors: list[str] = []
    try:
        for nid in nodes:
            supervisor.stop(nid)
            step("node_stopped", node_id=nid)
        health = store.node_health()
        still_up = [n for n in nodes if health.get(n)]
        step("verified_nodes_down", still_up=still_up)
        if still_up:
            raise ScenarioConflict(f"nodes still answering after stop: {still_up}")

        for fid, f in files.items():
            outcome = read_and_hash(store, fid, f.sha256)
            predicted = prediction["predictions"][fid]
            actual = outcome["recovered"] and outcome["sha256_match"]
            results[fid] = {"name": f.name, "sha256_expected": f.sha256,
                            "predicted_recoverable": predicted,
                            "actual_recoverable": actual,
                            "prediction_matched": predicted == actual, **outcome}
        step("retrieval_attempted", files=len(results),
             recovered=sum(r["actual_recoverable"] for r in results.values()))
        if mode == "replace" and not all(r["actual_recoverable"] for r in results.values()):
            restore_mode = "restart"
            step("replace_downgraded", reason="a file failed to read during the outage; "
                                              "restarting with original data instead of wiping")
    finally:
        for nid in nodes:
            try:
                supervisor.start(nid, wipe=(restore_mode == "replace"))
                step("node_restored", node_id=nid, wiped=restore_mode == "replace")
            except SonarkError as e:
                restore_errors.append(f"{nid}: {e}")
                step("node_restore_failed", node_id=nid, error=str(e))

    repair = store.scrub(repair=True)
    step("repair_ran", repaired=repair.repaired, unrepaired=repair.unrepaired)
    verify = store.scrub()
    step("verification_scrub", healthy=verify.healthy)
    final = {fid: read_and_hash(store, fid, f.sha256) for fid, f in files.items()}
    step("final_readback", intact=sum(r["recovered"] for r in final.values()))

    matched = all(r["prediction_matched"] for r in results.values())
    report = {
        "run_id": run_id,
        "scenario_id": prediction["scenario_id"],
        "nodes": nodes,
        "mode": mode,
        "restore_mode": restore_mode,
        "started_at": timeline[0]["ts"],
        "finished_at": _now(),
        "initial_state": initial,
        "prediction": {"summary": prediction["summary"],
                       "predictions": prediction["predictions"],
                       "explanation": prediction["explanation"],
                       "files": prediction["files"]},
        "outage_results": results,
        "prediction_matched": matched,
        "mismatches": [fid for fid, r in results.items() if not r["prediction_matched"]],
        "restore_errors": restore_errors,
        "repair": _scrub_summary(repair),
        "verification": _scrub_summary(verify),
        "final_integrity": {fid: {"recovered": r["recovered"], "sha256_match": r["sha256_match"],
                                  "error": r["error"]} for fid, r in final.items()},
        "all_files_intact_after": all(r["recovered"] for r in final.values()),
        "timeline": timeline,
    }
    report["summary"] = (
        f"Failed {', '.join(nodes)}. Predicted {sum(prediction['predictions'].values())}/"
        f"{len(files)} files recoverable; actually recovered "
        f"{sum(r['actual_recoverable'] for r in results.values())}/{len(files)} with matching "
        f"SHA-256. Prediction {'MATCHED' if matched else 'DID NOT MATCH'}. "
        f"Restored ({restore_mode}); repair rebuilt {repair.repaired} shard(s); "
        f"cluster {'healthy' if verify.healthy else 'NOT healthy'} after repair.")
    store.meta.save_scenario(run_id, prediction["scenario_id"], nodes, mode, matched,
                             json.dumps(report))
    store.meta.log("scenario_end", detail=json.dumps(
        {"run_id": run_id, "matched": matched, "repaired": repair.repaired,
         "healthy_after": verify.healthy, "restore_errors": restore_errors}))
    return report
