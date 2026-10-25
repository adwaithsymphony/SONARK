import "@testing-library/jest-dom/vitest";

// jsdom has no WebGL; return null quietly so the stage falls back to 2D.
if (typeof HTMLCanvasElement !== "undefined") HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

// Workflow tests render the full desktop frame (spec: >= 1280 px).
if (typeof window !== "undefined") Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1600 });
