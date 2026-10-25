"""Coordinator: splits files into erasure-coded shards, places them on nodes,
reads them back through failures, and scrubs/repairs damaged shards."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Iterator

from .client import NodeClient, NodeError, NodeUnavailable
from .metadata import ChunkRecord, FileRecord, Metadata, ShardRecord, shard_id
from .rs import NotEnoughShards, ReedSolomon

DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class SonarkError(Exception):
    pass


class DataLossError(SonarkError):
    """Fewer than k intact shards exist for a chunk. Data cannot be rebuilt."""


class PlacementError(SonarkError):
    """Not enough healthy nodes to place shards on distinct nodes."""


@dataclass
class ClusterConfig:
    nodes: dict[str, str]
    k: int = 4
    m: int = 2
    chunk_size: int = DEFAULT_CHUNK_SIZE
    metadata: str = "metadata.db"
    base_dir: str = "."

    @classmethod
    def load(cls, path: str | os.PathLike) -> "ClusterConfig":
        path = Path(path)
        raw = json.loads(path.read_text())
        return cls(nodes=raw["nodes"], k=raw.get("k", 4), m=raw.get("m", 2),
                   chunk_size=raw.get("chunk_size", DEFAULT_CHUNK_SIZE),
                   metadata=raw.get("metadata", "metadata.db"),
                   base_dir=str(path.parent))

    def save(self, path: str | os.PathLike) -> None:
        Path(path).write_text(json.dumps(
            {"nodes": self.nodes, "k": self.k, "m": self.m,
             "chunk_size": self.chunk_size, "metadata": self.metadata}, indent=2) + "\n")

    @property
    def metadata_path(self) -> str:
        return str(Path(self.base_dir) / self.metadata)


@dataclass
class ShardIssue:
    file_id: str
    chunk_index: int
    shard_index: int
    node_id: str
    kind: str          # "missing" | "corrupt" | "node_down"
    resolution: str = ""  # filled in by repair

    def __str__(self) -> str:
        s = (f"{self.kind:<9} file={self.file_id[:8]} chunk={self.chunk_index} "
             f"shard={self.shard_index} node={self.node_id}")
        return s + (f" -> {self.resolution}" if self.resolution else "")


@dataclass
class ReadReport:
    file: FileRecord
    issues: list[ShardIssue] = field(default_factory=list)
    reconstructed_chunks: int = 0

    @property
    def degraded(self) -> bool:
        return bool(self.issues)


@dataclass
class ScrubReport:
    files_checked: int = 0
    chunks_checked: int = 0
    shards_checked: int = 0
    issues: list[ShardIssue] = field(default_factory=list)
    repaired: int = 0
    unrepaired: int = 0
    lost_chunks: list[tuple[str, int]] = field(default_factory=list)

    @property
    def healthy(self) -> bool:
        return not self.issues and not self.lost_chunks


class Sonark:
    def __init__(self, config: ClusterConfig, metadata: Metadata | None = None,
                 threadsafe_metadata: bool = False):
        self.config = config
        self.meta = metadata or Metadata(config.metadata_path,
                                         check_same_thread=not threadsafe_metadata)
        self.clients = {nid: NodeClient(nid, url) for nid, url in config.nodes.items()}
        self.pool = ThreadPoolExecutor(max_workers=max(8, 2 * len(self.clients)))
        # Nodes seen down by the last health sweep or a failed request. Skipped
        # until the next sweep so each operation pays a dead node's connect
        # timeout at most once.
        self._down: set[str] = set()

    def close(self) -> None:
        self.pool.shutdown(wait=True)
        for client in self.clients.values():
            client.close()
        self.meta.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ---- node health ---------------------------------------------------

    def node_health(self) -> dict[str, bool]:
        ids = sorted(self.clients)
        health = dict(zip(ids, self.pool.map(lambda nid: self.clients[nid].health(), ids)))
        self._down = {nid for nid, ok in health.items() if not ok}
        return health

    def alive_nodes(self) -> list[str]:
        return [nid for nid, ok in self.node_health().items() if ok]

    # ---- write path ----------------------------------------------------

    def put_file(self, path: str | os.PathLike, name: str | None = None) -> FileRecord:
        with open(path, "rb") as f:
            return self.put_stream(f, name or Path(path).name)

    def put_bytes(self, data: bytes, name: str) -> FileRecord:
        import io
        return self.put_stream(io.BytesIO(data), name)

    def put_stream(self, stream: BinaryIO, name: str) -> FileRecord:
        k, m, chunk_size = self.config.k, self.config.m, self.config.chunk_size
        rs = ReedSolomon(k, m)
        alive = self.alive_nodes()
        if len(alive) < rs.n:
            raise PlacementError(f"need {rs.n} healthy nodes for k={k}, m={m}; "
                                 f"only {len(alive)} are up")
        file_id = uuid.uuid4().hex
        self.meta.create_file(file_id, name, k, m, chunk_size)
        file_hash = hashlib.sha256()
        size = 0
        index = 0
        try:
            while True:
                chunk = stream.read(chunk_size)
                if not chunk:
                    break
                file_hash.update(chunk)
                size += len(chunk)
                self._write_chunk(file_id, index, chunk, rs, alive)
                index += 1
        except BaseException:
            self._abort(file_id)
            raise
        self.meta.complete_file(file_id, size, file_hash.hexdigest(), index)
        self.meta.log("put", file_id, detail=f"{name} size={size} chunks={index}")
        return self.meta.get_file(file_id)

    def _write_chunk(self, file_id: str, index: int, chunk: bytes,
                     rs: ReedSolomon, alive: list[str]) -> None:
        shards = rs.encode_chunk(chunk)
        hashes = [sha256(s) for s in shards]
        # Rotate the starting node per chunk so load spreads across the cluster.
        order = alive[index % len(alive):] + alive[: index % len(alive)]
        planned = order[: rs.n]
        spares = order[rs.n:]

        def write(i: int, node: str) -> bool:
            try:
                self.clients[node].put_shard(shard_id(file_id, index, i), shards[i], hashes[i])
                return True
            except (NodeUnavailable, NodeError):
                return False

        ok = list(self.pool.map(write, range(rs.n), planned))
        placement = list(planned)
        for i, success in enumerate(ok):
            while not success:
                if not spares:
                    raise PlacementError(
                        f"chunk {index}: could not place shard {i} on any healthy node")
                node = spares.pop(0)
                success = write(i, node)
                if success:
                    placement[i] = node

        self.meta.add_chunk(
            ChunkRecord(file_id, index, len(chunk), len(shards[0]), sha256(chunk)),
            [ShardRecord(file_id, index, i, placement[i], hashes[i]) for i in range(rs.n)])

    def _abort(self, file_id: str) -> None:
        for chunk in self.meta.chunks(file_id):
            for s in self.meta.shards(file_id, chunk.chunk_index):
                try:
                    self.clients[s.node_id].delete_shard(s.shard_id)
                except (NodeUnavailable, NodeError, KeyError):
                    pass
        self.meta.delete_file(file_id)

    # ---- read path -----------------------------------------------------

    def _fetch(self, s: ShardRecord) -> tuple[ShardRecord, bytes | None, str | None]:
        """Fetch one shard and verify it. Returns (record, data, issue_kind)."""
        client = self.clients.get(s.node_id)
        if client is None or s.node_id in self._down:
            return s, None, "node_down"
        try:
            data = client.get_shard(s.shard_id)
        except NodeUnavailable:
            self._down.add(s.node_id)
            return s, None, "node_down"
        except NodeError:
            return s, None, "node_down"
        if data is None:
            return s, None, "missing"
        if sha256(data) != s.sha256:
            return s, None, "corrupt"
        return s, data, None

    def _read_chunk(self, f: FileRecord, chunk: ChunkRecord,
                    issues: list[ShardIssue]) -> tuple[bytes, bool]:
        """Return (chunk bytes, whether reconstruction was needed)."""
        rs = ReedSolomon(f.k, f.m)
        records = self.meta.shards(f.file_id, chunk.chunk_index)
        got: list[bytes | None] = [None] * rs.n

        def collect(batch: list[ShardRecord]) -> None:
            for s, data, problem in self.pool.map(self._fetch, batch):
                if problem:
                    issues.append(ShardIssue(f.file_id, chunk.chunk_index,
                                             s.shard_index, s.node_id, problem))
                else:
                    got[s.shard_index] = data

        collect(records[: rs.k])                      # data shards first
        good = sum(x is not None for x in got)
        if good < rs.k:
            collect(records[rs.k:])                   # fall back to parity
        good = sum(x is not None for x in got)
        if good < rs.k:
            raise DataLossError(f"file {f.file_id} chunk {chunk.chunk_index}: "
                                f"only {good} intact shards, need {rs.k}")
        rebuilt = any(got[i] is None for i in range(rs.k))
        data_shards = rs.reconstruct(got)[: rs.k] if rebuilt else got[: rs.k]
        data = rs.join(data_shards, chunk.size)
        if sha256(data) != chunk.sha256:
            raise DataLossError(f"file {f.file_id} chunk {chunk.chunk_index}: "
                                "rebuilt chunk failed SHA-256 check")
        return data, rebuilt

    def iter_chunks(self, ref: str, report: ReadReport | None = None) -> Iterator[bytes]:
        f = self._resolve(ref)
        report = report or ReadReport(f)
        self.node_health()
        file_hash = hashlib.sha256()
        for chunk in self.meta.chunks(f.file_id):
            data, rebuilt = self._read_chunk(f, chunk, report.issues)
            report.reconstructed_chunks += rebuilt
            file_hash.update(data)
            yield data
        if file_hash.hexdigest() != f.sha256:
            raise DataLossError(f"file {f.file_id}: whole-file SHA-256 mismatch")

    def read_bytes(self, ref: str) -> tuple[bytes, ReadReport]:
        report = ReadReport(self._resolve(ref))
        data = b"".join(self.iter_chunks(ref, report))
        return data, report

    def get_file(self, ref: str, out_path: str | os.PathLike) -> ReadReport:
        """Write a file to out_path. Only renames into place once fully verified."""
        report = ReadReport(self._resolve(ref))
        out_path = Path(out_path)
        tmp = out_path.with_name(out_path.name + ".sonark-partial")
        try:
            with open(tmp, "wb") as out:
                for data in self.iter_chunks(ref, report):
                    out.write(data)
            os.replace(tmp, out_path)
        finally:
            if tmp.exists():
                tmp.unlink()
        return report

    def _resolve(self, ref: str) -> FileRecord:
        f = self.meta.get_file(ref)
        if f is None or f.state != "complete":
            raise SonarkError(f"no such file: {ref}")
        return f

    # ---- scrub + repair ------------------------------------------------

    def scrub(self, repair: bool = False, ref: str | None = None) -> ScrubReport:
        """Fetch and hash-check every shard. With repair=True, rebuild bad ones."""
        report = ScrubReport()
        files = [self._resolve(ref)] if ref else self.meta.list_files()
        health = self.node_health()
        for f in files:
            report.files_checked += 1
            for chunk in self.meta.chunks(f.file_id):
                report.chunks_checked += 1
                self._scrub_chunk(f, chunk, report, repair, health)
        self.meta.log("scrub", detail=(
            f"repair={repair} files={report.files_checked} shards={report.shards_checked} "
            f"issues={len(report.issues)} repaired={report.repaired} "
            f"lost={len(report.lost_chunks)}"))
        return report

    def _scrub_chunk(self, f: FileRecord, chunk: ChunkRecord, report: ScrubReport,
                     repair: bool, health: dict[str, bool]) -> None:
        rs = ReedSolomon(f.k, f.m)
        records = self.meta.shards(f.file_id, chunk.chunk_index)
        got: list[bytes | None] = [None] * rs.n
        bad: list[ShardIssue] = []
        for s, data, problem in self.pool.map(self._fetch, records):
            report.shards_checked += 1
            if problem:
                bad.append(ShardIssue(f.file_id, chunk.chunk_index, s.shard_index,
                                      s.node_id, problem))
            else:
                got[s.shard_index] = data
        report.issues.extend(bad)
        if not bad:
            return
        intact = sum(x is not None for x in got)
        if intact < rs.k:
            report.lost_chunks.append((f.file_id, chunk.chunk_index))
            for issue in bad:
                issue.resolution = "UNRECOVERABLE (fewer than k intact shards)"
            report.unrepaired += len(bad)
            self.meta.log("data_loss", f.file_id, chunk.chunk_index,
                          detail=f"intact={intact} k={rs.k}")
            return
        if not repair:
            return

        try:
            full = rs.reconstruct(got)
        except NotEnoughShards:  # pragma: no cover - guarded above
            return
        if sha256(rs.join(full[: rs.k], chunk.size)) != chunk.sha256:
            for issue in bad:
                issue.resolution = "FAILED (rebuilt chunk hash mismatch)"
            report.unrepaired += len(bad)
            return

        by_index = {s.shard_index: s for s in records}
        for issue in bad:
            s = by_index[issue.shard_index]
            shard = full[issue.shard_index]
            if sha256(shard) != s.sha256:
                issue.resolution = "FAILED (rebuilt shard hash mismatch)"
                report.unrepaired += 1
                continue
            target = s.node_id if health.get(s.node_id) else None
            if target is None:
                target = self._pick_spare(f.file_id, chunk.chunk_index, health)
            if target is None:
                issue.resolution = "DEFERRED (no spare healthy node)"
                report.unrepaired += 1
                continue
            try:
                self.clients[target].put_shard(s.shard_id, shard, s.sha256)
            except (NodeUnavailable, NodeError) as e:
                issue.resolution = f"FAILED ({e})"
                report.unrepaired += 1
                continue
            if target != s.node_id:
                self.meta.move_shard(s, target)
                issue.resolution = f"rebuilt and moved to {target}"
            else:
                issue.resolution = f"rebuilt on {target}"
            report.repaired += 1
            self.meta.log("repair", f.file_id, chunk.chunk_index, s.shard_index, target,
                          detail=f"{issue.kind} on {s.node_id}")

    def _pick_spare(self, file_id: str, chunk_index: int,
                    health: dict[str, bool]) -> str | None:
        """A healthy node holding no shard of this chunk, least loaded first."""
        holders = {s.node_id for s in self.meta.shards(file_id, chunk_index)}
        counts = self.meta.shard_counts()
        candidates = [n for n, ok in health.items() if ok and n not in holders]
        if not candidates:
            return None
        return min(candidates, key=lambda n: (counts.get(n, 0), n))

    # ---- housekeeping --------------------------------------------------

    def delete(self, ref: str) -> FileRecord:
        f = self._resolve(ref)
        self._abort(f.file_id)
        self.meta.log("delete", f.file_id, detail=f.name)
        return f

    def gc(self) -> dict[str, int]:
        """Delete shards on live nodes that metadata no longer places there
        (left behind by relocation, deletes, or aborted writes)."""
        removed: dict[str, int] = {}
        for nid in self.alive_nodes():
            client = self.clients[nid]
            expected = self.meta.shard_ids_on_node(nid)
            count = 0
            for sid in client.list_shards():
                if sid not in expected:
                    client.delete_shard(sid)
                    count += 1
            removed[nid] = count
        self.meta.log("gc", detail=json.dumps(removed))
        return removed

    def status(self) -> dict:
        health = self.node_health()
        counts = self.meta.shard_counts()
        files = self.meta.list_files()
        return {
            "k": self.config.k, "m": self.config.m,
            "nodes": {nid: {"url": self.clients[nid].url, "up": up,
                            "shards": counts.get(nid, 0)} for nid, up in health.items()},
            "files": len(files),
            "bytes": sum(f.size for f in files),
        }

