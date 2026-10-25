import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import * as s from "../api/schemas";
import { fixture, type FixtureName } from "./fixtures";

// Every captured 2xx response must satisfy the schema the client uses for it.
const cases: [FixtureName, ZodTypeAny][] = [
  ["health", s.health],
  ["upload", s.fileSummary],
  ["status", s.clusterStatus],
  ["status_node_down", s.clusterStatus],
  ["files", s.fileList],
  ["files_node_down", s.fileList],
  ["file_detail", s.fileDetail],
  ["twin", s.twin],
  ["twin_noshards", s.twin],
  ["preview_survive", s.scenarioPreview],
  ["preview_loss", s.scenarioPreview],
  ["execute", s.scenarioReport],
  ["execute_loss", s.scenarioReport],
  ["scenarios", s.scenarioList],
  ["scenario_detail", s.scenarioReport],
  ["scrub", s.scrubSummary],
  ["repair", s.repairResult],
  ["gc", s.gcResult],
  ["node_stop", s.nodeControlResult],
  ["node_start", s.nodeControlResult],
  ["events", s.eventList],
];

const errorCases: FixtureName[] = ["error_unknown_node", "error_428_execute", "error_409_replace", "error_428_repair", "error_404_file"];

describe("schemas match real backend responses", () => {
  it.each(cases)("%s", (name, schema) => {
    const f = fixture(name);
    expect(f.status).toBeLessThan(300);
    const parsed = schema.safeParse(f.body.data);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 1));
  });

  it.each(errorCases)("error envelope %s", (name) => {
    const f = fixture(name);
    expect(f.status).toBeGreaterThanOrEqual(400);
    expect(s.apiErrorBody.safeParse(f.body).success).toBe(true);
  });

  it("428 from execute carries expected_confirm", () => {
    const f = fixture("error_428_execute");
    expect(f.body.error.details.expected_confirm).toMatch(/^scn-[0-9a-f]{12}$/);
  });

  it("twin with shards=true has per-shard placement; without it does not", () => {
    const withShards = s.twin.parse(fixture("twin").body.data);
    const without = s.twin.parse(fixture("twin_noshards").body.data);
    expect(withShards.files[0]!.stripes[0]!.shards!.length).toBeGreaterThan(0);
    expect(without.files[0]!.stripes[0]!.shards).toBeUndefined();
  });

  it("rejects a response with a retyped field", () => {
    const bad = fixture("status").body.data;
    bad.nodes[0].up = "yes";
    expect(s.clusterStatus.safeParse(bad).success).toBe(false);
  });
});
