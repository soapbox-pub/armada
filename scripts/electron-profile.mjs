#!/usr/bin/env node
/**
 * Memory and CPU of the real desktop app (electron/), measured from outside:
 * launches the shell under Xvfb with a throwaway profile, logs in as a throwaway
 * key, joins a community from an invite, and reports per Chromium process type
 * (browser = the shell + ArmadaDB, renderer = the page, gpu-process, utility).
 *
 *   ARMADA_PERF_INVITE='https://armada.buzz/invite/…#…' node scripts/electron-profile.mjs --label before
 *     --skip-build     use electron/dist and electron/*.cjs as they are
 *     --settle <s>     after the join, before measuring (60)
 *     --visible <s>    window shown, nobody touching anything (120)
 *     --hidden <s>     then hidden to the tray as the close button does (120)
 *     --reloads <n>    then reload the page n times, timing each (3)
 *     --reduce-effects the Reduce effects switch on, every part included
 *     --main-profile   CPU-profile the main process across the reloads
 *     --electron-args '<switches>'  extra Chromium/Electron switches, for A/B runs
 *     --low-memory     with Desktop › Low memory mode on
 *     --reduce-only <part>  with --reduce-effects: only motion, media, blur or flair
 *     --frames         10s of compositor tracing per phase: what draws frames
 *
 * Phases report PSS (proportional, so shared pages aren't double counted) and
 * CPU as % of one core, per process type; Chromium's memory-infra breakdown of
 * the renderer (decoded images, V8, malloc); the JS heap; and the main
 * process's worst event-loop lag, which is what a synchronous store blocks.
 *
 * Linux only (/proc). Nothing is published: every outbound EVENT is answered
 * with an OK in the page before it reaches a socket. The invite carries the
 * community's keys, so it is never written to a report.
 *
 * Output: perf-reports/electron-<label>.json and a summary on stdout.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LABEL = opt("label", "run");
const INVITE = opt("invite", process.env.ARMADA_PERF_INVITE ?? "");
const SETTLE = Number(opt("settle", "60"));
const VISIBLE = Number(opt("visible", "120"));
const HIDDEN = Number(opt("hidden", "120"));
const RELOADS = Number(opt("reloads", "3"));
const CDP_PORT = 9333;
const INSPECT_PORT = 9334;
const OUT = resolve(root, "perf-reports");
if (!INVITE) {
  console.error("needs --invite <url> or ARMADA_PERF_INVITE");
  process.exit(2);
}

if (!flag("skip-build")) {
  console.log("building web + electron bundles…");
  for (const [cmd, a] of [["npx", ["vite", "build", "-l", "error"]], ["npm", ["run", "build:electron"]], ["node", ["electron/scripts/stage-web.mjs"]]]) {
    const r = spawnSync(cmd, a, { cwd: root, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

// ─── Launch ─────────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), "armada-eprof-"));
// `--low-memory`: the Desktop › Low memory mode setting, as the toggle leaves it.
if (flag("low-memory")) writeFileSync(join(profile, "low-memory-mode"), "on\n");
const electronBin = resolve(root, "electron/node_modules/.bin/electron");
const env = { ...process.env, XDG_SESSION_TYPE: "x11" };
delete env.WAYLAND_DISPLAY;
const proc = spawn(
  "xvfb-run",
  ["-a", "-s", "-screen 0 1280x900x24", electronBin, ".", "--ozone-platform=x11", `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`, `--inspect=${INSPECT_PORT}`, ...opt("electron-args", "").split(" ").filter(Boolean)],
  { cwd: resolve(root, "electron"), env, stdio: ["ignore", "ignore", "pipe"], detached: true },
);
let shellLog = "";
proc.stderr.on("data", (d) => (shellLog += d));
const stop = () => {
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    // already gone
  }
  rmSync(profile, { recursive: true, force: true });
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${shellLog.slice(-2000)}`);
    await sleep(500);
  }
}

// ─── The main process, through its Node inspector ───────────────────────────

const mainWs = await waitFor(async () => {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json();
  return list[0]?.webSocketDebuggerUrl;
}, 60_000, "the main-process inspector");
const main = new WebSocket(mainWs);
await new Promise((r, j) => {
  main.onopen = r;
  main.onerror = j;
});
let nextId = 1;
const pending = new Map();
main.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
};
async function mainCall(method, params = {}) {
  const id = nextId++;
  main.send(JSON.stringify({ id, method, params }));
  return (await new Promise((r) => pending.set(id, r))).result;
}
/** Top self-time functions of a main-process CPU profile. */
function hotFunctions(profile, n = 15) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const self = new Map();
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  return [...self].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `${Math.round(us / 1000)}ms ${k}`);
}
async function inMain(expression) {
  const id = nextId++;
  main.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  const msg = await new Promise((r) => pending.set(id, r));
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 500));
  return msg.result?.result?.value;
}
// Event-loop lag in the main process: a 50ms tick, recording how late each fires.
await inMain(`(() => {
  const s = globalThis.__lag = { max: 0, over50: 0, over200: 0, last: performance.now() };
  setInterval(() => {
    const now = performance.now(), late = now - s.last - 50;
    s.last = now;
    if (late > s.max) s.max = late;
    if (late > 50) s.over50++;
    if (late > 200) s.over200++;
  }, 50).unref();
  return true;
})()`);
const resetLag = () => inMain(`Object.assign(globalThis.__lag, { max: 0, over50: 0, over200: 0 }), true`);
const readLag = () => inMain(`({ maxMs: Math.round(globalThis.__lag.max), over50: globalThis.__lag.over50, over200: globalThis.__lag.over200 })`);

// ─── The page ───────────────────────────────────────────────────────────────

const browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 60_000, "the renderer");
const page = await waitFor(() => browser.contexts()[0]?.pages()[0], 30_000, "the window");
await page.addInitScript(() => {
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string" && data.startsWith('["EVENT"')) {
      try {
        const id = JSON.parse(data)[1].id;
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["OK", id, true, ""]) })), 0);
      } catch {
        // not an event: dropped all the same
      }
      return;
    }
    return send.call(this, data);
  };
});
const browserCdp = await browser.newBrowserCDPSession();
const pageCdp = await browser.contexts()[0].newCDPSession(page);
await pageCdp.send("Performance.enable");

// ─── Measurements ───────────────────────────────────────────────────────────

/** Per process type: PSS MB and CPU seconds, for every process under our profile. */
function processes() {
  const out = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.includes(profile) || !/electron\/dist\/electron/.test(cmd.split("\0")[0])) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const pss = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0);
      let type = /--type=([\w-]+)/.exec(cmd)?.[1] ?? "browser";
      if (type === "utility") type = `utility:${/--utility-sub-type=([\w.]+)/.exec(cmd)?.[1]?.split(".").pop() ?? "?"}`;
      // Zygotes hold nothing; the tracing service exists only because we measure.
      if (type === "zygote" || /TracingService/.test(type)) continue;
      out.push({ pid: Number(pid), type, pssMB: pss / 1024, cpuSec: (Number(f[11]) + Number(f[12])) / 100 });
    } catch {
      // exited mid-walk
    }
  }
  return out;
}
function byType(list, key) {
  const o = {};
  for (const p of list) o[p.type] = (o[p.type] ?? 0) + p[key];
  return o;
}
const r1 = (n) => Math.round(n * 10) / 10;
function pssSummary(list) {
  const t = byType(list, "pssMB");
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  return { totalMB: Math.round(total), ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)])) };
}
function cpuBetween(a, b, sec) {
  const ta = byType(a, "cpuSec"), tb = byType(b, "cpuSec");
  const o = {};
  let total = 0;
  for (const k of Object.keys(tb)) {
    const d = tb[k] - (ta[k] ?? 0);
    total += d;
    o[k] = r1((d / sec) * 100);
  }
  return { totalPct: r1((total / sec) * 100), ...o };
}

/** Chromium's own accounting of the renderer: decoded images, V8, malloc. */
async function memoryInfra() {
  const events = [];
  const onData = (e) => events.push(...e.value);
  browserCdp.on("Tracing.dataCollected", onData);
  const done = new Promise((r) => browserCdp.once("Tracing.tracingComplete", r));
  await browserCdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["disabled-by-default-memory-infra"], memoryDumpConfig: { triggers: [] } },
    transferMode: "ReportEvents",
  });
  await browserCdp.send("Tracing.requestMemoryDump", { deterministic: true, levelOfDetail: "detailed" });
  await browserCdp.send("Tracing.end");
  await done;
  browserCdp.off("Tracing.dataCollected", onData);
  const renderers = new Set(processes().filter((p) => p.type === "renderer").map((p) => p.pid));
  const out = {};
  for (const e of events) {
    const a = e.ph === "v" && renderers.has(e.pid) ? e.args?.dumps?.allocators : undefined;
    if (!a) continue;
    const size = (k) => parseInt(a[k]?.attrs?.size?.value ?? "0", 16) / 1048576;
    for (const k of ["cc/image_memory", "discardable", "v8", "malloc", "partition_alloc", "blink_gc"]) {
      if (a[k]) out[k] = r1((out[k] ?? 0) + size(k));
    }
  }
  return out;
}

/** 10s of compositor tracing: frames drawn, and the busiest trace events by count. */
async function frameCensus() {
  const events = [];
  const onData = (e) => events.push(...e.value);
  browserCdp.on("Tracing.dataCollected", onData);
  const done = new Promise((r) => browserCdp.once("Tracing.tracingComplete", r));
  await browserCdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["disabled-by-default-devtools.timeline.frame", "viz", "cc", "gpu", "blink"] },
    transferMode: "ReportEvents",
  });
  await sleep(10_000);
  await browserCdp.send("Tracing.end");
  await done;
  browserCdp.off("Tracing.dataCollected", onData);
  const counts = {};
  for (const e of events) if (e.ph === "X" || e.ph === "B" || e.ph === "I" || e.ph === "i") counts[e.name] = (counts[e.name] ?? 0) + 1;
  const per = (name) => r1((counts[name] ?? 0) / 10);
  return {
    drawFramePerSec: per("DrawFrame"),
    beginFramePerSec: per("Scheduler::BeginFrame") || per("BeginFrame"),
    top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${r1(v / 10)}/s`),
  };
}

async function pageState() {
  return page.evaluate(() => {
    const imgs = [...document.images];
    return {
      jsHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
      images: imgs.length,
      decodedImageMB: Math.round(imgs.reduce((s, i) => s + i.naturalWidth * i.naturalHeight * 4, 0) / 1048576),
      largestImagePx: imgs.reduce((m, i) => Math.max(m, i.naturalWidth * i.naturalHeight), 0),
      topImages: imgs
        .map((i) => ({ i, px: i.naturalWidth * i.naturalHeight }))
        .sort((a, b) => b.px - a.px)
        .slice(0, 4)
        .map(({ i }) => `${i.naturalWidth}x${i.naturalHeight}→${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)} ${i.currentSrc.slice(0, 5)} .${i.className.split(" ")[0]}`),
      canvases: document.querySelectorAll("canvas").length,
      domNodes: document.getElementsByTagName("*").length,
      visibility: document.visibilityState,
    };
  });
}

/** `sec` seconds of whatever the app is doing, sampled every 30s. */
async function phase(name, sec) {
  console.log(`▶ ${name} (${sec}s)`);
  await resetLag();
  const metricsA = Object.fromEntries((await pageCdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const start = processes();
  const t0 = Date.now();
  const samples = [];
  let prev = start;
  for (let left = sec; left > 0; left -= 30) {
    const step = Math.min(30, left);
    await sleep(step * 1000);
    const now = processes();
    samples.push({ pss: pssSummary(now), cpu: cpuBetween(prev, now, step) });
    prev = now;
  }
  const wall = (Date.now() - t0) / 1000;
  const metricsB = Object.fromEntries((await pageCdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  return {
    pss: pssSummary(prev),
    cpu: cpuBetween(start, prev, wall),
    pageMainThreadPct: r1(((metricsB.TaskDuration - metricsA.TaskDuration) / wall) * 100),
    mainLag: await readLag(),
    infra: await memoryInfra(),
    frames: flag("frames") ? await frameCensus() : undefined,
    page: await pageState(),
    pssPer30s: samples.map((s) => s.pss.totalMB),
    cpuPer30s: samples.map((s) => s.cpu.totalPct),
  };
}

// ─── Scenario ───────────────────────────────────────────────────────────────

/** `--reduce-only <part>`: Reduce effects with every other part left out. */
function reduceExcept() {
  const keep = opt("reduce-only", "");
  if (!keep) return [];
  const parts = { motion: "armada:reduce-motion", media: "armada:still-media", blur: "armada:reduce-blur", flair: "armada:hide-flair" };
  return Object.entries(parts).filter(([p]) => p !== keep).map(([, k]) => k);
}

const report = { label: LABEL, at: new Date().toISOString(), electron: readFileSync(resolve(root, "electron/node_modules/electron/package.json"), "utf8").match(/"version": "([^"]+)"/)[1] };
await waitFor(() => page.url().startsWith("app://"), 30_000, "app://");
await sleep(5000);
report.loggedOut = { pss: pssSummary(processes()) };

const sk = generateSecretKey();
const pk = getPublicKey(sk);
await page.evaluate(([json, pk, reduce, only]) => {
  localStorage.setItem("armada:login", json);
  localStorage.setItem("armada:active-pubkey", pk);
  localStorage.setItem(`armada:relay-prompt-shown:${pk}`, "1");
  if (reduce) localStorage.setItem("armada:reduce-effects", "1");
  // Parts left out ("0"), to see which part of Reduce effects a saving comes from.
  for (const key of only) localStorage.setItem(key, "0");
}, [JSON.stringify([{ id: `nsec:${pk}`, type: "nsec", pubkey: pk, createdAt: new Date().toISOString(), data: { nsec: nip19.nsecEncode(sk) } }]), pk, flag("reduce-effects"), reduceExcept()]);
await resetLag();
const joinStart = processes();
const joinT0 = Date.now();
const invite = new URL(INVITE);
await page.goto(`app://armada${invite.pathname}${invite.hash}`);
const accept = page.getByRole("button", { name: /accept invite/i });
await accept.waitFor({ timeout: 90_000 });
await accept.click();
await page.waitForURL(/\/c\//, { timeout: 90_000 });
console.log(`joined; settling ${SETTLE}s`);
await sleep(SETTLE * 1000);
// The join pours history into the store: the main process's busiest stretch.
report.join = { mainLag: await readLag(), cpu: cpuBetween(joinStart, processes(), (Date.now() - joinT0) / 1000) };

// Text in the composer, so spellcheck (if on) has loaded its dictionary.
await page.locator("[contenteditable=true], textarea").first().fill("teh quick brwn fox jumpd").catch(() => {});
await sleep(3000);
report.visible = await phase("visible", VISIBLE);

// As hideWindowToTray does (main.js): hide, then tell the page.
await inMain(`(() => {
  const { BrowserWindow } = process.mainModule.require("electron");
  const w = BrowserWindow.getAllWindows()[0];
  w.hide();
  w.webContents.send("armada:window-hidden");
  return true;
})()`);
// Past the page's rest grace (trayRest.ts).
await sleep(15_000);
report.hidden = await phase("hidden", HIDDEN);
await inMain(`(() => { const { BrowserWindow } = process.mainModule.require("electron"); BrowserWindow.getAllWindows()[0].show(); return true; })()`);
await sleep(3000);

// Reloads: the second and later are what a V8 code cache would speed up.
report.reloads = [];
// Time the app:// handler's file reads (main.js serveFile) across the reloads.
await inMain(`(() => {
  const fs = process.mainModule.require("fs");
  const s = globalThis.__reads = { ms: 0, n: 0, maxMs: 0, bytes: 0 };
  if (!fs.__timed) {
    const orig = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      const t = performance.now();
      const out = orig.call(this, p, ...rest);
      if (typeof p === "string" && p.includes("/dist/")) {
        const d = performance.now() - t;
        globalThis.__reads.ms += d; globalThis.__reads.n++; globalThis.__reads.bytes += out.length;
        if (d > globalThis.__reads.maxMs) globalThis.__reads.maxMs = d;
      }
      return out;
    };
    fs.__timed = true;
  }
  return true;
})()`);
await resetLag();
if (flag("main-profile")) {
  await mainCall("Profiler.enable");
  await mainCall("Profiler.start");
}
for (let i = 0; i < RELOADS; i++) {
  await pageCdp.send("Performance.disable");
  await pageCdp.send("Performance.enable");
  // V8 compile time and code-cache use, from its own trace events.
  const events = [];
  const onData = (e) => events.push(...e.value);
  browserCdp.on("Tracing.dataCollected", onData);
  const traced = new Promise((r) => browserCdp.once("Tracing.tracingComplete", r));
  await browserCdp.send("Tracing.start", { traceConfig: { includedCategories: ["v8", "disabled-by-default-v8.compile"] }, transferMode: "ReportEvents" });
  const t0 = Date.now();
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("main [data-scroll-anchor]", { timeout: 60_000 }).catch(() => {});
  const ms = Date.now() - t0;
  await sleep(1500);
  await browserCdp.send("Tracing.end");
  await traced;
  browserCdp.off("Tracing.dataCollected", onData);
  const sum = (re) => Math.round(events.filter((e) => e.ph === "X" && re.test(e.name)).reduce((a, e) => a + (e.dur ?? 0), 0) / 1000);
  const count = (re) => events.filter((e) => re.test(e.name)).length;
  const v8 = { compileMs: sum(/^(v8\.compile|V8\.CompileLazy|v8\.compileModule)$/), consumeCache: count(/consumeCache|ConsumeCodeCache/i), produceCache: count(/produceCache|ProduceCodeCache/i) };
  const m = Object.fromEntries((await pageCdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  report.reloads.push({ toFirstRowMs: ms, scriptMs: Math.round(m.ScriptDuration * 1000), taskMs: Math.round(m.TaskDuration * 1000), ...v8 });
  await sleep(5000);
}

report.reloadMainLag = await readLag();
if (flag("main-profile")) report.reloadMainHot = hotFunctions((await mainCall("Profiler.stop")).profile);
report.reloadFileReads = await inMain(`({ ms: Math.round(__reads.ms), n: __reads.n, maxMs: Math.round(__reads.maxMs), MB: Math.round(__reads.bytes / 1048576) })`);
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, `electron-${LABEL}.json`), JSON.stringify(report, null, 2));
const line = (p) => `PSS ${p.pss.totalMB} MB ${JSON.stringify(p.pss)} | CPU ${p.cpu.totalPct}% ${JSON.stringify(p.cpu)} | page main thread ${p.pageMainThreadPct}% | main lag ${JSON.stringify(p.mainLag)}\n    renderer infra ${JSON.stringify(p.infra)}\n    page ${JSON.stringify(p.page)}\n    frames ${JSON.stringify(p.frames)}\n    PSS/30s ${p.pssPer30s.join(" ")}  CPU/30s ${p.cpuPer30s.join(" ")}`;
console.log(`\n══ electron-${LABEL} ══`);
console.log(`logged out: PSS ${report.loggedOut.pss.totalMB} MB ${JSON.stringify(report.loggedOut.pss)}`);
console.log(`join+settle: main lag ${JSON.stringify(report.join.mainLag)} | CPU ${JSON.stringify(report.join.cpu)}`);
console.log(`visible: ${line(report.visible)}`);
console.log(`hidden:  ${line(report.hidden)}`);
console.log(`reloads: ${report.reloads.map((r) => `${r.toFirstRowMs}ms (script ${r.scriptMs}ms, compile ${r.compileMs}ms, cache in/out ${r.consumeCache}/${r.produceCache})`).join(", ")} | main lag ${JSON.stringify(report.reloadMainLag)} | app:// reads ${JSON.stringify(report.reloadFileReads)}`);
if (report.reloadMainHot) console.log(`main process during reloads:\n  ${report.reloadMainHot.join("\n  ")}`);
main.close();
await browser.close().catch(() => {});
process.exit(0);
