import { describe, expect, it, vi } from "vitest";
import { exportEvents, shardId } from "../components/frame/DetailInspectors";
import type { SonarkEvent } from "../api/schemas";

describe("event export", () => {
  it("writes CSV with quoting for commas, quotes and JSON details", () => {
    globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}); // jsdom cannot navigate
    const rows: SonarkEvent[] = [
      { ts: "2026-10-25T01:00:00+00:00", kind: "scrub", file_id: null, chunk_index: null, shard_index: null, node_id: null, detail: 'repair=False, "x"' },
      { ts: "2026-10-25T01:00:01+00:00", kind: "scenario_end", file_id: null, chunk_index: null, shard_index: null, node_id: null, detail: { run_id: "run-1" } },
    ];
    const csv = exportEvents(rows, "csv");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("ts,kind,node_id,file_id,chunk_index,shard_index,detail");
    expect(lines[1]).toBe('2026-10-25T01:00:00+00:00,scrub,,,,,"repair=False, ""x"""');
    expect(lines[2]).toBe('2026-10-25T01:00:01+00:00,scenario_end,,,,,"{""run_id"":""run-1""}"');
    const json = JSON.parse(exportEvents(rows, "json"));
    expect(json.events).toHaveLength(2);
    expect(json.exported_by).toContain("GET /api/events");
  });
  it("shard ids follow the backend naming scheme", () => {
    expect(shardId("abc", 2, 5)).toBe("abc-000002-005");
  });
});
