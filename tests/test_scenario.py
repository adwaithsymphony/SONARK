"""Controlled scenarios with REAL node processes (supervisor kills and restarts them)."""

import hashlib
import http.client
import json
import os
import shutil
import socket
import tempfile
import unittest
from pathlib import Path

from sonark.api import ApiServer, SonarkAPI
from sonark.scenario import ConfirmationRequired, ScenarioConflict, run_scenario
from sonark.store import ClusterConfig, Sonark
from sonark.supervisor import NodeSupervisor, NotManaged
from sonark.twin import observe, preview

CHUNK = 64 * 1024


def free_ports(n):
    socks = []
    for _ in range(n):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        socks.append(s)
    ports = [s.getsockname()[1] for s in socks]
    for s in socks:
        s.close()
    return ports


class ScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="sonark-scn-"))
        nodes = {f"n{i}": f"http://127.0.0.1:{p}" for i, p in enumerate(free_ports(6), 1)}
        cls.config = ClusterConfig(nodes=nodes, k=4, m=2, chunk_size=CHUNK,
                                   base_dir=str(cls.dir))
        cls.sup = NodeSupervisor(cls.config)
        cls.sup.start_all()
        cls.store = Sonark(cls.config, threadsafe_metadata=True)
        cls.payload = os.urandom(3 * CHUNK + 11)
        cls.f = cls.store.put_bytes(cls.payload, "wide.bin")
        cls.store.config.k, cls.store.config.m = 2, 1
        cls.small = cls.store.put_bytes(os.urandom(CHUNK), "narrow.bin")  # on n1, n2, n3
        cls.store.config.k, cls.store.config.m = 4, 2

    @classmethod
    def tearDownClass(cls):
        cls.store.close()
        cls.sup.stop_all()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.assertTrue(all(self.sup.running(n) for n in self.config.nodes))

    def confirm(self, nodes):
        return preview(observe(self.store), nodes)["scenario_id"]

    def all_running(self):
        return all(self.sup.running(n) for n in self.config.nodes)

    def test_confirmation_is_required_and_nothing_happens_without_it(self):
        for bad in (None, "scn-000000000000"):
            with self.assertRaises(ConfirmationRequired) as e:
                run_scenario(self.store, self.sup, ["n4"], bad)
            self.assertEqual(e.exception.expected, self.confirm(["n4"]))
        self.assertTrue(self.all_running())

    def test_stale_confirmation_rejected(self):
        token = self.confirm(["n5"])
        sh = self.store.meta.shards(self.f.file_id, 0)[0]
        path = self.dir / "nodes" / sh.node_id / "shards" / sh.shard_id[:2] / sh.shard_id
        original = path.read_bytes()
        path.write_bytes(b"rot")
        try:
            with self.assertRaises(ConfirmationRequired):
                run_scenario(self.store, self.sup, ["n5"], token)
            self.assertTrue(self.all_running())
        finally:
            path.write_bytes(original)
        self.assertTrue(self.store.scrub().healthy)

    def test_survivable_scenario_matches_and_verifies_sha(self):
        rep = run_scenario(self.store, self.sup, ["n4", "n5"], self.confirm(["n4", "n5"]))
        self.assertTrue(rep["prediction_matched"])
        r = rep["outage_results"][self.f.file_id]
        self.assertTrue(r["predicted_recoverable"] and r["actual_recoverable"])
        self.assertEqual(r["sha256_actual"], hashlib.sha256(self.payload).hexdigest())
        self.assertGreater(r["reconstructed_chunks"], 0)
        self.assertTrue(rep["verification"]["healthy"])
        self.assertTrue(rep["all_files_intact_after"])
        self.assertTrue(self.all_running())
        kinds = [e[1] for e in self.store.meta.events(10)]
        self.assertIn("scenario_start", kinds)
        self.assertIn("scenario_end", kinds)
        saved = json.loads(self.store.meta.get_scenario(rep["run_id"]))
        self.assertEqual(saved["scenario_id"], rep["scenario_id"])

    def test_unrecoverable_scenario_is_reported_honestly(self):
        nodes = ["n1", "n2", "n3"]
        rep = run_scenario(self.store, self.sup, nodes, self.confirm(nodes))
        self.assertTrue(rep["prediction_matched"])
        for fid in (self.f.file_id, self.small.file_id):
            r = rep["outage_results"][fid]
            self.assertFalse(r["predicted_recoverable"])
            self.assertFalse(r["actual_recoverable"])
            self.assertIsNone(r["sha256_actual"])
            self.assertIn("intact shards", r["error"])
        # Restart brings the original shards back; nothing was overwritten.
        self.assertTrue(rep["all_files_intact_after"])
        self.assertEqual(self.store.read_bytes(self.f.file_id)[0], self.payload)

    def test_partial_loss_one_file_survives_other_lost(self):
        nodes = ["n1", "n2"]  # kills narrow (2+1 on n1-n3), wide (4+2) survives
        rep = run_scenario(self.store, self.sup, nodes, self.confirm(nodes))
        self.assertTrue(rep["prediction_matched"])
        self.assertTrue(rep["outage_results"][self.f.file_id]["actual_recoverable"])
        self.assertFalse(rep["outage_results"][self.small.file_id]["actual_recoverable"])

    def test_replace_mode_rebuilds_redundancy(self):
        rep = run_scenario(self.store, self.sup, ["n6"], self.confirm(["n6"]), mode="replace")
        self.assertTrue(rep["prediction_matched"])
        self.assertEqual(rep["restore_mode"], "replace")
        held = len(self.store.meta.shard_ids_on_node("n6"))
        self.assertEqual(rep["repair"]["repaired"], held)
        self.assertGreater(held, 0)
        self.assertTrue(rep["verification"]["healthy"])
        self.assertTrue(rep["all_files_intact_after"])
        # repeated repair afterwards is a no-op
        again = self.store.scrub(repair=True)
        self.assertEqual(again.repaired, 0)

    def test_replace_refused_when_loss_predicted(self):
        nodes = ["n1", "n2"]
        with self.assertRaises(ScenarioConflict):
            run_scenario(self.store, self.sup, nodes, self.confirm(nodes), mode="replace")
        self.assertTrue(self.all_running())

    def test_unmanaged_nodes_cannot_be_failed(self):
        other = NodeSupervisor(self.config)  # did not start anything
        with self.assertRaises(NotManaged):
            run_scenario(self.store, other, ["n1"], self.confirm(["n1"]))
        with self.assertRaises(NotManaged):
            other.start("n1")  # port already served by someone else
        self.assertTrue(self.all_running())

    def test_api_execute_flow(self):
        api = SonarkAPI(self.store, self.sup)
        server = ApiServer(api, port=0).start()
        port = server.httpd.server_address[1]

        def post(path, body):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
            conn.request("POST", path, json.dumps(body), {"Content-Type": "application/json"})
            r = conn.getresponse()
            out = r.status, json.loads(r.read())
            conn.close()
            return out

        try:
            st, body = post("/api/scenarios/execute", {"nodes": ["n3"]})
            self.assertEqual(st, 428)
            token = body["error"]["details"]["expected_confirm"]
            self.assertTrue(self.all_running())
            st, body = post("/api/scenarios/preview", {"nodes": ["n3"]})
            self.assertEqual(body["data"]["scenario_id"], token)
            self.assertTrue(body["data"]["executable"])
            st, body = post("/api/scenarios/execute", {"nodes": ["n3"], "confirm": token,
                                                       "mode": "bogus"})
            self.assertEqual(st, 400)
            st, body = post("/api/scenarios/execute", {"nodes": ["n3"], "confirm": token})
            self.assertEqual(st, 200)
            self.assertTrue(body["data"]["prediction_matched"])
            st, body = post("/api/nodes/n2/stop", {})
            self.assertEqual(st, 428)
            st, body = post("/api/nodes/n2/stop", {"confirm": "n2"})
            self.assertEqual((st, body["data"]["running"]), (200, False))
            st, body = post("/api/nodes/n2/start", {})
            self.assertEqual((st, body["data"]["running"]), (200, True))
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
