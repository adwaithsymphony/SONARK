"""Survival Twin against real nodes and real Reed-Solomon reads."""

import hashlib
import itertools
import os
import unittest

from sonark import DataLossError
from sonark.client import NodeClient, NodeUnavailable
from sonark.twin import analyze, observe, preview

from .test_cluster import CHUNK, Cluster, flip_bit


class FailFastClient(NodeClient):
    """Stands in for a crashed node without the OS connect delay."""

    def health(self, timeout=2.0):
        return False

    def _request(self, *a, **kw):
        raise NodeUnavailable(f"{self.node_id}: simulated outage")


def actually_recoverable(store, file_id, sha) -> bool:
    try:
        data, _ = store.read_bytes(file_id)
    except DataLossError:
        return False
    return hashlib.sha256(data).hexdigest() == sha


class ObserveTests(unittest.TestCase):
    def setUp(self):
        self.c = Cluster(6)
        self.s = self.c.store
        self.f = self.s.put_bytes(os.urandom(3 * CHUNK + 5), "a.bin")

    def tearDown(self):
        self.c.close()

    def statuses(self, snap):
        return {(st.chunk_index, sh.shard_index): sh.status
                for st in snap.file(self.f.file_id).stripes for sh in st.shards}

    def test_classifies_real_damage(self):
        sh = self.s.meta.shards(self.f.file_id, 0)
        flip_bit(self.c.shard_path(sh[0].node_id, sh[0].shard_id))
        self.c.shard_path(sh[1].node_id, sh[1].shard_id).unlink()
        down = self.s.meta.shards(self.f.file_id, 1)[2].node_id
        self.c.stop(down)
        st = self.statuses(observe(self.s, verify=True))
        self.assertEqual(st[(0, 0)], "corrupt")
        self.assertEqual(st[(0, 1)], "missing")
        self.assertEqual(st[(1, 2)], "node_down")
        self.assertEqual(st[(2, 5)] if self.s.meta.shards(self.f.file_id, 2)[5].node_id != down
                         else "ok", "ok")
        report = analyze(observe(self.s))["files"][0]
        # With 6 nodes the stopped node also holds a chunk-0 shard, so chunk 0
        # has 3 invalid shards (corrupt, missing, down) and only 3 valid < k=4.
        self.assertEqual(report["stripes"][0]["valid"], 3)
        self.assertEqual(report["status"], "lost")
        self.assertFalse(actually_recoverable(self.s, self.f.file_id, self.f.sha256))

    def test_unverified_mode_does_not_detect_corruption(self):
        sh = self.s.meta.shards(self.f.file_id, 0)[0]
        flip_bit(self.c.shard_path(sh.node_id, sh.shard_id))
        fast = observe(self.s, verify=False)
        self.assertFalse(fast.verified)
        self.assertEqual(self.statuses(fast)[(0, 0)], "unverified")
        self.assertEqual(self.statuses(observe(self.s, verify=True))[(0, 0)], "corrupt")

    def test_observe_is_read_only(self):
        before = {nid: sorted(c.list_shards()) for nid, c in self.s.clients.items()}
        events = len(self.s.meta.events(1000))
        snap = observe(self.s)
        preview(snap, ["n1", "n2", "n3"])
        after = {nid: sorted(c.list_shards()) for nid, c in self.s.clients.items()}
        self.assertEqual(before, after)
        self.assertEqual(len(self.s.meta.events(1000)), events)


class PredictionMatchesRealityTests(unittest.TestCase):
    """For every subset of nodes, predicted recoverability == real decode result."""

    def setUp(self):
        self.c = Cluster(7)
        self.s = self.c.store
        self.files = [self.s.put_bytes(os.urandom(3 * CHUNK + 77), "wide.bin")]
        self.s.config.k, self.s.config.m = 2, 1             # different coding params
        self.files.append(self.s.put_bytes(os.urandom(CHUNK + 9), "narrow.bin"))
        self.s.config.k, self.s.config.m = 3, 3
        self.files.append(self.s.put_bytes(os.urandom(2 * CHUNK), "tough.bin"))
        self.s.config.k, self.s.config.m = 4, 2
        self.make_uneven()

    def tearDown(self):
        self.c.close()

    def make_uneven(self):
        """Move one shard of wide.bin chunk 0 onto a node that already holds
        another shard of that stripe (real file move + metadata update)."""
        f = self.files[0]
        sh = self.s.meta.shards(f.file_id, 0)
        src, dst = sh[1], sh[0].node_id
        data = self.c.shard_path(src.node_id, src.shard_id).read_bytes()
        self.s.clients[dst].put_shard(src.shard_id, data, src.sha256)
        self.s.clients[src.node_id].delete_shard(src.shard_id)
        self.s.meta.move_shard(src, dst)
        self.concentrated = dst

    def test_uneven_placement_detected(self):
        r = analyze(observe(self.s))
        wide = next(f for f in r["files"] if f["name"] == "wide.bin")
        self.assertEqual(wide["fault_tolerance"], 1)
        self.assertTrue(wide["placement_concentrated"])
        self.assertTrue(any(s["size"] == 2 and self.concentrated in s["nodes"]
                            for s in wide["minimal_loss_sets"]))

    def test_every_subset(self):
        # Damage before the sweep too: one corrupt and one missing shard.
        tough = self.files[2]
        sh = self.s.meta.shards(tough.file_id, 1)
        flip_bit(self.c.shard_path(sh[0].node_id, sh[0].shard_id))
        self.c.shard_path(sh[3].node_id, sh[3].shard_id).unlink()

        snap = observe(self.s, verify=True)
        real = dict(self.s.clients)
        nodes = sorted(real)
        checked = matched = 0
        for size in range(0, len(nodes) + 1):
            for failed in itertools.combinations(nodes, size):
                predicted = (preview(snap, failed)["predictions"] if failed else
                             {f["file_id"]: f["recoverable"] for f in analyze(snap)["files"]})
                for nid in failed:
                    self.s.clients[nid] = FailFastClient(nid, real[nid].url)
                try:
                    for f in self.files:
                        actual = actually_recoverable(self.s, f.file_id, f.sha256)
                        checked += 1
                        with self.subTest(failed=failed, file=f.name):
                            self.assertEqual(predicted[f.file_id], actual)
                        matched += predicted[f.file_id] == actual
                finally:
                    self.s.clients.update(real)
        self.assertEqual(checked, 2 ** len(nodes) * len(self.files))
        self.assertEqual(matched, checked)


if __name__ == "__main__":
    unittest.main()
