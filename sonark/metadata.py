"""Metadata store (SQLite). The single source of truth for where data lives."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    file_id      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    sha256       TEXT,
    k            INTEGER NOT NULL,
    m            INTEGER NOT NULL,
    chunk_size   INTEGER NOT NULL,
    chunk_count  INTEGER NOT NULL DEFAULT 0,
    state        TEXT NOT NULL CHECK (state IN ('writing', 'complete')),
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_name ON files(name);

CREATE TABLE IF NOT EXISTS chunks (
    file_id      TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    shard_size   INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    PRIMARY KEY (file_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS shards (
    file_id      TEXT NOT NULL,
    chunk_index  INTEGER NOT NULL,
    shard_index  INTEGER NOT NULL,
    node_id      TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    PRIMARY KEY (file_id, chunk_index, shard_index),
    FOREIGN KEY (file_id, chunk_index) REFERENCES chunks(file_id, chunk_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS shards_node ON shards(node_id);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    kind         TEXT NOT NULL,
    file_id      TEXT,
    chunk_index  INTEGER,
    shard_index  INTEGER,
    node_id      TEXT,
    detail       TEXT
);

CREATE TABLE IF NOT EXISTS scenarios (
    run_id       TEXT PRIMARY KEY,
    scenario_id  TEXT NOT NULL,
    ts           TEXT NOT NULL,
    nodes        TEXT NOT NULL,
    mode         TEXT NOT NULL,
    matched      INTEGER NOT NULL,
    report       TEXT NOT NULL
);
"""


def shard_id(file_id: str, chunk_index: int, shard_index: int) -> str:
    return f"{file_id}-{chunk_index:06d}-{shard_index:03d}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class FileRecord:
    file_id: str
    name: str
    size: int
    sha256: str | None
    k: int
    m: int
    chunk_size: int
    chunk_count: int
    state: str
    created_at: str


@dataclass(frozen=True)
class ChunkRecord:
    file_id: str
    chunk_index: int
    size: int
    shard_size: int
    sha256: str


@dataclass(frozen=True)
class ShardRecord:
    file_id: str
    chunk_index: int
    shard_index: int
    node_id: str
    sha256: str

    @property
    def shard_id(self) -> str:
        return shard_id(self.file_id, self.chunk_index, self.shard_index)


class Metadata:
    def __init__(self, path: str, check_same_thread: bool = True):
        # check_same_thread=False is for the API server, which serializes all
        # access behind one lock.
        self.db = sqlite3.connect(path, check_same_thread=check_same_thread)
        self.threadsafe = not check_same_thread
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    # files
    def create_file(self, file_id: str, name: str, k: int, m: int, chunk_size: int) -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO files (file_id, name, size, k, m, chunk_size, state, created_at)"
                " VALUES (?, ?, 0, ?, ?, ?, 'writing', ?)",
                (file_id, name, k, m, chunk_size, _now()))

    def complete_file(self, file_id: str, size: int, sha256: str, chunk_count: int) -> None:
        with self.db:
            self.db.execute(
                "UPDATE files SET size = ?, sha256 = ?, chunk_count = ?, state = 'complete'"
                " WHERE file_id = ?", (size, sha256, chunk_count, file_id))

    def get_file(self, ref: str) -> FileRecord | None:
        row = self.db.execute(
            "SELECT * FROM files WHERE file_id = ? OR (name = ? AND state = 'complete')"
            " ORDER BY (file_id = ?) DESC, created_at DESC, rowid DESC LIMIT 1",
            (ref, ref, ref)).fetchone()
        return FileRecord(*row) if row else None

    def list_files(self, include_incomplete: bool = False) -> list[FileRecord]:
        sql = "SELECT * FROM files"
        if not include_incomplete:
            sql += " WHERE state = 'complete'"
        return [FileRecord(*r) for r in self.db.execute(sql + " ORDER BY created_at, rowid")]

    def delete_file(self, file_id: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM shards WHERE file_id = ?", (file_id,))
            self.db.execute("DELETE FROM chunks WHERE file_id = ?", (file_id,))
            self.db.execute("DELETE FROM files WHERE file_id = ?", (file_id,))

    # chunks + shards
    def add_chunk(self, chunk: ChunkRecord, shards: list[ShardRecord]) -> None:
        with self.db:
            self.db.execute("INSERT INTO chunks VALUES (?, ?, ?, ?, ?)",
                            (chunk.file_id, chunk.chunk_index, chunk.size,
                             chunk.shard_size, chunk.sha256))
            self.db.executemany("INSERT INTO shards VALUES (?, ?, ?, ?, ?)",
                                [(s.file_id, s.chunk_index, s.shard_index, s.node_id, s.sha256)
                                 for s in shards])

    def chunks(self, file_id: str) -> list[ChunkRecord]:
        return [ChunkRecord(*r) for r in self.db.execute(
            "SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index", (file_id,))]

    def shards(self, file_id: str, chunk_index: int) -> list[ShardRecord]:
        return [ShardRecord(*r) for r in self.db.execute(
            "SELECT * FROM shards WHERE file_id = ? AND chunk_index = ? ORDER BY shard_index",
            (file_id, chunk_index))]

    def move_shard(self, s: ShardRecord, new_node: str) -> None:
        with self.db:
            self.db.execute(
                "UPDATE shards SET node_id = ? WHERE file_id = ? AND chunk_index = ?"
                " AND shard_index = ?", (new_node, s.file_id, s.chunk_index, s.shard_index))

    def shard_ids_on_node(self, node_id: str) -> set[str]:
        return {shard_id(f, c, i) for f, c, i in self.db.execute(
            "SELECT file_id, chunk_index, shard_index FROM shards WHERE node_id = ?",
            (node_id,))}

    def all_file_ids(self) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT file_id FROM files")}

    def shard_counts(self) -> dict[str, int]:
        return dict(self.db.execute("SELECT node_id, COUNT(*) FROM shards GROUP BY node_id"))

    # events
    def log(self, kind: str, file_id=None, chunk_index=None, shard_index=None,
            node_id=None, detail=None) -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO events (ts, kind, file_id, chunk_index, shard_index, node_id, detail)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (_now(), kind, file_id, chunk_index, shard_index, node_id, detail))

    def events(self, limit: int = 50) -> list[tuple]:
        return list(self.db.execute(
            "SELECT ts, kind, file_id, chunk_index, shard_index, node_id, detail"
            " FROM events ORDER BY id DESC LIMIT ?", (limit,)))

    # scenarios
    def save_scenario(self, run_id: str, scenario_id: str, nodes: list[str], mode: str,
                      matched: bool, report_json: str) -> None:
        with self.db:
            self.db.execute("INSERT INTO scenarios VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (run_id, scenario_id, _now(), json.dumps(nodes), mode,
                             int(matched), report_json))

    def list_scenarios(self, limit: int = 50) -> list[dict]:
        return [{"run_id": r[0], "scenario_id": r[1], "ts": r[2], "nodes": json.loads(r[3]),
                 "mode": r[4], "prediction_matched": bool(r[5])}
                for r in self.db.execute(
                    "SELECT run_id, scenario_id, ts, nodes, mode, matched FROM scenarios"
                    " ORDER BY ts DESC, rowid DESC LIMIT ?", (limit,))]

    def get_scenario(self, run_id: str) -> str | None:
        row = self.db.execute("SELECT report FROM scenarios WHERE run_id = ?",
                              (run_id,)).fetchone()
        return row[0] if row else None
