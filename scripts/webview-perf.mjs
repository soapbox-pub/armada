#!/usr/bin/env node
/**
 * Measure the app's WebView on a connected Android device over the DevTools
 * protocol: what a tap costs on a real phone, which `perf-profile.mjs`'s
 * headless Chromium can only approximate. Needs a debuggable build (the
 * profiling APK, or any debug build) open and logged in.
 *
 *   node scripts/webview-perf.mjs switch /c/<community> general memes general memes
 *   node scripts/webview-perf.mjs renders general          # profiling build only
 *   node scripts/webview-perf.mjs restyle                  # whole-document restyle costs
 *   node scripts/webview-perf.mjs modal ["More options"]   # a menu's open + close
 *   node scripts/webview-perf.mjs eval 'location.pathname'
 *
 * Options: --pkg <id> (buzz.armada.app.profile), --port <n> (9560),
 * --max-ms <n> (restyle/modal: exit 1 when any one restyle takes longer).
 * ADB / ANDROID_SERIAL are honoured.
 *
 *   switch   taps each channel in turn (back to the list between, as on a phone):
 *            when its rows show, and the long tasks after. Repeat names to time
 *            revisits of kept timelines.
 *   renders  per-component renders, and why, for one channel tap (`__armadaPerf`).
 *   restyle  a forced restyle of the whole document, then of each change a modal
 *            layer makes to <body>: inline `pointer-events: none` and
 *            react-remove-scroll-bar's lock. Each should be a few ms; a whole-
 *            document cost means a selector or an inherited property reaches
 *            every element from <body> (see AGENTS.md, "Performance rules").
 *   modal    opens and closes the menu behind the button labelled as given,
 *            tracing every style recalc on the way.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const PKG = opt("pkg", "buzz.armada.app.profile");
const PORT = Number(opt("port", "9560"));
const maxMs = opt("max-ms");
const MAX_MS = maxMs === undefined ? undefined : Number(maxMs);
const [command, ...rest] = args;
const ADB = process.env.ADB || "adb";

function adb(...a) {
  try {
    return execFileSync(ADB, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    // `pidof` exits 1 for "not running"; anything adb says on stderr is the real failure.
    if (!e.stderr) return "";
    console.error(`adb ${a.join(" ")}: ${e.stderr.trim()}`);
    process.exit(1);
  }
}

async function connect() {
  const pid = adb("shell", "pidof", PKG).split(/\s+/)[0];
  if (!pid) throw new Error(`${PKG} isn't running; open it first (or pass --pkg)`);
  adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith("https://localhost"));
  if (!page) throw new Error("no app page in the WebView");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    return result?.result?.value;
  };
  return { send, evaluate, listeners, close: () => ws.close() };
}

/** In-page helpers every page script below starts with. */
const PRELUDE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (el) => el.getClientRects().length > 0;
  const channelButton = (name) => [...document.querySelectorAll("button[data-channel]")].find((b) => shown(b) && b.textContent.trim() === name);
  const toList = async () => {
    for (let i = 0; i < 3 && ![...document.querySelectorAll("button[data-channel]")].some(shown); i++) { history.back(); await sleep(2000); }
  };
`;

async function switchChannels(page, [community, ...names]) {
  if (!community || names.length === 0) throw new Error("switch <community href> <channel>...");
  const out = await page.evaluate(`(async () => {
    ${PRELUDE}
    const link = document.querySelector('a[href="${community}"]');
    if (link) { link.click(); await sleep(6000); }
    const lt = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(e); });
    po.observe({ type: "longtask" });
    const out = [];
    for (const name of ${JSON.stringify(names)}) {
      await toList();
      const b = channelButton(name);
      if (!b) { out.push(name + ": not in the list"); continue; }
      lt.length = 0;
      const t0 = performance.now();
      b.click();
      let rows = null;
      while (performance.now() - t0 < 15000) {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        if ([...document.querySelectorAll("[data-event-id]")].some(shown)) { rows = performance.now() - t0; break; }
      }
      await sleep(3000);
      const blocked = lt.filter((e) => e.startTime >= t0 - 20).map((e) => Math.round(e.duration));
      out.push(name.padEnd(16) + " rows@" + (rows === null ? "never" : Math.round(rows) + "ms") +
        "  long tasks " + blocked.length + ", " + blocked.reduce((a, b) => a + b, 0) + "ms, max " + Math.max(0, ...blocked) + "ms");
    }
    po.disconnect();
    return out;
  })()`);
  console.log(out.join("\n"));
}

async function renders(page, [name]) {
  if (!name) throw new Error("renders <channel>");
  const out = await page.evaluate(`(async () => {
    ${PRELUDE}
    const perf = window.__armadaPerf;
    if (!perf) return "not a profiling build (VITE_PROFILE=1 VITE_PROFILE_REACT=1)";
    await toList();
    const b = channelButton(${JSON.stringify(name)});
    if (!b) return "no channel " + ${JSON.stringify(name)};
    perf.renders(true);
    perf.runtime(true);
    b.click();
    await sleep(4000);
    const r = perf.runtime().react;
    return [\`commits \${r.commits}, rendering \${r.commitMs}ms\`].concat(r.components.slice(0, 25).map((c) =>
      \`\${String(Math.round(c.selfMs)).padStart(6)}ms \${String(c.renders).padStart(4)}r \${String(c.mounts).padStart(4)}m  \${c.name}  \${String(c.why).slice(0, 160)}\`));
  })()`);
  console.log(Array.isArray(out) ? out.join("\n") : out);
}

/** The rules react-remove-scroll-bar injects while a modal layer is open (gap 0, as on a phone). */
const SCROLL_LOCK_CSS = `
  .with-scroll-bars-hidden { overflow: hidden !important; padding-right: 0px !important; }
  body[data-scroll-locked] { overflow: hidden !important; overscroll-behavior: contain; position: relative !important; margin-right: 0px !important; }
  .right-scroll-bar-position { right: 0px !important; }
  .width-before-scroll-bar { margin-right: 0px !important; }
  body[data-scroll-locked] { --removed-body-scroll-bar-size: 0px; }`;

async function restyle(page) {
  const out = await page.evaluate(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));
    const median = async (apply, revert) => {
      const t = [];
      for (let i = 0; i < 5; i++) {
        await frame();
        let t0 = performance.now();
        apply();
        void document.body.offsetHeight;
        const on = performance.now() - t0;
        await frame();
        t0 = performance.now();
        revert();
        void document.body.offsetHeight;
        t.push(Math.max(on, performance.now() - t0));
      }
      t.sort((a, b) => a - b);
      return Math.round(t[2]);
    };
    let lock;
    return {
      elements: document.getElementsByTagName("*").length,
      wholeDocument: await median(() => document.documentElement.classList.add("__restyle"), () => document.documentElement.classList.remove("__restyle")),
      bodyPointerEventsNone: await median(() => (document.body.style.pointerEvents = "none"), () => (document.body.style.pointerEvents = "")),
      bodyScrollLock: await median(
        () => { lock = document.createElement("style"); lock.textContent = ${JSON.stringify(SCROLL_LOCK_CSS)}; document.head.append(lock); document.body.setAttribute("data-scroll-locked", "1"); },
        () => { document.body.removeAttribute("data-scroll-locked"); lock.remove(); },
      ),
    };
  })()`);
  console.log(`${out.elements} elements; median ms of the slower direction:`);
  for (const [k, v] of Object.entries(out)) if (k !== "elements") console.log(`  ${k.padEnd(22)} ${v}ms`);
  console.log("wholeDocument is the price of anything that restyles everything; the body rows should be far below it.");
  return Math.max(out.bodyPointerEventsNone, out.bodyScrollLock);
}

async function modal(page, [label = "More options"]) {
  const events = [];
  page.listeners.add((msg) => {
    if (msg.method === "Tracing.dataCollected") events.push(...msg.params.value);
  });
  let done;
  const complete = new Promise((r) => (done = r));
  page.listeners.add((msg) => msg.method === "Tracing.tracingComplete" && done());
  await page.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] },
  });
  const opened = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = [...document.querySelectorAll("button[aria-haspopup]")].find((x) => x.getClientRects().length && x.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!b) return false;
    await sleep(300);
    b.click();
    await sleep(1500);
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(1500);
    return true;
  })()`);
  await page.send("Tracing.end");
  await complete;
  if (!opened) throw new Error(`no menu button labelled "${label}" on screen`);
  const open = new Map();
  const recalcs = [];
  for (const e of events.sort((a, b) => a.ts - b.ts)) {
    if (e.name !== "UpdateLayoutTree") continue;
    if (e.ph === "B") open.set(e.tid, e);
    else if (e.ph === "E" && open.has(e.tid)) {
      const b = open.get(e.tid);
      open.delete(e.tid);
      recalcs.push({ ms: (e.ts - b.ts) / 1000, elements: e.args?.elementCount ?? b.args?.elementCount });
    } else if (e.ph === "X") recalcs.push({ ms: e.dur / 1000, elements: e.args?.elementCount });
  }
  const big = recalcs.filter((r) => r.ms >= 5);
  console.log(`menu "${label}" open + close: ${recalcs.length} style recalcs, ${Math.round(recalcs.reduce((a, r) => a + r.ms, 0))}ms`);
  for (const r of big) console.log(`  ${r.ms.toFixed(1).padStart(7)}ms  ${r.elements ?? "?"} elements`);
  return Math.max(0, ...recalcs.map((r) => r.ms));
}

const page = await connect();
try {
  let worst;
  if (command === "switch") await switchChannels(page, rest);
  else if (command === "renders") await renders(page, rest);
  else if (command === "restyle") worst = await restyle(page);
  else if (command === "modal") worst = await modal(page, rest);
  else if (command === "eval") {
    const src = rest[0] && existsSync(rest[0]) ? readFileSync(rest[0], "utf8") : rest.join(" ");
    console.log(JSON.stringify(await page.evaluate(src), null, 1));
  } else {
    console.error("usage: webview-perf.mjs switch|renders|restyle|modal|eval … (see the header)");
    process.exitCode = 2;
  }
  if (MAX_MS !== undefined && worst !== undefined && worst > MAX_MS) {
    console.error(`FAIL: a restyle took ${Math.round(worst)}ms (> --max-ms ${MAX_MS})`);
    process.exitCode = 1;
  }
} finally {
  page.close();
}
