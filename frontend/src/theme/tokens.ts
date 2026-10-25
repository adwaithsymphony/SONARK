/**
 * Design tokens from the SONARK Spatial Workstation specification (section 3.1).
 * Shared by Tailwind (CSS) and the Three.js stage. Colour is semantic only.
 *
 * Spec palette:
 *   bg-base #070B0C · bg-surface #0C1214 · bg-raised #111A1D
 *   line rgba(120,200,170,0.12) · line-strong rgba(120,200,170,0.28)
 *   text-primary #D8E6E1 · text-secondary #8DA39C · text-muted #5B6F69
 *   accent #3FD6A0 · warn #F2B33D · danger #F0525C · info #7FB8FF · hypothetical #B7A6FF
 */
export const palette = {
  bgBase: "#070B0C",
  bgSurface: "#0C1214",
  bgRaised: "#111A1D",
  line: "rgba(120,200,170,0.12)",
  lineStrong: "rgba(120,200,170,0.28)",
  textPrimary: "#D8E6E1",
  textSecondary: "#8DA39C",
  textMuted: "#5B6F69",
  accent: "#3FD6A0",
  warn: "#F2B33D",
  danger: "#F0525C",
  info: "#7FB8FF",
  hypothetical: "#B7A6FF",
} as const;

/** Semantic roles mapped onto the palette (no colours outside the palette). */
export const color = {
  bg: palette.bgBase,
  surface: palette.bgSurface,
  surface2: palette.bgRaised,
  raised: palette.bgRaised,
  line: palette.line,
  lineStrong: palette.lineStrong,
  // Solid equivalents of the hairlines on bg-base, for WebGL (which has no rgba strokes).
  lineSolid: "#0F1A19",
  lineStrongSolid: "#1E302C",
  text: palette.textPrimary,
  muted: palette.textSecondary,
  faint: palette.textMuted,
  live: palette.accent,
  preview: palette.hypothetical,
  experiment: palette.warn,
  info: palette.info,
  healthy: palette.accent,
  degraded: palette.warn,
  atRisk: palette.warn, // same hue as degraded; told apart by label and glyph
  lost: palette.danger,
  down: palette.danger,
  unknown: palette.textMuted,
  shardOk: palette.accent,
  shardUnverified: palette.warn,
  shardMissing: palette.textSecondary,
  shardCorrupt: palette.danger,
  shardNodeDown: palette.textMuted,
} as const;

export type ColorToken = keyof typeof color;
