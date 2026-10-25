/** Real API responses captured by scripts/capture_fixtures.py. */
const all = import.meta.glob("./fixtures/*.json", { eager: true, import: "default" }) as Record<
  string,
  { status: number; body: unknown }
>;

export type FixtureName =
  | "health" | "upload" | "status" | "files" | "file_detail" | "twin" | "twin_noshards"
  | "preview_survive" | "preview_loss" | "error_unknown_node" | "error_428_execute" | "execute"
  | "error_409_replace" | "execute_loss" | "scenarios" | "scenario_detail" | "scrub"
  | "error_428_repair" | "repair" | "gc" | "node_stop" | "status_node_down" | "files_node_down"
  | "node_start" | "events" | "error_404_file";

export function fixture(name: FixtureName): { status: number; body: any } {
  const f = all[`./fixtures/${name}.json`];
  if (!f) throw new Error(`missing fixture ${name}; run python frontend/scripts/capture_fixtures.py`);
  return structuredClone(f);
}

export const data = (name: FixtureName) => fixture(name).body.data;

type Route = { method: string; path: RegExp; reply: (body: unknown, url: URL) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> };

/** Minimal fetch mock: routes match method + pathname and record every call. */
export function mockApi(routes: Route[]) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const r = routes.find((x) => x.method === method && x.path.test(url.pathname));
    if (!r) return new Response(JSON.stringify({ error: { code: "not_found", message: "no mock", details: {} } }), { status: 404 });
    const out = await r.reply(body, url);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json" } });
  };
  globalThis.fetch = fetchMock as typeof fetch;
  return { calls };
}

export const r = (method: string, path: RegExp, name: FixtureName | (() => { status: number; body: unknown })): Route => ({
  method,
  path,
  reply: typeof name === "function" ? name : () => fixture(name),
});

export const baseRoutes = (): Route[] => [
  r("GET", /^\/api\/health$/, "health"),
  r("GET", /^\/api\/status$/, "status"),
  r("GET", /^\/api\/files$/, "files"),
  r("GET", /^\/api\/files\/[^/]+$/, "file_detail"),
  r("GET", /^\/api\/twin$/, "twin"),
  r("GET", /^\/api\/scenarios$/, "scenarios"),
  r("GET", /^\/api\/scenarios\/run-[0-9a-f]+$/, "scenario_detail"),
  r("GET", /^\/api\/events$/, "events"),
];
