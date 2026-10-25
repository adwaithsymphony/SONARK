"""HTTP API: contract, validation, and safety checks."""

import hashlib
import http.client
import json
import os
import unittest

from sonark.api import ApiError, ApiServer, SonarkAPI
from sonark.store import SonarkError

from .test_cluster import CHUNK, Cluster


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.c = Cluster(6, threadsafe=True)
        self.api = SonarkAPI(self.c.store, supervisor=None, max_upload=2 * 1024 * 1024)
        self.server = ApiServer(self.api, port=0,
                                cors_origins=("http://localhost:5173",)).start()
        self.port = self.server.httpd.server_address[1]

    def tearDown(self):
        self.server.stop()
        self.c.close()

    def call(self, method, path, body=None, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        h = dict(headers or {})
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        if raw:
            return resp.status, data, dict(resp.getheaders())
        return resp.status, json.loads(data) if data else None

    def upload(self, data: bytes, name="a.bin"):
        return self.call("PUT", f"/api/files?name={name}", body=data,
                         headers={"Content-Type": "application/octet-stream"})

    # ---- happy paths ---------------------------------------------------

    def test_health_and_status(self):
        st, body = self.call("GET", "/api/health")
        self.assertEqual(st, 200)
        self.assertFalse(body["data"]["node_control"])
        st, body = self.call("GET", "/api/status")
        self.assertEqual(st, 200)
        self.assertEqual(body["data"]["nodes_up"], 6)
        self.assertEqual({n["node_id"] for n in body["data"]["nodes"]},
                         {f"n{i}" for i in range(1, 7)})

    def test_upload_list_detail_download(self):
        payload = os.urandom(2 * CHUNK + 3)
        st, body = self.upload(payload)
        self.assertEqual(st, 201)
        fid = body["data"]["file_id"]
        self.assertEqual(body["data"]["sha256"], hashlib.sha256(payload).hexdigest())

        st, body = self.call("GET", "/api/files")
        self.assertEqual(st, 200)
        self.assertEqual(body["data"]["files"][0]["status"], "healthy")
        self.assertEqual(body["data"]["files"][0]["fault_tolerance"], 2)

        st, body = self.call("GET", f"/api/files/{fid}")
        self.assertEqual(st, 200)
        prot = body["data"]["protection"]
        self.assertEqual(prot["stripe_count"], 3)
        self.assertEqual(len(prot["stripes"][0]["shards"]), 6)

        st, data, headers = self.call("GET", f"/api/files/{fid}/content", raw=True)
        self.assertEqual(st, 200)
        self.assertEqual(data, payload)
        self.assertEqual(headers["X-Sonark-SHA256"], hashlib.sha256(payload).hexdigest())
        # by name as well
        st, data, _ = self.call("GET", "/api/files/a.bin/content", raw=True)
        self.assertEqual(data, payload)

    def test_twin_and_preview(self):
        st, body = self.upload(os.urandom(CHUNK))
        fid = body["data"]["file_id"]
        st, body = self.call("GET", "/api/twin")
        self.assertEqual(st, 200)
        self.assertEqual(body["data"]["summary"]["cluster_fault_tolerance"], 2)
        self.assertTrue(body["data"]["snapshot"]["verified"])

        before = {n: sorted(c.list_shards()) for n, c in self.c.store.clients.items()}
        st, body = self.call("POST", "/api/scenarios/preview", {"nodes": ["n1", "n2", "n3"]})
        self.assertEqual(st, 200)
        p = body["data"]
        self.assertTrue(p["scenario_id"].startswith("scn-"))
        self.assertEqual(p["predictions"], {fid: False})
        self.assertTrue(p["summary"]["data_loss_predicted"])
        self.assertFalse(p["executable"])  # no supervisor
        after = {n: sorted(c.list_shards()) for n, c in self.c.store.clients.items()}
        self.assertEqual(before, after)
        st, body = self.call("GET", "/api/status")
        self.assertEqual(body["data"]["nodes_up"], 6)

    def test_events(self):
        self.upload(b"hello")
        st, body = self.call("GET", "/api/events?limit=5")
        self.assertEqual(st, 200)
        self.assertEqual(body["data"]["events"][0]["kind"], "put")

    def test_lost_file_download_is_503(self):
        st, body = self.upload(os.urandom(CHUNK))
        fid = body["data"]["file_id"]
        for n in ("n1", "n2", "n3"):
            self.c.stop(n)
        st, body = self.call("GET", f"/api/files/{fid}/content")
        self.assertEqual(st, 503)
        self.assertEqual(body["error"]["code"], "data_unavailable")

    # ---- validation ----------------------------------------------------

    def test_upload_validation(self):
        st, body = self.call("PUT", "/api/files", body=b"x")
        self.assertEqual((st, body["error"]["code"]), (400, "invalid_name"))
        st, body = self.call("PUT", "/api/files?name=..%2Fetc%2Fpasswd", body=b"x")
        self.assertEqual((st, body["error"]["code"]), (400, "invalid_name"))
        st, body = self.call("PUT", "/api/files?name=big", body=b"x" * (2 * 1024 * 1024 + 1))
        self.assertEqual((st, body["error"]["code"]), (413, "payload_too_large"))

    def test_json_validation(self):
        st, body = self.call("POST", "/api/scenarios/preview", body=b'{"nodes":["n1"]}',
                             headers={"Content-Type": "text/plain"})
        self.assertEqual((st, body["error"]["code"]), (415, "unsupported_media_type"))
        st, body = self.call("POST", "/api/scenarios/preview", body=b"{nope",
                             headers={"Content-Type": "application/json"})
        self.assertEqual((st, body["error"]["code"]), (400, "invalid_json"))
        st, body = self.call("POST", "/api/scenarios/preview", [1, 2])
        self.assertEqual((st, body["error"]["code"]), (400, "invalid_json"))
        st, body = self.call("POST", "/api/scenarios/preview", {"nodes": []})
        self.assertEqual(st, 400)
        st, body = self.call("POST", "/api/scenarios/preview", {"nodes": ["n9"]})
        self.assertEqual((st, body["error"]["code"]), (400, "unknown_node"))
        st, body = self.call("GET", "/api/twin?verify=maybe")
        self.assertEqual((st, body["error"]["code"]), (400, "invalid_parameter"))
        st, body = self.call("GET", "/api/events?limit=0")
        self.assertEqual(st, 400)

    def test_routing_errors(self):
        st, body = self.call("GET", "/api/nope")
        self.assertEqual((st, body["error"]["code"]), (404, "not_found"))
        st, body = self.call("DELETE", "/api/twin")
        self.assertEqual((st, body["error"]["code"]), (405, "method_not_allowed"))
        st, body = self.call("GET", "/api/files/doesnotexist")
        self.assertEqual(st, 404)
        st, body = self.call("GET", "/api/scenarios/run-000000000000")
        self.assertEqual(st, 404)

    # ---- confirmation safeguards -------------------------------------

    def test_repair_and_gc_need_confirmation(self):
        for path in ("/api/repair", "/api/gc"):
            st, body = self.call("POST", path, {})
            self.assertEqual((st, body["error"]["code"]), (428, "confirmation_required"))
            st, body = self.call("POST", path, {"confirm": "yes"})
            self.assertEqual(st, 428)
            st, body = self.call("POST", path, {"confirm": True})
            self.assertEqual(st, 200)

    def test_repair_fixes_corruption(self):
        st, body = self.upload(os.urandom(CHUNK))
        fid = body["data"]["file_id"]
        sh = self.c.store.meta.shards(fid, 0)[2]
        p = self.c.shard_path(sh.node_id, sh.shard_id)
        p.write_bytes(b"garbage")
        st, body = self.call("POST", "/api/scrub", {})
        self.assertEqual(body["data"]["details"][0]["kind"], "corrupt")
        st, body = self.call("POST", "/api/repair", {"confirm": True})
        self.assertEqual(body["data"]["repaired"], 1)
        self.assertTrue(body["data"]["after"]["healthy"])

    def test_delete_needs_matching_confirm(self):
        st, body = self.upload(b"data")
        fid = body["data"]["file_id"]
        st, body = self.call("DELETE", f"/api/files/{fid}")
        self.assertEqual(st, 428)
        self.assertEqual(body["error"]["details"]["expected_confirm"], fid)
        st, body = self.call("DELETE", f"/api/files/{fid}?confirm=wrong")
        self.assertEqual(st, 428)
        st, body = self.call("DELETE", f"/api/files/{fid}?confirm={fid}")
        self.assertEqual(st, 200)
        self.assertEqual(self.call("GET", f"/api/files/{fid}")[0], 404)

    def test_execute_and_node_control_disabled_without_supervisor(self):
        st, body = self.call("POST", "/api/scenarios/execute", {"nodes": ["n1"], "confirm": "x"})
        self.assertEqual(st, 409)
        st, body = self.call("POST", "/api/nodes/n1/stop", {"confirm": "n1"})
        self.assertEqual(st, 409)
        st, body = self.call("POST", "/api/nodes/n99/stop", {"confirm": "n99"})
        self.assertEqual(st, 404)

    # ---- network safety ------------------------------------------------

    def test_foreign_host_header_rejected(self):
        st, body = self.call("GET", "/api/status", headers={"Host": "evil.example:8800"})
        self.assertEqual((st, body["error"]["code"]), (403, "forbidden_host"))
        st, _ = self.call("GET", "/api/status", headers={"Host": f"localhost:{self.port}"})
        self.assertEqual(st, 200)

    def test_cors(self):
        st, _, h = self.call("OPTIONS", "/api/repair", headers={
            "Origin": "http://evil.example", "Access-Control-Request-Method": "POST"}, raw=True)
        self.assertEqual(st, 403)
        st, _, h = self.call("OPTIONS", "/api/repair", headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"}, raw=True)
        self.assertEqual(st, 204)
        self.assertEqual(h["Access-Control-Allow-Origin"], "http://localhost:5173")
        st, _, h = self.call("GET", "/api/health", headers={"Origin": "http://evil.example"},
                             raw=True)
        self.assertNotIn("Access-Control-Allow-Origin", h)

    def test_api_requires_threadsafe_store(self):
        plain = Cluster(6)
        try:
            with self.assertRaises(SonarkError):
                SonarkAPI(plain.store)
        finally:
            plain.close()

    def test_remote_bind_refused_and_read_only(self):
        with self.assertRaises(SonarkError):
            ApiServer(SonarkAPI(self.c.store), host="0.0.0.0", port=0)
        ro = SonarkAPI(self.c.store, read_only=True)
        with self.assertRaises(ApiError) as e:
            ro.dispatch("POST", "/api/repair", {"content-type": "application/json"},
                        lambda n: b"{}")
        self.assertEqual(e.exception.status, 403)
        self.assertEqual(ro.dispatch("GET", "/api/health", {}, None).status, 200)


if __name__ == "__main__":
    unittest.main()
