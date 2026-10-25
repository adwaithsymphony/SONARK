import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three-stdlib";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { ShardStatus } from "../../api/schemas";
import { formatTime } from "../../lib/format";
import { nodeStateMeta, shardStatusMeta } from "../../lib/status";
import { color } from "../../theme/tokens";
import { prefersReducedMotion, shardsByNode, worstStatus, type StageModel, type StageNode, type StageShard } from "./model";

/** Per-node shard counts from the verified Twin snapshot (backend data), if loaded. */
export interface NodeSummary {
  counts: Partial<Record<ShardStatus, number>>;
  files: number;
  takenAt: string;
}

export interface StageProps {
  model: StageModel;
  selectedNode: string | null;
  hypothetical: Set<string>;
  experimentTargets: Set<string>;
  layers: { labels: boolean; shards: boolean; placement: boolean };
  cameraToken: number;
  focusToken: number;
  onNodeClick: (id: string) => void;
  lastSeenUp?: Record<string, number>;
  summaries?: Map<string, NodeSummary>;
  modeCopy?: string;
  onExportReady?: (fn: (() => void) | null) => void;
  onShardClick?: (s: StageShard) => void;
}

const NODE_R = 0.42;
const NODE_Y = 0.7;
const HUB_Y = 1.9;
const SHARD = 0.14;
const RING_R = 0.82;
const PER_ROW = 12;
const MAX_SHARD_INSTANCES = 1500;

export default function Stage3D(props: StageProps) {
  const reduced = useMemo(prefersReducedMotion, []);
  const home = useMemo(() => new THREE.Vector3(0, props.model.radius * 1.45, props.model.radius * 2.2), [props.model.radius]);
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ position: home.toArray(), fov: 38, near: 0.1, far: 200 }}
      // preserveDrawingBuffer lets "Export PNG" read the rendered frame
      gl={{ antialias: true, powerPreference: "low-power", preserveDrawingBuffer: true }}
      onCreated={({ gl }) => gl.setClearColor(color.bg)}
      aria-label="3D cluster stage"
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[6, 12, 8]} intensity={1.2} />
      <directionalLight position={[-8, 5, -6]} intensity={0.3} />
      <Grid
        args={[40, 40]}
        position={[0, 0, 0]}
        cellSize={0.5}
        cellThickness={0.6}
        cellColor={color.lineSolid}
        sectionSize={2.5}
        sectionThickness={0.9}
        sectionColor={color.lineStrongSolid}
        fadeDistance={props.model.radius * 6}
        fadeStrength={1.5}
        followCamera={false}
      />
      <Scene {...props} />
      <CameraRig home={home} reduced={reduced} {...props} />
      <Exporter model={props.model} modeCopy={props.modeCopy} onExportReady={props.onExportReady} hypothetical={props.hypothetical} targets={props.experimentTargets} />
    </Canvas>
  );
}

const Scene = memo(function Scene({
  model,
  selectedNode,
  hypothetical,
  experimentTargets,
  layers,
  onNodeClick,
  lastSeenUp,
  summaries,
  onShardClick,
}: StageProps) {
  const byNode = useMemo(() => shardsByNode(model.shards), [model.shards]);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [model, selectedNode, hypothetical, experimentTargets, layers, invalidate]);
  return (
    <group>
      {model.nodes.map((n) => (
        <NodeGlyph
          key={n.id}
          node={n}
          selected={selectedNode === n.id}
          hypo={hypothetical.has(n.id)}
          target={experimentTargets.has(n.id)}
          fileShards={byNode.get(n.id)?.length ?? 0}
          dimmed={model.shards.length > 0 && !model.hostNodes.has(n.id)}
          showLabel={layers.labels}
          lastSeen={lastSeenUp?.[n.id]}
          summary={summaries?.get(n.id)}
          onClick={onNodeClick}
        />
      ))}
      {layers.shards && model.shards.length > 0 && <ShardInstances model={model} byNode={byNode} hypothetical={hypothetical} onPick={onShardClick} />}
      {layers.placement && model.shards.length > 0 && (
        <Placement model={model} byNode={byNode} hypothetical={hypothetical} showLabel={layers.labels} />
      )}
    </group>
  );
});

function arcPoints(r: number, y: number, from = 0, to = Math.PI * 2, seg = 64): [number, number, number][] {
  return Array.from({ length: seg + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / seg;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
}

const NodeGlyph = memo(function NodeGlyph({
  node,
  selected,
  hypo,
  target,
  fileShards,
  dimmed,
  showLabel,
  lastSeen,
  summary,
  onClick,
}: {
  node: StageNode;
  selected: boolean;
  hypo: boolean;
  target: boolean;
  fileShards: number;
  dimmed: boolean;
  showLabel: boolean;
  lastSeen: number | undefined;
  summary: NodeSummary | undefined;
  onClick: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const up = node.state === "up";
  // Hypothetical failures are ghosts: 30% opacity, violet. Actual failures are desaturated.
  const body = hypo ? color.preview : up ? "#1E4A3D" : "#2B3331";
  const opacity = hypo ? 0.3 : dimmed ? 0.35 : 1;
  const ring = useMemo(() => arcPoints(NODE_R + 0.2, NODE_Y), []);
  const outer = useMemo(() => arcPoints(NODE_R + 0.34, NODE_Y), []);
  // "Broken ring" for an actual failure: an arc with a visible gap.
  const broken = useMemo(() => arcPoints(NODE_R + 0.34, NODE_Y, Math.PI * 0.15, Math.PI * 1.85), []);
  useEffect(() => {
    if (!hover) return;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hover]);

  const stateWord = hypo ? "PROPOSED FAILURE" : target ? "EXPERIMENT TARGET" : up ? "ONLINE" : "OFFLINE";
  const stateCls = hypo ? "text-preview" : target ? "text-experiment" : up ? "text-live" : "text-lost";

  return (
    <group position={[node.x, 0, node.z]}>
      <mesh
        position={[0, NODE_Y, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onClick(node.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <icosahedronGeometry args={[NODE_R, 0]} />
        <meshStandardMaterial
          color={body}
          flatShading
          roughness={0.5}
          metalness={0.15}
          emissive={hypo ? color.preview : up ? color.live : "#000000"}
          emissiveIntensity={hypo ? 0.25 : up ? (hover || selected ? 0.22 : 0.08) : 0}
          transparent
          opacity={opacity}
          depthWrite={!hypo}
        />
      </mesh>
      {/* footprint on the floor in the observed-state colour */}
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[NODE_R * 0.55, NODE_R * 0.6, 32]} />
        <meshBasicMaterial color={hypo ? color.preview : nodeStateMeta[node.state].color} transparent opacity={0.18 * (dimmed ? 0.5 : 1)} />
      </mesh>
      {selected && <Line toneMapped={false} points={ring} color={color.info} lineWidth={1.2} />}
      {hypo && <Line toneMapped={false} points={outer} color={color.preview} lineWidth={1.4} dashed dashSize={0.16} gapSize={0.1} />}
      {!hypo && !up && !target && <Line toneMapped={false} points={broken} color={color.lost} lineWidth={1.4} />}
      {target && <Line toneMapped={false} points={outer} color={color.experiment} lineWidth={1.8} />}

      {selected && (
        <Html position={[0, NODE_Y, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          {/* screen-space corner brackets around the selected node */}
          <div className="relative h-16 w-16" aria-hidden>
            <span className="absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-info" />
            <span className="absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-info" />
            <span className="absolute bottom-0 left-0 h-2.5 w-2.5 border-b border-l border-info" />
            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 border-b border-r border-info" />
          </div>
        </Html>
      )}

      {(showLabel || hover || selected) && (
        // Fixed pixel size (no distanceFactor) so every label reads the same; anchored above its node.
        <Html position={[0, NODE_Y + NODE_R + 0.12, 0]} center zIndexRange={[20, 10]} style={{ pointerEvents: "none" }}>
          <div
            className={`-translate-y-1/2 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-center font-mono text-[11px] leading-4 ${
              hover || selected ? "border-line-strong bg-surface" : "border-transparent bg-bg/80"
            } ${dimmed && !hover && !selected ? "opacity-50" : ""}`}
          >
            <div>
              <span className="text-ink">{node.id}</span> <span className={stateCls}>{stateWord}</span>
            </div>
            {!up && !hypo && (
              <div className="text-faint">{lastSeen ? `last seen up ${formatTime(lastSeen)} (this UI)` : "last seen: not reported"}</div>
            )}
            {(hover || selected) && (
              <div className="text-left text-muted">
                <div>
                  observed: {nodeStateMeta[node.state].label.toLowerCase()} · {node.shards} shards in metadata
                  {!node.managed && " · unmanaged"}
                </div>
                {fileShards > 0 && <div>{fileShards} shards of the selected file</div>}
                {summary ? (
                  <div>
                    {(["ok", "unverified", "missing", "corrupt", "node_down"] as const)
                      .filter((k) => summary.counts[k])
                      .map((k) => `${summary.counts[k]} ${k}`)
                      .join(" · ") || "no shards"}{" "}
                    · {summary.files} file(s) · verified {formatTime(summary.takenAt)}
                  </div>
                ) : (
                  <div className="text-faint">per-shard state: open Survival Twin to verify</div>
                )}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
});

let roundedBox: THREE.BufferGeometry | null = null;
function shardGeometry() {
  roundedBox ??= new RoundedBoxGeometry(SHARD, SHARD, SHARD, 2, 0.03);
  return roundedBox;
}

/** One instanced mesh for every shard of the selected file, fanned around its host node. */
function ShardInstances({
  model,
  byNode,
  hypothetical,
  onPick,
}: {
  model: StageModel;
  byNode: Map<string, StageShard[]>;
  hypothetical: Set<string>;
  onPick: ((s: StageShard) => void) | undefined;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const items = useMemo(() => {
    const out: { pos: THREE.Vector3; color: THREE.Color; shard: StageShard; node: string }[] = [];
    const bg = new THREE.Color(color.bg);
    for (const n of model.nodes) {
      const list = byNode.get(n.id);
      if (!list) continue;
      list.forEach((s, i) => {
        if (out.length >= MAX_SHARD_INSTANCES) return;
        const row = Math.floor(i / PER_ROW);
        const inRow = Math.min(PER_ROW, list.length - row * PER_ROW);
        // fan the markers around the side of the node facing the centre of the ring
        const facing = Math.atan2(-n.z, -n.x);
        const a = facing + ((i % PER_ROW) - (inRow - 1) / 2) * 0.32;
        const c = new THREE.Color(shardStatusMeta[s.status].color);
        if (hypothetical.has(n.id)) c.lerp(bg, 0.65); // ghosted with its node
        out.push({
          pos: new THREE.Vector3(n.x + Math.cos(a) * RING_R, NODE_Y - 0.2 + row * 0.2, n.z + Math.sin(a) * RING_R),
          color: c,
          shard: s,
          node: n.id,
        });
      });
    }
    return out;
  }, [model, byNode, hypothetical]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    items.forEach((it, i) => {
      m.makeTranslation(it.pos.x, it.pos.y, it.pos.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, it.color);
    });
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items]);
  const h = hovered !== null ? items[hovered] : undefined;
  return (
    <>
      <instancedMesh
        key={items.length}
        ref={ref}
        args={[shardGeometry(), undefined, Math.max(1, items.length)]}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          setHovered(e.instanceId ?? null);
        }}
        onPointerOut={() => setHovered(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const it = e.instanceId !== undefined ? items[e.instanceId] : undefined;
          if (it) onPick?.(it.shard);
        }}
      >
        <meshStandardMaterial roughness={0.45} />
      </instancedMesh>
      {h && (
        <Html position={h.pos.toArray()} center zIndexRange={[30, 20]} style={{ pointerEvents: "none" }}>
          <div className="-translate-y-5 whitespace-nowrap rounded-sm border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink">
            {model.fileName ?? "file"}#{h.shard.chunk}:{h.shard.shard} · {h.node} ·{" "}
            <span style={{ color: shardStatusMeta[h.shard.status].color }}>{h.shard.status}</span>
          </div>
        </Html>
      )}
    </>
  );
}

/** File → node lines, drawn only between the selected file and nodes holding its shards. */
function Placement({
  model,
  byNode,
  hypothetical,
  showLabel,
}: {
  model: StageModel;
  byNode: Map<string, StageShard[]>;
  hypothetical: Set<string>;
  showLabel: boolean;
}) {
  return (
    <group>
      <mesh position={[0, HUB_Y, 0]}>
        <octahedronGeometry args={[0.2, 0]} />
        <meshStandardMaterial color={color.live} emissive={color.live} emissiveIntensity={0.25} flatShading />
      </mesh>
      {showLabel && model.fileName && (
        <Html position={[0, HUB_Y - 0.45, 0]} center zIndexRange={[20, 10]} style={{ pointerEvents: "none" }}>
          <div className="whitespace-nowrap rounded-sm bg-bg/80 px-1.5 py-0.5 font-mono text-[11px] text-live">{model.fileName}</div>
        </Html>
      )}
      {model.nodes.map((n) => {
        const list = byNode.get(n.id);
        if (!list) return null;
        const hypo = hypothetical.has(n.id);
        return (
          <Line
            key={n.id}
            toneMapped={false}
            points={[
              [0, HUB_Y, 0],
              [n.x, NODE_Y + NODE_R, n.z],
            ]}
            color={hypo ? color.preview : shardStatusMeta[worstStatus(list)].color}
            lineWidth={1}
            transparent
            opacity={hypo ? 0.6 : 0.7}
            dashed={hypo}
            dashSize={0.18}
            gapSize={0.12}
          />
        );
      })}
    </group>
  );
}

/**
 * PNG export: re-render the current frame, then draw node labels and a header
 * onto a 2D canvas (HTML labels are not part of the WebGL frame).
 */
function Exporter({
  model,
  modeCopy,
  onExportReady,
  hypothetical,
  targets,
}: {
  model: StageModel;
  modeCopy: string | undefined;
  onExportReady: ((fn: (() => void) | null) => void) | undefined;
  hypothetical: Set<string>;
  targets: Set<string>;
}) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (!onExportReady) return;
    onExportReady(() => {
      gl.render(scene, camera);
      const src = gl.domElement;
      const out = document.createElement("canvas");
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext("2d");
      if (!ctx) return;
      const dpr = src.width / (src.clientWidth || src.width) || 1;
      ctx.fillStyle = color.bg;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      ctx.font = `${12 * dpr}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "center";
      for (const n of model.nodes) {
        const p = new THREE.Vector3(n.x, NODE_Y + NODE_R + 0.2, n.z).project(camera);
        const x = ((p.x + 1) / 2) * out.width;
        const y = ((1 - p.y) / 2) * out.height;
        const hypo = hypothetical.has(n.id);
        const target = targets.has(n.id);
        ctx.fillStyle = hypo ? color.preview : target ? color.experiment : n.state === "up" ? color.text : color.lost;
        ctx.fillText(`${n.id} ${hypo ? "PROPOSED FAILURE" : target ? "EXPERIMENT TARGET" : n.state === "up" ? "ONLINE" : "OFFLINE"}`, x, y);
      }
      ctx.textAlign = "left";
      ctx.fillStyle = color.muted;
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      ctx.fillText(`SONARK · ${modeCopy ?? ""} · exported ${stamp} UTC`, 12 * dpr, 20 * dpr);
      ctx.fillText("Node positions identify nodes; they do not show network distance.", 12 * dpr, out.height - 12 * dpr);
      const a = document.createElement("a");
      a.href = out.toDataURL("image/png");
      a.download = `sonark-stage-${stamp.replace(/[: ]/g, "-")}.png`;
      a.click();
    });
    return () => onExportReady(null);
  }, [gl, scene, camera, model, modeCopy, onExportReady, hypothetical, targets]);
  return null;
}

function CameraRig({
  home,
  reduced,
  model,
  selectedNode,
  cameraToken,
  focusToken,
}: StageProps & { home: THREE.Vector3; reduced: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, invalidate } = useThree();
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  // Narrow stages pull the camera back so the whole ring stays in view.
  const fitHome = useMemo(() => home.clone().multiplyScalar(Math.max(1, 1.5 / aspect)), [home, aspect]);
  const userMoved = useRef(false);
  useEffect(() => {
    if (userMoved.current) return;
    camera.position.copy(fitHome);
    controls.current?.target.set(0, 0, 0);
    controls.current?.update();
    invalidate();
  }, [fitHome, camera, invalidate]);
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; t0: number; from: THREE.Vector3; fromT: THREE.Vector3 } | null>(null);

  const go = (pos: THREE.Vector3, target: THREE.Vector3) => {
    const c = controls.current;
    if (reduced || !c) {
      camera.position.copy(pos);
      c?.target.copy(target);
      c?.update();
      invalidate();
      return;
    }
    goal.current = { pos, target, t0: performance.now(), from: camera.position.clone(), fromT: c.target.clone() };
    invalidate();
  };

  useEffect(() => {
    if (cameraToken > 0) {
      userMoved.current = false;
      go(fitHome.clone(), new THREE.Vector3());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraToken]);

  useEffect(() => {
    if (focusToken === 0) return;
    const n = model.nodes.find((x) => x.id === selectedNode);
    if (!n) return go(fitHome.clone(), new THREE.Vector3());
    const t = new THREE.Vector3(n.x, NODE_Y, n.z);
    const dir = new THREE.Vector3(n.x, 0, n.z).normalize();
    go(t.clone().add(dir.multiplyScalar(4)).add(new THREE.Vector3(0, 2.6, 0)), t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  // Camera moves take 550 ms with ease-out (spec 3.3: <= 600 ms).
  useFrame(() => {
    const g = goal.current;
    const c = controls.current;
    if (!g || !c) return;
    const t = Math.min(1, (performance.now() - g.t0) / 550);
    const k = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(g.from, g.pos, k);
    c.target.lerpVectors(g.fromT, g.target, k);
    c.update();
    if (t >= 1) goal.current = null;
    invalidate();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      onStart={() => {
        userMoved.current = true;
      }}
      enableDamping={!reduced}
      dampingFactor={0.12}
      minDistance={3}
      maxDistance={model.radius * 6}
      maxPolarAngle={Math.PI * 0.47}
    />
  );
}
