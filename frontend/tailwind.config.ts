import type { Config } from "tailwindcss";
import { color } from "./src/theme/tokens";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: color.bg,
        surface: color.surface,
        surface2: color.surface2,
        raised: color.raised,
        line: color.line,
        "line-strong": color.lineStrong,
        ink: color.text,
        muted: color.muted,
        faint: color.faint,
        live: color.live,
        preview: color.preview,
        experiment: color.experiment,
        info: color.info,
        healthy: color.healthy,
        degraded: color.degraded,
        "at-risk": color.atRisk,
        lost: color.lost,
        down: color.down,
        unknown: color.unknown,
        "s-ok": color.shardOk,
        "s-unverified": color.shardUnverified,
        "s-missing": color.shardMissing,
        "s-corrupt": color.shardCorrupt,
        "s-down": color.shardNodeDown,
      },
      // Three type roles (spec 3.2): UI sans, technical mono, editorial serif.
      fontFamily: {
        sans: ['"Geist Variable"', "Inter", "system-ui", "Segoe UI", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "Consolas", "monospace"],
        serif: ['"Instrument Serif"', "Georgia", "serif"],
      },
      // Type scale 11/12/13/14/16/20/28/44 (spec 3.2).
      fontSize: {
        "2xs": ["11px", "16px"],
        xs: ["12px", "16px"],
        sm: ["13px", "18px"],
        base: ["14px", "20px"],
        lg: ["16px", "22px"],
        xl: ["20px", "26px"],
        "2xl": ["28px", "32px"],
        "4xl": ["44px", "48px"],
      },
      borderRadius: { DEFAULT: "4px", md: "6px", lg: "6px", sm: "3px" },
      transitionTimingFunction: { out: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    },
  },
  plugins: [],
} satisfies Config;
