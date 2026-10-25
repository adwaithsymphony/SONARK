import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { FactKind, LedgerFact, RecoveryStage, StageState } from "../../lib/evidence";
import { hashDiff } from "../../lib/evidence";
import { formatTime } from "../../lib/format";
import { cx } from "../common/ui";

/** Every state has a glyph and a word, never colour alone. */
export const stageMeta: Record<StageState, { label: string; glyph: string; cls: string }> = {
  succeeded: { label: "Succeeded", glyph: "✓", cls: "text-healthy border-healthy/50" },
  failed: { label: "Failed", glyph: "✕", cls: "text-lost border-lost/60" },
  partial: { label: "Partially reported", glyph: "◐", cls: "text-degraded border-degraded/50" },
  not_reported: { label: "Not reported", glyph: "○", cls: "text-faint border-line-strong" },
  not_reached: { label: "Not reached", glyph: "–", cls: "text-faint border-line-strong" },
};

export function StageBadge({ state }: { state: StageState }) {
  const m = stageMeta[state];
  return (
    <span className={cx("chip border", m.cls)}>
      <span aria-hidden>{m.glyph}</span> {m.label}
    </span>
  );
}

/** Scenario fact chips (spec 6.E): distinct glyph, colour and label for each. */
export const factMeta: Record<FactKind | "awaiting_confirmation" | "in_progress", { label: string; glyph: string; cls: string }> = {
  hypothetical_preview: { label: "Hypothetical preview", glyph: "◌", cls: "border-dashed border-preview text-preview" },
  awaiting_confirmation: { label: "Awaiting confirmation", glyph: "⌨", cls: "border-info/60 text-info" },
  confirmed: { label: "Confirmed", glyph: "⌨", cls: "border-info/60 text-info" },
  in_progress: { label: "Experiment in progress", glyph: "▶", cls: "border-experiment text-experiment" },
  experiment_executed: { label: "Experiment executed", glyph: "▶", cls: "border-experiment/70 text-experiment" },
  observed_failure: { label: "Observed failure", glyph: "↓", cls: "border-lost/60 text-lost" },
  reconstruction_succeeded: { label: "Reconstruction succeeded", glyph: "✓", cls: "border-healthy/50 text-healthy" },
  reconstruction_failed: { label: "Reconstruction failed", glyph: "✕", cls: "border-lost/60 text-lost" },
  verified_recovery: { label: "Verified recovery", glyph: "◆", cls: "border-healthy/50 text-healthy" },
  integrity_failed: { label: "Integrity failed", glyph: "≠", cls: "border-lost/60 text-lost" },
  repair_completed: { label: "Repair completed", glyph: "⟲", cls: "border-healthy/50 text-healthy" },
  repair_incomplete: { label: "Repair incomplete", glyph: "⚠", cls: "border-lost/60 text-lost" },
};

export function FactChip({ kind }: { kind: keyof typeof factMeta }) {
  const m = factMeta[kind];
  return (
    <span className={cx("chip whitespace-nowrap border", m.cls)}>
      <span aria-hidden>{m.glyph}</span> {m.label}
    </span>
  );
}

export function Ledger({ facts }: { facts: LedgerFact[] }) {
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">Scenario state ledger</caption>
      <tbody>
        {facts.map((f, i) => (
          <tr key={i} className="border-t border-line align-top first:border-t-0">
            <td className="py-1 pr-3">
              <FactChip kind={f.kind} />
            </td>
            <td className="py-1 pr-3 text-ink">{f.detail}</td>
            <td className="py-1 text-right font-mono text-2xs text-faint">{f.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Vertical, event-driven recovery timeline (spec 6.F). */
export function RecoveryTimeline({ stages }: { stages: RecoveryStage[] }) {
  return (
    <ol className="relative" aria-label="Recovery timeline">
      {stages.map((s, i) => (
        <TimelineStage key={s.n} s={s} last={i === stages.length - 1} />
      ))}
    </ol>
  );
}

function TimelineStage({ s, last }: { s: RecoveryStage; last: boolean }) {
  const [open, setOpen] = useState(s.state === "failed");
  const m = stageMeta[s.state];
  return (
    <li className="relative pb-2 pl-8">
      {!last && <span className="absolute bottom-0 left-[11px] top-6 w-px bg-line" aria-hidden />}
      <span className={cx("absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full border bg-surface font-mono text-2xs", m.cls)} aria-hidden>
        {m.glyph}
      </span>
      <button
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={s.details.length === 0}
      >
        <span className="text-sm font-medium text-ink">
          {s.n} · {s.title}
        </span>
        <StageBadge state={s.state} />
        <span className="ml-auto font-mono text-2xs text-faint">{s.ts ? formatTime(s.ts) : "no timestamp recorded"}</span>
        {s.details.length > 0 &&
          (open ? <ChevronDown className="no-print h-3 w-3 text-faint" /> : <ChevronRight className="no-print h-3 w-3 text-faint" />)}
      </button>
      <p className="mt-0.5 text-xs text-muted">{s.summary}</p>
      <p className="font-mono text-2xs text-faint">source: {s.source}</p>
      {s.details.length > 0 && (
        // collapsed details stay in the DOM so a printed proof always contains them
        <ul className={cx("mt-1 space-y-0.5 rounded-sm border border-line bg-bg/60 p-2 font-mono text-2xs", !open && "hidden print:block")}>
          {s.details.map((d, i) => (
            <li key={i} className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-2">
              <span className="text-muted">{d.label}</span>
              <span className={d.state ? stageMeta[d.state].cls.split(" ")[0] : "text-ink"}>{d.value}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Expected vs recovered SHA-256, aligned character by character. Differences
 * are highlighted and the first differing position is named.
 */
export function HashCompare({ expected, actual }: { expected: string; actual: string | null }) {
  if (!actual)
    return (
      <div className="font-mono text-2xs">
        <div>
          <span className="inline-block w-20 text-faint">original</span> <span className="break-all text-ink">{expected}</span>
        </div>
        <div>
          <span className="inline-block w-20 text-faint">recovered</span> <span className="text-faint">— no bytes were recovered, nothing to compare</span>
        </div>
      </div>
    );
  const d = hashDiff(expected, actual);
  const line = (segs: { text: string; same: boolean }[]) =>
    segs.map((s, i) => (
      <span key={i} className={s.same ? "text-ink" : "rounded-sm bg-lost/25 text-lost underline decoration-lost"}>
        {s.text}
      </span>
    ));
  return (
    <div className="space-y-0.5 font-mono text-2xs" aria-label={d.firstDiff === null ? "Hashes identical" : `Hashes differ from character ${d.firstDiff + 1}`}>
      <div className="flex gap-2">
        <span className="w-20 shrink-0 text-faint">original</span>
        <span className="break-all">{line(d.a)}</span>
      </div>
      <div className="flex gap-2">
        <span className="w-20 shrink-0 text-faint">recovered</span>
        <span className="break-all">{line(d.b)}</span>
      </div>
      <div className="flex gap-2">
        <span className="w-20 shrink-0 text-faint">verdict</span>
        {d.firstDiff === null ? (
          <span className="text-healthy">✓ identical: all {expected.length} hex characters match</span>
        ) : (
          <span className="text-lost">✕ differ: first difference at character {d.firstDiff + 1}</span>
        )}
      </div>
    </div>
  );
}
