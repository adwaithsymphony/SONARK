"""Survival Twin analyzer: pure tests against brute force."""

import copy
import itertools
import random
import unittest

from sonark.twin import (FileState, ShardState, Snapshot, StripeState, analyze,
                         analyze_file, min_loss_size, preview, scenario_id,
                         stripe_minimal_loss_sets)

NODES6 = [f"n{i}" for i in range(1, 7)]


def stripe(k, m, placement, statuses=None, index=0):
    statuses = statuses or ["ok"] * len(placement)
    return StripeState(index, k, m, [ShardState(i, n, s)
                                     for i, (n, s) in enumerate(zip(placement, statuses))])


def file(stripes, fid="f1"):
    return FileState(fid, fid + ".bin", 100, "00" * 32, stripes)


def snap(files, nodes=None, down=()):
    nodes = nodes or sorted({s.node_id for f in files for st in f.stripes for s in st.shards})
    return Snapshot("t", True, {n: n not in down for n in nodes}, files)


def sets(report):
    return {frozenset(s["nodes"]) for s in report["minimal_loss_sets"]}


def brute_lost(fs: FileState, failed) -> bool:
    failed = set(failed)
    for st in fs.stripes:
        ok = sum(1 for s in st.shards if s.valid and s.node_id not in failed)
        if ok < st.k:
            return True
    return False


def brute_minimal(fs: FileState, nodes):
    lost = [frozenset(c) for r in range(len(nodes) + 1)
            for c in itertools.combinations(nodes, r) if brute_lost(fs, c)]
    return {s for s in lost if not any(t < s for t in lost)}


class StripeMathTests(unittest.TestCase):
    def test_conventional_4_plus_2(self):
        r = analyze_file(file([stripe(4, 2, NODES6)]))
        self.assertEqual(r["status"], "healthy")
        self.assertEqual(r["smallest_loss_set_size"], 3)
        self.assertEqual(r["fault_tolerance"], 2)
        self.assertEqual(sets(r), {frozenset(c) for c in itertools.combinations(NODES6, 3)})
        self.assertEqual(r["minimal_loss_sets_total"], 20)
        self.assertFalse(r["placement_concentrated"])

    def test_missing_corrupt_and_down_shards_do_not_count(self):
        for bad in ("missing", "corrupt", "node_down"):
            st = stripe(4, 2, NODES6, ["ok", bad, "ok", "ok", "ok", "ok"])
            r = analyze_file(file([st]))
            self.assertEqual(r["status"], "degraded", bad)
            self.assertEqual(r["fault_tolerance"], 1)
            self.assertEqual(r["stripes"][0]["valid"], 5)
            self.assertEqual(r["stripes"][0]["shard_status_counts"][bad], 1)
            # Losing n2 costs nothing more: its shard is already invalid.
            self.assertNotIn("n2", {n for s in sets(r) for n in s})
            self.assertEqual(len(sets(r)), 10)  # pairs of the 5 valid holders

    def test_unverified_counts_as_valid(self):
        r = analyze_file(file([stripe(4, 2, NODES6, ["unverified"] * 6)]))
        self.assertEqual(r["status"], "healthy")
        self.assertEqual(r["fault_tolerance"], 2)

    def test_uneven_placement_two_shards_on_one_node(self):
        placement = ["n1", "n1", "n2", "n3", "n4", "n5"]
        r = analyze_file(file([stripe(4, 2, placement)]))
        self.assertEqual(r["smallest_loss_set_size"], 2)
        self.assertEqual(r["fault_tolerance"], 1)
        self.assertTrue(r["placement_concentrated"])
        expected = {frozenset({"n1", x}) for x in ["n2", "n3", "n4", "n5"]} | {
            frozenset(c) for c in itertools.combinations(["n2", "n3", "n4", "n5"], 3)}
        self.assertEqual(sets(r), expected)

    def test_at_risk_when_margin_zero(self):
        st = stripe(4, 2, NODES6, ["ok", "ok", "ok", "ok", "missing", "corrupt"])
        r = analyze_file(file([st]))
        self.assertEqual(r["status"], "at_risk")
        self.assertEqual(r["fault_tolerance"], 0)
        self.assertEqual(sets(r), {frozenset({n}) for n in NODES6[:4]})

    def test_already_lost(self):
        st = stripe(4, 2, NODES6, ["ok", "ok", "ok", "missing", "corrupt", "node_down"])
        r = analyze_file(file([st]))
        self.assertEqual(r["status"], "lost")
        self.assertFalse(r["recoverable"])
        self.assertEqual(r["smallest_loss_set_size"], 0)
        self.assertEqual(sets(r), {frozenset()})
        self.assertIn("Unrecoverable", r["explanation"])

    def test_multiple_stripes_different_placement(self):
        a = stripe(4, 2, NODES6, index=0)
        b = stripe(4, 2, ["n3", "n4", "n5", "n6", "n7", "n8"], index=1)
        fs = file([a, b])
        r = analyze_file(fs)
        nodes = [f"n{i}" for i in range(1, 9)]
        self.assertEqual(sets(r), brute_minimal(fs, nodes))
        self.assertEqual(r["fault_tolerance"], 2)
        row = next(s for s in r["minimal_loss_sets"] if set(s["nodes"]) == {"n1", "n2", "n3"})
        self.assertEqual(row["stripes_lost"], [0])
        row = next(s for s in r["minimal_loss_sets"] if set(s["nodes"]) == {"n4", "n5", "n6"})
        self.assertEqual(row["stripes_lost"], [0, 1])

    def test_mixed_coding_parameters_in_one_snapshot(self):
        f1 = file([stripe(2, 1, ["n1", "n2", "n3"])], "small")
        f2 = file([stripe(6, 3, [f"n{i}" for i in range(1, 10)])], "wide")
        res = analyze(snap([f1, f2]))
        by = {f["file_id"]: f for f in res["files"]}
        self.assertEqual(by["small"]["fault_tolerance"], 1)
        self.assertEqual(by["wide"]["fault_tolerance"], 3)
        self.assertEqual(by["wide"]["coding"], ["6+3"])
        self.assertEqual(res["summary"]["cluster_fault_tolerance"], 1)
        # Cluster-wide minimal sets: inclusion-minimal sets that destroy ANY file.
        nodes = [f"n{i}" for i in range(1, 10)]
        lost = [frozenset(c) for r in range(1, 10) for c in itertools.combinations(nodes, r)
                if brute_lost(f1, c) or brute_lost(f2, c)]
        expect = {x for x in lost if not any(y < x for y in lost)}
        got = {frozenset(s["nodes"]) for s in res["cluster_minimal_loss_sets"]}
        self.assertEqual(res["cluster_minimal_loss_sets_total"], len(expect))
        self.assertTrue(got <= expect)
        self.assertTrue({frozenset(c) for c in itertools.combinations(["n1", "n2", "n3"], 2)}
                        <= got)

    def test_empty_file(self):
        r = analyze_file(file([]))
        self.assertTrue(r["recoverable"])
        self.assertIsNone(r["fault_tolerance"])
        self.assertEqual(r["minimal_loss_sets"], [])

    def test_min_loss_size_greedy(self):
        self.assertEqual(min_loss_size({"a": 3, "b": 1, "c": 1}, 3), 1)
        self.assertEqual(min_loss_size({"a": 1, "b": 1, "c": 1}, 3), 3)
        self.assertEqual(min_loss_size({"a": 1}, 0), 0)

    def test_enumeration_cap_keeps_smallest_exact(self):
        st = stripe(10, 6, [f"n{i}" for i in range(16)])
        w = st.weights()
        found, complete = stripe_minimal_loss_sets(w, 7, max_combinations=100)
        self.assertFalse(complete)
        r = analyze_file(file([st]))
        self.assertEqual(r["smallest_loss_set_size"], 7)  # exact regardless of cap

    def test_matches_brute_force_on_random_placements(self):
        rnd = random.Random(42)
        statuses = ["ok"] * 6 + ["unverified", "missing", "corrupt", "node_down"]
        for trial in range(300):
            nodes = [f"n{i}" for i in range(rnd.randint(3, 8))]
            stripes = []
            for c in range(rnd.randint(1, 4)):
                k = rnd.randint(1, 4)
                m = rnd.randint(0, 3)
                placement = [rnd.choice(nodes) for _ in range(k + m)]  # uneven on purpose
                stats = [rnd.choice(statuses) for _ in range(k + m)]
                stripes.append(stripe(k, m, placement, stats, index=c))
            fs = file(stripes)
            r = analyze_file(fs, max_sets=10_000)
            with self.subTest(trial=trial):
                expect = brute_minimal(fs, nodes)
                self.assertEqual(sets(r), expect)
                self.assertTrue(r["enumeration_complete"])
                smallest = min((len(s) for s in expect), default=None)
                self.assertEqual(r["smallest_loss_set_size"], smallest)
                self.assertEqual(r["recoverable"], not brute_lost(fs, ()))
                # Every scenario prediction agrees with direct evaluation.
                s = snap([fs], nodes)
                for size in range(1, len(nodes) + 1):
                    for failed in itertools.combinations(nodes, size):
                        p = preview(s, failed)
                        self.assertEqual(p["predictions"][fs.file_id],
                                         not brute_lost(fs, failed), failed)


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.f1 = file([stripe(4, 2, NODES6, index=0),
                        stripe(4, 2, ["n2", "n3", "n4", "n5", "n6", "n1"], index=1)], "a")
        self.f2 = file([stripe(2, 1, ["n4", "n5", "n6"])], "b")
        self.s = snap([self.f1, self.f2], NODES6)

    def test_survivable_scenario(self):
        p = preview(self.s, ["n1", "n2"])
        self.assertFalse(p["summary"]["data_loss_predicted"])
        self.assertEqual(p["summary"]["files_affected"], 1)
        self.assertEqual(p["summary"]["files_unaffected"], 1)
        self.assertEqual(p["predictions"], {"a": True, "b": True})
        a = p["files"][0]
        self.assertEqual((a["status_before"], a["status_after"]), ("healthy", "at_risk"))
        self.assertEqual([r["valid_after"] for r in a["stripes"]], [4, 4])
        self.assertIn("Survives", a["explanation"])

    def test_loss_scenario(self):
        p = preview(self.s, ["n4", "n5"])
        self.assertTrue(p["summary"]["data_loss_predicted"])
        self.assertEqual(p["predictions"], {"a": True, "b": False})
        b = next(f for f in p["files"] if f["file_id"] == "b")
        self.assertEqual(b["stripes_lost"], [0])
        self.assertIn("LOST", b["stripes"][0]["explanation"])

    def test_preview_does_not_mutate(self):
        before = copy.deepcopy(self.s)
        preview(self.s, ["n1", "n2", "n3"])
        self.assertEqual(before.fingerprint(), self.s.fingerprint())
        self.assertEqual(before, self.s)

    def test_validation(self):
        with self.assertRaises(ValueError):
            preview(self.s, [])
        with self.assertRaises(ValueError):
            preview(self.s, ["n99"])

    def test_scenario_id_stable_and_state_sensitive(self):
        a = preview(self.s, ["n2", "n1"])["scenario_id"]
        self.assertEqual(a, preview(self.s, ["n1", "n2"])["scenario_id"])
        self.assertEqual(a, scenario_id(self.s, ["n1", "n2"]))
        self.assertNotEqual(a, preview(self.s, ["n1"])["scenario_id"])
        changed = copy.deepcopy(self.s)
        changed.files[0].stripes[0].shards[0] = ShardState(0, "n1", "corrupt")
        self.assertNotEqual(a, preview(changed, ["n1", "n2"])["scenario_id"])

    def test_already_down_node_reported(self):
        st = stripe(4, 2, NODES6, ["node_down", "ok", "ok", "ok", "ok", "ok"])
        s = snap([file([st])], NODES6, down=["n1"])
        p = preview(s, ["n1", "n2"])
        self.assertEqual(p["nodes_already_down"], ["n1"])
        self.assertEqual(p["files"][0]["stripes"][0]["valid_after"], 4)


if __name__ == "__main__":
    unittest.main()
