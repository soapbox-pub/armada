#!/usr/bin/env node
/**
 * Autonomous performance run: boots a PRODUCTION build of the real app in
 * headless Chromium, logged in as a throwaway key with a seeded DM history,
 * drives it through the situations users complain about, and writes what
 * `src/lib/perfRuntime.ts` and the browser measured.
 *
 *   npm run perf:profile                 # build + run every scenario
 *   node scripts/perf-profile.mjs --skip-build --idle 60
 *   node scripts/perf-profile.mjs --only idle-thread,switch
 *   node scripts/perf-profile.mjs --only concord-switch --cpu-profile   # + hot functions
 *   node scripts/perf-profile.mjs --react-timings   # per-component self ms (inflates CPU)
 *   node scripts/perf-profile.mjs --cpu-throttle 4   # the main thread N× slower, nearer a phone
 *
 * Scenarios (each a fresh page on the same seeded origin):
 *   dm-walk      a fresh account whose 3000 DMs are on its DM relay and none
 *                on disk: the DM list open, untouched, while the inbox scan and
 *                the background history walk read them (--walk-sec <s>, 90)
 *   landing      logged-out root, idle
 *   boot         cold load straight into the big DM thread
 *   idle-thread  the big thread open, nobody touching anything
 *   scroll       paging the big thread's history back to the top
 *   switch       hopping between conversations, with heap after forced GC
 *                between rounds (a leak is a rising floor, not a rising peak)
 *   concord-boot    cold load into a seeded community's 3000-message #general
 *   concord-idle    #general open, nobody touching anything
 *   concord-scroll  paging #general's history back
 *   concord-switch  hopping between the community's channels, heap per round
 *                   (--switch-rounds <n>, 4; --heap-snapshot diffs round 1 against the last)
 *   leak         the same tour of the app (DM threads, the DM list, channels,
 *                notifications, settings, a profile) round after round, with the
 *                heap/DOM/listener floor after a forced GC per round, a census of
 *                the query cache and module caches, and a heap-snapshot diff of
 *                round 2 against the last (`leak-diff.txt`: what grew, and what
 *                holds it). --leak-rounds <n> (10)
 *                   (--ranked seeds the community on the vsk-13 Roster, so the
 *                   owner's background Concord duties stay mounted)
 *   concord-type    composing in #general: per-keystroke cost to the next frame
 *   concord-type-touch  the same, phone-sized with touch emulation
 *   concord-walk    a community with only each channel's newest page on disk and
 *                   its whole history (7200 wraps) on the relay: #general open,
 *                   untouched, while the background history walk reads the rest
 *                   (--walk-sec <s>, 90). Reports how far it got and what it cost
 *   concord-many    many joined communities (--communities <n>, 20), each owned by
 *                   another key with a Guestbook of --members <n> (400) Joins, their
 *                   Control and Guestbook wraps on the relay: a cold boot and a warm
 *                   reload into one #general, measuring its paint and when the wire
 *                   first subscribes each community's chat (--window-sec <s>, 45).
 *                   --missed <n> (30) newer #general messages per community wait only
 *                   on the relay, sent during a two-hour absence the wire's cursor
 *                   predates: how soon the open channel shows them, and how many each
 *                   community has stored by the window's end. --later <n> (10) more
 *                   reach the relay between the cold boot and the warm reload, which
 *                   is measured the same way
 *   dm-many      the seeded account (40 conversations) back after 30 minutes away,
 *                20 DMs waiting on its two DM relays, one answering 3s late (and also
 *                one of its own relays, where it keeps no contact list): a cold boot into the DM list, then a
 *                warm reload into the thread 10 more arrived in while it was closed;
 *                when the list/thread paints and the newest DM shows (--window-sec, 30)
 *   routes       a boot into each page with no message timeline (notifications,
 *                settings, discover, invites, a profile): when the wire starts
 *   discover     /discover idle — the one scenario with real relay traffic
 *   discover-all /discover with "show all communities" on, scrolled 30 times
 *                so every page of listings loads and its cards mount
 *   live-switch  switching in and out of a REAL community, joined from an
 *                invite given as `--invite <url>` (or ARMADA_PERF_INVITE);
 *                skipped without one. Reads its real relays; every publish is
 *                still swallowed here. The invite carries the community's
 *                keys in its fragment, so it is never written to a report.
 *
 *   node scripts/perf-profile.mjs --skip-build --cpu-profile --only live-switch --invite 'https://armada.buzz/invite/naddr1…#…'
 *     --settle <sec>  how long to let the join sync before measuring (45)
 *     --rounds <n>    switch-ins measured (6)
 *     --boot-sec <s>  with `--only live-switch,live-boot`, then reload straight
 *                     into the community and measure the cold start (60)
 *     live-idle       with `--only …,live-idle`: then --idle seconds with the
 *                     community open and nothing touched
 *     --offline       after settling, answer every REQ locally: the switch cost
 *                     against what is on disk, with no history paging behind it
 *
 * Offline except `discover`: the seeds go straight into the app's own
 * ArmadaDB through the production writers (`e2e/screenshotSeed.ts`,
 * `e2e/concordSeed.ts`), and the throwaway account has no relays. The seeded
 * community names `wss://relay.invalid`, which the harness answers itself.
 * Nothing is ever published — the account is minted here and never signs
 * anything a relay keeps.
 *
 * Numbers are "CPU" in the sense Chromium's TaskDuration means it: main-thread
 * busy time over wall time. Headless, single-process (`--single-process`: see
 * playwright.config.ts for why some sandboxes need it), and on this machine's
 * cores — compare runs against each other, not against a phone.
 *
 * Output: `perf-reports/<scenario>.json` (full reports) and a summary on
 * stdout. `ARMADA_PERF_PUBLISH_LOG=1` also prints each swallowed publish with
 * its time and relay, to see a republish loop's cadence.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { formatDiff } from "./heap-diff.mjs";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19, nip44 } from "nostr-tools";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const IDLE_SEC = Number(opt("idle", "120"));
const INVITE = opt("invite", process.env.ARMADA_PERF_INVITE ?? "");
const ONLY = opt("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = 8282;
const ORIGIN = `http://localhost:${PORT}`;
// Outside `dist-perf/`, which every build empties.
const OUT = resolve(root, "perf-reports");
/** Messages in the seeded community's #general. */
const CONCORD_BIG = 3000;

const LIVE = ["live-switch", "live-boot", "live-idle", "account-hop"];
const wants = (name) => (ONLY.length === 0 && !LIVE.includes(name)) || ONLY.includes(name);

// ─── Build + serve ──────────────────────────────────────────────────────────

if (!flag("skip-build")) {
  console.log(`building (VITE_PROFILE=1${flag("react-timings") ? ", VITE_PROFILE_REACT=1" : ""}, vite.config.perf.ts)…`);
  const r = spawnSync("npx", ["vite", "build", "-l", "error", "-c", "vite.config.perf.ts"], {
    cwd: root,
    stdio: "inherit",
    // `--react-timings`: React's profiling build, for per-component self time.
    // Off by default — its render logging inflates CPU (see vite.config.ts).
    env: { ...process.env, VITE_PROFILE: "1", ...(flag("react-timings") ? { VITE_PROFILE_REACT: "1" } : {}) },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
mkdirSync(OUT, { recursive: true });

const server = spawn("npx", ["vite", "preview", "-c", "vite.config.perf.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // already gone
  }
};
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server never answered on ${ORIGIN}`);
}

// ─── The seeded world ───────────────────────────────────────────────────────

const nowSec = Math.floor(Date.now() / 1000);

function person(name) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: nip19.npubEncode(pubkey), name };
}

const LINES = [
  "did that invite link work for you?",
  "yeah im in",
  "ran 6 of us last night with screen share, no drops",
  "ok lets move raid night in there 👍",
  "bet. ill make a channel tonight",
  "check this out https://example.com/some/long/path?with=query",
  "lol",
  "can you send me the map file again, the last one was corrupted somewhere around the second floor",
  "**bold** and _italic_ and `code` all in one line",
  "> quoting what you said earlier\nand replying under it",
  "brb",
  "that emote pack goes hard",
];

/**
 * `peers` conversations; the first is the BIG thread (`bigThread` messages over
 * ~90 days), the rest a handful each. Every conversation has a message from me
 * so it lands in the inbox, not the request tier.
 */
function buildWorld({ peers: peerCount = 40, bigThread = 3000, small = 12 } = {}) {
  const me = person("perf-me");
  const peers = Array.from({ length: peerCount }, (_, i) => person(`peer${i}`));
  const profiles = [me, ...peers].map((p) => {
    const content = JSON.stringify({ name: p.name, about: `about ${p.name}` });
    const base = { pubkey: p.pubkey, kind: 0, created_at: nowSec - 86400 * 100, tags: [], content };
    return { rumorId: getEventHash(base), pubkey: p.pubkey, createdAt: base.created_at, content };
  });

  const messages = [];
  const dm = (author, other, content, createdAt) => {
    const tags = [["p", author === me ? other.pubkey : me.pubkey]];
    const base = { pubkey: author.pubkey, kind: 14, created_at: createdAt, tags, content };
    messages.push({
      rumorId: getEventHash(base),
      author: author.pubkey,
      peers: [other.pubkey],
      tags,
      content,
      createdAt,
      kind: 14,
    });
  };

  const span = 86400 * 90;
  for (let i = 0; i < bigThread; i++) {
    const author = i % 3 === 0 ? me : peers[0];
    dm(author, peers[0], `${LINES[i % LINES.length]} (#${i})`, nowSec - span + Math.floor((span * i) / bigThread));
  }
  peers.slice(1).forEach((p, pi) => {
    for (let i = 0; i < small; i++) {
      dm(i % 2 ? me : p, p, LINES[(i + pi) % LINES.length], nowSec - 86400 * (pi + 1) + i * 60);
    }
  });
  return { me, peers, payload: { self: me.pubkey, profiles, messages } };
}

// ─── Browser plumbing ───────────────────────────────────────────────────────

// ONE context and ONE page for the whole run: under `--single-process` a
// second browser context kills the browser. Scenarios are separated by full
// reloads instead, which is also what a cold start is.
// `--enable-precise-memory-info`: without it `performance.memory` is bucketed
// and cached, and the in-app heap samples read as a flat line.
const browser = await chromium.launch({
  args: [...(process.env.ARMADA_E2E_SINGLE_PROCESS ? ["--single-process"] : []), "--enable-precise-memory-info"],
});
// No service worker: chrome-headless-shell has no BadgeService binder, and the
// worker's `clearAppBadge()` gets the renderer killed for a bad IPC message.
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: ORIGIN, serviceWorkers: "block" });
const page = await context.newPage();
// `--reduced-motion`: the OS setting; `--app-reduce-motion`: the app's own switch.
if (flag("reduced-motion")) await page.emulateMedia({ reducedMotion: "reduce" });
if (flag("app-reduce-motion")) await context.addInitScript(() => localStorage.setItem("armada:reduce-motion", "1"));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("crash", () => errors.push("RENDERER CRASHED"));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
// Survives navigations within the page, so the warm reload is throttled too.
if (opt("cpu-throttle", "")) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(opt("cpu-throttle", "1")) });

/**
 * Nothing this run does may land on a relay. The throwaway account still
 * behaves like a real one — it syncs read state (kind 30078), registers for
 * push (25742), etc. — so every outbound EVENT is swallowed here and answered
 * with the OK a relay would send, which keeps the client's publish path (and
 * its cost) exactly as it is in the field. Reads pass through untouched.
 */
const swallowed = {};
const harnessStart = Date.now();
/**
 * Once set, every REQ is answered as an empty relay (like `.invalid` below):
 * `live-switch --offline` measures switching against what is already on disk,
 * with no history paging in behind it.
 */
let answerLocally = false;
/**
 * What the `.invalid` relay holds: empty except in `concord-walk`, which hands
 * it a community's whole chat history. Matched on ids/kinds/authors/since/
 * until/limit and single-letter tags, newest first.
 */
let fakeRelayEvents = [];
const fakeRelayReqs = { reqs: 0, events: 0 };
function fakeRelayAnswer(filters) {
  const out = new Map();
  for (const f of filters) {
    const tagFilters = Object.entries(f).filter(([k]) => k.startsWith("#"));
    let evs = fakeRelayEvents.filter(
      (e) =>
        tagFilters.every(([k, vals]) => e.tags.some((t) => t[0] === k.slice(1) && vals.includes(t[1]))) &&
        (!f.ids || f.ids.includes(e.id)) &&
        (!f.kinds || f.kinds.includes(e.kind)) &&
        (!f.authors || f.authors.includes(e.pubkey)) &&
        (f.since === undefined || e.created_at >= f.since) &&
        (f.until === undefined || e.created_at <= f.until),
    );
    evs.sort((a, b) => b.created_at - a.created_at);
    if (f.limit !== undefined) evs = evs.slice(0, f.limit);
    for (const e of evs) out.set(e.id, e);
  }
  return [...out.values()];
}
function notePublish(key, host) {
  swallowed[key] = (swallowed[key] ?? 0) + 1;
  if (process.env.ARMADA_PERF_PUBLISH_LOG) {
    console.log(`  publish +${((Date.now() - harnessStart) / 1000).toFixed(1)}s ${key} → ${host}`);
  }
}
// Publishes are swallowed IN the page, before they reach a socket. Routing a
// live relay's sockets through Playwright instead costs a CDP round trip per
// inbound frame, which a history walk's megabytes turn into most of the
// renderer's CPU — the harness measuring itself.
await page.exposeFunction("__armadaHarnessPublish", notePublish);
await context.addInitScript(() => {
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string" && data.startsWith('["EVENT"')) {
      try {
        const event = JSON.parse(data)[1];
        const d = event.tags?.find((t) => t[0] === "d")?.[1];
        window.__armadaHarnessPublish?.(d === undefined ? String(event.kind) : `${event.kind}:${d}`, new URL(this.url).host);
        const ok = JSON.stringify(["OK", event.id, true, ""]);
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: ok })), 0);
      } catch {
        // not an event: drop it all the same
      }
      return;
    }
    return send.call(this, data);
  };
});
// Only the `.invalid` relay is routed, unless `--offline` will answer every REQ.
const routed = flag("offline") ? /^wss?:\/\// : /^wss?:\/\/[^/]*\.invalid(?:[:/]|$)/;
await page.routeWebSocket(routed, (ws) => {
  // The seeded community names `wss://relay.invalid`: answer it here as an
  // empty relay (EOSE for every REQ) rather than dialing nothing and leaving
  // its reads to time out.
  const fake = /\.invalid(?:[:/]|$)/.test(new URL(ws.url()).hostname + "/");
  const server = fake ? null : ws.connectToServer();
  ws.onMessage((msg) => {
    if ((fake || answerLocally) && typeof msg === "string" && msg.startsWith('["REQ"')) {
      try {
        const [, sub, ...filters] = JSON.parse(msg);
        const events = fake && !answerLocally ? fakeRelayAnswer(filters) : [];
        fakeRelayReqs.reqs++;
        fakeRelayReqs.events += events.length;
        for (const e of events) ws.send(JSON.stringify(["EVENT", sub, e]));
        ws.send(JSON.stringify(["EOSE", sub]));
      } catch {
        // malformed REQ: nothing to answer
      }
      return;
    }
    if (typeof msg === "string" && msg.startsWith('["EVENT"')) {
      try {
        const event = JSON.parse(msg)[1];
        const d = event.tags?.find((t) => t[0] === "d")?.[1];
        notePublish(d === undefined ? String(event.kind) : `${event.kind}:${d}`, new URL(ws.url()).host);
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      } catch {
        return;
      }
    }
    server?.send(msg);
  });
  server?.onMessage((msg) => ws.send(msg));
});

// `concord-many`: when the page SENT each kind-1059 REQ, on the boot timeline's clock; the
// harness relay's own log lags whenever its answers are backed up. Registered after the
// route, so it wraps the WebSocket routed sockets are made of as well as the native one.
await context.addInitScript(() => {
  for (const proto of new Set([WebSocket.prototype, Object.getPrototypeOf(WebSocket.prototype)])) {
    const own = Object.getOwnPropertyDescriptor(proto, "send");
    if (!own || typeof own.value !== "function") continue;
    const send = own.value;
    proto.send = function (data) {
      if (typeof data === "string" && data.startsWith('["REQ"')) {
        try {
          const [, , ...filters] = JSON.parse(data);
          for (const f of filters) {
            if (f.kinds?.includes(1059) && f.authors) {
              (window.__armadaReqLog ??= []).push({ t: Math.round(performance.now()), live: f.limit === undefined, authors: f.authors });
            }
          }
        } catch {
          // not ours to judge
        }
      }
      return send.call(this, data);
    };
  }
});

/**
 * `concord-many`'s relay: every `*.invalid` socket is answered inside the page from the
 * events the harness serves at `/__armada-fake-relay.json` (fetched once per page load),
 * one message per task as a socket delivers them; publishes get an OK. Only while
 * `perf-inpage-relay` is set, so other scenarios keep the routed relay.
 */
function installInPageRelay() {
  if (localStorage.getItem("perf-inpage-relay") !== "1") return;
  const SLOW_MS = 3_000;
  const Native = window.WebSocket;
  let db;
  const load = () =>
    (db ??= fetch("/__armada-fake-relay.json")
      .then((r) => r.json())
      .then((events) => {
        const byAuthor = new Map();
        for (const e of events) {
          if (!byAuthor.has(e.pubkey)) byAuthor.set(e.pubkey, []);
          byAuthor.get(e.pubkey).push(e);
        }
        return { events, byAuthor };
      }));
  const answer = ({ events, byAuthor }, filters) => {
    const out = new Map();
    for (const f of filters) {
      const pool = f.authors ? f.authors.flatMap((a) => byAuthor.get(a) ?? []) : events;
      const tags = Object.entries(f).filter(([k]) => k.startsWith("#"));
      let evs = pool.filter(
        (e) =>
          (!f.ids || f.ids.includes(e.id)) &&
          (!f.kinds || f.kinds.includes(e.kind)) &&
          (f.since === undefined || e.created_at >= f.since) &&
          (f.until === undefined || e.created_at <= f.until) &&
          tags.every(([k, vals]) => e.tags.some((t) => t[0] === k.slice(1) && vals.includes(t[1]))),
      );
      evs.sort((a, b) => b.created_at - a.created_at);
      if (f.limit !== undefined) evs = evs.slice(0, f.limit);
      for (const e of evs) out.set(e.id, e);
    }
    return [...out.values()];
  };
  class InPageRelay extends EventTarget {
    constructor(url) {
      super();
      Object.assign(this, { url, readyState: 0, protocol: "", extensions: "", binaryType: "blob", bufferedAmount: 0 });
      Object.assign(this, { onopen: null, onmessage: null, onclose: null, onerror: null });
      void load().then(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.emit(new Event("open"));
      });
    }
    emit(ev) {
      this.dispatchEvent(ev);
      this[`on${ev.type}`]?.call(this, ev);
    }
    reply(msg) {
      // `slow.invalid` answers late, as a distant or loaded relay does.
      const delay = new URL(this.url).hostname.startsWith("slow.") ? SLOW_MS : 0;
      setTimeout(() => {
        if (this.readyState === 1) this.emit(new MessageEvent("message", { data: JSON.stringify(msg) }));
      }, delay);
    }
    send(data) {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg[0] === "REQ") {
        const [, sub, ...filters] = msg;
        for (const f of filters) {
          if (f.kinds?.includes(1059) && f.authors) {
            (window.__armadaReqLog ??= []).push({ t: Math.round(performance.now()), live: f.limit === undefined, authors: f.authors, since: f.since });
          }
        }
        void load().then((d) => {
          for (const e of answer(d, filters)) this.reply(["EVENT", sub, e]);
          this.reply(["EOSE", sub]);
        });
      } else if (msg[0] === "EVENT") {
        this.reply(["OK", msg[1].id, true, ""]);
      }
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      setTimeout(() => this.emit(new CloseEvent("close", { code, reason, wasClean: true })), 0);
    }
  }
  // From the document's start, as a real relay is up before anyone dials it.
  void load();
  for (const [k, v] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    InPageRelay[k] = v;
    InPageRelay.prototype[k] = v;
  }
  window.WebSocket = new Proxy(Native, {
    construct(target, args, newTarget) {
      try {
        if (new URL(String(args[0])).hostname.endsWith(".invalid")) return new InPageRelay(String(args[0]));
      } catch {
        // not a URL: the native constructor says so
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/**
 * `concord-many`: when text first appears in `<main>`, by a MutationObserver from the
 * document's start, so the time is the DOM change's own (polling over CDP, or a
 * watcher installed by `page.evaluate`, arrives late on a busy boot).
 */
function installWatch() {
  const raw = localStorage.getItem("perf-watch");
  if (!raw) return;
  const { paint, missed, root = "main" } = JSON.parse(raw);
  const seen = (window.__armadaSeen = {});
  const observer = new MutationObserver(() => {
    const text = document.querySelector(root)?.textContent;
    if (!text) return;
    const now = Math.round(performance.now());
    if (seen.paint === undefined && text.includes(paint)) seen.paint = now;
    if (missed && seen.missed === undefined && text.includes(missed)) seen.missed = now;
    // A message that leaves the view once shown is a flicker the reader sees.
    else if (missed && seen.missed !== undefined && !text.includes(missed) && seen.missedLost === undefined) seen.missedLost = now;
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
}

/** What the in-page relay serves (`/__armada-fake-relay.json`). */
let relayBody = "[]";
let inPageInstalled = false;
/** Install the in-page relay and the DOM watcher, once for the run; each acts only while its localStorage flag is set. */
async function installInPageScripts() {
  if (inPageInstalled) return;
  inPageInstalled = true;
  await page.route("**/__armada-fake-relay.json", (route) => route.fulfill({ contentType: "application/json", body: relayBody }));
  await context.addInitScript(installInPageRelay);
  await context.addInitScript(installWatch);
}

/** Errors raised since `mark` (an index into `errors`). */
const errorsSince = (mark) => errors.slice(mark);

/** Log `who` in as an nsec account, the way the login dialog leaves storage. */
async function login(who) {
  const loginJson = JSON.stringify([
    {
      id: `nsec:${who.pubkey}`,
      type: "nsec",
      pubkey: who.pubkey,
      createdAt: new Date().toISOString(),
      data: { nsec: nip19.nsecEncode(who.sk) },
    },
  ]);
  await page.evaluate(
    ([json, pk]) => {
      localStorage.setItem("armada:login", json);
      localStorage.setItem("armada:active-pubkey", pk);
      // Skip the one-time "restore your setup" interstitial (best-effort; the
      // scenarios also dismiss it whenever it shows).
      localStorage.setItem(`armada:relay-prompt-shown:${pk}`, "1");
    },
    [loginJson, who.pubkey],
  );
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

/** Heap after a forced full GC: the floor, which is what a leak raises. */
async function heapFloorMB(cdp) {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const m = await metrics(cdp);
  return Math.round((m.JSHeapUsedSize / 1048576) * 10) / 10;
}

/** A heap snapshot into `perf-reports/<name>`, for DevTools → Memory → load. */
async function writeHeapSnapshot(cdp, name) {
  const chunks = [];
  const onChunk = ({ chunk }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  writeFileSync(resolve(OUT, name), chunks.join(""));
}

/**
 * Everything a leak raises, after a forced GC: JS heap, DOM nodes, listeners,
 * and the page's own census (query cache and registered module caches).
 */
async function memoryFloor(cdp) {
  const heapMB = await heapFloorMB(cdp);
  const m = await metrics(cdp);
  const census = await page.evaluate(() => window.__armadaPerf.memory?.());
  return { heapMB, domNodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, census };
}

/** Least-squares slope of `ys` per step: growth per round, robust to one noisy round. */
function slope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return Math.round((num / den) * 1000) / 1000;
}

/** Per census line, first → last value, for the lines that moved. */
function censusGrowth(first, last) {
  const out = {};
  const pairs = (c) => ({
    ...Object.fromEntries((c?.queries ?? []).map((q) => [`query ${q.family}`, q.queries])),
    ...Object.fromEntries((c?.queries ?? []).map((q) => [`queryKB ${q.family}`, q.dataKB])),
    ...Object.fromEntries(Object.entries(c?.probes ?? {}).map(([k, v]) => [`probe ${k}`, v])),
    "queries (all)": c?.queryTotals?.queries ?? 0,
    "queries unobserved": c?.queryTotals?.unobserved ?? 0,
    "query data KB": c?.queryTotals?.dataKB ?? 0,
    "live intervals": c?.liveIntervals ?? 0,
    "open sockets": c?.openSockets ?? 0,
  });
  const a = pairs(first);
  const b = pairs(last);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((b[k] ?? 0) !== (a[k] ?? 0)) out[k] = `${a[k] ?? 0} → ${b[k] ?? 0}`;
  }
  return Object.fromEntries(Object.entries(out).sort((x, y) => {
    const d = (s) => { const [p, q] = s.split(" → ").map(Number); return q - p; };
    return d(y[1]) - d(x[1]);
  }));
}

/** Diff two snapshots in a child (they parse to GBs), writing `<name>.txt` and returning the parsed diff. */
function runHeapDiff(early, late, name) {
  const json = resolve(OUT, `${name}.json`);
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", resolve(root, "scripts/heap-diff.mjs"), resolve(OUT, early), resolve(OUT, late), "--json", json], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return { error: (r.stderr || "").slice(-2000) };
  writeFileSync(resolve(OUT, `${name}.txt`), r.stdout);
  return JSON.parse(readFileSync(json, "utf8"));
}

/** Main-thread cost between two metric snapshots, as a share of wall time. */
function cost(a, b, wallSec) {
  const pct = (k) => Math.round(((b[k] - a[k]) / wallSec) * 1000) / 10;
  return {
    wallSec: Math.round(wallSec),
    cpuPct: pct("TaskDuration"),
    scriptPct: pct("ScriptDuration"),
    layoutPct: pct("LayoutDuration"),
    stylePct: pct("RecalcStyleDuration"),
    layouts: b.LayoutCount - a.LayoutCount,
    styleRecalcs: b.RecalcStyleCount - a.RecalcStyleCount,
    heapMB: Math.round((b.JSHeapUsedSize / 1048576) * 10) / 10,
    domNodes: b.Nodes,
    listeners: b.JSEventListeners,
  };
}

/** Dismiss the "restore your setup" interstitial whenever it shows. */
async function dismissRestore(page) {
  const skip = page.getByText("Skip for now");
  if (await skip.isVisible().catch(() => false)) {
    await skip.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function until(page, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissRestore(page);
    if (await predicate().catch(() => false)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

const perfReady = (page) => page.waitForFunction(() => window.__armadaPerf?.json, null, { timeout: 60_000 });
const report = async (page) => JSON.parse(await page.evaluate(() => window.__armadaPerf.json()));
const resetCounters = (page) => page.evaluate(() => window.__armadaPerf.reset());

/**
 * CPU seconds (user + system) of the browser and every descendant, by
 * Chromium `--type=` (renderer, gpu-process, utility, browser). Linux only;
 * null elsewhere. Unlike TaskDuration this includes raster, compositing and
 * GPU work, which is where animated media costs on a machine without a GPU.
 */
function processCpuSec() {
  // Playwright spawns Chromium as our child; the preview server is one too, so
  // only Chromium binaries are counted.
  const rootPid = process.pid;
  if (process.platform !== "linux") return null;
  const procs = new Map();
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces/parens: fields resume after the last ")".
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const type = /--type=([\w-]+)/.exec(cmd)?.[1] ?? "browser";
      const chrome = /chrom/i.test(cmd.split("\0")[0]);
      procs.set(Number(pid), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), type, chrome });
    } catch {
      // exited mid-walk
    }
  }
  const inTree = (pid) => {
    for (let p = pid, n = 0; p > 1 && n < 64; p = procs.get(p)?.ppid ?? 0, n++) if (p === rootPid) return true;
    return false;
  };
  const byType = {};
  for (const [pid, p] of procs) if (p.chrome && pid !== rootPid && inTree(pid)) byType[p.type] = (byType[p.type] ?? 0) + p.ticks / 100;
  return byType;
}

/** Per process type, CPU between two `processCpuSec()` readings as % of one core. */
function processCost(a, b, wallSec) {
  if (!a || !b) return undefined;
  const out = {};
  let total = 0;
  for (const k of Object.keys(b)) {
    const d = b[k] - (a[k] ?? 0);
    total += d;
    out[k] = Math.round((d / wallSec) * 1000) / 10;
  }
  return { totalPct: Math.round((total / wallSec) * 1000) / 10, ...out };
}

/** Measure `seconds` of whatever the page is doing, with fresh counters. */
async function measureIdle(page, cdp, seconds) {
  await resetCounters(page);
  const a = await metrics(cdp);
  const pa = processCpuSec();
  const t = Date.now();
  // Whole-process CPU per 30s slice: shows whether background work winds down.
  const series = [];
  let prev = pa;
  for (let left = seconds * 1000; left > 0; left -= 30_000) {
    const step = Math.min(30_000, left);
    await page.waitForTimeout(step);
    const now = processCpuSec();
    series.push(processCost(prev, now, step / 1000)?.totalPct);
    prev = now;
  }
  const b = await metrics(cdp);
  const wall = (Date.now() - t) / 1000;
  return { ...cost(a, b, wall), processPct: processCost(pa, processCpuSec(), wall), processPctPer30s: series, heapFloorMB: await heapFloorMB(cdp) };
}

/** Router navigation without a reload: what clicking a conversation does. */
const softNavigate = (page, path) =>
  page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

const results = {};

function save(name, data) {
  // Publishes the client attempted during this scenario (all swallowed).
  data = { ...data, published: { ...swallowed } };
  for (const k of Object.keys(swallowed)) delete swallowed[k];
  results[name] = data;
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

/** The parts of a runtime report worth reading in a summary. */
function digest(r) {
  const rt = r.runtime;
  return {
    longFrames: `${rt.frames.count} (${rt.frames.totalMs}ms, blocking ${rt.frames.blockingMs}ms, max ${rt.frames.maxMs}ms)`,
    commitsPerMin: rt.react.commitsPerMin,
    topRenders: rt.react.components.slice(0, 8).map((c) => `${c.name} ×${c.renders + c.mounts} (${c.selfMs}ms)${c.why ? ` why: ${c.why}` : ""}`),
    topScripts: rt.frames.scripts.slice(0, 5).map((s) => `${s.totalMs}ms ×${s.count} ${s.site}`),
    timers: `setTimeout ${rt.timers.setTimeoutPerSec}/s, rAF ${rt.timers.rafPerSec}/s, ${rt.timers.liveIntervals.length} live intervals`,
    busyIntervals: rt.timers.liveIntervals
      .filter((i) => i.fires > 0 && i.ms < 5000)
      .slice(0, 6)
      .map((i) => `${i.ms}ms ×${i.fires} ${i.site}`),
    rafSites: rt.timers.rafSites.slice(0, 3).map((s) => `~${s.estCalls} ${s.site}`),
    timeoutSites: rt.timers.timeoutSites.slice(0, 5).map((s) => `~${s.estCalls} ${s.site}`),
    animations: rt.animations.map((a) => `${a.name} ×${a.count} on ${a.target}`),
    relays: rt.relays.slice(0, 6).map(
      (x) => `${x.url} open=${x.open}/${x.opened} subs=${x.liveSubs} (peak ${x.peakSubs}) reqs=${x.reqs} ev=${x.events} in=${Math.round(x.bytesIn / 1024)}KB`,
    ),
    reqShapes: rt.reqShapes.slice(0, 6).map((s) => `${s.reqs} REQ, ${s.events} ev: ${s.shape}`),
    queries: (rt.queries ?? []).slice(0, 8).map((q) => `${q.fetches} fetch / ${q.updates} update / ${q.observers} obs: ${q.family}`),
    topStorage: r.boot.aggregates.slice(0, 6).map((a) => `${Math.round(a.total)}ms ×${a.count} ${a.label}`),
  };
}

/**
 * Sampling CPU profile of `fn`, reduced to the top self-time functions
 * (name + file:line, names kept by the profile build). `--cpu-profile` only:
 * the sampler's own overhead would skew every other number in the run.
 */
async function cpuProfile(name, fn) {
  if (!flag("cpu-profile")) return { result: await fn(), hot: undefined };
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const result = await fn();
  const { profile } = await cdp.send("Profiler.stop");
  // The raw profile too, for call trees (DevTools → Performance → load).
  writeFileSync(resolve(OUT, `${name}.cpuprofile`), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const self = new Map();
  for (const [id, us] of dt) {
    const { functionName, url, lineNumber, columnNumber } = byId.get(id).callFrame;
    // The hashed name and column are kept so a site resolves through the
    // build's sourcemaps (`dist-perf/assets/*.map`): a minified chunk is line 1.
    const file = url.replace(/^.*\/assets\//, "");
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber + 1}:${columnNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const hot = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([fn, us]) => `${Math.round(us / 1000)}ms ${fn}`);
  return { result, hot };
}

/**
 * Where the page's event listeners are: per event type, and per element (tag
 * + first class) for the heaviest holders. Uses the DevTools command-line
 * `getEventListeners`, so it walks every element — harness-only, and run
 * after a scenario's measurement, never inside one.
 */
async function listenerCensus() {
  const { result } = await cdp.send("Runtime.evaluate", {
    includeCommandLineAPI: true,
    returnByValue: true,
    expression: `(() => {
      const byType = {}, byElement = {};
      let total = 0;
      const targets = [window, document, ...document.querySelectorAll("*")];
      for (const el of targets) {
        const ls = getEventListeners(el);
        let n = 0;
        for (const [type, list] of Object.entries(ls)) { byType[type] = (byType[type] || 0) + list.length; n += list.length; }
        if (!n) continue;
        total += n;
        const name = el === window ? "window" : el === document ? "document" : el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : "");
        byElement[name] = (byElement[name] || 0) + n;
      }
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 12);
      return { total, byType: top(byType), byElement: top(byElement) };
    })()`,
  });
  // JSEventListeners also counts non-DOM targets (AbortSignals, IDB requests,
  // media queries) that no census can enumerate; after a full GC, what remains
  // is held, not garbage.
  await heapFloorMB(cdp);
  return { ...result.value, jsListenersAfterGc: (await metrics(cdp)).JSEventListeners };
}

/**
 * Scroll the open timeline to its top 40 times, 750ms apart — each one asks it
 * for older history. Returns the rendered row count after each step.
 */
async function scrollBack() {
  const steps = [];
  for (let i = 0; i < 40; i++) {
    const rows = await page.evaluate(() => {
      const row = document.querySelector("[data-scroll-anchor]");
      let el = row?.parentElement ?? null;
      while (el && !(el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) {
        el = el.parentElement;
      }
      if (!el) return null;
      el.scrollTop = 0;
      return document.querySelectorAll("[data-scroll-anchor]").length;
    });
    steps.push(rows);
    await page.waitForTimeout(750);
  }
  return steps;
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

await waitForServer();
const world = buildWorld();
const big = world.peers[0];

const lastBig = `${LINES[(3000 - 1) % LINES.length]} (#2999)`;
const bigVisible = () => page.getByText(lastBig, { exact: false }).last().isVisible();

try {
  if (wants("landing")) {
    console.log(`\n▶ landing (logged out, ${IDLE_SEC}s idle)`);
    const mark = errors.length;
    await page.goto("/");
    await perfReady(page);
    await page.waitForTimeout(5000);
    const idle = await measureIdle(page, cdp, IDLE_SEC);
    save("landing", { idle, errors: errorsSince(mark), report: await report(page) });
  }

  if (wants("account-hop")) {
    // A real account (ARMADA_PERF_NSEC, never read from a file here) hopping between two
    // of its rail communities, named by --hop-names "A,B". Publishes are swallowed in the
    // page like every scenario's, and the context is ephemeral.
    const secret = process.env.ARMADA_PERF_NSEC ?? "";
    const names = opt("hop-names", "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!secret || names.length < 2) {
      console.log("\n▶ account-hop skipped: set ARMADA_PERF_NSEC and pass --hop-names 'A,B'");
    } else {
      const sk = secret.startsWith("nsec1") ? nip19.decode(secret).data : Uint8Array.from(Buffer.from(secret, "hex"));
      const who = { sk, pubkey: getPublicKey(sk) };
      console.log(`\n▶ account-hop as ${nip19.npubEncode(who.pubkey).slice(0, 16)}… between ${names.join(" ↔ ")}`);
      const mark = errors.length;
      await page.goto("/");
      await login(who);
      await page.goto("/");
      await perfReady(page);
      const settleSec = Number(opt("settle", "60"));
      console.log(`  settling ${settleSec}s (first sync of the account)`);
      await page.waitForTimeout(settleSec * 1000);
      const railButton = (name) => page.locator(`[aria-label="${name.replace(/"/g, '\\"')}"]`).first();
      /** Click a rail community; ms until its own timeline rows paint, and the long tasks meanwhile. */
      const hop = (name) =>
        page.evaluate((label) => new Promise((done) => {
          const before = location.pathname;
          const busy = [];
          const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) busy.push(Math.round(e.duration)); });
          obs.observe({ type: "longtask" });
          const target = document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
          const start = performance.now();
          target?.click();
          let shown = -1;
          const check = () => {
            const now = performance.now();
            const moved = location.pathname !== before;
            if (shown < 0 && moved && document.querySelector("main [data-scroll-anchor]")) shown = Math.round(now - start);
            if ((shown >= 0 && now - start > shown + 1500) || now - start > 20_000) {
              obs.disconnect();
              done({ to: label, path: location.pathname.slice(0, 12), shownMs: shown, busyMs: busy.reduce((a, b) => a + b, 0), longTasks: busy.length, maxTaskMs: Math.max(0, ...busy) });
            } else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }), name);
      for (const name of names) {
        if (!(await railButton(name).count())) console.log(`  ⚠ no rail item labelled "${name}"`);
      }
      // One untimed round, so both are mounted once as a member would have them.
      for (const name of names) {
        await hop(name);
        await page.waitForTimeout(3000);
      }
      await resetCounters(page);
      await page.evaluate(() => window.__armadaPerf?.renders?.(true));
      const a = await metrics(cdp);
      const t = Date.now();
      const rounds = Number(opt("rounds", "4"));
      const hops = [];
      const { hot } = await cpuProfile("account-hop", async () => {
        for (let r = 0; r < rounds; r++) {
          for (const name of names) {
            hops.push(await hop(name));
            await page.waitForTimeout(2500);
          }
        }
      });
      const b = await metrics(cdp);
      for (const h of hops) console.log(`  → ${h.to}: shown ${h.shownMs}ms, long tasks ${h.busyMs}ms (${h.longTasks}, max ${h.maxTaskMs})`);
      save("account-hop", { hops, hot, cost: cost(a, b, (Date.now() - t) / 1000), errors: errorsSince(mark), report: await report(page) });
      // Nothing of this account outlives the scenario on this origin.
      await page.evaluate(() => localStorage.clear());
    }
  }

  // Seed through the production writers, on the app's own origin.
  await page.goto("/e2e/screenshotSeed.html");
  await login(world.me);
  await page.waitForFunction(() => Boolean(window.__armadaSeed), null, { timeout: 60_000 });
  const seedStart = Date.now();
  await page.evaluate((p) => window.__armadaSeed(p), world.payload);
  console.log(`\nseeded ${world.payload.messages.length} DMs across ${world.peers.length} conversations in ${Date.now() - seedStart}ms`);

  if (wants("boot") || wants("idle-thread") || wants("scroll")) {
    console.log("\n▶ boot (cold load into the big thread)");
    let mark = errors.length;
    const t0 = Date.now();
    await page.goto(`/dm/${big.npub}`);
    const painted = await until(page, bigVisible, 90_000);
    const bootMs = Date.now() - t0;
    await perfReady(page);
    save("boot", { bootMs, painted, errors: errorsSince(mark), report: await report(page) });

    if (wants("idle-thread")) {
      console.log(`▶ idle-thread (${IDLE_SEC}s)`);
      mark = errors.length;
      await page.waitForTimeout(5000);
      const idle = await measureIdle(page, cdp, IDLE_SEC);
      save("idle-thread", { idle, errors: errorsSince(mark), report: await report(page) });
    }

    if (wants("scroll")) {
      console.log("▶ scroll (page the big thread back)");
      mark = errors.length;
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const { result: steps, hot } = await cpuProfile("scroll", scrollBack);
      const b = await metrics(cdp);
      const reachedFirst = await page.getByText("(#0)", { exact: false }).count();
      save("scroll", {
        hot,
        scroll: cost(a, b, (Date.now() - t) / 1000),
        renderedRowsPerStep: steps,
        reachedFirstMessage: reachedFirst > 0,
        errors: errorsSince(mark),
        report: await report(page),
      });
    }
  }

  if (wants("switch")) {
    console.log("\n▶ switch (conversation hopping, heap floor per round)");
    const mark = errors.length;
    await page.goto("/dm");
    await until(page, () => page.getByText("peer1", { exact: true }).first().isVisible(), 90_000);
    await perfReady(page);
    await page.waitForTimeout(3000);
    const floors = [await heapFloorMB(cdp)];
    await resetCounters(page);
    const a = await metrics(cdp);
    const t = Date.now();
    const targets = world.peers.slice(0, 15);
    const { hot } = await cpuProfile("switch", async () => {
      for (let round = 0; round < 4; round++) {
        for (const p of targets) {
          await softNavigate(page, `/dm/${p.npub}`);
          await page.waitForTimeout(600);
        }
        floors.push(await heapFloorMB(cdp));
      }
    });
    const b = await metrics(cdp);
    save("switch", {
      hot,
      switches: targets.length * 4,
      cost: cost(a, b, (Date.now() - t) / 1000),
      heapFloorMBPerRound: floors,
      errors: errorsSince(mark),
      report: await report(page),
    });
  }

  const concordScenarios = ["concord-boot", "concord-idle", "concord-scroll", "concord-switch", "concord-type", "concord-type-touch", "leak"];
  if (concordScenarios.some(wants)) {
    // Seed a community: a 3000-message #general and seven small channels.
    await page.goto("/e2e/concordSeed.html");
    await page.waitForFunction(() => Boolean(window.__armadaSeedConcord), null, { timeout: 60_000 });
    const seedAt = Date.now();
    const concord = await page.evaluate(
      (p) => window.__armadaSeedConcord(p),
      {
        sk: Buffer.from(world.me.sk).toString("hex"),
        others: world.peers.slice(0, 8).map((p) => p.pubkey),
        channelSizes: [CONCORD_BIG, 60, 60, 60, 60, 60, 60, 60],
        lines: LINES,
        ranked: process.argv.includes("--ranked"),
      },
    );
    console.log(`\nseeded community ${concord.communityId.slice(0, 8)}… (${CONCORD_BIG} + 7×60 messages) in ${Date.now() - seedAt}ms`);
    const channelPath = (i) => `/c/${concord.communityId}/${concord.channelIds[i]}`;
    const lastGeneral = `${LINES[(CONCORD_BIG - 1) % LINES.length]} (#${CONCORD_BIG - 1})`;
    const generalVisible = () => page.getByText(lastGeneral, { exact: false }).last().isVisible();

    console.log("\n▶ concord-boot (cold load into #general)");
    let mark = errors.length;
    const t0 = Date.now();
    await page.goto(channelPath(0));
    const painted = await until(page, generalVisible, 90_000);
    const bootMs = Date.now() - t0;
    await perfReady(page);
    // Sanity-check a lazily built control still works: the first avatar's
    // profile card must open on its first click.
    const profileCardOpens = await (async () => {
      const avatar = page.locator('[data-scroll-anchor] button[aria-haspopup="dialog"]').last();
      if (!(await avatar.count())) return false;
      await avatar.click({ timeout: 5000 }).catch(() => undefined);
      const opened = await page.locator('[role="dialog"]').first().isVisible({ timeout: 3000 }).catch(() => false);
      await page.keyboard.press("Escape");
      return opened;
    })();
    const coldReport = await report(page);
    // Warm: the same channel reloaded, as every launch after the first opens it, from its snapshot.
    const t1 = Date.now();
    const { result: warmPainted, hot: warmHot } = await cpuProfile("concord-boot-warm", async () => {
      await page.goto(channelPath(0));
      return until(page, generalVisible, 90_000);
    });
    const warmBootMs = Date.now() - t1;
    await perfReady(page);
    // When each script arrived on the warm load: a chunk fetched late holds the first paint behind it.
    const warmScripts = await page.evaluate(() =>
      performance.getEntriesByType("resource")
        .filter((e) => e.name.endsWith(".js"))
        .map((e) => ({ name: e.name.replace(/^.*\/assets\//, ""), start: Math.round(e.startTime), end: Math.round(e.responseEnd), kb: Math.round(e.decodedBodySize / 1024) }))
        .sort((a, b) => a.start - b.start),
    );
    save("concord-boot", { bootMs, painted, warmBootMs, warmPainted, warmHot, warmScripts, profileCardOpens, errors: errorsSince(mark), report: coldReport, warmReport: await report(page) });

    if (wants("concord-idle")) {
      console.log(`▶ concord-idle (${IDLE_SEC}s)`);
      mark = errors.length;
      await page.waitForTimeout(5000);
      const idle = await measureIdle(page, cdp, IDLE_SEC);
      save("concord-idle", { idle, errors: errorsSince(mark), report: await report(page) });
    }

    if (wants("concord-scroll")) {
      console.log("▶ concord-scroll (page #general back)");
      mark = errors.length;
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const { result: steps, hot } = await cpuProfile("concord-scroll", scrollBack);
      const b = await metrics(cdp);
      const reachedFirst = await page.getByText("(#0)", { exact: false }).count();
      save("concord-scroll", {
        hot,
        scroll: cost(a, b, (Date.now() - t) / 1000),
        renderedRowsPerStep: steps,
        reachedFirstMessage: reachedFirst > 0,
        listeners: await listenerCensus(),
        errors: errorsSince(mark),
        report: await report(page),
      });
    }

    if (wants("concord-switch")) {
      console.log("▶ concord-switch (channel hopping, heap floor per round)");
      mark = errors.length;
      await page.goto(channelPath(1));
      await until(page, () => page.getByText("(#59)", { exact: false }).first().isVisible(), 90_000);
      await page.waitForTimeout(3000);
      const floors = [await heapFloorMB(cdp)];
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const rounds = Number(opt("switch-rounds", "4"));
      const { hot } = await cpuProfile("concord-switch", async () => {
        for (let round = 0; round < rounds; round++) {
          for (let i = 1; i < concord.channelIds.length; i++) {
            await softNavigate(page, channelPath(i));
            await page.waitForTimeout(600);
          }
          floors.push(await heapFloorMB(cdp));
          // With --heap-snapshot: an early and a final snapshot, to diff what the rounds retained.
          if (flag("heap-snapshot") && (round === 1 || round === rounds - 1)) {
            await writeHeapSnapshot(cdp, `concord-switch-r${round}.heapsnapshot`);
          }
        }
      });
      const b = await metrics(cdp);
      save("concord-switch", {
        hot,
        switches: (concord.channelIds.length - 1) * rounds,
        cost: cost(a, b, (Date.now() - t) / 1000),
        heapFloorMBPerRound: floors,
        errors: errorsSince(mark),
        report: await report(page),
      });
    }

    for (const touch of [false, true]) {
      const name = touch ? "concord-type-touch" : "concord-type";
      if (!wants(name)) continue;
      console.log(`▶ ${name} (composing in #general${touch ? ", phone-sized with touch" : ""})`);
      mark = errors.length;
      if (touch) {
        await page.setViewportSize({ width: 412, height: 915 });
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      }
      await page.goto(channelPath(0));
      await until(page, generalVisible, 90_000);
      await page.waitForTimeout(3000);
      const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
      const box = page.locator("main textarea:visible").first();
      await box.click();
      // Keydown → the first task after the next frame: what a keystroke costs
      // the reader, layout included.
      await page.evaluate(() => {
        window.__keyMs = [];
        addEventListener("keydown", (e) => {
          const t0 = e.timeStamp;
          requestAnimationFrame(() => setTimeout(() => window.__keyMs.push(performance.now() - t0)));
        }, true);
      });
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      let keys = 0;
      /** Whether the long message moved the field onto its own full-width row. */
      let fullWidth = false;
      const { hot } = await cpuProfile(name, async () => {
        for (let round = 0; round < 3; round++) {
          // Long enough to wrap several lines on a phone; edits mid-message
          // take the composer's full re-measure path.
          const text = LINES.slice(0, 6).join(" ");
          await box.pressSequentially(text, { delay: 25 });
          if (round === 0) fullWidth = await box.evaluate((el) => el.parentElement.classList.contains("basis-full"));
          for (let i = 0; i < 40; i++) await page.keyboard.press("Backspace", { delay: 25 });
          await box.pressSequentially(LINES[7], { delay: 25 });
          await page.keyboard.press("ControlOrMeta+a");
          await page.keyboard.press("Backspace");
          keys += text.length + 40 + LINES[7].length + 2;
        }
      });
      const b = await metrics(cdp);
      const ms = (await page.evaluate(() => window.__keyMs)).sort((x, y) => x - y);
      const at = (q) => Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] * 10) / 10;
      save(name, {
        hot,
        coarsePointer: coarse,
        fullWidth,
        keys,
        keyToFrameMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) },
        perKey: {
          taskMs: Math.round(((b.TaskDuration - a.TaskDuration) / keys) * 1e4) / 10,
          scriptMs: Math.round(((b.ScriptDuration - a.ScriptDuration) / keys) * 1e4) / 10,
          layoutMs: Math.round(((b.LayoutDuration - a.LayoutDuration) / keys) * 1e4) / 10,
          styleMs: Math.round(((b.RecalcStyleDuration - a.RecalcStyleDuration) / keys) * 1e4) / 10,
          layouts: Math.round(((b.LayoutCount - a.LayoutCount) / keys) * 100) / 100,
        },
        cost: cost(a, b, (Date.now() - t) / 1000),
        errors: errorsSince(mark),
        report: await report(page),
      });
      if (touch) {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    }

    if (wants("leak")) {
      const rounds = Math.max(3, Number(opt("leak-rounds", "10")));
      console.log(`▶ leak (${rounds} rounds of the same tour, floor per round)`);
      mark = errors.length;
      const tour = [
        `/dm/${big.npub}`,
        ...world.peers.slice(1, 4).map((p) => `/dm/${p.npub}`),
        "/dm",
        ...[0, 1, 2, 3].map(channelPath),
        "/notifications",
        "/settings",
        `/${world.peers[1].npub}`,
      ];
      await page.goto(tour[0]);
      await until(page, bigVisible, 90_000);
      await page.waitForTimeout(3000);
      const floors = [];
      const t = Date.now();
      const a = await metrics(cdp);
      for (let round = 0; round < rounds; round++) {
        for (const path of tour) {
          await softNavigate(page, path);
          await page.waitForTimeout(700);
          await dismissRestore(page);
        }
        // Back to the same place every round, so every floor measures one state.
        await softNavigate(page, tour[0]);
        await page.waitForTimeout(1500);
        // The profiler's own per-window counters are measurement, not the app.
        await resetCounters(page);
        floors.push(await memoryFloor(cdp));
        // Round 1 is still warming (lazy chunks, first-open caches): diff from round 2.
        if (flag("no-heap-snapshot")) continue;
        if (round === 1) await writeHeapSnapshot(cdp, "leak-early.heapsnapshot");
        if (round === rounds - 1) await writeHeapSnapshot(cdp, "leak-late.heapsnapshot");
      }
      const b = await metrics(cdp);
      const warm = floors.slice(1);
      const diff = flag("no-heap-snapshot") ? undefined : runHeapDiff("leak-early.heapsnapshot", "leak-late.heapsnapshot", "leak-diff");
      save("leak", {
        rounds,
        tour: tour.length,
        cost: cost(a, b, (Date.now() - t) / 1000),
        perRound: {
          heapMB: slope(warm.map((f) => f.heapMB)),
          domNodes: slope(warm.map((f) => f.domNodes)),
          listeners: slope(warm.map((f) => f.listeners)),
        },
        heapFloorMB: floors.map((f) => f.heapMB),
        domNodes: floors.map((f) => f.domNodes),
        listeners: floors.map((f) => f.listeners),
        documents: floors.map((f) => f.documents),
        censusGrowth: censusGrowth(floors[1]?.census, floors.at(-1)?.census),
        census: floors.at(-1)?.census,
        heapDiff: diff && {
          error: diff.error,
          heapMB: diff.heapMB,
          detachedNodes: diff.detachedNodes,
          growers: diff.growers?.filter((g) => !g.profiler && !g.devtools).slice(0, 10).map((g) => `+${g.entriesAdded} ${g.owner || "?"} (${g.object})`),
          newByClass: diff.newByClass?.slice(0, 10).map((c) => `${Math.round(c.bytes / 1024)}KB ×${c.count} ${c.class}`),
        },
        errors: errorsSince(mark),
        report: await report(page),
      });
      if (diff && !diff.error) console.log(`\n${formatDiff(diff).split("\n").slice(0, 60).join("\n")}\n(full: perf-reports/leak-diff.txt)`);
    }
  }


  if (wants("concord-many") || wants("concord-hop")) {
    // Many joined communities with real Guestbooks: how long a boot takes to paint
    // the open channel, and to subscribe every community's chat on the wire.
    const MANY = Number(opt("communities", "20"));
    const MEMBERS = Number(opt("members", "400"));
    const WINDOW_SEC = Number(opt("window-sec", "45"));
    const MISSED = Number(opt("missed", "30"));
    const LATER = Number(opt("later", "10"));
    await installInPageScripts();
    // The `.invalid` relay answers inside the page here (see installInPageRelay): through
    // the routed socket every frame is a CDP round trip, and a few thousand Guestbook
    // wraps back up everything behind them, the app's catch-up included, by seconds.
    relayBody = "[]";
    await page.goto("/e2e/concordSeed.html");
    await page.evaluate(() => localStorage.setItem("perf-inpage-relay", "1"));
    await page.waitForFunction(() => Boolean(window.__armadaSeedConcordMany), null, { timeout: 60_000 });
    const seedAt = Date.now();
    const many = await page.evaluate((p) => window.__armadaSeedConcordMany(p), {
      sk: Buffer.from(world.me.sk).toString("hex"),
      communities: MANY,
      members: MEMBERS,
      messages: 200,
      missed: MISSED,
      later: LATER,
      awaySecs: 7200,
      lines: LINES,
    });
    relayBody = JSON.stringify(many.wraps);
    console.log(`\nseeded ${MANY} communities × ${MEMBERS} members (${many.wraps.length} wraps on the relay) in ${Date.now() - seedAt}ms`);
    const first = many.communities[0];

    const bootOnce = async (label, newestMissed) => {
      console.log(`▶ concord-many ${label}`);
      const mark = errors.length;
      const t0 = Date.now();
      // Watched from the new document's start (installWatch), on the boot timeline's clock.
      await page.evaluate((needles) => localStorage.setItem("perf-watch", JSON.stringify(needles)), { paint: "(#c0-", missed: newestMissed ?? "" });
      await page.goto(`/c/${first.communityId}/${first.channelIds[0]}`, { waitUntil: "commit" });
      const painted = await page.waitForFunction(() => window.__armadaSeen?.paint !== undefined, null, { timeout: 90_000 }).then(() => true, () => false);
      // What storage had done by first paint: whatever the first rows queued behind.
      const atPaint = painted
        ? await page.evaluate(() => {
            const r = JSON.parse(window.__armadaPerf?.json?.() ?? "null");
            return r?.boot.aggregates.slice(0, 80).map((a) => `${Math.round(a.total)}ms ×${a.count}${a.units !== undefined ? ` ${a.units} ${a.unitName}` : ""} ${a.label}`);
          }).catch(() => undefined)
        : undefined;
      await perfReady(page);
      await page.evaluate(() => {
        window.__busy = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__busy.push([Math.round(e.startTime), Math.round(e.duration)]);
        }).observe({ type: "longtask", buffered: true });
      });
      const wait = WINDOW_SEC * 1000 - (Date.now() - t0);
      if (wait > 0) await page.waitForTimeout(wait);
      const sent = await page.evaluate(() => window.__armadaReqLog ?? []);
      /** Per community, ms since page load until a live REQ named its chat streams; null when none did. */
      const chatSubSent = many.communities.map((c) => {
        const hit = sent.find((r) => r.live && c.chatPks.some((pk) => r.authors.includes(pk)));
        return hit ? hit.t : null;
      });
      const summarize = (xs) => {
        const got = xs.filter((x) => x !== null).sort((a, b) => a - b);
        return { covered: `${got.length}/${xs.length}`, firstMs: got[0] ?? null, medianMs: got[Math.floor(got.length / 2)] ?? null, lastMs: got.at(-1) ?? null };
      };
      const busy = await page.evaluate(() => window.__busy);
      const seen = await page.evaluate(() => window.__armadaSeen ?? {});
      const paintMs = seen.paint ?? null;
      const missedShownMs = seen.missed ?? null;
      const missedLostMs = seen.missedLost ?? null;
      const rep = await report(page);
      const wireQuery = (rep.runtime.queries ?? []).filter((q) => /concord-channels|notif-subs/.test(q.family));
      return {
        painted,
        paintMs,
        missedShownMs,
        missedLostMs,
        chatSubSent: summarize(chatSubSent),
        reqs1059: sent.length,
        longTasks: {
          count: busy.length,
          totalMs: busy.reduce((a, [, d]) => a + d, 0),
          maxMs: Math.max(0, ...busy.map(([, d]) => d)),
          // [start, duration] since page load, on the timeline's clock.
          at: busy.map(([t, d]) => `${t}+${d}`).join(" "),
        },
        wireQueries: wireQuery.map((q) => `${q.fetches} fetch / ${q.updates} update: ${q.family}`),
        topStorage: rep.boot.aggregates.slice(0, 8).map((a) => `${Math.round(a.total)}ms ×${a.count} ${a.label}`),
        atPaint,
        // Every storage operation and read shape, for attributing where the time went.
        aggregates: rep.boot.aggregates.slice(0, 400).map((a) => `${Math.round(a.total)}ms ×${a.count}${a.units !== undefined ? ` ${a.units} ${a.unitName}` : ""} ${a.label}`),
        // Milestones and live kind-1059 REQs, both since page load.
        timeline: rep.boot.timeline.map((m) => `${Math.round(m.at)} ${m.label}${m.detail ? ` (${m.detail})` : ""}`),
        liveReqsSent: sent.filter((r) => r.live).slice(0, 12).map((r) => `${r.t} ${r.authors.length} author(s) since ${r.since}`),
        errors: errorsSince(mark),
      };
    };
    /** What each community's #general stored beyond `base` rows by the window's end, against `want`. */
    const storedBeyond = async (base, want) => {
      await page.goto("/e2e/concordSeed.html");
      await page.waitForFunction(() => Boolean(window.__armadaConcordCoverage), null, { timeout: 60_000 });
      const stored = [];
      for (const c of many.communities) {
        const [general] = await page.evaluate(([id, ch]) => window.__armadaConcordCoverage(id, [ch]), [c.communityId, c.channelIds[0]]);
        stored.push(Math.max(0, general.stored - base));
      }
      return { complete: `${stored.filter((n) => n >= want).length}/${stored.length}`, perCommunity: stored.join(" ") };
    };
    // Cold: two hours away, then the first boot.
    const cold = await bootOnce("cold (first boot after seeding)", MISSED > 0 ? `(#c0-missed-${MISSED - 1})` : undefined);
    if (MISSED > 0) cold.missedStored = await storedBeyond(200, MISSED);
    // Warm: the `later` messages arrive while the app is closed, then a reload.
    // Not before their date: a wrap from the future is held, not caught up on.
    const untilLater = many.laterAtMs + 2_000 - Date.now();
    if (untilLater > 0) await page.waitForTimeout(untilLater);
    relayBody = JSON.stringify([...many.wraps, ...many.laterWraps]);
    const warm = await bootOnce("warm (reload)", LATER > 0 ? `(#c0-later-${LATER - 1})` : undefined);
    if (LATER > 0) warm.missedStored = await storedBeyond(200 + MISSED, LATER);
    if (wants("concord-hop")) {
      // Hopping between the joined communities, each already on disk: how long until the
      // new community's #general shows its rows, and how long the main thread stays busy.
      const HOPS = Number(opt("hops", "8"));
      const ring = many.communities.slice(0, Math.min(4, many.communities.length));
      console.log(`▶ concord-hop (${HOPS} hops over ${ring.length} communities)`);
      await page.goto(`/c/${ring[0].communityId}/${ring[0].channelIds[0]}`);
      await perfReady(page);
      await page.waitForTimeout(10_000);
      const hopMark = errors.length;
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const hops = [];
      const { hot } = await cpuProfile("concord-hop", async () => {
        for (let i = 1; i <= HOPS; i++) {
          const ci = i % ring.length;
          const c = ring[ci];
          const index = many.communities.indexOf(c);
          hops.push(await page.evaluate(
            ([path, needle]) =>
              new Promise((done) => {
                const busy = [];
                const obs = new PerformanceObserver((list) => {
                  for (const e of list.getEntries()) busy.push(Math.round(e.duration));
                });
                obs.observe({ type: "longtask" });
                const start = performance.now();
                history.pushState({}, "", path);
                dispatchEvent(new PopStateEvent("popstate"));
                let shown = -1;
                let lastBusyEnd = start;
                const check = () => {
                  const now = performance.now();
                  if (shown < 0 && document.querySelector("main")?.textContent?.includes(needle)) shown = Math.round(now - start);
                  // Settled: the rows are up and no frame took longer than 50ms for a second.
                  if (now - lastBusyEnd > 50) lastBusyEnd = now;
                  if ((shown >= 0 && now - start > 1000 + shown) || now - start > 15_000) {
                    obs.disconnect();
                    done({ shownMs: shown, busyMs: busy.reduce((x, y) => x + y, 0), longTasks: busy.length, maxTaskMs: Math.max(0, ...busy) });
                  } else requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
              }),
            [`/c/${c.communityId}/${c.channelIds[0]}`, `(#c${index}-`],
          ));
          await page.waitForTimeout(2000);
        }
      });
      const b = await metrics(cdp);
      const shown = hops.map((h) => h.shownMs);
      console.log(`  shown ms: ${shown.join(" ")}; long-task ms per hop: ${hops.map((h) => h.busyMs).join(" ")}`);
      save("concord-hop", { hops, hot, cost: cost(a, b, (Date.now() - t) / 1000), errors: errorsSince(hopMark), report: await report(page) });
    }
    const span = (ws) => (ws.length ? `${Math.min(...ws.map((w) => w.created_at))}..${Math.max(...ws.map((w) => w.created_at))}` : "none");
    const relaySpans = { later: span(many.laterWraps), planes: span(many.wraps.filter((w) => !many.communities.some((c) => c.chatPks.includes(w.pubkey)))) };
    save("concord-many", { communities: MANY, members: MEMBERS, windowSec: WINDOW_SEC, relaySpans, cold, warm });
    await page.evaluate(() => {
      localStorage.removeItem("perf-inpage-relay");
      localStorage.removeItem("perf-watch");
    });
  }

  if (wants("dm-many")) {
    // The seeded account (40 conversations) back after 30 minutes away: 20 DMs wait on
    // its DM relay. A cold boot into the DM list, then 10 more arrive while the app is
    // closed and a warm reload opens the thread they're in.
    await installInPageScripts();
    const MISSED_DMS = 20;
    const LATER_DMS = 10;
    const senders = world.peers.slice(1, 11);
    const wrapDm = (from, i, label, createdAt) => {
      const rumor = { kind: 14, content: `${LINES[i % LINES.length]} (dm-${label}-${i})`, tags: [["p", world.me.pubkey]], created_at: createdAt, pubkey: from.pubkey };
      rumor.id = getEventHash(rumor);
      const seal = finalizeEvent(
        { kind: 13, content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(from.sk, world.me.pubkey)), tags: [], created_at: createdAt },
        from.sk,
      );
      const wrapSk = generateSecretKey();
      return finalizeEvent(
        { kind: 1059, content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapSk, world.me.pubkey)), tags: [["p", world.me.pubkey]], created_at: createdAt },
        wrapSk,
      );
    };
    const start = Math.floor(Date.now() / 1000);
    const missed = Array.from({ length: MISSED_DMS }, (_, i) => wrapDm(senders[i % senders.length], i, "missed", start - 1800 + i * 60));
    const lastSender = senders[(MISSED_DMS - 1) % senders.length];

    await page.goto("/e2e/screenshotSeed.html");
    await login(world.me);
    await page.evaluate((pk) => {
      const key = `armada:app-config:${pk}`;
      const cur = JSON.parse(localStorage.getItem(key) ?? "{}");
      // One of them slow: what a DM shows behind is the point. It is one of the account's own
      // relays too, so the self-state reads (the contact list, which this account lacks) wait on it.
      const relays = [...(cur.relayMetadata?.relays ?? []), { url: "wss://slow.invalid", read: true, write: true }];
      localStorage.setItem(key, JSON.stringify({
        ...cur,
        dmRelays: ["wss://dm.invalid", "wss://slow.invalid"],
        relayMetadata: { relays, updatedAt: Math.floor(Date.now() / 1000), pubkey: pk },
      }));
      localStorage.setItem("perf-inpage-relay", "1");
    }, world.me.pubkey);
    relayBody = JSON.stringify(missed);

    const bootDm = async (label, path, needles) => {
      console.log(`▶ dm-many ${label}`);
      const mark = errors.length;
      const t0 = Date.now();
      await page.evaluate((n) => localStorage.setItem("perf-watch", JSON.stringify({ ...n, root: "body" })), needles);
      await page.goto(path, { waitUntil: "commit" });
      const painted = await page.waitForFunction(() => window.__armadaSeen?.paint !== undefined, null, { timeout: 90_000 }).then(() => true, () => false);
      await perfReady(page);
      const wait = Number(opt("window-sec", "30")) * 1000 - (Date.now() - t0);
      if (wait > 0) await page.waitForTimeout(wait);
      const seen = await page.evaluate(() => window.__armadaSeen ?? {});
      const rep = await report(page);
      return {
        painted,
        paintMs: seen.paint ?? null,
        missedShownMs: seen.missed ?? null,
        missedLostMs: seen.missedLost ?? null,
        timeline: rep.boot.timeline.map((m) => `${Math.round(m.at)} ${m.label}${m.detail ? ` (${m.detail})` : ""}`),
        topStorage: rep.boot.aggregates.slice(0, 8).map((a) => `${Math.round(a.total)}ms ×${a.count} ${a.label}`),
        aggregates: rep.boot.aggregates.slice(0, 400).map((a) => `${Math.round(a.total)}ms ×${a.count}${a.units !== undefined ? ` ${a.units} ${a.unitName}` : ""} ${a.label}`),
        errors: errorsSince(mark),
      };
    };
    // The list paints a conversation's name; the newest missed DM is its preview.
    const cold = await bootDm("cold (DM list)", "/dm", { paint: "peer3", missed: `(dm-missed-${MISSED_DMS - 1})` });
    const later = Array.from({ length: LATER_DMS }, (_, i) => wrapDm(lastSender, i, "later", Math.floor(Date.now() / 1000) - LATER_DMS + i));
    relayBody = JSON.stringify([...missed, ...later]);
    const warm = await bootDm("warm (the thread)", `/dm/${lastSender.npub}`, { paint: `(dm-missed-${MISSED_DMS - 1})`, missed: `(dm-later-${LATER_DMS - 1})` });
    save("dm-many", { cold, warm });
    await page.evaluate(() => {
      localStorage.removeItem("perf-inpage-relay");
      localStorage.removeItem("perf-watch");
    });
  }

  if (wants("routes")) {
    // Pages with no message timeline: how long the boot gate holds the wire on each.
    console.log("\n▶ routes (when the wire starts on pages with no timeline)");
    const mark = errors.length;
    const out = {};
    for (const path of ["/notifications", "/settings", "/discover", "/invites", `/${world.peers[1].npub}`]) {
      await page.goto(path);
      await perfReady(page);
      await page.waitForTimeout(7_000);
      const rep = await report(page);
      const at = (label) => rep.boot.timeline.find((m) => m.label === label)?.at;
      out[path.startsWith("/npub") ? "/<profile>" : path] = { wireMount: at("wire.mount") === undefined ? null : Math.round(at("wire.mount")) };
    }
    save("routes", { routes: out, errors: errorsSince(mark) });
  }

  if (wants("concord-walk")) {
    // A community as a fresh device holds it: the newest page of each channel
    // on disk, the whole history on its relay. #general is open and nothing is
    // touched while the background walk reads the rest.
    const WALK_SIZES = [3000, 600, 600, 600, 600, 600, 600, 600];
    const WALK_SEC = Number(opt("walk-sec", "90"));
    await page.goto("/e2e/concordSeed.html");
    await page.waitForFunction(() => Boolean(window.__armadaSeedConcord), null, { timeout: 60_000 });
    const seedAt = Date.now();
    const walk = await page.evaluate(
      (p) => window.__armadaSeedConcord(p),
      {
        sk: Buffer.from(world.me.sk).toString("hex"),
        others: [],
        channelSizes: WALK_SIZES,
        lines: LINES,
        relayHistory: { localNewest: 50 },
      },
    );
    fakeRelayEvents = walk.wraps;
    console.log(`\nseeded walk community: ${walk.wraps.length} wraps on the relay, 50/channel on disk, in ${Date.now() - seedAt}ms`);

    console.log(`▶ concord-walk (${WALK_SEC}s with #general open)`);
    const mark = errors.length;
    const lastWalk = `${LINES[(WALK_SIZES[0] - 1) % LINES.length]} (#${WALK_SIZES[0] - 1})`;
    await page.goto(`/c/${walk.communityId}/${walk.channelIds[0]}`);
    await until(page, () => page.getByText(lastWalk, { exact: false }).last().isVisible(), 90_000);
    await perfReady(page);
    fakeRelayReqs.reqs = 0;
    fakeRelayReqs.events = 0;
    // Per-second main-thread busy share, to see the walk's shape, not just its mean.
    await page.evaluate(() => {
      window.__busy = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__busy.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({ type: "longtask", buffered: false });
    });
    await resetCounters(page);
    const a = await metrics(cdp);
    const t = Date.now();
    const { hot } = await cpuProfile("concord-walk", () => page.waitForTimeout(WALK_SEC * 1000));
    const b = await metrics(cdp);
    const longTasks = await page.evaluate(() => window.__busy);
    const rep = await report(page);
    const relay = { ...fakeRelayReqs };
    // The same page once the walk has had its window: what it costs to sit there afterwards.
    const after = await measureIdle(page, cdp, Number(opt("walk-after-sec", "60")));
    const heapFloorAfterMB = await heapFloorMB(cdp);
    // Read after that forced GC: `after.listeners` still counts collectable abort and request listeners.
    const listenersAfterGc = (await metrics(cdp)).JSEventListeners;
    // What the walk left retained, for DevTools → Memory → load.
    if (flag("heap-snapshot")) await writeHeapSnapshot(cdp, "concord-walk.heapsnapshot");
    // Read the coverage from the seed page, which bundles the store's readers.
    await page.goto("/e2e/concordSeed.html");
    await page.waitForFunction(() => Boolean(window.__armadaConcordCoverage), null, { timeout: 60_000 });
    const coverage = await page.evaluate(([c, ids]) => window.__armadaConcordCoverage(c, ids), [walk.communityId, walk.channelIds]);
    const stored = coverage.reduce((n, c) => n + c.stored, 0);
    save("concord-walk", {
      hot,
      cost: cost(a, b, (Date.now() - t) / 1000),
      after,
      heapFloorAfterMB,
      listenersAfterGc,
      longTasks: {
        count: longTasks.length,
        totalMs: longTasks.reduce((n, [, d]) => n + d, 0),
        maxMs: longTasks.reduce((n, [, d]) => Math.max(n, d), 0),
        over100ms: longTasks.filter(([, d]) => d > 100).length,
      },
      relay,
      walked: { stored, of: walk.wraps.length, channelsExhausted: coverage.filter((c) => c.exhausted).length, perChannel: coverage },
      errors: errorsSince(mark),
      report: rep,
    });
    fakeRelayEvents = [];
  }


  if (wants("dm-walk")) {
    // NIP-17 the way a fresh login meets it: every message a real gift wrap on
    // the account's DM relay, nothing on disk.
    const dmMe = person("dm-walk-me");
    const senders = Array.from({ length: 20 }, (_, i) => person(`dm-peer${i}`));
    const DM_WALK = 3000;
    const WALK_SEC = Number(opt("walk-sec", "90"));
    const span = 86400 * 90;
    const wraps = [];
    const builtAt = Date.now();
    for (let i = 0; i < DM_WALK; i++) {
      const from = senders[i % senders.length];
      const createdAt = nowSec - span + Math.floor((span * i) / DM_WALK);
      const rumor = { kind: 14, content: `${LINES[i % LINES.length]} (#${i})`, tags: [["p", dmMe.pubkey]], created_at: createdAt, pubkey: from.pubkey };
      rumor.id = getEventHash(rumor);
      const seal = finalizeEvent(
        { kind: 13, content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(from.sk, dmMe.pubkey)), tags: [], created_at: createdAt },
        from.sk,
      );
      const wrapSk = generateSecretKey();
      wraps.push(finalizeEvent(
        { kind: 1059, content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapSk, dmMe.pubkey)), tags: [["p", dmMe.pubkey]], created_at: createdAt },
        wrapSk,
      ));
    }
    console.log(`\nbuilt ${DM_WALK} gift wraps in ${Date.now() - builtAt}ms`);

    await page.goto("/e2e/screenshotSeed.html");
    await login(dmMe);
    await page.evaluate((pk) => {
      localStorage.setItem(`armada:app-config:${pk}`, JSON.stringify({ dmRelays: ["wss://dm.invalid"], useAppRelays: false }));
    }, dmMe.pubkey);
    fakeRelayEvents = wraps;

    console.log(`▶ dm-walk (${WALK_SEC}s with the DM list open)`);
    const mark = errors.length;
    fakeRelayReqs.reqs = 0;
    fakeRelayReqs.events = 0;
    await page.goto("/dm");
    await perfReady(page);
    await page.evaluate(() => {
      window.__busy = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__busy.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({ type: "longtask", buffered: false });
    });
    await resetCounters(page);
    const a = await metrics(cdp);
    const t = Date.now();
    const { hot } = await cpuProfile("dm-walk", () => page.waitForTimeout(WALK_SEC * 1000));
    const b = await metrics(cdp);
    const longTasks = await page.evaluate(() => window.__busy);
    const rep = await report(page);
    const relay = { ...fakeRelayReqs };
    const after = await measureIdle(page, cdp, Number(opt("walk-after-sec", "60")));
    const heapFloorAfterMB = await heapFloorMB(cdp);
    await page.goto("/e2e/screenshotSeed.html");
    await page.waitForFunction(() => Boolean(window.__armadaDmCoverage), null, { timeout: 60_000 });
    const coverage = await page.evaluate((pk) => window.__armadaDmCoverage(pk), dmMe.pubkey);
    save("dm-walk", {
      hot,
      cost: cost(a, b, (Date.now() - t) / 1000),
      after,
      heapFloorAfterMB,
      longTasks: {
        count: longTasks.length,
        totalMs: longTasks.reduce((n, [, d]) => n + d, 0),
        maxMs: longTasks.reduce((n, [, d]) => Math.max(n, d), 0),
        over100ms: longTasks.filter(([, d]) => d > 100).length,
      },
      relay,
      walked: { stored: coverage.stored, of: DM_WALK, relaysExhausted: coverage.exhausted.length },
      errors: errorsSince(mark),
      report: rep,
    });
    fakeRelayEvents = [];
    // Back to the world's account for whatever runs next.
    await login(world.me);
  }

  if (LIVE.some(wants)) {
    if (!INVITE) {
      console.log("\n▶ live-switch skipped: pass --invite <url>");
    } else {
      console.log("\n▶ live-switch (join a real community, then switch in and out of it)");
      const mark = errors.length;
      const invite = new URL(INVITE);
      await page.goto(invite.pathname + invite.hash);
      const accept = page.getByRole("button", { name: /accept invite/i });
      await until(page, () => accept.isVisible(), 90_000);
      await accept.click();
      await until(page, async () => /^\/c\/[^/]+/.test(new URL(page.url()).pathname), 90_000);
      const communityPath = new URL(page.url()).pathname.match(/^\/c\/[^/]+/)[0];
      // Let the join's sweeps settle: this is the community as a member has
      // it on disk, which is what switching back into it reads.
      const settleSec = Number(opt("settle", "45"));
      console.log(`  joined ${communityPath.slice(0, 14)}…, settling ${settleSec}s`);
      await page.waitForTimeout(settleSec * 1000);
      if (flag("offline")) {
        console.log("  answering every REQ locally from here on (--offline)");
        answerLocally = true;
      }
      // Out to the DM list, not to another community, so the numbers are the
      // community's own mount and unmount.
      const away = "/dm";
      await softNavigate(page, away);
      await page.waitForTimeout(3000);
      const floors = [await heapFloorMB(cdp)];
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const rounds = Number(opt("rounds", "6"));
      /** Time from the navigation to the first frame after it with a message row rendered. */
      const switchInMs = [];
      const { hot } = await cpuProfile("live-switch", async () => {
        for (let round = 0; round < rounds; round++) {
          const ms = await page.evaluate(
            (path) =>
              new Promise((done) => {
                const start = performance.now();
                history.pushState({}, "", path);
                dispatchEvent(new PopStateEvent("popstate"));
                const check = () => {
                  if (document.querySelector("main [data-scroll-anchor]")) done(Math.round(performance.now() - start));
                  else if (performance.now() - start > 15_000) done(-1);
                  else requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
              }),
            communityPath,
          );
          switchInMs.push(ms);
          await page.waitForTimeout(3000);
          await softNavigate(page, away);
          await page.waitForTimeout(1500);
          floors.push(await heapFloorMB(cdp));
        }
      });
      const b = await metrics(cdp);
      save("live-switch", {
        hot,
        rounds,
        switchInMs,
        cost: cost(a, b, (Date.now() - t) / 1000),
        heapFloorMBPerRound: floors,
        errors: errorsSince(mark),
        report: await report(page),
      });

      if (wants("live-boot")) {
        // A cold start straight into the joined community, as reopening the
        // app is: everything since the page load, for --boot-sec seconds.
        const bootSec = Number(opt("boot-sec", "60"));
        console.log(`▶ live-boot (reload into the community, ${bootSec}s)`);
        const bootMark = errors.length;
        const a2 = await metrics(cdp);
        const t2 = Date.now();
        const { hot: bootHot } = await cpuProfile("live-boot", async () => {
          await page.goto(communityPath);
          await perfReady(page);
          await page.waitForTimeout(bootSec * 1000);
        });
        const b2 = await metrics(cdp);
        // CDP's counters restart with the new document, so the reload's cost
        // is everything the fresh document has counted.
        const zero = Object.fromEntries(Object.keys(b2).map((k) => [k, 0]));
        save("live-boot", {
          hot: bootHot,
          cost: cost(b2.TaskDuration < a2.TaskDuration ? zero : a2, b2, (Date.now() - t2) / 1000),
          errors: errorsSince(bootMark),
          report: await report(page),
        });
      }

      if (wants("live-idle")) {
        // The joined community open and nobody touching anything: what it
        // costs to leave the app sitting in a busy room.
        console.log(`▶ live-idle (${IDLE_SEC}s)`);
        const idleMark = errors.length;
        // live-switch ends on `away`.
        if (!new URL(page.url()).pathname.startsWith(communityPath)) {
          await softNavigate(page, communityPath);
          await page.waitForTimeout(10_000);
        }
        await resetCounters(page);
        let idle;
        const { hot: idleHot } = await cpuProfile("live-idle", async () => {
          idle = await measureIdle(page, cdp, IDLE_SEC);
        });
        save("live-idle", { hot: idleHot, idle, errors: errorsSince(idleMark), report: await report(page) });
      }
    }
  }

  if (wants("discover")) {
    console.log(`\n▶ discover (${IDLE_SEC}s idle, live relays)`);
    const mark = errors.length;
    await page.goto("/discover");
    await perfReady(page);
    await until(page, async () => false, 15_000);
    const idle = await measureIdle(page, cdp, IDLE_SEC);
    save("discover", { idle, errors: errorsSince(mark), report: await report(page) });
  }

  if (wants("discover-all")) {
    console.log(`\n▶ discover-all (unfiltered world, scrolled to the end, live relays)`);
    const mark = errors.length;
    await page.evaluate(() => {
      const pk = localStorage.getItem("armada:active-pubkey");
      const key = `armada:app-config:${pk}`;
      const cur = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...cur, discoverAllContent: true }));
    });
    await page.goto("/discover");
    await perfReady(page);
    await resetCounters(page);
    const a = await metrics(cdp);
    const t = Date.now();
    // Each step reaches the infinite-scroll sentinel, so later pages load too.
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    const { hot } = await cpuProfile("discover-all", async () => {
      for (let i = 0; i < 30; i++) {
        await dismissRestore(page);
        await page.mouse.wheel(0, 1500);
        await page.waitForTimeout(1000);
      }
    });
    const b = await metrics(cdp);
    save("discover-all", { scroll: cost(a, b, (Date.now() - t) / 1000), hot, errors: errorsSince(mark), report: await report(page) });
  }
} finally {
  await browser.close();
  stopServer();
}

// ─── Summary ────────────────────────────────────────────────────────────────

for (const [name, r] of Object.entries(results)) {
  console.log(`\n══ ${name} ══`);
  const { report: rep, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
  if (rep) console.log(JSON.stringify(digest(rep), null, 1));
}
console.log(`full reports: ${OUT}`);
process.exit(0);
