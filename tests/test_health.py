"""Health probes and API responsiveness while a node is down or the API is busy."""

import http.client
import json
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sonark.api import ApiServer, SonarkAPI
from sonark.client import NodeClient

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
