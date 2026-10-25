"""Deterministic Survival Twin fixture: predict, break, prove.

Builds a fresh 6-node cluster of real node processes in a temp directory,
stores four seeded files with different coding parameters, makes one file's
placement uneven, and then:

  1. Analyzes survival from real verified shard state.
  2. Sweeps all 2^6 node-failure sets with fail-fast client stubs (a simulated
     outage; real shards are fetched and really decoded) and counts how often
     the Twin, and a naive "survives any <= m failures" rule, match reality.
  3. Runs real controlled scenarios by killing node processes, including one
     with mode="replace" (nodes come back empty and repair rebuilds them).

Content is seeded, so file hashes and the chosen scenarios are the same on
every run. Timings are measured, not assumed.
"""

from __future__ import annotations

import itertools
import json
import random
import shutil
import socket
import tempfile
import time
from pathlib import Path

from .client import NodeClient, NodeUnavailable
from .scenario import ConfirmationRequired, read_and_hash, run_scenario
from .store import ClusterConfig, Sonark
from .supervisor import NodeSupervisor
from .twin import analyze, observe, preview

KiB = 1024
CHUNK = 256 * KiB
FILES = [  # name, k, m, size
    ("alpha.bin", 4, 2, 3 * CHUNK + 1000),
    ("beta.bin", 2, 1, CHUNK // 2),
    ("gamma.bin", 3, 3, 2 * CHUNK),
    ("skewed.bin", 4, 2, CHUNK),
]


class _Down(NodeClient):
    def health(self, timeout=2.0):
        return False

    def _request(self, *a, **kw):
        raise NodeUnavailable(f"{self.node_id}: simulated outage")


def _ports(n: int) -> list[int]:
    socks, ports = [], []
    for _ in range(n):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        socks.append(s)
        ports.append(s.getsockname()[1])
    for s in socks:
        s.close()
    return ports


def _h(title: str) -> None:
    print(f"\n=== {title} " + "=" * max(0, 64 - len(title)), flush=True)


def run(keep: bool = False, json_out: str | None = None, seed: int = 2026) -> int:
    root = Path(tempfile.mkdtemp(prefix="sonark-twin-"))
    nodes = {f"n{i}": f"http://127.0.0.1:{p}" for i, p in enumerate(_ports(6), 1)}
    config = ClusterConfig(nodes=nodes, k=4, m=2, chunk_size=CHUNK, base_dir=str(root))
    config.save(root / "cluster.json")
    sup = NodeSupervisor(config, log_dir=root / "logs")
    store = None
    out: dict = {"seed": seed}
    try:
        _h("Setup: 6 node processes, 4 seeded files")
        sup.start_all()
        store = Sonark(config)
        rnd = random.Random(seed)
        for name, k, m, size in FILES:
            store.config.k, store.config.m = k, m
            f = store.put_bytes(rnd.randbytes(size), name)
            print(f"  {name:<11} {k}+{m}  {size:>7} B  {f.chunk_count} stripe(s)  "
                  f"sha256 {f.sha256[:16]}...")
        store.config.k, store.config.m = 4, 2
        files = {f.name: f for f in store.meta.list_files()}

        # Make skewed.bin uneven: move shard 1 onto the node holding shard 0.
        sk = files["skewed.bin"]
        sh = store.meta.shards(sk.file_id, 0)
        src, dst = sh[1], sh[0].node_id
        data = store.clients[src.node_id].get_shard(src.shard_id)
        store.clients[dst].put_shard(src.shard_id, data, src.sha256)
        store.clients[src.node_id].delete_shard(src.shard_id)
        store.meta.move_shard(src, dst)
        print(f"  skewed.bin: moved shard 1 from {src.node_id} to {dst} "
              f"({dst} now holds 2 of its 6 shards)")

        _h("1. Survival Twin analysis (verified snapshot)")
        t0 = time.perf_counter()
        snap = observe(store, verify=True)
        t1 = time.perf_counter()
        result = analyze(snap)
        t2 = time.perf_counter()
        for f in result["files"]:
            smallest = [s["nodes"] for s in f["minimal_loss_sets"] if s["size"] ==
                        f["smallest_loss_set_size"]][:3]
            print(f"  {f['name']:<11} {f['status']:<8} tolerates any {f['fault_tolerance']} "
                  f"(design m={f['design_tolerance']})  minimal loss sets: "
                  f"{f['minimal_loss_sets_total']}  e.g. {smallest}")
        print(f"  cluster fault tolerance: {result['summary']['cluster_fault_tolerance']}  "
              f"cluster minimal loss sets: {result['cluster_minimal_loss_sets_total']}")
        print(f"  measured: observe {1000 * (t1 - t0):.1f} ms "
              f"({sum(len(st.shards) for f in snap.files for st in f.stripes)} shards hashed), "
              f"analyze {1000 * (t2 - t1):.1f} ms")
        out["analysis"] = {"files": {f["name"]: {k: f[k] for k in (
            "status", "fault_tolerance", "design_tolerance", "smallest_loss_set_size",
            "minimal_loss_sets_total", "placement_concentrated")} for f in result["files"]},
            "observe_ms": round(1000 * (t1 - t0), 1), "analyze_ms": round(1000 * (t2 - t1), 1)}

        _h("2. Exhaustive sweep: all 64 failure sets, real decode (simulated outage)")
        real = dict(store.clients)
        ids = sorted(real)
        twin_ok = naive_ok = total = 0
        naive_wrong: list[str] = []
        t0 = time.perf_counter()
        for size in range(len(ids) + 1):
            for failed in itertools.combinations(ids, size):
                pred = preview(snap, failed)["predictions"] if failed else \
                    {f["file_id"]: f["recoverable"] for f in result["files"]}
                for nid in failed:
                    store.clients[nid] = _Down(nid, real[nid].url)
                try:
                    for f in files.values():
                        actual = read_and_hash(store, f.file_id, f.sha256)["recovered"]
                        naive = size <= f.m
                        total += 1
                        twin_ok += pred[f.file_id] == actual
                        naive_ok += naive == actual
                        if naive != actual and len(naive_wrong) < 5:
                            naive_wrong.append(f"{f.name} with {{{','.join(failed)}}}: naive "
                                               f"{'survives' if naive else 'lost'}, "
                                               f"actual {'survives' if actual else 'lost'}")
                finally:
                    store.clients.update(real)
        elapsed = time.perf_counter() - t0
        print(f"  Survival Twin matched reality: {twin_ok}/{total}")
        print(f"  naive rule (|failed| <= m)  : {naive_ok}/{total}")
        for line in naive_wrong:
            print(f"    naive wrong: {line}")
        print(f"  measured: {total} real file reads in {elapsed:.2f} s")
        out["sweep"] = {"cases": total, "twin_matched": twin_ok, "naive_matched": naive_ok,
                        "seconds": round(elapsed, 2)}

        _h("3. Controlled scenarios with real node processes")
        runs = []

        def pick(size: int, want_lost: set[str]) -> list[str]:
            for failed in itertools.combinations(ids, size):
                p = preview(observe(store, verify=True), failed)
                lost = {f["name"] for f in p["files"] if not f["recoverable_after"]}
                if lost == want_lost:
                    return list(failed)
            raise RuntimeError(f"no {size}-node scenario loses exactly {want_lost}")

        try:
            run_scenario(store, sup, ["n1"], confirm=None)
            print("  [FAIL] unconfirmed scenario was executed")
        except ConfirmationRequired as e:
            print(f"  unconfirmed execute refused, as required (expected confirm {e.expected})")

        plans = [
            ("replace one node (comes back empty)", pick(1, set()), "replace"),
            ("survivable pair", pick(2, set()), "restart"),
            ("pair that only the uneven file cannot survive", pick(2, {"skewed.bin"}), "restart"),
            ("three nodes", ["n4", "n5", "n6"], "restart"),
        ]
        for label, failed, mode in plans:
            p = preview(observe(store, verify=True), failed)
            t0 = time.perf_counter()
            rep = run_scenario(store, sup, failed, confirm=p["scenario_id"], mode=mode)
            dt = time.perf_counter() - t0
            print(f"\n  {label}: fail {failed} mode={mode}  ({dt:.1f} s)")
            for r in rep["outage_results"].values():
                print(f"    {r['name']:<11} predicted "
                      f"{'survive' if r['predicted_recoverable'] else 'LOSS   '}  actual "
                      f"{'recovered, sha256 match' if r['actual_recoverable'] else 'LOST: ' + str(r['error'])[:60]}"
                      f"{'  (' + str(r['reconstructed_chunks']) + ' stripes rebuilt)' if r['reconstructed_chunks'] else ''}")
            print(f"    prediction matched: {rep['prediction_matched']}   repair rebuilt "
                  f"{rep['repair']['repaired']} shard(s)   healthy after: "
                  f"{rep['verification']['healthy']}   all files intact after: "
                  f"{rep['all_files_intact_after']}")
            runs.append({"label": label, "nodes": failed, "mode": mode, "run_id": rep["run_id"],
                         "matched": rep["prediction_matched"],
                         "repaired": rep["repair"]["repaired"],
                         "healthy_after": rep["verification"]["healthy"],
                         "intact_after": rep["all_files_intact_after"],
                         "seconds": round(dt, 1)})
        out["scenarios"] = runs

        ok = (twin_ok == total and all(r["matched"] and r["intact_after"] for r in runs))
        _h("Result")
        print(f"  Twin vs reality: {twin_ok}/{total} sweep cases, "
              f"{sum(r['matched'] for r in runs)}/{len(runs)} real scenarios matched.")
        print("  " + ("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED"))
        out["passed"] = ok
        if json_out:
            Path(json_out).write_text(json.dumps(out, indent=2))
            print(f"  results written to {json_out}")
        return 0 if ok else 1
    finally:
        if store is not None:
            store.close()
        sup.stop_all()
        if keep:
            print(f"fixture kept in {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)
