import { memo, useMemo } from "react";
import { nodeStateMeta, shardStatusMeta } from "../../lib/status";
import { color } from "../../theme/tokens";
import { shardsByNode, worstStatus } from "./model";
import type { StageProps } from "./Stage3D";

/**
 * Precise, keyboard-accessible 2D topology. Same layout and encodings as the
 * 3D stage. Every node is a real button.
 */
export default memo(function Topology2D({ model, selectedNode, hypothetical, experimentTargets, layers, onNodeClick }: StageProps) {
  const byNode = useMemo(() => shardsByNode(model.shards), [model.shards]);
  const R = 100;
  const scale = R / Math.max(model.radius, 1);
  const pad = 46;
  const size = R * 2 + pad * 2;
  const pos = (x: number, z: number) => [x * scale + R + pad, z * scale + R + pad] as const;
  const [cx, cy] = pos(0, 0);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-full w-full"
      role="group"
      aria-label="2D cluster topology"
      preserveAspectRatio="xMidYMid meet"
    >
      {layers.placement && model.shards.length > 0 && (
        <g aria-hidden>
          {model.nodes.map((n) => {
            const list = byNode.get(n.id);
            if (!list) return null;
            const [x, y] = pos(n.x, n.z);
            const hypo = hypothetical.has(n.id);
            return (
              <line
                key={n.id}
                x1={cx}
                y1={cy}
                x2={x}
                y2={y}
                stroke={hypo ? color.preview : shardStatusMeta[worstStatus(list)].color}
                strokeOpacity={0.7}
                strokeWidth={1 + Math.min(3, list.length * 0.25)}
                strokeDasharray={hypo ? "5 4" : undefined}
              />
            );
          })}
          <rect x={cx - 6} y={cy - 6} width={12} height={12} transform={`rotate(45 ${cx} ${cy})`} fill={color.live} />
          {layers.labels && model.fileName && (
            <text x={cx} y={cy + 22} textAnchor="middle" className="fill-live font-mono" fontSize={9} paintOrder="stroke" stroke={color.bg} strokeWidth={3}>
              {model.fileName.length > 28 ? `${model.fileName.slice(0, 27)}…` : model.fileName}
            </text>
          )}
        </g>
      )}
      {model.nodes.map((n) => {
        const [x, y] = pos(n.x, n.z);
        const sel = selectedNode === n.id;
        const hypo = hypothetical.has(n.id);
        const target = experimentTargets.has(n.id);
        const dim = model.shards.length > 0 && !model.hostNodes.has(n.id);
        const st = nodeStateMeta[n.state];
        const list = byNode.get(n.id) ?? [];
        const hex = Array.from({ length: 6 }, (_, i) => {
          const a = (Math.PI / 3) * i + Math.PI / 6;
          return `${x + Math.cos(a) * 15},${y + Math.sin(a) * 15}`;
        }).join(" ");
        return (
          <g
            key={n.id}
            role="button"
            tabIndex={0}
            aria-pressed={sel}
            aria-label={`Node ${n.id}, ${target ? "last seen " : ""}${st.label}, ${n.shards} shards${hypo ? ", selected as hypothetical failure" : ""}${
              target ? ", experiment target" : ""
            }${list.length ? `, holds ${list.length} shards of the selected file` : ""}`}
            onClick={() => onNodeClick(n.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onNodeClick(n.id);
              }
            }}
            className="cursor-pointer outline-none [&:focus-visible>polygon]:stroke-info"
            opacity={dim ? 0.45 : 1}
          >
            {hypo && <circle cx={x} cy={y} r={22} fill="none" stroke={color.preview} strokeWidth={1.2} strokeDasharray="4 3" />}
            {target && <circle cx={x} cy={y} r={22} fill="none" stroke={color.experiment} strokeWidth={1.5} />}
            {/* actual failure: broken red ring (circumference ≈ 138; one gap) */}
            {!hypo && !target && n.state !== "up" && (
              <circle cx={x} cy={y} r={22} fill="none" stroke={color.lost} strokeWidth={1.2} strokeDasharray="118 20" />
            )}
            {sel && <circle cx={x} cy={y} r={19} fill="none" stroke={color.info} strokeWidth={1} />}
            <polygon
              points={hex}
              fill={hypo ? color.preview : n.state === "up" ? "#1E4A3D" : "#2B3331"}
              fillOpacity={hypo ? 0.3 : 1}
              stroke={hypo ? color.preview : st.color}
              strokeOpacity={hypo ? 0.6 : 1}
              strokeWidth={1}
            />
            <circle cx={x} cy={y} r={3} fill={hypo ? color.preview : st.color} />
            {layers.shards &&
              list.slice(0, 12).map((s, i) => (
                <rect
                  key={s.key}
                  x={x - 15 + (i % 6) * 5}
                  y={y + 19 + Math.floor(i / 6) * 5}
                  width={4}
                  height={4}
                  fill={shardStatusMeta[s.status].color}
                >
                  <title>{`chunk ${s.chunk} shard ${s.shard}: ${s.status}`}</title>
                </rect>
              ))}
            {layers.shards && list.length > 12 && (
              <text x={x + 17} y={y + 27} fontSize={7} className="fill-muted font-mono">
                +{list.length - 12}
              </text>
            )}
            {layers.labels && (
              <text x={x} y={y - 27} textAnchor="middle" fontSize={9} className="font-mono" paintOrder="stroke" stroke={color.bg} strokeWidth={3}>
                <tspan fill={color.text}>{n.id}</tspan>{" "}
                <tspan fill={hypo ? color.preview : target ? color.experiment : n.state === "up" ? color.live : color.lost}>
                  {hypo ? "PROPOSED FAILURE" : target ? "TARGET" : n.state === "up" ? "ONLINE" : "OFFLINE"}
                </tspan>
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});
