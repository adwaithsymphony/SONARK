"""Integration tests against real HTTP storage nodes (in-process threads)."""

import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from sonark import ClusterConfig, DataLossError, PlacementError, Sonark
from sonark.client import NodeClient, NodeError
from sonark.node import NodeServer

CHUNK = 64 * 1024


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class Cluster:
    """N node servers + a coordinator, all in a temp dir."""

    def __init__(self, n_nodes: int, k: int = 4, m: int = 2, threadsafe: bool = False):
        self.dir = Path(tempfile.mkdtemp(prefix="sonark-test-"))
        self.servers: dict[str, NodeServer] = {}
        for i in range(1, n_nodes + 1):
            self.start(f"n{i}")
        cfg = ClusterConfig(nodes={nid: s.url for nid, s in self.servers.items()},
                            k=k, m=m, chunk_size=CHUNK, base_dir=str(self.dir))
        self.store = Sonark(cfg, threadsafe_metadata=threadsafe)

    def start(self, nid: str, wipe: bool = False) -> NodeServer:
        data = self.dir / "nodes" / nid
        if wipe and data.exists():
            shutil.rmtree(data)
        server = NodeServer(nid, data).start()
        self.servers[nid] = server
        if hasattr(self, "store"):  # node came back at a new port
            self.store.clients[nid] = NodeClient(nid, server.url)
        return server

    def stop(self, nid: str) -> None:
        self.servers.pop(nid).stop()

    def shard_path(self, nid: str, sid: str) -> Path:
        return self.dir / "nodes" / nid / "shards" / sid[:2] / sid

    def placement(self, file_id: str, chunk: int) -> list:
        return self.store.meta.shards(file_id, chunk)

    def close(self) -> None:
        self.store.close()
        for s in self.servers.values():
            s.stop()
        shutil.rmtree(self.dir, ignore_errors=True)


def flip_bit(path: Path, offset: int = 0) -> None:
    data = bytearray(path.read_bytes())
    data[offset % len(data)] ^= 0x01
    path.write_bytes(bytes(data))


class SixNodeTests(unittest.TestCase):
    def setUp(self):
        self.c = Cluster(6)
        self.s = self.c.store
        self.data = os.urandom(5 * CHUNK + 1234)  # 6 chunks, short tail
        self.f = self.s.put_bytes(self.data, "blob.bin")

    def tearDown(self):
        self.c.close()

    def read(self):
        return self.s.read_bytes(self.f.file_id)

    def test_round_trip_and_metadata(self):
        self.assertEqual(self.f.chunk_count, 6)
        self.assertEqual(self.f.sha256, sha(self.data))
        data, report = self.read()
        self.assertEqual(data, self.data)
        self.assertFalse(report.degraded)
        for c in range(6):
            nodes = [s.node_id for s in self.c.placement(self.f.file_id, c)]
            self.assertEqual(len(set(nodes)), 6, "shards of a chunk must be on distinct nodes")
        self.assertTrue(self.s.scrub().healthy)

    def test_get_by_name_and_to_file(self):
        out = self.c.dir / "out.bin"
        report = self.s.get_file("blob.bin", out)
        self.assertEqual(out.read_bytes(), self.data)
        self.assertFalse(report.degraded)

    def test_empty_and_tiny_files(self):
        for payload in (b"", b"x", b"abc"):
            f = self.s.put_bytes(payload, f"p{len(payload)}")
            self.assertEqual(self.s.read_bytes(f.file_id)[0], payload)

    def test_one_node_down_read_reconstructs(self):
        self.c.stop("n1")
        data, report = self.read()
        self.assertEqual(data, self.data)
        self.assertEqual(sha(data), self.f.sha256)
        self.assertTrue(report.degraded)
        self.assertTrue(all(i.kind == "node_down" and i.node_id == "n1" for i in report.issues))

    def test_two_nodes_down_read_reconstructs(self):
        self.c.stop("n2")
        self.c.stop("n5")
        data, report = self.read()
        self.assertEqual(data, self.data)
        self.assertGreater(report.reconstructed_chunks, 0)

    def test_three_nodes_down_is_reported_as_data_loss(self):
        for nid in ("n1", "n3", "n6"):
            self.c.stop(nid)
        with self.assertRaises(DataLossError):
            self.read()
        report = self.s.scrub(repair=True)
        self.assertEqual(len(report.lost_chunks), 6)
        self.assertEqual(report.repaired, 0)
        self.assertTrue(all("UNRECOVERABLE" in i.resolution for i in report.issues))

    def test_failed_get_leaves_no_output_file(self):
        for nid in ("n1", "n3", "n6"):
            self.c.stop(nid)
        out = self.c.dir / "out.bin"
        with self.assertRaises(DataLossError):
            self.s.get_file(self.f.file_id, out)
        self.assertFalse(out.exists())
        self.assertFalse((self.c.dir / "out.bin.sonark-partial").exists())

    def test_corrupt_shard_detected_and_repaired(self):
        s0 = self.c.placement(self.f.file_id, 0)[1]
        path = self.c.shard_path(s0.node_id, s0.shard_id)
        flip_bit(path, 100)

        data, report = self.read()
        self.assertEqual(data, self.data)
        self.assertEqual([(i.kind, i.chunk_index, i.shard_index) for i in report.issues],
                         [("corrupt", 0, 1)])

        scan = self.s.scrub()
        self.assertEqual([i.kind for i in scan.issues], ["corrupt"])
        self.assertEqual(scan.repaired, 0)

        fix = self.s.scrub(repair=True)
        self.assertEqual(fix.repaired, 1)
        self.assertEqual(sha(path.read_bytes()), s0.sha256)
        self.assertTrue(self.s.scrub().healthy)

    def test_repeated_repair_is_idempotent(self):
        s = self.c.placement(self.f.file_id, 2)[4]
        self.c.shard_path(s.node_id, s.shard_id).unlink()
        first = self.s.scrub(repair=True)
        self.assertEqual((first.repaired, first.unrepaired), (1, 0))
        self.assertEqual(first.issues[0].kind, "missing")
        for _ in range(3):
            again = self.s.scrub(repair=True)
            self.assertTrue(again.healthy)
            self.assertEqual(again.repaired, 0)

    def test_corruption_beyond_parity_is_unrecoverable(self):
        shards = self.c.placement(self.f.file_id, 3)
        for s in shards[:3]:  # m + 1 = 3 bad shards in one chunk
            flip_bit(self.c.shard_path(s.node_id, s.shard_id))
        with self.assertRaises(DataLossError):
            self.read()
        report = self.s.scrub(repair=True)
        self.assertEqual(report.lost_chunks, [(self.f.file_id, 3)])
        self.assertEqual(report.repaired, 0)
        # Other chunks are still fine; the damaged shards were not overwritten.
        for s in shards[:3]:
            self.assertNotEqual(sha(self.c.shard_path(s.node_id, s.shard_id).read_bytes()),
                                s.sha256)

    def test_mixed_failures_within_tolerance(self):
        self.c.stop("n4")
        s = next(x for x in self.c.placement(self.f.file_id, 1) if x.node_id != "n4")
        flip_bit(self.c.shard_path(s.node_id, s.shard_id))
        data, _ = self.read()
        self.assertEqual(data, self.data)

    def test_node_down_no_spare_is_deferred_then_restart_heals(self):
        self.c.stop("n2")
        report = self.s.scrub(repair=True)
        self.assertGreater(len(report.issues), 0)
        self.assertEqual(report.repaired, 0)
        self.assertTrue(all("DEFERRED" in i.resolution for i in report.issues))
        self.c.start("n2")  # same data directory, new process
        self.assertTrue(self.s.scrub().healthy)

    def test_replaced_empty_node_is_refilled(self):
        self.c.stop("n3")
        self.c.start("n3", wipe=True)  # disk replaced: node is up but empty
        report = self.s.scrub(repair=True)
        self.assertEqual(report.repaired, 6)
        self.assertTrue(all(i.kind == "missing" for i in report.issues))
        self.assertTrue(self.s.scrub().healthy)
        self.assertEqual(self.read()[0], self.data)

    def test_write_needs_enough_nodes(self):
        self.c.stop("n6")
        with self.assertRaises(PlacementError):
            self.s.put_bytes(b"data", "nope")
        self.assertIsNone(self.s.meta.get_file("nope"))

    def test_delete_removes_shards(self):
        self.s.delete(self.f.file_id)
        for nid in self.c.servers:
            self.assertEqual(self.s.clients[nid].list_shards(), [])

    def test_node_rejects_upload_with_wrong_hash(self):
        client = self.s.clients["n1"]
        with self.assertRaises(NodeError):
            client.put_shard("abc", b"hello", sha(b"other"))
        self.assertIsNone(client.get_shard("abc"))

    def test_node_rejects_bad_shard_ids(self):
        client = self.s.clients["n1"]
        for bad in ("..", "a/b", "%2e%2e"):
            with self.assertRaises(NodeError):
                client.put_shard(bad, b"x", sha(b"x"))


class SevenNodeTests(unittest.TestCase):
    def setUp(self):
        self.c = Cluster(7)
        self.s = self.c.store
        self.data = os.urandom(4 * CHUNK)
        self.f = self.s.put_bytes(self.data, "blob.bin")

    def tearDown(self):
        self.c.close()

    def test_node_loss_relocates_then_gc_cleans_returning_node(self):
        victim = "n1"
        held = self.s.meta.shard_ids_on_node(victim)
        self.assertGreater(len(held), 0)
        self.c.stop(victim)

        report = self.s.scrub(repair=True)
        self.assertEqual(report.repaired, len(held))
        self.assertEqual(report.unrepaired, 0)
        self.assertEqual(self.s.meta.shard_ids_on_node(victim), set())
        for c in range(self.f.chunk_count):
            nodes = [s.node_id for s in self.c.placement(self.f.file_id, c)]
            self.assertEqual(len(set(nodes)), 6)
            self.assertNotIn(victim, nodes)
        self.assertTrue(self.s.scrub().healthy)

        # Full redundancy again: two more failures are survivable.
        self.c.stop("n2")
        self.c.stop("n3")
        self.assertEqual(self.s.read_bytes(self.f.file_id)[0], self.data)
        self.c.start("n2")
        self.c.start("n3")

        self.c.start(victim)  # comes back holding stale copies
        removed = self.s.gc()
        self.assertEqual(removed[victim], len(held))
        self.assertEqual(self.s.clients[victim].list_shards(), [])
        self.assertTrue(self.s.scrub().healthy)

    def test_writes_skip_a_down_node(self):
        self.c.stop("n7")
        f = self.s.put_bytes(b"z" * 1000, "z")
        self.assertEqual(self.s.read_bytes(f.file_id)[0], b"z" * 1000)
        on_n7 = {sid for sid in self.s.meta.shard_ids_on_node("n7")
                 if sid.startswith(f.file_id)}
        self.assertEqual(on_n7, set())


if __name__ == "__main__":
    unittest.main()
