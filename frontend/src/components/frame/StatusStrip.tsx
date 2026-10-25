import { useEvents, useFiles, useHealth, useStatus, useTwin } from "../../api/queries";
import type { FileStatus } from "../../api/schemas";
import { formatTime, plural } from "../../lib/format";
import { fileStatusMeta, nodeState } from "../../lib/status";
import { useUi } from "../../state/ui";
import { cx } from "../common/ui";

/**
 * Slim overview strip (spec 6.A): inline text, not cards. Every value is from
 * the backend; flags appear only when the backend data makes them true.
 */
export default function StatusStrip() {
  const health = useHealth();
  const status = useStatus();
  const files = useFiles();
  const twin = useTwin(false);
  const events = useEvents(false);
  const ui = useUi();

  const nodes = status.data?.nodes ?? [];
  const online = nodes.filter((n) => n.up).length;
  const stopped = nodes.filter((n) => nodeState(n) === "stopped").length;
  const unreachable = nodes.filter((n) => nodeState(n) === "down").length;

  const counts: Record<FileStatus, number> = { healthy: 0, degraded: 0, at_risk: 0, lost: 0 };
  let unknown = 0;
  for (const f of files.data?.files ?? []) {
    if (f.status) counts[f.status]++;
    else unknown++;
  }
  const total = files.data?.files.length ?? 0;

  // Repair is only meaningful for shards the verified snapshot found missing or corrupt.
  let badShards = 0;
  let badFiles = 0;
  for (const f of twin.data?.files ?? []) {
    const n = f.stripes.reduce((a, s) => a + (s.shard_status_counts["missing"] ?? 0) + (s.shard_status_counts["corrupt"] ?? 0), 0);
    badShards += n;
    if (n > 0) badFiles++;
  }
  const lastScrub = events.data?.events.find((e) => e.kind === "scrub");

  const sep = <span className="text-faint" aria-hidden>·</span>;
  const stale = status.isError || files.isError;

  return (
    <div
      role="status"
      aria-label="Cluster status"
      className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-line bg-surface px-3 py-1.5 text-xs", stale && "opacity-70")}
    >
      <span>
        API{" "}
        {health.isError ? (
          <b className="font-medium text-lost">Unreachable</b>
        ) : health.data ? (
          <b className="font-medium text-live">Reachable</b>
        ) : (
          <span className="text-muted">checking…</span>
        )}
      </span>
      {sep}
      {status.data ? (
        <span>
          Nodes <b className="font-mono font-medium text-live">{online}</b> <span className="text-muted">online</span>
          {stopped > 0 && (
            <>
              {" "}
              · <b className="font-mono font-medium text-lost">{stopped}</b> <span className="text-lost">offline (stopped)</span>
            </>
          )}
          {unreachable > 0 && (
            <>
              {" "}
              · <b className="font-mono font-medium text-lost">{unreachable}</b> <span className="text-lost">offline (unreachable)</span>
            </>
          )}
        </span>
      ) : (
        <span className="text-muted">Nodes —</span>
      )}
      {sep}
      <span>
        Files <b className="font-mono font-medium">{files.data ? total : "—"}</b>
      </span>
      {files.data && total > 0 && (
        <>
          {sep}
          <span className="inline-flex items-center gap-2" title="From /api/files: node health only, shard hashes not checked">
            <span className="flex h-1.5 w-24 overflow-hidden rounded-sm bg-bg" aria-hidden>
              {(["lost", "at_risk", "degraded", "healthy"] as const).map((k) =>
                counts[k] ? <span key={k} style={{ flex: counts[k], background: fileStatusMeta[k].color }} /> : null,
              )}
            </span>
            <span className="text-muted">
              <span className="text-healthy">{counts.healthy} healthy</span> · <span className="text-degraded">{counts.degraded} degraded</span> ·{" "}
              <span className="text-at-risk">{counts.at_risk} at risk</span> · <span className="text-lost">{counts.lost} unrecoverable</span>
              {unknown > 0 && ` · ${unknown} unknown`}
              <span className="text-faint"> (fast, unverified)</span>
            </span>
          </span>
        </>
      )}
      {badShards > 0 && twin.data && (
        <>
          {sep}
          <button className="font-medium text-degraded underline-offset-2 hover:underline" onClick={() => ui.setView("integrity")}>
            Repair needed: {plural(badShards, "shard")} missing or corrupt in {plural(badFiles, "file")}
          </button>
          <span className="text-faint">(verified {formatTime(twin.data.snapshot.taken_at)})</span>
        </>
      )}
      <span className="ml-auto text-faint">
        {events.data ? (
          lastScrub ? (
            <>
              Last integrity scan <span className="font-mono">{formatTime(lastScrub.ts)}</span>
            </>
          ) : (
            <button className="text-degraded underline-offset-2 hover:underline" onClick={() => ui.setView("integrity")}>
              Integrity scan needed: none in the recent event log
            </button>
          )
        ) : null}
      </span>
    </div>
  );
}
