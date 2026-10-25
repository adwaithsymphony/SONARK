"""Survival Twin: predicts which node failures each file survives.

The model works from real state, not from configuration:

  * A *snapshot* records, for every stripe (chunk) of every file, where each
    shard is and whether it is currently valid. Valid means it was fetched and
    matched its SHA-256 ("ok"), or, in a fast unverified snapshot, that it sits
    on a node that answered a health check ("unverified").
  * A stripe with parameters (k, m) is recoverable iff at least k of its
    shards are valid. Shards that are missing, corrupt or on an unreachable
    node do not count.
  * When a set F of nodes fails, a stripe loses every valid shard held on F.
    It survives iff  valid - sum(valid shards on n for n in F)  >=  k.
    Placement is read from metadata, so a node holding two shards of one
    stripe counts twice, and a node holding none counts zero.
  * A file survives F iff every one of its stripes survives F.

Failure sets
  A *loss set* for a file is a set of nodes whose joint failure makes the file
  unrecoverable. A *minimal loss set* is a loss set none of whose proper subsets
  is a loss set (inclusion-minimal). The *smallest* loss sets are the minimal
  ones of minimum size. *Fault tolerance* is (size of a smallest loss set) - 1:
  the file survives ANY combination of that many node failures, and there is
  at least one combination of one more that destroys it.

Algorithm
  For one stripe, give each node a weight w(n) = number of valid shards it
  holds and let need = valid - k + 1 (shards that must be lost). F is a loss
  set iff sum w(F) >= need. Because weights are positive, F is minimal iff it
  is a loss set and removing any single member drops it below need, and every
  minimal set has at most `need` members. We enumerate node combinations of
  size 1..need among the nodes holding valid shards. The minimum size is
  computed exactly and cheaply by taking the heaviest nodes first, so it is
  always exact even when enumeration is capped.
  File-level minimal sets are the inclusion-minimal members of the union of
  its stripes' minimal sets. Stripes with identical (weights, need) are
  analyzed once.

Limits
  Enumeration per stripe stops after `max_combinations` candidate checks. If
  it does, `complete` is false for that file. The smallest size and fault
  tolerance remain exact, but the listed sets may be incomplete. Reported set
  lists are truncated to `max_sets` entries, with the true count given.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from itertools import combinations
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:  # pragma: no cover
    from .store import Sonark

VALID_STATUSES = ("ok", "unverified")
SHARD_STATUSES = ("ok", "unverified", "missing", "corrupt", "node_down")
MAX_COMBINATIONS = 200_000
MAX_SETS = 50


@dataclass(frozen=True)
class ShardState:
    shard_index: int
    node_id: str
    status: str

    @property
    def valid(self) -> bool:
        return self.status in VALID_STATUSES


@dataclass
class StripeState:
    chunk_index: int
    k: int
    m: int
    shards: list[ShardState]

    @property
    def n(self) -> int:
        return self.k + self.m

    def weights(self, failed: frozenset[str] = frozenset()) -> dict[str, int]:
        """Valid shards per node, ignoring nodes in `failed`."""
        w: dict[str, int] = {}
        for s in self.shards:
            if s.valid and s.node_id not in failed:
                w[s.node_id] = w.get(s.node_id, 0) + 1
        return w

    def valid_count(self, failed: frozenset[str] = frozenset()) -> int:
        return sum(self.weights(failed).values())

    def without(self, failed: frozenset[str]) -> "StripeState":
        return StripeState(self.chunk_index, self.k, self.m, [
            ShardState(s.shard_index, s.node_id, "node_down")
            if s.node_id in failed and s.valid else s for s in self.shards])


@dataclass
class FileState:
    file_id: str
    name: str
    size: int
    sha256: str
    stripes: list[StripeState]


@dataclass
class Snapshot:
    taken_at: str
    verified: bool
    nodes: dict[str, bool]          # node id -> answered health check
    files: list[FileState] = field(default_factory=list)

    def fingerprint(self) -> str:
        h = hashlib.sha256()
        h.update(json.dumps(sorted(self.nodes.items())).encode())
        for f in sorted(self.files, key=lambda f: f.file_id):
            h.update(f.file_id.encode())
            for st in f.stripes:
                for s in st.shards:
                    h.update(f"{st.chunk_index}:{s.shard_index}:{s.node_id}:{s.status};".encode())
        return h.hexdigest()

    def file(self, file_id: str) -> FileState | None:
        return next((f for f in self.files if f.file_id == file_id), None)


# ---------------------------------------------------------------------------
# Observation (reads real state; never writes)


def observe(store: "Sonark", verify: bool = True,
            file_ids: Iterable[str] | None = None) -> Snapshot:
    """Build a snapshot from metadata plus live node state.

    verify=True fetches every shard and checks its SHA-256 (as scrub does).
    verify=False only checks node health; shards on reachable nodes are
    marked "unverified" and counted as valid.
    """
    health = store.node_health()
    snap = Snapshot(datetime.now(timezone.utc).isoformat(timespec="seconds"), verify, health)
    files = store.meta.list_files()
    if file_ids is not None:
        wanted = set(file_ids)
        files = [f for f in files if f.file_id in wanted]
    for f in files:
        stripes = []
        for chunk in store.meta.chunks(f.file_id):
            records = store.meta.shards(f.file_id, chunk.chunk_index)
            if verify:
                results = store.pool.map(store._fetch, records)
                shards = [ShardState(s.shard_index, s.node_id, problem or "ok")
                          for s, _data, problem in results]
            else:
                shards = [ShardState(s.shard_index, s.node_id,
                                     "unverified" if health.get(s.node_id) else "node_down")
                          for s in records]
            stripes.append(StripeState(chunk.chunk_index, f.k, f.m, shards))
        snap.files.append(FileState(f.file_id, f.name, f.size, f.sha256 or "", stripes))
    return snap


# ---------------------------------------------------------------------------
# Failure-set mathematics (pure)


def min_loss_size(weights: dict[str, int], need: int) -> int | None:
    """Exact size of a smallest node set whose weights sum to >= need."""
    if need <= 0:
        return 0
    total = 0
    for i, w in enumerate(sorted(weights.values(), reverse=True), 1):
        total += w
        if total >= need:
            return i
    return None  # cannot happen when need <= valid, kept for safety


def stripe_minimal_loss_sets(weights: dict[str, int], need: int,
                             max_combinations: int = MAX_COMBINATIONS
                             ) -> tuple[list[frozenset[str]], bool]:
    """All inclusion-minimal node sets with sum(weights) >= need.

    Returns (sets, complete). need <= 0 means the stripe is already lost:
    the empty set is the only minimal loss set.
    """
    if need <= 0:
        return [frozenset()], True
    nodes = sorted(weights)
    found: list[frozenset[str]] = []
    checked = 0
    for size in range(1, min(need, len(nodes)) + 1):
        for combo in combinations(nodes, size):
            checked += 1
            if checked > max_combinations:
                return found, False
            total = sum(weights[n] for n in combo)
            if total >= need and all(total - weights[n] < need for n in combo):
                found.append(frozenset(combo))
    return found, True


def _minimal(sets: Iterable[frozenset[str]]) -> list[frozenset[str]]:
    """Inclusion-minimal members of a family of sets."""
    ordered = sorted(set(sets), key=lambda s: (len(s), sorted(s)))
    out: list[frozenset[str]] = []
    for s in ordered:
        if not any(t <= s for t in out):
            out.append(s)
    return out


def _stripe_report(st: StripeState) -> dict:
    counts = {status: 0 for status in SHARD_STATUSES}
    for s in st.shards:
        counts[s.status] = counts.get(s.status, 0) + 1
    valid = st.valid_count()
    w = st.weights()
    need = valid - st.k + 1
    return {
        "chunk_index": st.chunk_index,
        "k": st.k, "m": st.m, "n": st.n,
        "valid": valid,
        "shard_status_counts": counts,
        "margin": valid - st.k,
        "recoverable": valid >= st.k,
        "valid_shards_per_node": dict(sorted(w.items())),
        "min_node_failures_to_lose": min_loss_size(w, need),
        "shards": [{"shard_index": s.shard_index, "node_id": s.node_id, "status": s.status}
                   for s in st.shards],
    }


def _status(stripes: list[dict], smallest: int | None) -> str:
    if any(not s["recoverable"] for s in stripes):
        return "lost"
    if smallest == 1:
        return "at_risk"
    if any(s["valid"] < s["n"] for s in stripes):
        return "degraded"
    return "healthy"


def file_minimal_loss_sets(fs: FileState, max_combinations: int = MAX_COMBINATIONS,
                           cache: dict | None = None) -> tuple[list[frozenset[str]], bool]:
    """All inclusion-minimal loss sets of a file (untruncated), and completeness.
    Stripes with the same (weights, need) profile are computed once via `cache`."""
    cache = {} if cache is None else cache
    candidates: list[frozenset[str]] = []
    complete = True
    for st in fs.stripes:
        w = st.weights()
        need = sum(w.values()) - st.k + 1
        key = (tuple(sorted(w.items())), need, max_combinations)
        if key not in cache:
            cache[key] = stripe_minimal_loss_sets(w, need, max_combinations)
        sets, ok = cache[key]
        complete &= ok
        candidates.extend(sets)
    return _minimal(candidates), complete


def analyze_file(fs: FileState, max_sets: int = MAX_SETS,
                 max_combinations: int = MAX_COMBINATIONS,
                 include_shards: bool = True, cache: dict | None = None) -> dict:
    stripes = [_stripe_report(st) for st in fs.stripes]
    minimal, complete = file_minimal_loss_sets(fs, max_combinations, cache)

    sizes = [min_loss_size(st.weights(), st.valid_count() - st.k + 1) for st in fs.stripes]
    smallest = min((s for s in sizes if s is not None), default=None)
    status = _status(stripes, smallest)

    def killed(nodes: frozenset[str]) -> list[int]:
        return [st.chunk_index for st in fs.stripes if st.valid_count(nodes) < st.k]

    design = min((st.m for st in fs.stripes), default=None)
    tolerance = None if smallest is None else smallest - 1
    report = {
        "file_id": fs.file_id,
        "name": fs.name,
        "size": fs.size,
        "sha256": fs.sha256,
        "stripe_count": len(fs.stripes),
        "coding": sorted({f"{st.k}+{st.m}" for st in fs.stripes}),
        "status": status,
        "recoverable": status != "lost",
        "fault_tolerance": tolerance,
        "design_tolerance": design,
        "placement_concentrated": (tolerance is not None and design is not None
                                   and status != "lost" and tolerance < design
                                   and all(s["valid"] == s["n"] for s in stripes)),
        "smallest_loss_set_size": smallest,
        "minimal_loss_sets_total": len(minimal),
        "minimal_loss_sets": [
            {"nodes": sorted(s), "size": len(s), "stripes_lost": killed(s)}
            for s in minimal[:max_sets]],
        "minimal_loss_sets_truncated": len(minimal) > max_sets,
        "enumeration_complete": complete,
        "explanation": _explain_file(fs, stripes, status, tolerance, minimal),
    }
    if include_shards:
        report["stripes"] = stripes
    else:
        report["stripes"] = [{k: v for k, v in s.items() if k != "shards"} for s in stripes]
    return report


def _explain_file(fs: FileState, stripes: list[dict], status: str,
                  tolerance: int | None, minimal: list[frozenset[str]]) -> str:
    if not stripes:
        return "Empty file: no stripes, nothing can be lost."
    if status == "lost":
        bad = [s for s in stripes if not s["recoverable"]]
        parts = ", ".join(f"chunk {s['chunk_index']} has {s['valid']} valid of {s['k']} needed"
                          for s in bad[:5])
        return f"Unrecoverable now: {parts}."
    worst = min(stripes, key=lambda s: s["margin"])
    text = (f"Recoverable. Survives any {tolerance} node failure(s). "
            f"Weakest stripe is chunk {worst['chunk_index']}: {worst['valid']} valid shards, "
            f"needs {worst['k']}.")
    if minimal:
        example = ", ".join(sorted(minimal[0]))
        text += f" Smallest fatal combination: {{{example}}}."
    if status == "at_risk":
        text += " A single node failure would cause data loss."
    return text


def analyze(snapshot: Snapshot, max_sets: int = MAX_SETS,
            include_shards: bool = False) -> dict:
    """Survival analysis for every file plus cluster-wide loss sets."""
    cache: dict = {}
    files = [analyze_file(f, max_sets=max_sets, include_shards=include_shards, cache=cache)
             for f in snapshot.files]
    union: list[frozenset[str]] = []
    complete = True
    for f in snapshot.files:
        sets, ok = file_minimal_loss_sets(f, cache=cache)
        union.extend(sets)
        complete &= ok
    cluster_min = _minimal(union)
    fs_by_id = {f.file_id: f for f in snapshot.files}

    def lost_files(nodes: frozenset[str]) -> list[str]:
        return [fid for fid, f in fs_by_id.items()
                if any(st.valid_count(nodes) < st.k for st in f.stripes)]

    sizes = [f["smallest_loss_set_size"] for f in files
             if f["smallest_loss_set_size"] is not None]
    counts = {s: 0 for s in ("healthy", "degraded", "at_risk", "lost")}
    for f in files:
        counts[f["status"]] += 1
    return {
        "snapshot": {"taken_at": snapshot.taken_at, "verified": snapshot.verified,
                     "fingerprint": snapshot.fingerprint()},
        "nodes": [{"node_id": n, "up": up} for n, up in sorted(snapshot.nodes.items())],
        "summary": {
            "files": len(files),
            "status_counts": counts,
            "recoverable_files": sum(f["recoverable"] for f in files),
            "cluster_fault_tolerance": (min(sizes) - 1) if sizes else None,
            "smallest_loss_set_size": min(sizes) if sizes else None,
        },
        "cluster_minimal_loss_sets": [
            {"nodes": sorted(s), "size": len(s), "files_lost": lost_files(s)}
            for s in cluster_min[:max_sets]],
        "cluster_minimal_loss_sets_total": len(cluster_min),
        "cluster_minimal_loss_sets_truncated": len(cluster_min) > max_sets,
        "enumeration_complete": complete,
        "files": files,
    }


# ---------------------------------------------------------------------------
# Scenario preview (pure, non-destructive)


def scenario_id(snapshot: Snapshot, nodes: Iterable[str]) -> str:
    payload = json.dumps(sorted(set(nodes))) + snapshot.fingerprint()
    return "scn-" + hashlib.sha256(payload.encode()).hexdigest()[:12]


def preview(snapshot: Snapshot, nodes: Iterable[str]) -> dict:
    """Predict the effect of failing `nodes` together. Changes nothing."""
    failed = frozenset(nodes)
    if not failed:
        raise ValueError("scenario needs at least one node")
    unknown = sorted(failed - set(snapshot.nodes))
    if unknown:
        raise ValueError(f"unknown node(s): {', '.join(unknown)}")
    already_down = sorted(n for n in failed if not snapshot.nodes[n])

    affected, unaffected = [], 0
    predictions: dict[str, bool] = {}
    for fs in snapshot.files:
        hit = [st for st in fs.stripes if st.weights().keys() & failed]
        before = analyze_file(fs, max_sets=5, include_shards=False)
        if not hit:
            unaffected += 1
            predictions[fs.file_id] = before["recoverable"]
            continue
        after_fs = FileState(fs.file_id, fs.name, fs.size, fs.sha256,
                             [st.without(failed) for st in fs.stripes])
        after = analyze_file(after_fs, max_sets=5, include_shards=False)
        stripe_rows = []
        for st in hit:
            w = st.weights()
            lost_here = {n: w[n] for n in sorted(failed & w.keys())}
            remaining = st.valid_count(failed)
            survives = remaining >= st.k
            stripe_rows.append({
                "chunk_index": st.chunk_index, "k": st.k, "m": st.m,
                "valid_before": st.valid_count(),
                "valid_shards_lost": lost_here,
                "valid_after": remaining,
                "recoverable_after": survives,
                "explanation": (
                    f"chunk {st.chunk_index}: loses {sum(lost_here.values())} valid shard(s) "
                    f"on {', '.join(f'{n}x{c}' for n, c in lost_here.items())}; "
                    f"{remaining} remain, {st.k} needed -> "
                    + ("survives" + (f" with {remaining - st.k} to spare" if survives else "")
                       if survives else "LOST")),
            })
        lost_stripes = [r["chunk_index"] for r in stripe_rows if not r["recoverable_after"]]
        if not before["recoverable"]:
            why = "Already unrecoverable before this scenario. " + before["explanation"]
        elif lost_stripes:
            why = (f"Data loss: {len(lost_stripes)} stripe(s) fall below k "
                   f"(chunks {', '.join(map(str, lost_stripes[:10]))}).")
        else:
            tightest = min(stripe_rows, key=lambda r: r["valid_after"] - r["k"])
            why = (f"Survives. Tightest stripe is chunk {tightest['chunk_index']} with "
                   f"{tightest['valid_after']} valid shards (needs {tightest['k']}). "
                   f"Remaining tolerance afterwards: {after['fault_tolerance']} more node(s).")
        predictions[fs.file_id] = after["recoverable"]
        affected.append({
            "file_id": fs.file_id, "name": fs.name, "sha256": fs.sha256,
            "status_before": before["status"], "status_after": after["status"],
            "recoverable_before": before["recoverable"],
            "recoverable_after": after["recoverable"],
            "fault_tolerance_after": after["fault_tolerance"],
            "stripes_affected": len(hit), "stripes_lost": lost_stripes,
            "stripes": stripe_rows,
            "explanation": why,
        })

    losses = [f for f in affected if not f["recoverable_after"]]
    new_losses = [f for f in losses if f["recoverable_before"]]
    return {
        "scenario_id": scenario_id(snapshot, failed),
        "nodes": sorted(failed),
        "nodes_already_down": already_down,
        "snapshot": {"taken_at": snapshot.taken_at, "verified": snapshot.verified,
                     "fingerprint": snapshot.fingerprint()},
        "summary": {
            "files_total": len(snapshot.files),
            "files_affected": len(affected),
            "files_unaffected": unaffected,
            "files_lost_after": len(losses),
            "files_newly_lost": len(new_losses),
            "data_loss_predicted": bool(new_losses),
        },
        "predictions": predictions,
        "files": affected,
        "explanation": (
            f"Failing {', '.join(sorted(failed))} would make {len(new_losses)} recoverable "
            f"file(s) unrecoverable; {len(affected) - len(losses)} affected file(s) survive."
            + (f" Already down: {', '.join(already_down)}." if already_down else "")),
    }
