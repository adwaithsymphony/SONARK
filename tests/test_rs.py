import itertools
import os
import random
import unittest

from sonark import gf256 as gf
from sonark.rs import NotEnoughShards, ReedSolomon

# Small configurations tested exhaustively over every erasure pattern.
CONFIGS = [(1, 0), (1, 1), (1, 3), (2, 1), (2, 2), (3, 2), (4, 2), (5, 3), (6, 3), (8, 4)]


class TestGF256(unittest.TestCase):
    def test_mul_div_inverse_all_pairs(self):
        for a in range(256):
            for b in range(1, 256):
                self.assertEqual(gf.div(gf.mul(a, b), b), a)

    def test_every_nonzero_has_inverse(self):
        for a in range(1, 256):
            self.assertEqual(gf.mul(a, gf.inv(a)), 1)

    def test_mul_tables_match_mul(self):
        for c in (0, 1, 2, 3, 29, 142, 255):
            for x in range(256):
                self.assertEqual(gf.MUL_TABLES[c][x], gf.mul(c, x))

    def test_distributive_sampled(self):
        rnd = random.Random(1)
        for _ in range(5000):
            a, b, c = rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)
            self.assertEqual(gf.mul(a, b ^ c), gf.mul(a, b) ^ gf.mul(a, c))
            self.assertEqual(gf.mul(gf.mul(a, b), c), gf.mul(a, gf.mul(b, c)))

    def test_mat_inv(self):
        rnd = random.Random(2)
        done = 0
        while done < 50:
            n = rnd.randint(1, 6)
            m = [[rnd.randrange(256) for _ in range(n)] for _ in range(n)]
            try:
                inv = gf.mat_inv(m)
            except ValueError:
                continue
            ident = [[1 if i == j else 0 for j in range(n)] for i in range(n)]
            self.assertEqual(gf.mat_mul(m, inv), ident)
            done += 1

    def test_singular_matrix_rejected(self):
        with self.assertRaises(ValueError):
            gf.mat_inv([[1, 2], [1, 2]])


class TestReedSolomon(unittest.TestCase):
    def test_every_k_by_k_submatrix_invertible(self):
        for k, m in CONFIGS + [(10, 4)]:
            rs = ReedSolomon(k, m)
            for rows in itertools.combinations(range(rs.n), k):
                gf.mat_inv([rs.rows[r] for r in rows])  # raises if singular

    def test_systematic(self):
        rs = ReedSolomon(4, 2)
        data = os.urandom(1001)
        shards = rs.encode_chunk(data)
        self.assertEqual(rs.join(shards[:4], len(data)), data)

    def test_recover_every_erasure_pattern(self):
        """For each config, erase every subset of up to m shards and rebuild."""
        rnd = random.Random(3)
        for k, m in CONFIGS:
            rs = ReedSolomon(k, m)
            for length in (1, k, 7 * k + 3, 257):
                data = bytes(rnd.randrange(256) for _ in range(length))
                full = rs.encode_chunk(data)
                for lost in range(m + 1):
                    for erased in itertools.combinations(range(rs.n), lost):
                        with self.subTest(k=k, m=m, length=length, erased=erased):
                            shards = [None if i in erased else s for i, s in enumerate(full)]
                            rebuilt = rs.reconstruct(shards)
                            self.assertEqual(rebuilt, full)
                            self.assertEqual(rs.join(rebuilt, length), data)

    def test_too_many_erasures_raise(self):
        for k, m in CONFIGS:
            rs = ReedSolomon(k, m)
            full = rs.encode_chunk(os.urandom(50))
            for erased in itertools.combinations(range(rs.n), m + 1):
                shards = [None if i in erased else s for i, s in enumerate(full)]
                with self.assertRaises(NotEnoughShards):
                    rs.reconstruct(shards)

    def test_larger_shards(self):
        rs = ReedSolomon(10, 4)
        data = os.urandom(3 * 1024 * 1024 + 17)
        full = rs.encode_chunk(data)
        shards = list(full)
        for i in (0, 3, 9, 12):
            shards[i] = None
        self.assertEqual(rs.reconstruct(shards), full)

    def test_invalid_params(self):
        for k, m in [(0, 1), (1, -1), (200, 57)]:
            with self.assertRaises(ValueError):
                ReedSolomon(k, m)
        ReedSolomon(200, 56)

    def test_mismatched_sizes_rejected(self):
        rs = ReedSolomon(2, 1)
        with self.assertRaises(ValueError):
            rs.encode([b"ab", b"a"])
        with self.assertRaises(ValueError):
            rs.reconstruct([b"ab", None, b"a"])


if __name__ == "__main__":
    unittest.main()
