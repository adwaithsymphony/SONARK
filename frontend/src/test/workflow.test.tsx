import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useUi } from "../state/ui";
import { baseRoutes, data, fixture, mockApi, r } from "./fixtures";

const initial = useUi.getState();

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useUi.setState({ ...initial, experiment: { phase: "idle" }, hypothetical: [] }, true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cluster overview", () => {
  it("renders real node ids and states from /api/status in the 2D fallback", async () => {
    mockApi([...baseRoutes().filter((x) => !x.path.test("/api/status")), r("GET", /^\/api\/status$/, "status_node_down")]);
    renderApp();
    expect(await screen.findByRole("button", { name: /Node n6, Stopped/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Node n1, Up/ })).toBeInTheDocument();
    expect(await screen.findByText("5/6 nodes up")).toBeInTheDocument();
    expect(screen.getByText(/WebGL unavailable/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mode: LIVE/)).toBeInTheDocument();
  });

  it("selecting a file shows its real placement on the stage", async () => {
    mockApi(baseRoutes());
    renderApp();
    const detail = data("file_detail");
    await screen.findByRole("button", { name: /Node n1, Up/ });
    act(() => useUi.getState().selectFile(detail.file_id));
    const hosts = new Set<string>();
    for (const st of detail.protection.stripes) for (const s of st.shards) hosts.add(s.node_id);
    for (const h of hosts) {
      expect(await screen.findByRole("button", { name: new RegExp(`Node ${h}, Up, \\d+ shards, holds \\d+ shards of the selected file`) })).toBeInTheDocument();
    }
    expect(await screen.findByText(new RegExp(`${detail.chunk_count * (detail.k + detail.m)} shards on ${hosts.size} nodes · hash-verified`))).toBeInTheDocument();
  });
});

describe("Survival Twin workflow", () => {
  it("preview never stops anything; execute needs typed confirmation and the preview's scenario_id", async () => {
    const preview = data("preview_survive");
    const { calls } = mockApi([
      ...baseRoutes(),
      r("POST", /^\/api\/scenarios\/preview$/, "preview_survive"),
      r("POST", /^\/api\/scenarios\/execute$/, "execute"),
    ]);
    const user = userEvent.setup();
    act(() => useUi.getState().setView("twin"));
    renderApp();

    await user.click(await screen.findByRole("button", { name: /Node n2, Up/ }));
    expect(screen.getByLabelText(/Mode: PREVIEW/)).toBeInTheDocument();
    expect(screen.getAllByText(/HYPOTHETICAL — CLUSTER NOT MODIFIED/).length).toBeGreaterThan(0);
    // the node keeps its observed state; only the hypothesis changed
    expect(screen.getByRole("button", { name: /Node n2, Up, .*selected as hypothetical failure/ })).toBeInTheDocument();

    expect(await screen.findByText(/No new data loss predicted/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/PREVIEW — no node has been stopped/)).toBeInTheDocument();
    expect(screen.getAllByText(/Recoverable · reduced redundancy/).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.url.pathname === "/api/scenarios/preview").map((c) => c.body)).toContainEqual({ nodes: ["n2"], verify: true });
    expect(calls.some((c) => c.url.pathname === "/api/scenarios/execute")).toBe(false);
    expect(calls.some((c) => c.method !== "GET" && c.url.pathname.includes("/nodes/"))).toBe(false);

    await user.click(screen.getByRole("button", { name: /Prepare experiment/ }));
    const dialog = screen.getByRole("dialog");
    const go = within(dialog).getByRole("button", { name: /Stop n2 now/ });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "n3");
    expect(go).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/to confirm/));
    await user.type(within(dialog).getByLabelText(/to confirm/), "n2");
    expect(go).toBeEnabled();
    await user.click(go);

    expect(await screen.findByText(/Prediction matched reality/)).toBeInTheDocument();
    const exec = calls.filter((c) => c.url.pathname === "/api/scenarios/execute");
    expect(exec).toHaveLength(1);
    expect(exec[0]!.body).toEqual({ nodes: ["n2"], confirm: preview.scenario_id, mode: "restart" });
    expect(screen.getByLabelText(/Mode: EXPERIMENT/)).toBeInTheDocument();
  });

  it("a 428 on execute is shown and nothing is reported as run", async () => {
    mockApi([
      ...baseRoutes(),
      r("POST", /^\/api\/scenarios\/preview$/, "preview_survive"),
      r("POST", /^\/api\/scenarios\/execute$/, "error_428_execute"),
    ]);
    const user = userEvent.setup();
    act(() => {
      useUi.getState().setView("twin");
      useUi.getState().setHypothetical(["n2"]);
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Prepare experiment/ }, { timeout: 3000 }));
    await user.type(screen.getByLabelText(/to confirm/), "n2");
    await user.click(screen.getByRole("button", { name: /Stop n2 now/ }));
    expect(await screen.findByText(/Confirmation required \(428 confirmation_required\)/)).toBeInTheDocument();
    expect(screen.getAllByText(fixture("error_428_execute").body.error.details.expected_confirm).length).toBeGreaterThan(0);
    expect(screen.getByText(/Nothing was stopped/)).toBeInTheDocument();
    // the backend refused before stopping anything, so the UI must not claim the cluster was modified
    expect(screen.getByLabelText(/Mode: PREVIEW|Mode: LIVE/)).toBeInTheDocument();
    expect(screen.queryByText(/ACTUAL — CLUSTER MODIFIED/)).toBeNull();
    expect(screen.queryByText(/Prediction matched reality/)).toBeNull();
  });

  it("predicted loss is listed before execution and replace mode is not offered", async () => {
    mockApi([...baseRoutes(), r("POST", /^\/api\/scenarios\/preview$/, "preview_loss")]);
    const user = userEvent.setup();
    act(() => {
      useUi.getState().setView("twin");
      useUi.getState().setHypothetical(["n1", "n2", "n3"]);
    });
    renderApp();
    expect(await screen.findByText(/Predicted data loss: 2 files would become unrecoverable/, {}, { timeout: 3000 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Prepare experiment/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Predicted unrecoverable during the outage/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Replace is unavailable/)).toBeInTheDocument();
    expect(within(dialog).getByText("n1 n2 n3")).toBeInTheDocument();
  });
});

describe("stripe matrix during a real experiment", () => {
  it("hides the stale preview and labels the snapshot as not current", async () => {
    const { calls } = mockApi([...baseRoutes(), r("POST", /^\/api\/scenarios\/preview$/, "preview_survive")]);
    act(() => {
      useUi.getState().setView("twin");
      useUi.getState().setHypothetical(["n2"]);
      useUi.getState().openMatrix();
    });
    renderApp();
    // before the run: the preview overlay is shown
    expect((await screen.findAllByText(/Recoverable · reduced redundancy/, {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    expect(document.querySelector('[title*="(PREVIEW)"]')).not.toBeNull();
    const previewsBefore = calls.filter((c) => c.url.pathname === "/api/scenarios/preview").length;
    act(() =>
      useUi.getState().setExperiment({ phase: "running", nodes: ["n2"], mode: "restart", scenarioId: "scn-000000000000", startedAt: Date.now() }),
    );
    expect(await screen.findByText(/This table is the snapshot taken before the run/)).toBeInTheDocument();
    expect(document.querySelector('[title*="(PREVIEW)"]')).toBeNull(); // no lost-hypothetical cells
    expect(screen.queryByText(/If failed · valid \/ k/)).toBeInTheDocument();
    expect(calls.filter((c) => c.url.pathname === "/api/scenarios/preview").length).toBe(previewsBefore);
  });
});

describe("proof of survival", () => {
  it("shows the stored report as evidence: ledger, nine-stage timeline, hashes, and what is not reported", async () => {
    const report = data("scenario_detail");
    mockApi(baseRoutes());
    act(() => useUi.getState().setView("lab"));
    renderApp();
    expect(await screen.findByRole("heading", { name: "Proof of Survival" })).toBeInTheDocument();
    expect(screen.getByText(report.summary)).toBeInTheDocument();
    // ledger rows and timeline stages come from the report
    expect(screen.getAllByText("Hypothetical preview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Repair completed").length).toBeGreaterThan(0);
    const timeline = screen.getByRole("list", { name: "Recovery timeline" });
    expect(timeline.children).toHaveLength(9); // one top-level item per stage
    expect(within(timeline).getByText(/File retrieval initiated/)).toBeInTheDocument();
    expect(within(timeline).getAllByText("Not reported").length).toBeGreaterThan(0);
    // fields the backend does not record are labelled, not invented
    expect(screen.getByText(/not reported \(the API has no users\)/)).toBeInTheDocument();
    expect(screen.getByText(/not reported by the backend/)).toBeInTheDocument();
    // full hashes are shown with a verdict
    const first = Object.values(report.outage_results)[0] as { sha256_expected: string };
    expect(screen.getAllByText(first.sha256_expected, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/identical: all 64 hex characters match/).length).toBeGreaterThan(0);
  });
});

describe("disconnected backend", () => {
  it("shows an unreachable banner and never invents data", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    renderApp();
    expect(await screen.findByText(/API unreachable at http:\/\/127.0.0.1:8800 \(via this page's \/api proxy\)/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Node n1/ })).toBeNull();
    expect(screen.getByText(/No data has been received yet/)).toBeInTheDocument();
  });
});
