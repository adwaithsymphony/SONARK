import { useEffect, useState } from "react";

/** Spec 4.1: below 768 px the app is a read-only, simplified layout. */
export const NARROW_QUERY = "(max-width: 767px)";

export function isNarrow(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(NARROW_QUERY).matches;
}

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export const NARROW_REASON = "Disruptive actions are disabled below 768 px; use a wider window.";
