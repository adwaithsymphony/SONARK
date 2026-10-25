"""End-to-end demo with real node processes.

Starts N storage node processes, stores a random file, then kills a node,
reads through the failure, replaces the node with an empty one, repairs,
injects bit rot, and finally pushes damage past the parity limit to show
that Sonark refuses to return bad data.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .client import NodeClient
from .store import ClusterConfig, DataLossError, Sonark

MiB = 1024 * 1024


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _step(n: int, title: str) -> None:
    print(f"\n=== {n}. {title} " + "=" * max(0, 60 - len(title)), flush=True)


def _check(ok: bool, label: str) -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}", flush=True)
    if not ok:
        raise SystemExit(f"demo check failed: {label}")


class Nodes:
    def __init__(self, root: Path, count: int):
        self.root = root
        self.ports = {f"n{i}": _free_port() for i in range(1, count + 1)}
        self.procs: dict[str, subprocess.Popen] = {}

    def url(self, nid: str) -> str:
        return f"http://127.0.0.1:{self.ports[nid]}"

    def data_dir(self, nid: str) -> Path:
        return self.root / "nodes" / nid

    def start(self, nid: str, wipe: bool = False) -> None:
        if wipe:
            shutil.rmtree(self.data_dir(nid), ignore_errors=True)
        self.procs[nid] = subprocess.Popen(
            [sys.executable, "-m", "sonark", "node", "--id", nid,
             "--port", str(self.ports[nid]), "--data", str(self.data_dir(nid))],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        client = NodeClient(nid, self.url(nid))
        deadline = time.time() + 15
        while not client.health(timeout=0.5):
            if time.time() > deadline:
                raise RuntimeError(f"node {nid} did not start")
            time.sleep(0.1)

    def kill(self, nid: str) -> None:
        proc = self.procs.pop(nid)
        proc.kill()
        proc.wait()

    def shard_path(self, nid: str, sid: str) -> Path:
        return self.data_dir(nid) / "shards" / sid[:2] / sid

    def stop_all(self) -> None:
        for nid in list(self.procs):
            self.kill(nid)


def _print_placement(s: Sonark, file_id: str, chunks: int) -> None:
    print("  chunk  " + "  ".join(f"s{i}" for i in range(s.config.k + s.config.m)))
    for c in range(chunks):
        print(f"  {c:>5}  " + "  ".join(x.node_id for x in s.meta.shards(file_id, c)))


def _print_issues(issues, limit: int = 8) -> None:
    for issue in issues[:limit]:
        print("    " + str(issue))
    if len(issues) > limit:
        print(f"    ... {len(issues) - limit} more")


def run(nodes: int = 6, k: int = 4, m: int = 2, size_mib: float = 6.0,
        keep: bool = False) -> int:
    if nodes < k + m:
        print(f"need at least k+m={k + m} nodes")
        return 2
    root = Path(tempfile.mkdtemp(prefix="sonark-demo-"))
    cluster = Nodes(root, nodes)
    s = None
    try:
        _step(1, f"Start {nodes} storage node processes")
        for nid in cluster.ports:
            cluster.start(nid)
            print(f"  {nid}  pid={cluster.procs[nid].pid:<6} {cluster.url(nid)}")
        cfg = ClusterConfig(nodes={nid: cluster.url(nid) for nid in cluster.ports},
                            k=k, m=m, chunk_size=1 * MiB, base_dir=str(root))
        cfg.save(root / "cluster.json")
        s = Sonark(cfg)

        _step(2, f"Upload a {size_mib:g} MiB random file (k={k}, m={m})")
        original = os.urandom(int(size_mib * MiB))
        digest = hashlib.sha256(original).hexdigest()
        src = root / "input.bin"
        src.write_bytes(original)
        t = time.time()
        f = s.put_file(src)
        print(f"  stored {f.file_id} in {time.time() - t:.2f}s, "
              f"{f.chunk_count} chunks x {k + m} shards")
        print(f"  sha256 {digest}")
        _print_placement(s, f.file_id, f.chunk_count)

        _step(3, "Retrieve with all nodes healthy")
        out = root / "out.bin"
        report = s.get_file(f.file_id, out)
        _check(hashlib.sha256(out.read_bytes()).hexdigest() == digest, "SHA-256 matches original")
        _check(not report.degraded, "no shard problems")

        victim = "n3"
        _step(4, f"Kill node {victim} (process terminated)")
        cluster.kill(victim)
        t = time.time()
        report = s.get_file(f.file_id, out)
        print(f"  degraded read in {time.time() - t:.2f}s: {len(report.issues)} shards "
              f"unavailable, {report.reconstructed_chunks} chunks rebuilt by Reed-Solomon")
        _check(hashlib.sha256(out.read_bytes()).hexdigest() == digest,
               "file reconstructed, SHA-256 matches original")

        _step(5, "Repair while the node is down")
        rep = s.scrub(repair=True)
        _print_issues(rep.issues, 3)
        if nodes == k + m:
            print(f"  every node already holds a shard of each chunk: no spare node, "
                  f"so repair is deferred ({rep.unrepaired} shards)")
        else:
            print(f"  {rep.repaired} shards rebuilt onto spare nodes")

        _step(6, f"Replace {victim} with a new empty node and repair")
        cluster.start(victim, wipe=True)
        scan = s.scrub()
        print(f"  scrub found {len(scan.issues)} problems "
              f"({', '.join(sorted({i.kind for i in scan.issues})) or 'none'})")
        rep = s.scrub(repair=True)
        print(f"  repaired {rep.repaired}, unrepaired {rep.unrepaired}")
        _check(s.scrub().healthy, "full redundancy restored (every shard verified)")
        _check(s.read_bytes(f.file_id)[0] == original, "file reads back identical")
        again = s.scrub(repair=True)
        _check(again.healthy and again.repaired == 0, "repeated repair is a no-op")

        _step(7, "Bit rot: flip one bit in a shard, delete another")
        c0 = s.meta.shards(f.file_id, 0)
        rot, gone = c0[1], s.meta.shards(f.file_id, 1)[4]
        p = cluster.shard_path(rot.node_id, rot.shard_id)
        b = bytearray(p.read_bytes())
        b[len(b) // 2] ^= 0x10
        p.write_bytes(bytes(b))
        cluster.shard_path(gone.node_id, gone.shard_id).unlink()
        scan = s.scrub()
        _print_issues(scan.issues)
        _check({i.kind for i in scan.issues} == {"corrupt", "missing"},
               "SHA-256 scrub detected the corrupt and the missing shard")
        rep = s.scrub(repair=True)
        _print_issues(rep.issues)
        _check(rep.repaired == 2 and s.scrub().healthy, "both shards rebuilt and verified")

        _step(8, f"Damage beyond tolerance: corrupt {m + 1} shards of chunk 2")
        for x in s.meta.shards(f.file_id, 2)[: m + 1]:
            p = cluster.shard_path(x.node_id, x.shard_id)
            b = bytearray(p.read_bytes())
            b[0] ^= 0xFF
            p.write_bytes(bytes(b))
        try:
            s.get_file(f.file_id, root / "bad.bin")
            _check(False, "read must fail")
        except DataLossError as e:
            print(f"  read refused: {e}")
        _check(not (root / "bad.bin").exists(), "no partial or wrong output written")
        rep = s.scrub(repair=True)
        print(f"  scrub: lost chunks {rep.lost_chunks}, repaired {rep.repaired}")
        _check(len(rep.lost_chunks) == 1 and rep.repaired == 0,
               "loss reported honestly, nothing fabricated")

        print("\nDemo complete: all checks passed.")
        return 0
    finally:
        if s is not None:
            s.close()
        cluster.stop_all()
        if keep:
            print(f"demo files kept in {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)
