"""Health probes and API responsiveness while a node is down or the API is busy."""

import hashlib
import http.client
import json
import shutil
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sonark.api import ApiServer, SonarkAPI
from sonark.client import NodeClient, NodeError, NodeUnavailable
from sonark.node import NodeServer

from .test_cluster import Cluster


def dead_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens here any more
    return port


class SlowHealth(BaseHTTPRequestHandler):
    """Accepts the connection at once (kernel handshake) but answers late."""

    delay = 1.0

    def do_GET(self):
        time.sleep(self.delay)
        body = b'{"ok": true}'
        try:
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass  # the short-timeout probe already gave up; that is the point of the test

    def log_message(self, *args):
        pass


class HealthProbeTests(unittest.TestCase):
    def test_dead_loopback_node_is_detected_quickly(self):
        client = NodeClient("gone", f"http://127.0.0.1:{dead_port()}")
        t = time.perf_counter()
        self.assertFalse(client.health())
        # Windows needs ~2 s to report a refused loopback connect; the probe stops
        # at the 0.5 s connect limit instead. Elsewhere refusal is immediate.
        self.assertLess(time.perf_counter() - t, 1.2)

    def test_slow_but_alive_node_is_still_healthy(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), SlowHealth)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            client = NodeClient("slow", f"http://127.0.0.1:{httpd.server_address[1]}")
            # the response takes 1 s: longer than the connect limit, within the read timeout
            self.assertTrue(client.health(timeout=2.0))
            self.assertFalse(client.health(timeout=0.3))
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_real_node_up_then_down(self):
        c = Cluster(1)
        try:
            client = c.store.clients["n1"]
            self.assertTrue(client.health())
            c.stop("n1")
            self.assertFalse(client.health())
        finally:
            c.close()


class NodeClientConnectionTests(unittest.TestCase):
    """Regression: node requests reuse keep-alive connections.

    One connection per request (thousands per minute) exhausted Windows TCP state:
    with urllib's `Connection: close` the node held TIME_WAIT and reused client ports
    hung until the 10 s timeout (uploads stalled or returned 503); with client-side
    closing the client ran out of ephemeral ports and live nodes were marked down."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="sonark-conn-")
        self.server = NodeServer("n1", self.dir).start()
        self.client = NodeClient("n1", self.server.url)
        self.opened = 0
        real = self.client._conn_cls

        def counting(*a, **k):
            self.opened += 1
            return real(*a, **k)

        self.client._conn_cls = counting

    def tearDown(self):
        self.client.close()
        self.server.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_requests_reuse_connections(self):
        for i in range(150):
            self.assertEqual(self.client._request("GET", "/health")[0], 200)
            sid = f"s{i:04d}"
            self.client.put_shard(sid, b"x" * 1000, hashlib.sha256(b"x" * 1000).hexdigest())
        self.assertLessEqual(self.opened, 2)

    def test_stopped_node_is_unreachable_despite_pooled_connections(self):
        self.client._request("GET", "/health")
        self.server.stop()
        with self.assertRaises(NodeUnavailable):
            self.client._request("GET", "/health", timeout=2)

    def test_node_restarted_on_same_port_is_reached_again(self):
        self.client._request("GET", "/health")
        port = int(self.server.url.rsplit(":", 1)[1])
        self.server.stop()
        self.server = NodeServer("n1", self.dir, port=port).start()
        self.assertEqual(self.client._request("GET", "/health")[0], 200)  # stale conn retried once

    def test_rejected_upload_does_not_poison_the_connection(self):
        with self.assertRaises(NodeError):
            self.client.put_shard("ab" * 8, b"data", "0" * 64)            # 400 after body read
        status, _ = self.client._request("PUT", "/shards/../bad", data=b"leftover-body")
        self.assertEqual(status, 400)                                      # 400 before body read
        self.assertEqual(self.client._request("GET", "/health")[0], 200)
        self.client.put_shard("cd" * 8, b"ok", hashlib.sha256(b"ok").hexdigest())
        self.assertEqual(self.client.get_shard("cd" * 8), b"ok")

    def test_status_codes_and_errors_unchanged(self):
        self.assertIsNone(self.client.get_shard("ab" * 8))                # 404 -> None
        self.client.put_shard("ab" * 8, b"data", hashlib.sha256(b"data").hexdigest())
        self.assertEqual(self.client.get_shard("ab" * 8), b"data")        # 200
        self.assertTrue(self.client.delete_shard("ab" * 8))               # 204
        self.assertFalse(self.client.delete_shard("ab" * 8))              # 404 on repeat
        self.server.stop()
        with self.assertRaises(NodeUnavailable):
            self.client.get_shard("ab" * 8)


class ApiBusyTests(unittest.TestCase):
    def setUp(self):
        self.c = Cluster(3, k=2, m=1, threadsafe=True)
        self.api = SonarkAPI(self.c.store, supervisor=None, lock_timeout=0.3)
        self.server = ApiServer(self.api, port=0).start()
        self.port = self.server.httpd.server_address[1]

    def tearDown(self):
        self.server.stop()
        self.c.close()

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", path)
        r = conn.getresponse()
        out = r.status, json.loads(r.read())
        conn.close()
        return out

    def test_health_answers_while_a_storage_operation_holds_the_lock(self):
        self.assertTrue(self.api.lock.acquire(timeout=1))
        try:
            t = time.perf_counter()
            st, body = self.get("/api/health")
            self.assertEqual(st, 200)
            self.assertLess(time.perf_counter() - t, 0.25)
            self.assertEqual(body["data"]["service"], "sonark")
            # storage endpoints still wait for the lock and report busy
            st, body = self.get("/api/status")
            self.assertEqual(st, 503)
            self.assertEqual(body["error"]["code"], "busy")
        finally:
            self.api.lock.release()
        self.assertEqual(self.get("/api/status")[0], 200)

    def test_status_with_a_node_down_reports_it_and_stays_fast(self):
        self.c.stop("n3")
        t = time.perf_counter()
        st, body = self.get("/api/status")
        self.assertEqual(st, 200)
        self.assertLess(time.perf_counter() - t, 1.5)
        up = {n["node_id"]: n["up"] for n in body["data"]["nodes"]}
        self.assertEqual(up, {"n1": True, "n2": True, "n3": False})


if __name__ == "__main__":
    unittest.main()
