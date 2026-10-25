"""Capture real Sonark API responses as frontend test fixtures.

Builds a throwaway cluster in a temp directory (6 node processes on free
loopback ports), starts the real API with node control, exercises every
endpoint the UI uses, and writes each raw response to
frontend/src/test/fixtures/<name>.json. Nothing outside the temp directory
is touched, and the temp directory is deleted afterwards.

Run from the repository root:
    python frontend/scripts/capture_fixtures.py
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import socket
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from sonark.api import ApiServer, SonarkAPI  # noqa: E402
from sonark.store import ClusterConfig, Sonark  # noqa: E402
from sonark.supervisor import NodeSupervisor  # noqa: E402

OUT = ROOT / "frontend" / "src" / "test" / "fixtures"
CHUNK = 64 * 1024


def free_ports(n: int) -> list[int]:
    socks = []
    for _ in range(n):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        socks.append(s)
    ports = [s.getsockname()[1] for s in socks]
    for s in socks:
        s.close()
    return ports


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="sonark-fixtures-"))
    nodes = {f"n{i}": f"http://127.0.0.1:{p}" for i, p in enumerate(free_ports(6), 1)}
    config = ClusterConfig(nodes=nodes, k=4, m=2, chunk_size=CHUNK, base_dir=str(tmp))
    sup = NodeSupervisor(config)
    sup.start_all()
    store = Sonark(config, threadsafe_metadata=True)
    server = ApiServer(SonarkAPI(store, sup), port=0).start()
    port = server.httpd.server_address[1]

    def call(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=180)
        h = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        raw = r.read()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        conn.close()
        return r.status, raw, hdrs

    def save(name, method, path, body=None, headers=None, expect=None):
        st, raw, _ = call(method, path, body, headers)
        doc = json.loads(raw)
        if expect is not None and st != expect:
            raise SystemExit(f"{name}: expected {expect}, got {st}: {raw[:300]!r}")
        (OUT / f"{name}.json").write_text(json.dumps({"status": st, "body": doc}, indent=1))
        print(f"  {name:<28} {st}")
        return doc

    try:
        put = {"Content-Type": "application/octet-stream"}
        save("health", "GET", "/api/health", expect=200)
        a = save("upload", "PUT", "/api/files?name=alpha.bin", os.urandom(3 * CHUNK + 11),
                 put, expect=201)["data"]
        store.config.k, store.config.m = 2, 1  # a second coding on fewer nodes
        call("PUT", "/api/files?name=beta.bin", os.urandom(CHUNK), put)
        store.config.k, store.config.m = 4, 2
        call("PUT", "/api/files?name=empty.txt", b"", put)

        save("status", "GET", "/api/status", expect=200)
        save("files", "GET", "/api/files", expect=200)
        save("file_detail", "GET", f"/api/files/{a['file_id']}", expect=200)
        save("twin", "GET", "/api/twin?verify=true&shards=true", expect=200)
        save("twin_noshards", "GET", "/api/twin", expect=200)
        p = save("preview_survive", "POST", "/api/scenarios/preview", {"nodes": ["n2"]},
                 expect=200)["data"]
        save("preview_loss", "POST", "/api/scenarios/preview",
             {"nodes": ["n1", "n2", "n3"]}, expect=200)
        save("error_unknown_node", "POST", "/api/scenarios/preview", {"nodes": ["zz"]},
             expect=400)
        save("error_428_execute", "POST", "/api/scenarios/execute", {"nodes": ["n2"]},
             expect=428)
        save("execute", "POST", "/api/scenarios/execute",
             {"nodes": ["n2"], "confirm": p["scenario_id"], "mode": "restart"}, expect=200)
        p3 = json.loads(call("POST", "/api/scenarios/preview",
                             {"nodes": ["n1", "n2", "n3"]})[1])["data"]
        save("error_409_replace", "POST", "/api/scenarios/execute",
             {"nodes": ["n1", "n2", "n3"], "confirm": p3["scenario_id"], "mode": "replace"},
             expect=409)
        save("execute_loss", "POST", "/api/scenarios/execute",
             {"nodes": ["n1", "n2", "n3"], "confirm": p3["scenario_id"]}, expect=200)
        runs = save("scenarios", "GET", "/api/scenarios", expect=200)["data"]["scenarios"]
        save("scenario_detail", "GET", f"/api/scenarios/{runs[0]['run_id']}", expect=200)
        save("scrub", "POST", "/api/scrub", {}, expect=200)
        save("error_428_repair", "POST", "/api/repair", {}, expect=428)
        save("repair", "POST", "/api/repair", {"confirm": True}, expect=200)
        save("gc", "POST", "/api/gc", {"confirm": True}, expect=200)
        save("node_stop", "POST", "/api/nodes/n6/stop", {"confirm": "n6"}, expect=200)
        save("status_node_down", "GET", "/api/status", expect=200)
        save("files_node_down", "GET", "/api/files", expect=200)
        save("node_start", "POST", "/api/nodes/n6/start", {}, expect=200)
        save("events", "GET", "/api/events?limit=200", expect=200)
        save("error_404_file", "GET", "/api/files/nope.bin", expect=404)
        st, raw, hdrs = call("GET", f"/api/files/{a['file_id']}/content")
        (OUT / "download_headers.json").write_text(json.dumps(
            {"status": st, "length": len(raw),
             "headers": {k: v for k, v in hdrs.items() if k.startswith("x-sonark")}},
            indent=1))
        print(f"  {'download_headers':<28} {st}")
    finally:
        server.stop()
        store.close()
        sup.stop_all()
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"fixtures written to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
