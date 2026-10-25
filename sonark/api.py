"""Local JSON API for Sonark (standard library only).

Every success response is {"data": ...}. Every error is
{"error": {"code": str, "message": str, "details": {...}}}.
See SONARK_SPEC.md section 14 for the endpoint contract.

Safety
  * Binds to 127.0.0.1 by default. Binding elsewhere needs allow_remote=True,
    and even then every mutating endpoint returns 403 (read-only remote mode).
  * The Host header must name a loopback host (blocks DNS rebinding).
  * JSON endpoints require Content-Type: application/json. Browsers cannot send
    that cross-origin without a CORS preflight, and preflights succeed only
    for origins listed in cors_origins.
  * Disruptive actions need an explicit `confirm` value (see each endpoint).
  * One lock serializes all storage operations; a request waiting more than
    `lock_timeout` seconds gets 503 busy.
"""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .client import NodeUnavailable
from .scenario import ConfirmationRequired, ScenarioConflict, run_scenario
from .store import DataLossError, PlacementError, Sonark, SonarkError
from .supervisor import LOOPBACK, NodeSupervisor, NotManaged
from .twin import analyze, analyze_file, observe, preview

MAX_JSON_BYTES = 1024 * 1024
DRAIN_LIMIT = 16 * 1024 * 1024  # unread body we discard so the client sees our error
DEFAULT_MAX_UPLOAD = 64 * 1024 * 1024
NAME_RE = re.compile(r"^[^\x00-\x1f\x7f/\\]{1,255}$")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or {}


class Response:
    def __init__(self, status: int = 200, data: Any = None, body: bytes | None = None,
                 headers: dict | None = None):
        self.status, self.data, self.body, self.headers = status, data, body, headers or {}


def _bool(q: dict, key: str, default: bool) -> bool:
    if key not in q:
        return default
    v = q[key][-1].lower()
    if v in ("1", "true", "yes"):
        return True
    if v in ("0", "false", "no"):
        return False
    raise ApiError(400, "invalid_parameter", f"{key} must be true or false")


def _int(q: dict, key: str, default: int, lo: int, hi: int) -> int:
    if key not in q:
        return default
    try:
        v = int(q[key][-1])
    except ValueError:
        raise ApiError(400, "invalid_parameter", f"{key} must be an integer") from None
    if not lo <= v <= hi:
        raise ApiError(400, "invalid_parameter", f"{key} must be between {lo} and {hi}")
    return v


def _file_summary(f) -> dict:
    return {"file_id": f.file_id, "name": f.name, "size": f.size, "sha256": f.sha256,
            "k": f.k, "m": f.m, "chunk_size": f.chunk_size, "chunk_count": f.chunk_count,
            "created_at": f.created_at}


class SonarkAPI:
    def __init__(self, store: Sonark, supervisor: NodeSupervisor | None = None,
                 max_upload: int = DEFAULT_MAX_UPLOAD, read_only: bool = False,
                 lock_timeout: float = 60.0):
        if not getattr(store.meta, "threadsafe", False):
            raise SonarkError("the API serves requests on many threads; create the store "
                              "with Sonark(config, threadsafe_metadata=True)")
        self.store = store
        self.supervisor = supervisor
        self.max_upload = max_upload
        self.read_only = read_only
        self.lock = threading.RLock()
        self.lock_timeout = lock_timeout
        self.routes = [
            ("GET", r"/api/health", self.health),
            ("GET", r"/api/status", self.status),
            ("GET", r"/api/files", self.list_files),
            ("PUT", r"/api/files", self.upload),
            ("GET", r"/api/files/(?P<ref>[^/]+)", self.file_detail),
            ("DELETE", r"/api/files/(?P<ref>[^/]+)", self.delete_file),
            ("GET", r"/api/files/(?P<ref>[^/]+)/content", self.download),
            ("GET", r"/api/twin", self.twin),
            ("POST", r"/api/scenarios/preview", self.scenario_preview),
            ("POST", r"/api/scenarios/execute", self.scenario_execute),
            ("GET", r"/api/scenarios", self.scenario_list),
            ("GET", r"/api/scenarios/(?P<run_id>run-[0-9a-f]{12})", self.scenario_get),
            ("POST", r"/api/scrub", self.scrub),
            ("POST", r"/api/repair", self.repair),
            ("POST", r"/api/gc", self.gc),
            ("POST", r"/api/nodes/(?P<node>[^/]+)/stop", self.node_stop),
            ("POST", r"/api/nodes/(?P<node>[^/]+)/start", self.node_start),
            ("GET", r"/api/events", self.events),
        ]
        self.routes = [(m, re.compile(p + r"$"), fn) for m, p, fn in self.routes]
        self.mutating = {self.upload, self.delete_file, self.scenario_execute, self.repair,
                         self.gc, self.node_stop, self.node_start}
        # Endpoints that touch neither storage nor metadata, so they never wait
        # behind a long storage operation (keeps reachability checks honest).
        self.lock_free = {self.health}

    # ---- dispatch ------------------------------------------------------

    def dispatch(self, method: str, raw_path: str, headers: dict, body_reader) -> Response:
        url = urlparse(raw_path)
        path, query = url.path.rstrip("/") or "/", parse_qs(url.query)
        allowed = []
        for m, pattern, fn in self.routes:
            match = pattern.match(path)
            if not match:
                continue
            allowed.append(m)
            if m != method:
                continue
            if self.read_only and fn in self.mutating:
                raise ApiError(403, "read_only", "server is in read-only remote mode")
            params = {k: unquote(v) for k, v in match.groupdict().items()}
            req = {"query": query, "headers": headers, "body": body_reader, **params}
            if fn in self.lock_free:
                return self._call(fn, req)
            if not self.lock.acquire(timeout=self.lock_timeout):
                raise ApiError(503, "busy", "another storage operation is running")
            try:
                return self._call(fn, req)
            finally:
                self.lock.release()
        if allowed:
            raise ApiError(405, "method_not_allowed", f"{method} not allowed on {path}",
                           {"allow": sorted(set(allowed))})
        raise ApiError(404, "not_found", f"no route for {path}")

    def _call(self, fn, req) -> Response:
        try:
            return fn(req)
        except ApiError:
            raise
        except ConfirmationRequired as e:
            details = {"expected_confirm": e.expected}
            if e.preview:
                details["preview"] = {"scenario_id": e.preview["scenario_id"],
                                      "summary": e.preview["summary"],
                                      "explanation": e.preview["explanation"]}
            raise ApiError(428, "confirmation_required", str(e), details) from None
        except (ScenarioConflict, NotManaged) as e:
            raise ApiError(409, "conflict", str(e)) from None
        except DataLossError as e:
            raise ApiError(503, "data_unavailable", str(e)) from None
        except PlacementError as e:
            raise ApiError(503, "insufficient_nodes", str(e)) from None
        except NodeUnavailable as e:
            raise ApiError(503, "node_unavailable", str(e)) from None
        except ValueError as e:
            raise ApiError(400, "invalid_request", str(e)) from None
        except SonarkError as e:
            msg = str(e)
            if msg.startswith("no such file") or msg.startswith("unknown node"):
                raise ApiError(404, "not_found", msg) from None
            raise ApiError(400, "invalid_request", msg) from None

    # ---- helpers -------------------------------------------------------

    def _json_body(self, req) -> dict:
        headers = req["headers"]
        ctype = (headers.get("content-type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "unsupported_media_type", "Content-Type must be application/json")
        length = self._length(headers, MAX_JSON_BYTES)
        raw = req["body"](length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "invalid_json", "request body is not valid JSON") from None
        if not isinstance(body, dict):
            raise ApiError(400, "invalid_json", "request body must be a JSON object")
        return body

    @staticmethod
    def _length(headers: dict, limit: int) -> int:
        raw = headers.get("content-length")
        if raw is None:
            if headers.get("transfer-encoding"):
                raise ApiError(411, "length_required", "chunked bodies are not supported")
            return 0
        try:
            length = int(raw)
        except ValueError:
            raise ApiError(400, "invalid_request", "bad Content-Length") from None
        if length < 0:
            raise ApiError(400, "invalid_request", "bad Content-Length")
        if length > limit:
            raise ApiError(413, "payload_too_large", f"body exceeds {limit} bytes",
                           {"limit": limit})
        return length

    def _nodes(self, body: dict) -> list[str]:
        nodes = body.get("nodes")
        if not isinstance(nodes, list) or not nodes or not all(isinstance(n, str) for n in nodes):
            raise ApiError(400, "invalid_request", "'nodes' must be a non-empty list of node ids")
        unknown = sorted(set(nodes) - set(self.store.clients))
        if unknown:
            raise ApiError(400, "unknown_node", f"unknown node(s): {', '.join(unknown)}",
                           {"known": sorted(self.store.clients)})
        return sorted(set(nodes))

    def _file(self, ref: str):
        if not NAME_RE.match(ref):
            raise ApiError(400, "invalid_request", "invalid file reference")
        f = self.store.meta.get_file(ref)
        if f is None or f.state != "complete":
            raise ApiError(404, "not_found", f"no such file: {ref}")
        return f

    def _require_confirm_true(self, body: dict, action: str) -> None:
        if body.get("confirm") is not True:
            raise ApiError(428, "confirmation_required",
                           f"{action} changes stored data; send {{\"confirm\": true}}")

    # ---- endpoints -----------------------------------------------------

    def health(self, req) -> Response:
        return Response(data={"service": "sonark", "version": __version__,
                              "read_only": self.read_only,
                              "node_control": self.supervisor is not None})

    def status(self, req) -> Response:
        st = self.store.status()
        control = self.supervisor.describe() if self.supervisor else {}
        nodes = [{"node_id": nid, **info,
                  "managed": control.get(nid, {}).get("managed", False),
                  "running": control.get(nid, {}).get("running"),
                  "pid": control.get(nid, {}).get("pid")}
                 for nid, info in st["nodes"].items()]
        return Response(data={"k": st["k"], "m": st["m"], "files": st["files"],
                              "bytes": st["bytes"], "nodes": nodes,
                              "nodes_up": sum(n["up"] for n in nodes)})

    def list_files(self, req) -> Response:
        snap = observe(self.store, verify=False)
        protection = {r["file_id"]: r for r in
                      (analyze_file(f, max_sets=0, include_shards=False) for f in snap.files)}
        out = []
        for f in self.store.meta.list_files():
            p = protection.get(f.file_id, {})
            out.append({**_file_summary(f), "status": p.get("status"),
                        "fault_tolerance": p.get("fault_tolerance"),
                        "protection_verified": False})
        return Response(data={"files": out})

    def upload(self, req) -> Response:
        q, headers = req["query"], req["headers"]
        name = (q.get("name") or [""])[-1]
        if not NAME_RE.match(name):
            raise ApiError(400, "invalid_name",
                           "query parameter 'name' is required: 1-255 chars, no slashes "
                           "or control characters")
        if headers.get("content-length") is None:
            raise ApiError(411, "length_required", "Content-Length is required")
        length = self._length(headers, self.max_upload)
        data = req["body"](length) if length else b""
        if len(data) != length:
            raise ApiError(400, "incomplete_body", "body shorter than Content-Length")
        f = self.store.put_bytes(data, name)
        return Response(201, data=_file_summary(f))

    def file_detail(self, req) -> Response:
        f = self._file(req["ref"])
        verify = _bool(req["query"], "verify", True)
        snap = observe(self.store, verify=verify, file_ids=[f.file_id])
        protection = analyze_file(snap.files[0], include_shards=True)
        return Response(data={**_file_summary(f), "snapshot_verified": verify,
                              "protection": protection})

    def download(self, req) -> Response:
        f = self._file(req["ref"])
        data, report = self.store.read_bytes(f.file_id)  # verified per chunk + whole file
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", f.name)[:100] or "file"
        return Response(200, body=data, headers={
            "Content-Type": "application/octet-stream",
            "Content-Disposition": f'attachment; filename="{safe}"',
            "X-Sonark-SHA256": f.sha256,
            "X-Sonark-Degraded": "true" if report.degraded else "false",
            "X-Sonark-Reconstructed-Chunks": str(report.reconstructed_chunks)})

    def delete_file(self, req) -> Response:
        f = self._file(req["ref"])
        if (req["query"].get("confirm") or [""])[-1] != f.file_id:
            raise ApiError(428, "confirmation_required",
                           "deleting is permanent; pass ?confirm=<file_id>",
                           {"expected_confirm": f.file_id})
        self.store.delete(f.file_id)
        return Response(data={"deleted": f.file_id})

    def twin(self, req) -> Response:
        q = req["query"]
        verify = _bool(q, "verify", True)
        max_sets = _int(q, "max_sets", 50, 0, 1000)
        start = time.perf_counter()
        snap = observe(self.store, verify=verify)
        observed = time.perf_counter()
        result = analyze(snap, max_sets=max_sets, include_shards=_bool(q, "shards", False))
        result["timing_ms"] = {"observe": round((observed - start) * 1000, 1),
                               "analyze": round((time.perf_counter() - observed) * 1000, 1)}
        return Response(data=result)

    def scenario_preview(self, req) -> Response:
        body = self._json_body(req)
        nodes = self._nodes(body)
        verify = body.get("verify", True)
        if not isinstance(verify, bool):
            raise ApiError(400, "invalid_request", "'verify' must be a boolean")
        p = preview(observe(self.store, verify=verify), nodes)
        p["executable"] = bool(verify and self.supervisor and all(
            self.supervisor.running(n) for n in nodes))
        if not verify:
            p["note"] = ("unverified snapshot: scenario_id cannot be used to execute; "
                         "preview with verify=true first")
        return Response(data=p)

    def scenario_execute(self, req) -> Response:
        body = self._json_body(req)
        nodes = self._nodes(body)
        if self.supervisor is None:
            raise ApiError(409, "conflict", "node control is disabled; start the API with "
                                            "`sonark serve --manage` to run scenarios")
        mode = body.get("mode", "restart")
        confirm = body.get("confirm")
        if confirm is not None and not isinstance(confirm, str):
            raise ApiError(400, "invalid_request", "'confirm' must be a scenario_id string")
        report = run_scenario(self.store, self.supervisor, nodes, confirm, mode)
        return Response(200, data=report)

    def scenario_list(self, req) -> Response:
        limit = _int(req["query"], "limit", 50, 1, 500)
        return Response(data={"scenarios": self.store.meta.list_scenarios(limit)})

    def scenario_get(self, req) -> Response:
        raw = self.store.meta.get_scenario(req["run_id"])
        if raw is None:
            raise ApiError(404, "not_found", f"no such scenario run: {req['run_id']}")
        return Response(data=json.loads(raw))

    def scrub(self, req) -> Response:
        from .scenario import _scrub_summary
        self._json_body(req)
        return Response(data=_scrub_summary(self.store.scrub(repair=False)))

    def repair(self, req) -> Response:
        from .scenario import _scrub_summary
        body = self._json_body(req)
        self._require_confirm_true(body, "repair")
        report = _scrub_summary(self.store.scrub(repair=True))
        report["after"] = _scrub_summary(self.store.scrub())
        return Response(data=report)

    def gc(self, req) -> Response:
        body = self._json_body(req)
        self._require_confirm_true(body, "gc")
        return Response(data={"removed": self.store.gc()})

    def _managed_node(self, nid: str) -> None:
        if nid not in self.store.clients:
            raise ApiError(404, "not_found", f"unknown node: {nid}")
        if self.supervisor is None:
            raise ApiError(409, "conflict", "node control is disabled (serve without --manage)")

    def node_stop(self, req) -> Response:
        nid = req["node"]
        self._managed_node(nid)
        body = self._json_body(req)
        if body.get("confirm") != nid:
            raise ApiError(428, "confirmation_required",
                           f"stopping a node is disruptive; send {{\"confirm\": \"{nid}\"}}",
                           {"expected_confirm": nid})
        self.supervisor.stop(nid)
        self.store.meta.log("node_stop", node_id=nid, detail="via API")
        return Response(data={"node_id": nid, "running": self.supervisor.running(nid)})

    def node_start(self, req) -> Response:
        nid = req["node"]
        self._managed_node(nid)
        self._json_body(req)
        if not self.supervisor.managed(nid) and self.store.clients[nid].health():
            raise ApiError(409, "conflict", f"{nid} is running but not managed by this server")
        self.supervisor.start(nid)
        self.store.meta.log("node_start", node_id=nid, detail="via API")
        return Response(data={"node_id": nid, "running": self.supervisor.running(nid)})

    def events(self, req) -> Response:
        limit = _int(req["query"], "limit", 50, 1, 1000)
        out = []
        for ts, kind, fid, ci, si, nid, detail in self.store.meta.events(limit):
            try:
                parsed = json.loads(detail) if detail and detail[:1] in "{[" else detail
            except json.JSONDecodeError:
                parsed = detail
            out.append({"ts": ts, "kind": kind, "file_id": fid, "chunk_index": ci,
                        "shard_index": si, "node_id": nid, "detail": parsed})
        return Response(data={"events": out})


# ---------------------------------------------------------------------------
# HTTP layer


def _allowed_host(host_header: str | None) -> bool:
    if not host_header:
        return False
    host = host_header.strip().lower()
    if host.startswith("["):
        host = host[1:host.find("]")] if "]" in host else host
    else:
        host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    return host in LOOPBACK


class _Handler(BaseHTTPRequestHandler):
    server_version = f"SonarkAPI/{__version__}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if self.server.verbose:
            super().log_message(fmt, *args)

    def _cors(self) -> dict:
        origin = self.headers.get("Origin")
        if origin and origin in self.server.cors_origins:
            return {"Access-Control-Allow-Origin": origin, "Vary": "Origin",
                    "Access-Control-Expose-Headers":
                        "X-Sonark-SHA256, X-Sonark-Degraded, X-Sonark-Reconstructed-Chunks"}
        return {}

    def _send(self, status: int, body: bytes, headers: dict) -> None:
        self.send_response(status)
        for k, v in {**headers, **self._cors()}.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, indent=1).encode(),
                   {"Content-Type": "application/json"})

    def _handle(self) -> None:
        headers = {k.lower(): v for k, v in self.headers.items()}
        consumed = 0

        def read(n: int) -> bytes:
            nonlocal consumed
            data = self.rfile.read(n)
            consumed += len(data)
            return data

        try:
            if self.server.check_host and not _allowed_host(headers.get("host")):
                raise ApiError(403, "forbidden_host", "Host header must be a loopback address")
            resp = self.server.api.dispatch(self.command, self.path, headers, read)
        except ApiError as e:
            self._drain(headers, consumed)
            return self._send_json(e.status, {"error": {"code": e.code, "message": e.message,
                                                        "details": e.details}})
        except Exception as e:  # pragma: no cover - last resort, never leak a traceback
            self.close_connection = True
            return self._send_json(500, {"error": {"code": "internal_error",
                                                   "message": type(e).__name__,
                                                   "details": {}}})
        if resp.body is not None:
            return self._send(resp.status, resp.body, resp.headers)
        self._send_json(resp.status, {"data": resp.data})

    def _drain(self, headers: dict, consumed: int) -> None:
        """Discard an unread request body so the error response reaches the client
        (closing with unread data makes Windows reset the connection)."""
        try:
            remaining = int(headers.get("content-length") or 0) - consumed
        except ValueError:
            remaining = -1
        if remaining < 0 or remaining > DRAIN_LIMIT:
            self.close_connection = True
            return
        while remaining > 0:
            got = self.rfile.read(min(remaining, 64 * 1024))
            if not got:
                break
            remaining -= len(got)

    do_GET = do_PUT = do_POST = do_DELETE = _handle

    def do_OPTIONS(self):
        cors = self._cors()
        if not cors:
            return self._send_json(403, {"error": {"code": "cors_forbidden",
                                                   "message": "origin not allowed",
                                                   "details": {}}})
        self.send_response(204)
        for k, v in cors.items():
            self.send_header(k, v)
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()


class ApiServer:
    def __init__(self, api: SonarkAPI, host: str = "127.0.0.1", port: int = 8800,
                 allow_remote: bool = False, cors_origins: tuple[str, ...] = (),
                 verbose: bool = False):
        remote = host not in LOOPBACK
        if remote and not allow_remote:
            raise SonarkError(f"refusing to bind {host}: the API is local-only "
                              "(pass allow_remote for read-only remote access)")
        if remote:
            api.read_only = True
        self.httpd = ThreadingHTTPServer((host, port), _Handler)
        self.httpd.daemon_threads = True
        self.httpd.api = api
        self.httpd.check_host = not remote
        self.httpd.cors_origins = set(cors_origins)
        self.httpd.verbose = verbose
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def serve_forever(self) -> None:
        self.httpd.serve_forever()

    def start(self) -> "ApiServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
