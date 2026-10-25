"""Storage node: an independent HTTP server that stores opaque shards on disk.

The node knows nothing about files, chunks or erasure coding. It stores
bytes under a shard id and verifies the SHA-256 the client sends on upload,
so corruption in transit is rejected before it reaches disk.

HTTP API
  GET    /health          -> {"node_id", "status"}
  GET    /stats           -> {"node_id", "shard_count", "bytes_used"}
  GET    /shards          -> {"shards": [ids]}
  GET    /shards/<id>     -> raw bytes | 404
  PUT    /shards/<id>     -> 201 (header X-Content-SHA256 checked if given)
  DELETE /shards/<id>     -> 204 | 404
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SHARD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MAX_SHARD_BYTES = 256 * 1024 * 1024


class ShardStore:
    """Shards on disk: <root>/shards/<id[:2]>/<id>. Writes are atomic."""

    def __init__(self, root: str | os.PathLike):
        self.root = Path(root)
        self.shard_dir = self.root / "shards"
        self.tmp_dir = self.root / "tmp"
        self.shard_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)

    def path(self, shard_id: str) -> Path:
        if not SHARD_ID_RE.match(shard_id):
            raise ValueError(f"invalid shard id: {shard_id!r}")
        return self.shard_dir / shard_id[:2] / shard_id

    def put(self, shard_id: str, data: bytes) -> None:
        dest = self.path(shard_id)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.tmp_dir / f"{shard_id}.{uuid.uuid4().hex}"
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dest)

    def get(self, shard_id: str) -> bytes | None:
        try:
            return self.path(shard_id).read_bytes()
        except FileNotFoundError:
            return None

    def delete(self, shard_id: str) -> bool:
        try:
            self.path(shard_id).unlink()
            return True
        except FileNotFoundError:
            return False

    def list(self) -> list[str]:
        return sorted(p.name for p in self.shard_dir.glob("*/*") if p.is_file())

    def stats(self) -> tuple[int, int]:
        files = [p for p in self.shard_dir.glob("*/*") if p.is_file()]
        return len(files), sum(p.stat().st_size for p in files)


class _Handler(BaseHTTPRequestHandler):
    server_version = "SonarkNode/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    def _send(self, code: int, body: bytes = b"", ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj).encode())

    def _shard_id(self) -> str | None:
        if self.path.startswith("/shards/"):
            sid = self.path[len("/shards/"):]
            if SHARD_ID_RE.match(sid):
                return sid
        return None

    @property
    def store(self) -> ShardStore:
        return self.server.store

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"node_id": self.server.node_id, "status": "ok"})
        if self.path == "/stats":
            count, used = self.store.stats()
            return self._json(200, {"node_id": self.server.node_id,
                                    "shard_count": count, "bytes_used": used})
        if self.path == "/shards":
            return self._json(200, {"shards": self.store.list()})
        sid = self._shard_id()
        if sid is None:
            return self._json(400, {"error": "bad path"})
        data = self.store.get(sid)
        if data is None:
            return self._json(404, {"error": "not found"})
        self._send(200, data, "application/octet-stream")

    def do_PUT(self):
        sid = self._shard_id()
        if sid is None:
            return self._json(400, {"error": "bad path"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._json(411, {"error": "Content-Length required"})
        if length < 0 or length > MAX_SHARD_BYTES:
            return self._json(413, {"error": "shard too large"})
        body = self.rfile.read(length)
        digest = hashlib.sha256(body).hexdigest()
        expected = self.headers.get("X-Content-SHA256")
        if expected and expected.lower() != digest:
            return self._json(400, {"error": "sha256 mismatch", "got": digest})
        self.store.put(sid, body)
        self._json(201, {"shard_id": sid, "sha256": digest, "size": len(body)})

    def do_DELETE(self):
        sid = self._shard_id()
        if sid is None:
            return self._json(400, {"error": "bad path"})
        if self.store.delete(sid):
            return self._send(204)
        self._json(404, {"error": "not found"})


class NodeServer:
    def __init__(self, node_id: str, data_dir: str | os.PathLike,
                 host: str = "127.0.0.1", port: int = 0, verbose: bool = False):
        self.httpd = ThreadingHTTPServer((host, port), _Handler)
        self.httpd.daemon_threads = True
        self.httpd.node_id = node_id
        self.httpd.store = ShardStore(data_dir)
        self.httpd.verbose = verbose
        self.node_id = node_id
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def serve_forever(self) -> None:
        self.httpd.serve_forever()

    def start(self) -> "NodeServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
