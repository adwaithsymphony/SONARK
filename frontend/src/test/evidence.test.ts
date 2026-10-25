import { describe, expect, it } from "vitest";
import { scenarioReport, type ScenarioReport } from "../api/schemas";
import { fileVerdict, hashDiff, ledger, recoveryStages } from "../lib/evidence";
import { data } from "./fixtures";

const survive = () => scenarioReport.parse(data("execute"));
const loss = () => scenarioReport.parse(data("execute_loss"));

describe("recovery timeline from real reports", () => {
  it("has the nine stages, with timestamps only where the backend recorded one", () => {
    const st = recoveryStages(survive());
    expect(st.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const r = survive();
    const tsSet = new Set(r.timeline.map((t) => t.ts));
    for (const s of st) if (s.ts !== null) expect(tsSet.has(s.ts)).toBe(true);
    // retrieval start and the surviving-shard list are not recorded by the backend
    expect(st[1]!.state).toBe("not_reported");
    expect(st[1]!.ts).toBeNull();
    expect(st[2]!.state).toBe("partial");
  });
  it("survivable run: every recorded stage succeeded", () => {
    const st = recoveryStages(survive());
    for (const i of [0, 3, 4, 5, 6, 7, 8]) expect(st[i]!.state).toBe("succeeded");
  });
  it("loss run: reconstruction failed for some files, only recovered bytes were hashed, restore and repair succeeded", () => {
    const st = recoveryStages(loss());
    expect(st[3]!.state).toBe("failed");
    // the fixture's empty file reads back and matches; the two lost files had nothing to hash
    expect(st[4]!.state).toBe("partial");
    expect(st[4]!.summary).toContain("1/1 decoded file(s) match");
    expect(st[5]!.state).toBe("succeeded"); // prediction matched
    expect(st[6]!.state).toBe("succeeded");
    expect(st[8]!.state).toBe("succeeded");
  });
  it("a missing timeline entry is reported as not reached, never filled in", () => {
    const r = survive();
    const cut: ScenarioReport = { ...r, timeline: r.timeline.filter((t) => t.action !== "repair_ran") };
    const st = recoveryStages(cut);
    expect(st[7]!.state).toBe("not_reached");
    expect(st[7]!.ts).toBeNull();
  });
});

describe("verdicts and ledger", () => {
  it("reconstructed and verified are separate facts", () => {
    const o = Object.values(survive().outage_results)[0]!;
    expect(fileVerdict({ ...o, reconstructed_chunks: 2, sha256_match: true }).label).toBe("RECONSTRUCTED · VERIFIED");
    expect(fileVerdict({ ...o, reconstructed_chunks: 0, sha256_match: true }).label).toBe("READ · VERIFIED");
    expect(fileVerdict({ ...o, sha256_actual: "ab", sha256_match: false }).label).toBe("RECONSTRUCTED · INTEGRITY FAILED");
    expect(fileVerdict({ ...o, error: "only 3 intact shards", sha256_actual: null }).label).toBe("NOT RECONSTRUCTED");
  });
  it("loss ledger records failure and repair as separate rows", () => {
    const kinds = ledger(loss()).map((f) => f.kind);
    expect(kinds).toContain("reconstruction_failed");
    expect(kinds).toContain("observed_failure");
    expect(kinds).toContain("repair_completed");
    expect(kinds).not.toContain("integrity_failed");
    expect(ledger(loss()).find((f) => f.kind === "verified_recovery")!.detail).toMatch(/^1 file/);
  });
});

describe("hash comparison", () => {
  it("marks the differing characters and the first difference", () => {
    const d = hashDiff("abcdef", "abXdeY");
    expect(d.firstDiff).toBe(2);
    expect(d.b).toEqual([
      { text: "ab", same: true },
      { text: "X", same: false },
      { text: "de", same: true },
      { text: "Y", same: false },
    ]);
    expect(hashDiff("aa", "aa").firstDiff).toBeNull();
  });
});
