/**
 * Client-side observations. The backend does not report a node's last heartbeat,
 * so the stage can only say when THIS browser last saw a node answer as up
 * (the time of the /api/status response). Nothing is recorded before the page
 * loaded; in that case the UI says "not reported".
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useStatus } from "../api/queries";

export const useObserved = create<{ lastSeenUp: Record<string, number>; record: (ids: string[], at: number) => void }>((set) => ({
  lastSeenUp: {},
  record: (ids, at) =>
    set((s) => {
      if (ids.every((id) => s.lastSeenUp[id] === at)) return s;
      const next = { ...s.lastSeenUp };
      for (const id of ids) next[id] = at;
      return { lastSeenUp: next };
    }),
}));

export function useRecordLastSeen() {
  const status = useStatus();
  const record = useObserved((s) => s.record);
  useEffect(() => {
    if (!status.data || status.isError) return;
    record(status.data.nodes.filter((n) => n.up).map((n) => n.node_id), status.dataUpdatedAt);
  }, [status.data, status.dataUpdatedAt, status.isError, record]);
}
