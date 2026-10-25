"""Process control for local storage nodes.

The supervisor starts each node as a separate OS process
(`python -m sonark node ...`) and keeps the process handle. That handle is
what makes controlled failure possible: only nodes this supervisor started
can be stopped or restarted by it. Nodes that were already running when the
supervisor started are reported as unmanaged and are never touched.

Node data lives in <cluster dir>/nodes/<node id>. Node URLs must be loopback
addresses; the port is taken from the URL in cluster.json.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from .client import NodeClient
from .node import SHARD_ID_RE
from .store import ClusterConfig, SonarkError

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class NotManaged(SonarkError):
    """The node was not started by this supervisor, so it cannot be controlled."""


class NodeSupervisor:
    def __init__(self, config: ClusterConfig, log_dir: str | Path | None = None):
        self.config = config
        self.root = (Path(config.base_dir) / "nodes").resolve()
        self.run_dir = Path(config.base_dir) / "run"
        self.log_dir = Path(log_dir) if log_dir else None
        self.procs: dict[str, subprocess.Popen] = {}

    # ---- addressing ----------------------------------------------------

    def _check_id(self, nid: str) -> None:
        if nid not in self.config.nodes:
            raise SonarkError(f"unknown node: {nid}")
        if not SHARD_ID_RE.match(nid):
            raise SonarkError(f"node id not usable as a directory name: {nid!r}")

    def data_dir(self, nid: str) -> Path:
        self._check_id(nid)
        path = (self.root / nid).resolve()
        if path.parent != self.root:
            raise SonarkError(f"node directory escapes cluster: {path}")
        return path

    def address(self, nid: str) -> tuple[str, int]:
        self._check_id(nid)
        url = urlparse(self.config.nodes[nid])
        if url.hostname not in LOOPBACK or not url.port:
            raise NotManaged(f"{nid}: only loopback nodes with an explicit port can be managed")
        return url.hostname, url.port

    # ---- state ---------------------------------------------------------

    def managed(self, nid: str) -> bool:
        return nid in self.procs

    def running(self, nid: str) -> bool:
        proc = self.procs.get(nid)
        return proc is not None and proc.poll() is None

    def describe(self) -> dict[str, dict]:
        return {nid: {"managed": self.managed(nid), "running": self.running(nid),
                      "pid": self.procs[nid].pid if self.running(nid) else None}
                for nid in sorted(self.config.nodes)}

    # ---- control -------------------------------------------------------

    def start(self, nid: str, wipe: bool = False, timeout: float = 15.0) -> None:
        host, port = self.address(nid)
        client = NodeClient(nid, self.config.nodes[nid])
        if self.running(nid):
            return
        if client.health(timeout=0.5):
            raise NotManaged(f"{nid}: something is already serving {host}:{port}")
        data = self.data_dir(nid)
        if wipe:
            shutil.rmtree(data, ignore_errors=True)
        out = subprocess.DEVNULL
        if self.log_dir:
            self.log_dir.mkdir(parents=True, exist_ok=True)
            out = open(self.log_dir / f"{nid}.log", "ab")
        self.procs[nid] = subprocess.Popen(
            [sys.executable, "-m", "sonark", "node", "--id", nid, "--host", host,
             "--port", str(port), "--data", str(data)],
            stdout=out, stderr=subprocess.STDOUT)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / f"{nid}.pid").write_text(str(self.procs[nid].pid))
        deadline = time.time() + timeout
        while not client.health(timeout=0.5):
            if self.procs[nid].poll() is not None or time.time() > deadline:
                self.stop(nid)
                raise SonarkError(f"node {nid} failed to start on {host}:{port}")
            time.sleep(0.1)

    def stop(self, nid: str) -> None:
        if nid not in self.procs:
            raise NotManaged(f"{nid} is not managed by this supervisor")
        proc = self.procs[nid]
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=10)
        (self.run_dir / f"{nid}.pid").unlink(missing_ok=True)

    def start_all(self) -> dict[str, str]:
        """Start every node not already reachable. Returns node -> outcome."""
        outcome = {}
        for nid in sorted(self.config.nodes):
            try:
                self.start(nid)
                outcome[nid] = "started"
            except NotManaged as e:
                outcome[nid] = f"unmanaged: {e}"
        return outcome

    def stop_all(self) -> None:
        for nid in list(self.procs):
            self.stop(nid)
        self.procs.clear()


def stop_stale(config: ClusterConfig) -> dict[str, str]:
    """Kill node processes left behind by a supervisor that did not shut down
    cleanly, using <cluster dir>/run/<node>.pid. A pid is only killed if that
    node's URL still answers /health with the expected node id."""
    run_dir = Path(config.base_dir) / "run"
    outcome: dict[str, str] = {}
    for nid, url in sorted(config.nodes.items()):
        pid_file = run_dir / f"{nid}.pid"
        if not pid_file.exists():
            outcome[nid] = "no pid file"
            continue
        pid = int(pid_file.read_text().strip() or 0)
        client = NodeClient(nid, url)
        try:
            status, body = client._request("GET", "/health", timeout=1.0)
            serving = status == 200 and json.loads(body).get("node_id") == nid
        except Exception:
            serving = False
        if serving and pid > 0:
            try:
                os.kill(pid, signal.SIGTERM)
                outcome[nid] = f"killed pid {pid}"
            except OSError as e:
                outcome[nid] = f"could not kill pid {pid}: {e}"
        else:
            outcome[nid] = "not running"
        pid_file.unlink(missing_ok=True)
    return outcome
