"""HTTP client for one storage node."""

from __future__ import annotations

import http.client
import json
import threading
from urllib.parse import urlparse

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
# Connect limit for health probes to loopback nodes (see NodeClient.health).
LOOPBACK_CONNECT_TIMEOUT = 0.5


class NodeUnavailable(Exception):
    """The node could not be reached (down, refused, timed out)."""


class NodeError(Exception):
    """The node answered but refused the request."""


class NodeClient:
    """HTTP client for one node, reusing keep-alive connections.

    Why connections are pooled: with one connection per request, a 50 MB upload opens
    300 connections and a verified Twin pass one per shard, i.e. thousands per minute.
    Every closed connection sits in TIME_WAIT for about 2 minutes. On Windows, when
    the node closed first (urllib always sent `Connection: close`), reused client ports
    collided with the node's TIME_WAIT entries and connects hung until the 10 s
    timeout, which failed shard writes. When the client closed first, the client ran
    out of its 16k ephemeral ports and connects failed outright, marking live nodes
    as down. Reusing a few connections per node removes both failure modes.
    """

    MAX_IDLE = 16  # idle connections kept per node (store pool is 2 x nodes threads)

    def __init__(self, node_id: str, url: str, timeout: float = 10.0):
        self.node_id = node_id
        self.url = url.rstrip("/")
        self.timeout = timeout
        parsed = urlparse(self.url)
        self._host, self._port = parsed.hostname, parsed.port
        self._base_path = parsed.path.rstrip("/")
        self._conn_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        self._idle: list[http.client.HTTPConnection] = []
        self._lock = threading.Lock()

    def _checkout(self, timeout: float) -> tuple[http.client.HTTPConnection, bool]:
        with self._lock:
            conn = self._idle.pop() if self._idle else None
        if conn is None:
            return self._conn_cls(self._host, self._port, timeout=timeout), False
        conn.timeout = timeout
        if conn.sock is not None:
            conn.sock.settimeout(timeout)
        return conn, True

    def _checkin(self, conn: http.client.HTTPConnection) -> None:
        with self._lock:
            if len(self._idle) < self.MAX_IDLE:
                self._idle.append(conn)
                return
        conn.close()

    def close(self) -> None:
        """Close idle pooled connections."""
        with self._lock:
            idle, self._idle = self._idle, []
        for conn in idle:
            conn.close()

    def _request(self, method: str, path: str, data: bytes | None = None,
                 headers: dict | None = None, timeout: float | None = None) -> tuple[int, bytes]:
        """One request on a pooled connection (direct, no proxy).

        A reused connection can be stale (the node restarted, or a stopped node closed
        it). Such a failure is retried once on a fresh connection. That is safe because
        every node operation is idempotent: PUT of the same shard id and bytes, GET, and
        DELETE (a repeat returns 404, which callers accept). A timeout is never retried,
        and an error on a fresh connection is reported at once, so a dead node costs no
        more than before.
        """
        limit = timeout or self.timeout
        for attempt in (1, 2):
            conn, reused = self._checkout(limit)
            try:
                conn.request(method, self._base_path + path, body=data, headers=headers or {})
                resp = conn.getresponse()
                body = resp.read()
            except (OSError, http.client.HTTPException) as e:
                conn.close()
                if reused and attempt == 1 and not isinstance(e, TimeoutError):
                    continue
                raise NodeUnavailable(f"{self.node_id} ({self.url}): {e}") from e
            # Reuse only after a clean exchange. An error reply to an upload may have left
            # request bytes unread on the node side, so that connection is discarded.
            if resp.will_close or (data is not None and not 200 <= resp.status < 300):
                conn.close()
            else:
                self._checkin(conn)
            return resp.status, body
        raise AssertionError("unreachable")  # pragma: no cover

    def health(self, timeout: float = 2.0) -> bool:
        """True iff the node answers GET /health with 200 within `timeout`.

        The TCP connect step gets a shorter limit on loopback addresses. A live
        local node completes the handshake in the kernel almost instantly, even
        when its process is busy, while Windows takes about 2 s to report a
        refused loopback connection (it retries the SYN). The response itself
        still gets the full `timeout`, so a slow but alive node is not misread
        as down.
        """
        url = urlparse(self.url)
        connect = min(LOOPBACK_CONNECT_TIMEOUT, timeout) if url.hostname in LOOPBACK_HOSTS else timeout
        conn_cls = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(url.hostname, url.port, timeout=connect)
        try:
            conn.connect()
            conn.sock.settimeout(timeout)
            conn.request("GET", "/health")
            resp = conn.getresponse()
            resp.read()
            return resp.status == 200
        except (OSError, http.client.HTTPException):
            return False
        finally:
            conn.close()

    def stats(self) -> dict:
        status, body = self._request("GET", "/stats")
        if status != 200:
            raise NodeError(f"{self.node_id}: stats -> {status}")
        return json.loads(body)

    def put_shard(self, shard_id: str, data: bytes, sha256: str) -> None:
        status, body = self._request(
            "PUT", f"/shards/{shard_id}", data=data,
            headers={"Content-Type": "application/octet-stream",
                     "X-Content-SHA256": sha256})
        if status != 201:
            raise NodeError(f"{self.node_id}: PUT {shard_id} -> {status} {body[:200]!r}")

    def get_shard(self, shard_id: str) -> bytes | None:
        """Return shard bytes, or None if the node does not have it."""
        status, body = self._request("GET", f"/shards/{shard_id}")
        if status == 200:
            return body
        if status == 404:
            return None
        raise NodeError(f"{self.node_id}: GET {shard_id} -> {status}")

    def delete_shard(self, shard_id: str) -> bool:
        status, _ = self._request("DELETE", f"/shards/{shard_id}")
        if status in (204, 404):
            return status == 204
        raise NodeError(f"{self.node_id}: DELETE {shard_id} -> {status}")

    def list_shards(self) -> list[str]:
        status, body = self._request("GET", "/shards")
        if status != 200:
            raise NodeError(f"{self.node_id}: list -> {status}")
        return json.loads(body)["shards"]
