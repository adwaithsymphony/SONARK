/**
 * Deterministic node placement. Nodes sit on a ring in natural-sorted id
 * order, so the same set of ids always produces the same layout. Positions
 * carry no meaning beyond identity: they do not imply network distance.
 */
import { naturalCompare } from "../state/ui";

export interface NodePlacement {
  id: string;
  index: number;
  angle: number; // radians, 0 = 12 o'clock, clockwise
  x: number; // unit-ring coordinates (radius 1)
  y: number;
}

export function ringLayout(ids: string[]): NodePlacement[] {
  const sorted = [...new Set(ids)].sort(naturalCompare);
  const n = sorted.length;
  return sorted.map((id, index) => {
    const angle = n <= 1 ? 0 : (index / n) * Math.PI * 2;
    return { id, index, angle, x: Math.sin(angle), y: -Math.cos(angle) };
  });
}

/** Radius that keeps neighbours apart as the cluster grows. */
export function ringRadius(n: number): number {
  return Math.max(3.2, (n * 1.35) / Math.PI);
}
