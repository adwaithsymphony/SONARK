/**
 * Browser end-to-end checks, driven through the Chrome DevTools Protocol of a
 * headless Edge/Chrome. No extra dependencies (Node 22+ has a global WebSocket).
 *
 * The "twin" flow RUNS A REAL CONTROLLED FAILURE (restart mode) through the UI,
 * and "integrity" runs a real repair, so point it at a throwaway cluster:
 *   node scripts/e2e-browser.mjs --url http://localhost:5173 --node n2 --out <dir>
 * Options:
 *   --flow twin,files,integrity   which flows to run (default: twin)
 *   --upload <absolute path>      file uploaded by the "files" flow
 *   --browser <path>              msedge.exe or chrome.exe
 * The "integrity" flow expects at least one damaged shard (scrub, then repair).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const URL_ = args.url ?? "http://localhost:5173";
const NODE = args.node ?? "n2";
const OUT = args.out ?? join(tmpdir(), "sonark-e2e");
const BROWSER = args.browser ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const FLOWS = (args.flow ?? "twin").split(",");
const UPLOAD = args.upload;
const API = args.api ?? "http://127.0.0.1:8810";
const SIZE = args.size ?? "1600,1000";
// --shots "name|#/route;name2|#/route2": real-time screenshots (virtual-time headless skips resize work)
const SHOTS = (args.shots ?? "").split(";").filter(Boolean).map((x) => x.split("|"));
const PORT = 9333;
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "sonark-e2e-profile-"));
const proc = spawn(
  BROWSER,
  [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run",
    "--disable-extensions", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--window-size=${SIZE}`, "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let seq = 0;
const pending = new Map();
const consoleErrors = [];
const log = [];
const step = (m) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${m}`;
  log.push(line);
  console.log(line);
};

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(desc, expr, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expr)) return Date.now() - t0;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${desc}`);
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  step(`screenshot ${name}.png`);
}
// innerText applies CSS text-transform, so compare case-insensitively.
const hasText = (t) => `document.body.innerText.toLowerCase().includes(${JSON.stringify(t.toLowerCase())})`;
const clickButton = (re) =>
  `(() => { const b = [...document.querySelectorAll('button')].find(b => ${re}.test(b.textContent.trim()) && !b.disabled); if (!b) return false; b.click(); return true; })()`;
const typeInto = (selector, value) =>
  `(() => { const i = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

async function twinFlow() {
  step(`open ${URL_}/#/twin`);
  await send("Page.navigate", { url: `${URL_}/#/twin` });
  await waitFor("verified twin summary", hasText("Under the current placement"), 30000);
  await waitFor("node checkboxes", `!!document.querySelector('[aria-label="Hypothetical node failures"] input')`);

  step(`tick ${NODE} as a hypothetical failure`);
  await evaluate(
    `(() => { const l = [...document.querySelectorAll('[aria-label="Hypothetical node failures"] label')].find(l => l.textContent.includes(${JSON.stringify(NODE)})); l.querySelector('input').click(); return true; })()`,
  );
  await waitFor("PREVIEW mode", `!!document.querySelector('[aria-label^="Mode: PREVIEW"]')`);
  const pt = await waitFor("preview result", `${hasText("No new data loss predicted")} || ${hasText("Predicted data loss")}`, 20000);
  step(`preview answered in ~${pt} ms; banner: ${await evaluate(hasText("HYPOTHETICAL — CLUSTER NOT MODIFIED"))}`);
  // the proposed node must still be observed as up: preview never changes actual state
  const st = await (await fetch(`${API}/api/status`)).json();
  step(`actual ${NODE} up after preview (from /api/status): ${st.data.nodes.find((n) => n.node_id === NODE).up}`);
  await shot("1-preview");

  step("open the experiment dialog");
  await waitFor("Prepare button", clickButton(/Prepare experiment/), 10000);
  await waitFor("dialog", `!!document.querySelector('dialog[open]')`);
  const disabledBefore = await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(b => /now$/.test(b.textContent)).disabled`);
  step(`confirm button disabled before typing: ${disabledBefore}`);
  await evaluate(typeInto("dialog[open] input", NODE));
  await shot("2-confirm");
  step("confirm: run the real experiment");
  const t0 = Date.now();
  await waitFor("confirm click", clickButton(/now$/), 5000);
  await waitFor("EXPERIMENT mode", `!!document.querySelector('[aria-label^="Mode: EXPERIMENT"]')`, 5000);
  await sleep(1500);
  await shot("3-running");
  await waitFor("experiment result", `${hasText("Prediction matched reality")} || ${hasText("did not match")}`, 120000);
  step(`experiment finished after ${Date.now() - t0} ms; matched: ${await evaluate(hasText("Prediction matched reality"))}`);
  await shot("4-result");

  step("open Proof of Survival");
  await waitFor("proof button", clickButton(/Open Proof of Survival/), 5000);
  await waitFor("proof view", hasText("PROOF OF SURVIVAL"), 15000);
  await shot("5-proof");

  step("back to LIVE and check every node is up again");
  await waitFor("back", clickButton(/Back to LIVE/), 5000);
  await send("Page.navigate", { url: `${URL_}/#/cluster` });
  await waitFor("all nodes up", `/(\\d+)\\/\\1 nodes up/.test(document.body.innerText)`, 30000);
  await shot("6-live-after");
}

async function filesFlow() {
  if (!UPLOAD) throw new Error("--upload <absolute path> is required for the files flow");
  step(`open ${URL_}/#/files and upload ${UPLOAD}`);
  await send("Page.navigate", { url: `${URL_}/#/files` });
  await waitFor("upload input", `!!document.querySelector('input[type=file]')`, 15000);
  await send("DOM.enable");
  const doc = await send("DOM.getDocument", {});
  const node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
  await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [UPLOAD] });
  await waitFor("201 stored", hasText("Stored (201)"), 30000);
  step(`upload confirmed by backend; UI says protection not verified yet: ${await evaluate(hasText("Protection not verified yet"))}`);
  await shot("7-uploaded");
  await waitFor("open and verify", clickButton(/^Open and verify$/), 5000);
  await waitFor("verified file detail", hasText("Hash-verified snapshot"), 20000);
  await waitFor("download", clickButton(/Download & verify/), 5000);
  await waitFor("download check", hasText("SHA-256 (browser)"), 30000);
  const ok = await evaluate(
    `(() => { const dt = [...document.querySelectorAll('dt')].find(d => d.textContent === 'Matches stored hash'); return dt?.nextElementSibling?.textContent ?? null; })()`,
  );
  step(`browser-computed SHA-256 matches stored hash: ${ok}`);
  await shot("8-download-verified");
  if (!ok || !ok.includes("Yes")) throw new Error("download hash check did not pass");
}

async function integrityFlow() {
  step(`open ${URL_}/#/integrity and scrub`);
  await send("Page.navigate", { url: `${URL_}/#/integrity` });
  await waitFor("scrub button", clickButton(/Run scrub/), 15000);
  await waitFor("scrub result", hasText("Scrub ·"), 60000);
  step(`scrub reports issues: ${await evaluate(hasText("issues found"))}`);
  await shot("9-scrub");
  await waitFor("repair button", clickButton(/^Repair…$/), 5000);
  await waitFor("dialog", `!!document.querySelector('dialog[open]')`);
  await waitFor(
    "confirm repair",
    `(() => { const b = [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Repair'); if (!b) return false; b.click(); return true; })()`,
    5000,
  );
  await waitFor("repair result", hasText("Verification scrub after repair"), 60000);
  const panels = await evaluate(
    `[...document.querySelectorAll('section')].filter(s => /Repair pass|Verification scrub after repair/.test(s.querySelector('h2')?.textContent ?? '')).map(s => s.innerText.replace(/\\s+/g, ' ')).join(' || ')`,
  );
  step(`repair panels: ${panels.slice(0, 500)}`);
  await shot("10-repair");
}

/** Load the overview, then wait (up to 3 min) for someone to stop the API. */
async function disconnectFlow() {
  step(`open ${URL_}/#/cluster and wait for the API to stop answering`);
  await send("Page.navigate", { url: `${URL_}/#/cluster` });
  await waitFor("overview loaded", `/\\d+\\/\\d+ nodes up/.test(document.body.innerText)`, 30000);
  writeFileSync(join(OUT, "disconnect-ready"), "ready\n");
  await waitFor("disconnected banner", hasText("API unreachable"), 180000);
  await sleep(6000); // let the other polls fail too
  step(`banner shown; cached panels marked STALE: ${await evaluate(`document.body.innerText.includes("STALE")`)}`);
  step(`top bar: ${await evaluate(`document.querySelector('header [role=status]')?.textContent`)}`);
  await shot("11-disconnected");
}

/** Log every API request the page makes for --seconds, with queueing and total time. */
async function netlogFlow() {
  const reqs = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("/api/") && m.params.request.method !== "OPTIONS")
      reqs.set(m.params.requestId, { url: m.params.request.url.replace(/^https?:\/\/[^/]+/, ""), method: m.params.request.method, t0: m.params.timestamp });
    if ((m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") && reqs.has(m.params.requestId)) {
      reqs.get(m.params.requestId).t1 = m.params.timestamp;
      if (m.method === "Network.loadingFailed") reqs.get(m.params.requestId).failed = m.params.errorText + (m.params.canceled ? " (canceled)" : "");
    }
  });
  await send("Network.enable");
  const t0 = Date.now();
  await send("Page.navigate", { url: `${URL_}/${args.route ?? "#/cluster"}` });
  const secs = Number(args.seconds ?? 30);
  let ready = null;
  while (Date.now() - t0 < secs * 1000) {
    if (ready === null && args.until && (await evaluate(hasText(args.until)))) ready = (Date.now() - t0) / 1000;
    await sleep(250);
  }
  if (args.until) step(`"${args.until}" visible after ${ready === null ? "NOT within " + secs : ready.toFixed(1)} s`);
  const list = [...reqs.values()].sort((a, b) => a.t0 - b.t0);
  const base = list[0]?.t0 ?? 0;
  for (const r of list)
    step(`  +${(r.t0 - base).toFixed(1).padStart(5)} s  ${r.t1 ? ((r.t1 - r.t0).toFixed(2) + " s").padStart(8) : " pending"}  ${r.method} ${r.url.slice(0, 70)}${r.failed ? "  [" + r.failed + "]" : ""}`);
  writeFileSync(join(OUT, "netlog.json"), JSON.stringify(list, null, 1));
}

const clickSel = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`;
async function key(k) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k.length === 1 ? k : undefined });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k });
}

/** Event, shard and node inspectors, shortcuts, rail expansion. */
async function inspectorsFlow() {
  step("events: open a scenario_end event in the inspector");
  await send("Page.navigate", { url: `${URL_}/#/events` });
  await waitFor("event rows", `[...document.querySelectorAll("tbody tr")].some(r => r.textContent.includes("scenario_end"))`, 20000);
  await evaluate(`(() => { const r = [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("scenario_end")); r.click(); return true; })()`);
  await waitFor("event inspector", hasText("Full payload"), 10000);
  step(`event inspector shows operation id: ${await evaluate(`[...document.querySelectorAll("dt")].some(d => d.textContent === "Operation ID")`)}`);
  await shot("i1-event-inspector");

  step("matrix: open a shard in the inspector");
  await send("Page.navigate", { url: `${URL_}/#/twin?file=${args.file}&surface=matrix` });
  await waitFor("matrix cell", `!!document.querySelector('button[aria-label^="Shard 0:0 "]')`, 30000);
  await evaluate(clickSel('button[aria-label^="Shard 0:0 "]'));
  await waitFor("shard inspector", hasText("Host node"), 15000);
  step(`shard inspector checksum row: ${await evaluate(hasText("does not expose per-shard SHA-256"))}`);
  await shot("i2-shard-inspector");

  step("node inspector with state history (2D stage)");
  await send("Page.navigate", { url: `${URL_}/#/cluster?stage=2d` });
  await waitFor("2D node", `!!document.querySelector('[role=button][aria-label^="Node n6"]')`, 20000);
  await evaluate(`(() => { document.querySelector('[role=button][aria-label^="Node n6"]').dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; })()`);
  await waitFor("node inspector", hasText("State history (event log)"), 10000);
  await sleep(1500);
  await shot("i3-node-inspector");

  step("keyboard: ? opens the shortcut sheet, g v goes to events, Esc clears");
  await evaluate(`document.activeElement && document.activeElement.blur(), true`);
  await key("?");
  await waitFor("shortcut sheet", `!!document.querySelector('[aria-label="Keyboard shortcuts"]')`, 3000);
  await shot("i4-shortcuts");
  await key("Escape");
  await key("g");
  await key("v");
  await waitFor("events view via g v", `location.hash.startsWith("#/events")`, 3000);
  step(`g v navigated to: ${await evaluate("location.hash")}`);

  step("rail expands on hover");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 28, y: 160 });
  await sleep(400);
  step(`rail width on hover: ${await evaluate(`document.querySelector('nav[aria-label="Primary"] > div').getBoundingClientRect().width`)} px`);
  await shot("i5-rail");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 800, y: 500 });
}

/** Print the Proof of Survival to PDF with the browser's own print pipeline. */
async function pdfFlow() {
  await send("Page.navigate", { url: `${URL_}/#/lab?run=${args.run}` });
  await waitFor("proof", hasText("Proof of Survival"), 20000);
  await sleep(1500);
  const r = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: false });
  const buf = Buffer.from(r.data, "base64");
  writeFileSync(join(OUT, "proof.pdf"), buf);
  const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  step(`printed proof.pdf: ${buf.length} bytes, ${pages} page(s)`);
}

/** Scan with a damaged shard, inspect a finding, repair, confirm the backend result. */
async function findingsFlow() {
  await send("Page.navigate", { url: `${URL_}/#/integrity` });
  await waitFor("scan button", clickButton(/Start scan/), 15000);
  await waitFor("findings table", hasText("What repair can accomplish"), 60000);
  const outlook = await evaluate(`[...document.querySelectorAll("tbody tr")].map(r => r.innerText.replace(/\s+/g, " ")).slice(0, 3).join(" || ")`);
  step(`findings: ${outlook.slice(0, 400)}`);
  await shot("f1-findings");
  await evaluate(`(() => { const r = [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("checksum mismatch")); if (!r) return false; r.click(); return true; })()`);
  await waitFor("shard inspector", hasText("Host node"), 15000);
  await shot("f2-finding-shard");
  await waitFor("repair button", clickButton(/^Repair…$/), 5000);
  await waitFor("dialog", `!!document.querySelector('dialog[open]')`);
  await evaluate(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Repair'); b.click(); return true; })()`);
  await waitFor("backend confirmed", hasText("Backend-confirmed"), 60000);
  await waitFor("redundancy line", hasText("Redundancy after repair"), 10000);
  step(`after repair: ${await evaluate(`[...document.querySelectorAll("dt")].filter(d => /Rebuilt|Redundancy|Post-repair/.test(d.textContent)).map(d => d.textContent + ": " + d.nextElementSibling.textContent).join(" | ")`)}`);
  await shot("f3-repaired");
}

/**
 * Blank-stage probe: switch views repeatedly and measure whether the 3D canvas
 * drew any node pixels. Optional --latency <ms> adds network latency (CDP).
 */
const STAGE_PROBE = `(() => {
  const c = document.querySelector('main canvas');
  if (!c) return { canvas: false };
  const o = document.createElement('canvas'); o.width = 96; o.height = 64;
  const x = o.getContext('2d'); x.drawImage(c, 0, 0, 96, 64);
  const d = x.getImageData(0, 0, 96, 64).data; let node = 0;
  for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; if (g > 55 && g > r + 12 && g >= b) node++; }
  return { canvas: true, w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, node };
})()`;
async function blankFlow() {
  await send("Network.enable");
  if (args.latency) {
    await send("Network.emulateNetworkConditions", { offline: false, latency: Number(args.latency), downloadThroughput: -1, uploadThroughput: -1 });
    step(`network latency emulated: ${args.latency} ms`);
  }
  await send("Page.navigate", { url: `${URL_}/#/cluster` });
  await waitFor("stage canvas", `!!document.querySelector('main canvas')`, 60000);
  await sleep(3000);
  const rounds = Number(args.rounds ?? 12);
  const delays = [150, 400, 1000, 2500];
  const blanks = [];
  for (let i = 0; i < rounds; i++) {
    for (const target of ["Survival Twin", "Cluster overview"]) {
      const route = target === "Survival Twin" ? `#/twin?file=${args.file ?? ""}&surface=matrix` : "#/cluster";
      if (args.via === "hash") await evaluate(`(location.hash = ${JSON.stringify(route)}, true)`);
      else if (args.via === "reload") await send("Page.navigate", { url: `${URL_}/${route}&r=${i}` });
      else await evaluate(`(() => { const b = document.querySelector('nav button[aria-label="${target}"]'); b.click(); return true; })()`);
      const samples = [];
      let waited = 0;
      for (const d of delays) {
        await sleep(d - waited);
        waited = d;
        samples.push({ t: d, ...(await evaluate(STAGE_PROBE)) });
      }
      const last = samples.at(-1);
      const firstDrawn = samples.find((x) => x.canvas && x.node > 0);
      const line = `${String(i + 1).padStart(2)} ${target.padEnd(16)} ` + samples.map((x) => (x.canvas ? `${x.t}ms:${x.node}px(${x.cw}x${x.ch})` : `${x.t}ms:nocanvas`)).join(" ");
      if (!last.canvas || last.node === 0) {
        blanks.push(line);
        step(`BLANK after 2.5 s -> ${line}`);
        await shot(`blank-${i + 1}-${target.replace(/\s/g, "")}`);
      } else if (!firstDrawn || firstDrawn.t > 400) {
        step(`slow first draw -> ${line}`);
      }
    }
  }
  step(`blank-stage probe: ${rounds * 2} switches, ${blanks.length} still blank after 2.5 s`);
  if (args.latency) await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}

/** Click "Export JSON" on a proof, capture the real file, compare with the checksum the page shows. */
async function proofJsonFlow() {
  await send("Page.navigate", { url: `${URL_}/#/lab?run=${args.run}` });
  await waitFor("proof", hasText("Proof of Survival"), 20000);
  await evaluate(`(() => { window.__exported = null; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__exported = { name: this.download, href: this.href }; return orig.call(this); }; return true; })()`);
  await waitFor("export button", clickButton(/Export JSON/), 5000);
  await waitFor("export captured", `!!window.__exported`, 10000);
  const text = await evaluate(`fetch(window.__exported.href).then(r => r.text())`);
  const name = await evaluate(`window.__exported.name`);
  writeFileSync(join(OUT, name), text);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(text, "utf8").digest("hex");
  await waitFor("checksum shown", hasText("SHA-256 of the exported file"), 5000);
  const shown = await evaluate(`[...document.querySelectorAll('code[aria-label="export SHA-256"]')].map(c => c.textContent)[0] ?? null`);
  const doc = JSON.parse(text);
  step(`exported ${name}: run ${doc.report.run_id}, ${text.length} bytes; SHA-256 ${sha}`);
  step(`checksum shown in the page matches the file: ${shown === sha}`);
  if (shown !== sha || doc.report.run_id !== args.run) throw new Error("export checksum or run id mismatch");
  await shot("proof-exported");
}

async function exportFlow() {
  step("export PNG from the 3D stage");
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT, eventsEnabled: true });
  await send("Page.navigate", { url: `${URL_}/${args.route ?? "#/cluster"}` });
  await waitFor("export button enabled", `(() => { const b = document.querySelector('button[aria-label="Export PNG"]'); return !!b && !b.disabled; })()`, 20000);
  await sleep(1500);
  // Capture what the export hands to the download anchor (headless may not save files).
  await evaluate(`(() => { window.__exported = null; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__exported = { name: this.download, href: this.href }; return orig.call(this); }; return true; })()`);
  await evaluate(`document.querySelector('button[aria-label="Export PNG"]').click(), true`);
  await sleep(1500);
  const ex = await evaluate(`window.__exported && { name: window.__exported.name, prefix: window.__exported.href.slice(0, 22), length: window.__exported.href.length }`);
  step(`export produced: ${JSON.stringify(ex)}`);
  if (!ex || !ex.prefix.startsWith("data:image/png")) throw new Error("export did not produce a PNG");
  const b64 = await evaluate(`window.__exported.href.split(",")[1]`);
  writeFileSync(join(OUT, ex.name), Buffer.from(b64, "base64"));
  step("export clicked; check the output directory for sonark-stage-*.png");
}

async function shotsFlow() {
  for (const [name, route] of SHOTS) {
    await send("Page.navigate", { url: `${URL_}/${route}` });
    await waitFor("app", `!!document.querySelector('[aria-label="Cluster status"], [aria-label="Survival Twin steps"], main')`, 15000);
    await sleep(Number(args.wait ?? 5000));
    if (args.click) {
      await evaluate(clickSel(args.click));
      await sleep(1500);
    }
    if (args.scrollto)
      await evaluate(
        `(() => { const el = [...document.querySelectorAll('button, h2, div')].find(e => e.textContent.trim().startsWith(${JSON.stringify(args.scrollto)})); el?.scrollIntoView({ block: "start" }); return !!el; })()`,
      );
    await sleep(300);
    await shot(name);
  }
}

let exitCode = 0;
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch {
      await sleep(200);
    }
  }
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  if (FLOWS.includes("twin")) await twinFlow();
  if (FLOWS.includes("files")) await filesFlow();
  if (FLOWS.includes("integrity")) await integrityFlow();
  if (FLOWS.includes("disconnect")) await disconnectFlow();
  if (FLOWS.includes("shots")) await shotsFlow();
  if (FLOWS.includes("export")) await exportFlow();
  if (FLOWS.includes("netlog")) await netlogFlow();
  if (FLOWS.includes("inspectors")) await inspectorsFlow();
  if (FLOWS.includes("pdf")) await pdfFlow();
  if (FLOWS.includes("findings")) await findingsFlow();
  if (FLOWS.includes("blank")) await blankFlow();
  if (FLOWS.includes("proofjson")) await proofJsonFlow();
} catch (e) {
  exitCode = 1;
  step(`FAILED: ${e.message}`);
  try {
    await shot("failure");
  } catch {}
} finally {
  step(`console errors: ${consoleErrors.length}`);
  for (const c of consoleErrors) step(`  ${c.slice(0, 300)}`);
  writeFileSync(join(OUT, "e2e-log.txt"), log.join("\n") + "\n");
  ws?.close();
  proc.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(exitCode);
}
