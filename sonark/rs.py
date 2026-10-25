"""Systematic Reed-Solomon erasure code over GF(2^8).

A chunk is split into k equal data shards (zero padded). m parity shards are
computed so that ANY k of the k+m shards rebuild the chunk.

Encoding matrix (n x k) is [ I_k ; C ] where C is an m x k Cauchy matrix
C[i][j] = 1 / (x_i + y_j) with x_i = k + i and y_j = j. Every square
submatrix of a Cauchy matrix is invertible, which makes [I ; C] MDS: every
k x k submatrix of the encoding matrix is invertible.
"""

from __future__ import annotations

from . import gf256 as gf


class NotEnoughShards(Exception):
    pass


def _combine(coeffs: list[int], shards: list[bytes], size: int) -> bytes:
    """Return sum_j coeffs[j] * shards[j] over GF(256), byte-wise."""
    acc = 0
    for c, shard in zip(coeffs, shards):
        if c == 0:
            continue
        product = shard if c == 1 else shard.translate(gf.MUL_TABLES[c])
        acc ^= int.from_bytes(product, "little")
    return acc.to_bytes(size, "little")


class ReedSolomon:
    def __init__(self, k: int, m: int):
        if k < 1 or m < 0 or k + m > 256:
            raise ValueError("need k >= 1, m >= 0, k + m <= 256")
        self.k, self.m, self.n = k, m, k + m
        self.parity_rows = [[gf.inv((k + i) ^ j) for j in range(k)] for i in range(m)]
        identity = [[1 if i == j else 0 for j in range(k)] for i in range(k)]
        self.rows = identity + self.parity_rows

    def shard_size(self, length: int) -> int:
        return max(1, -(-length // self.k))

    def split(self, chunk: bytes) -> list[bytes]:
        size = self.shard_size(len(chunk))
        padded = chunk.ljust(size * self.k, b"\0")
        return [padded[i * size:(i + 1) * size] for i in range(self.k)]

    def encode(self, data_shards: list[bytes]) -> list[bytes]:
        """Return all n shards (data followed by parity)."""
        if len(data_shards) != self.k:
            raise ValueError(f"expected {self.k} data shards")
        size = len(data_shards[0])
        if any(len(s) != size for s in data_shards):
            raise ValueError("data shards must be the same size")
        parity = [_combine(row, data_shards, size) for row in self.parity_rows]
        return list(data_shards) + parity

    def encode_chunk(self, chunk: bytes) -> list[bytes]:
        return self.encode(self.split(chunk))

    def reconstruct(self, shards: list[bytes | None]) -> list[bytes]:
        """Fill in missing shards (None). Needs at least k present shards.

        Present shards must already be verified; this function trusts them.
        """
        if len(shards) != self.n:
            raise ValueError(f"expected {self.n} shard slots")
        present = [i for i, s in enumerate(shards) if s is not None]
        if len(present) < self.k:
            raise NotEnoughShards(f"have {len(present)} shards, need {self.k}")
        size = len(shards[present[0]])
        if any(len(shards[i]) != size for i in present):
            raise ValueError("shards must be the same size")

        if all(shards[j] is not None for j in range(self.k)):
            data = list(shards[: self.k])
        else:
            use = present[: self.k]  # sorted, so data shards are preferred
            decode = gf.mat_inv([self.rows[i] for i in use])
            sources = [shards[i] for i in use]
            data = [
                shards[j] if shards[j] is not None else _combine(decode[j], sources, size)
                for j in range(self.k)
            ]

        out = list(data)
        for i, row in enumerate(self.parity_rows):
            existing = shards[self.k + i]
            out.append(existing if existing is not None else _combine(row, data, size))
        return out

    def join(self, data_shards: list[bytes], length: int) -> bytes:
        return b"".join(data_shards[: self.k])[:length]
