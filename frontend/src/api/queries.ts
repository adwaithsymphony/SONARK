/**
 * TanStack Query hooks. Polling pauses while a scenario is executing: the API
 * serializes storage operations behind one lock, so extra requests would only
 * queue up behind the experiment.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useExperimentRunning } from "../state/ui";
import { api } from "./endpoints";
import { backoff, usePerf } from "./scheduler";

export const qk = {
  health: ["health"] as const,
  status: ["status"] as const,
  files: ["files"] as const,
  fileDetail: (id: string, verify: boolean) => ["file", id, verify] as const,
  twin: ["twin"] as const,
  preview: (nodes: string[], stateSig: string) => ["preview", nodes.join(","), stateSig] as const,
  scenarios: ["scenarios"] as const,
  scenario: (id: string) => ["scenario", id] as const,
  events: ["events"] as const,
};

/**
 * Poll interval that drops to "off" while an experiment holds the API lock,
 * and backs off to 3x the endpoint's last measured latency when the backend
 * is slow (for example while a node is down), so polls cannot pile up.
 */
function usePoll(ms: number | false, key?: string): number | false {
  const running = useExperimentRunning();
  const last = usePerf((s) => (key ? s.latency[key] : undefined));
  if (running || ms === false) return false;
  return backoff(ms, last);
}

export function useHealth() {
  const interval = usePoll(5000, "GET /api/health");
  return useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: interval,
    retry: 0,
  });
}

export function useStatus() {
  const interval = usePoll(5000, "GET /api/status");
  return useQuery({ queryKey: qk.status, queryFn: ({ signal }) => api.status(signal), refetchInterval: interval });
}

export function useFiles() {
  const interval = usePoll(10000, "GET /api/files");
  return useQuery({ queryKey: qk.files, queryFn: ({ signal }) => api.files(signal), refetchInterval: interval });
}

export function useFileDetail(fileId: string | null, verify = true) {
  const running = useExperimentRunning();
  return useQuery({
    queryKey: qk.fileDetail(fileId ?? "", verify),
    queryFn: ({ signal }) => api.fileDetail(fileId!, verify, signal),
    enabled: !!fileId && !running,
    staleTime: 15000,
  });
}

/** Verified Survival Twin with per-shard data. Reads every shard, so it polls slowly. */
/**
 * Verified Survival Twin. It re-reads and hashes every shard while holding the API's
 * single lock, so on a cluster with a lot of data it blocks uploads and every other
 * request for seconds. It therefore fetches (and polls) only where it is the point of
 * the screen (`active`, or `fetchIfMissing`); other screens show the cached result or
 * offer "Verify now" (refetch() works even when the query is not enabled).
 */
export function useTwin(active: boolean, fetchIfMissing = active) {
  const interval = usePoll(active ? 30000 : false, "GET /api/twin");
  const running = useExperimentRunning();
  return useQuery({
    queryKey: qk.twin,
    queryFn: ({ signal }) => api.twin({ verify: true, shards: true }, signal),
    refetchInterval: interval,
    enabled: !running && (active || fetchIfMissing),
    staleTime: 10000,
  });
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Non-destructive preview. Debounced; obsolete requests are aborted by
 * TanStack Query through `signal` when the key changes. `stateSig` ties the
 * preview to observed node states so a node going up/down forces a fresh one.
 */
export function usePreview(nodes: string[], stateSig: string) {
  const debounced = useDebounced(nodes, 350);
  const running = useExperimentRunning();
  const settled = debounced.join(",") === nodes.join(",");
  const q = useQuery({
    queryKey: qk.preview(debounced, stateSig),
    queryFn: ({ signal }) => api.preview(debounced, signal),
    enabled: debounced.length > 0 && !running,
    staleTime: 0,
    gcTime: 30000,
    retry: 0,
  });
  return { ...q, settled };
}

export function useScenarios() {
  const interval = usePoll(15000, "GET /api/scenarios");
  return useQuery({
    queryKey: qk.scenarios,
    queryFn: ({ signal }) => api.scenarios(50, signal),
    refetchInterval: interval,
  });
}

export function useScenario(runId: string | null) {
  return useQuery({
    queryKey: qk.scenario(runId ?? ""),
    queryFn: ({ signal }) => api.scenario(runId!, signal),
    enabled: !!runId,
    staleTime: Infinity, // stored reports never change
  });
}

export function useEvents(enabled = true) {
  const interval = usePoll(enabled ? 5000 : false, "GET /api/events");
  return useQuery({
    queryKey: qk.events,
    queryFn: ({ signal }) => api.events(200, signal),
    refetchInterval: interval,
    placeholderData: keepPreviousData,
  });
}

/** After any mutation, refetch everything that describes cluster state. */
export function useInvalidateCluster() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.status }),
      qc.invalidateQueries({ queryKey: qk.files }),
      qc.invalidateQueries({ queryKey: qk.twin }),
      qc.invalidateQueries({ queryKey: ["file"] }),
      qc.invalidateQueries({ queryKey: ["preview"] }),
      qc.invalidateQueries({ queryKey: qk.scenarios }),
      qc.invalidateQueries({ queryKey: qk.events }),
    ]);
}

export function useScrub() {
  const inv = useInvalidateCluster();
  return useMutation({ mutationFn: api.scrub, onSettled: inv });
}
export function useRepair() {
  const inv = useInvalidateCluster();
  return useMutation({ mutationFn: api.repair, onSettled: inv });
}
export function useGc() {
  const inv = useInvalidateCluster();
  return useMutation({ mutationFn: api.gc, onSettled: inv });
}
export function useNodeStop() {
  const inv = useInvalidateCluster();
  return useMutation({ mutationFn: (n: string) => api.nodeStop(n), onSettled: inv });
}
export function useNodeStart() {
  const inv = useInvalidateCluster();
  return useMutation({ mutationFn: (n: string) => api.nodeStart(n), onSettled: inv });
}
export function useDeleteFile() {
  const inv = useInvalidateCluster();
  return useMutation({
    mutationFn: (v: { ref: string; fileId: string }) => api.deleteFile(v.ref, v.fileId),
    onSettled: inv,
  });
}
