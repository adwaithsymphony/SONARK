"""HTTP client for one storage node."""

from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from urllib.parse import urlparse

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
# Connect limit for health probes to loopback nodes (see NodeClient.health).
LOOPBACK_CONNECT_TIMEOUT = 0.5


class NodeUnavailable(Exception):
    """The node could not be reached (down, refused, timed out)."""


class NodeError(Exception):
    """The node answered but refused the request."""


# Ignore system proxy settings: nodes are addressed directly.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class NodeClient:
    def __init__(self, node_id: str, url: str, timeout: float = 10.0):
        self.node_id = node_id
        self.url = url.rstrip("/")
        self.timeout = timeout

    def _request(self, method: str, path: str, data: bytes | None = None,
                 headers: dict | None = None, timeout: float | None = None) -> tuple[int, bytes]:
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers=headers or {})
        try:
            with _OPENER.open(req, timeout=timeout or self.timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            raise NodeUnavailable(f"{self.node_id} ({self.url}): {e}") from e

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
