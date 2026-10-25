/** Last backend-confirmed scrub/repair result, kept for the dock's Findings tab. */
import { create } from "zustand";
import type { RepairResult, ScrubSummary } from "../api/schemas";

export type Finding =
  | { kind: "scrub"; at: number; result: ScrubSummary }
  | { kind: "repair"; at: number; result: RepairResult };

export const useFindings = create<{ last: Finding | null; set: (f: Finding) => void }>((set) => ({
  last: null,
  set: (last) => set({ last }),
}));
