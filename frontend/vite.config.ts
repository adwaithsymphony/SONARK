/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The browser talks only to this dev/preview server, which forwards /api to the
 * Sonark backend. The page and the API therefore share one origin, so no CORS setup
 * is needed for whichever address this server answers on (localhost, or [::1] on Windows).
 * The server stays bound to this machine (host "localhost"), so the API's
 * local-only protection is unchanged. Point it elsewhere with SONARK_API, e.g.
 *   $env:SONARK_API="http://127.0.0.1:8810"; npm run dev
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const apiTarget = (env.SONARK_API ?? "http://127.0.0.1:8800").replace(/\/+$/, "");
const proxy = {
  // changeOrigin sends Host: 127.0.0.1:<port>, which the API's loopback Host check accepts
  "/api": { target: apiTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  define: { __SONARK_API_TARGET__: JSON.stringify(apiTarget) },
  server: { host: "localhost", port: 5173, strictPort: true, proxy },
  preview: { host: "localhost", port: 4173, strictPort: true, proxy },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    css: false,
  },
});
