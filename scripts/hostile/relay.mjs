#!/usr/bin/env node
/**
 * Hostile Nostr relays for comparing Concord clients (scripts/hostile/README.md).
 *
 * Several relays in one process, each its OWN store (so they diverge the way real
 * relays do), each with a fault profile drawn from a seeded RNG:
 *
 *   latency [min,max] ms   every outbound frame is delayed; `reorder` lets them overtake
 *   okLie p                 OK true, event NOT stored (the worst lie a relay tells)
 *   okFalse p               OK false
 *   okSilent p              stored, no OK ever sent
 *   omit p                  each stored event withheld from a REQ answer with this chance
 *   cap n                   at most n events per REQ whatever `limit` asks
 *   dup p                   an event sent twice
 *   liveDrop p              a live event not pushed to a subscription
 *   disconnect p            the socket dropped after a frame, mid-conversation
 *   blackhole               accepts sockets, never answers anything
 *
 * Control API on --control (HTTP, JSON):
 *   GET  /stats                       counters per relay
 *   GET  /events?relay=&authors=&kinds=   stored events, for analysis (unfiltered by faults)
 *   POST /heal                        every relay to the calm profile
 *   POST /profile  {relay, profile}   replace one relay's profile
 *   POST /reset                       empty every store and counter
 *
 * Usage: node scripts/hostile/relay.mjs --control 7100 --relays hostile|calm [--seed 1]
 * Relays listen on 7101.. in the order of the chosen set.
 */
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";

import { CALM, SETS } from "./profiles.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const CONTROL = Number(args.control ?? 7100);
let seed = Number(args.seed ?? 1) >>> 0;
const rand = () => {
  // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const chance = (p) => p > 0 && rand() < p;

// `--tls <dir>` serves wss:// with <dir>/relay.pem and relay.key, signed by <dir>/ca.pem.
const TLS = args.tls ? { cert: readFileSync(`${args.tls}/relay.pem`), key: readFileSync(`${args.tls}/relay.key`) } : undefined;
const set = SETS[args.relays ?? "hostile"];
if (!set) throw new Error(`no relay set ${args.relays}`);

const isReplaceable = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k) => k >= 30000 && k < 40000;
const isEphemeral = (k) => k >= 20000 && k < 30000;
const dTag = (e) => e.tags.find((t) => t[0] === "d")?.[1] ?? "";

function matches(f, e) {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [k, v] of Object.entries(f)) {
    if (k[0] !== "#" || !Array.isArray(v)) continue;
    const name = k.slice(1);
    if (!e.tags.some((t) => t[0] === name && v.includes(t[1]))) return false;
  }
  return true;
}

class Relay {
  constructor(index, profile) {
    this.index = index;
    this.port = CONTROL + 1 + index;
    this.url = `${TLS ? "wss" : "ws"}://localhost:${this.port}`;
    this.profile = profile;
    this.reset();
  }
  reset() {
    this.events = new Map();
    this.subs = new Set();
    this.stats = { events: 0, stored: 0, lied: 0, refused: 0, silent: 0, reqs: 0, served: 0, withheld: 0, disconnects: 0, sockets: 0 };
  }
  store(e) {
    if (isEphemeral(e.kind)) return;
    if (isReplaceable(e.kind) || isAddressable(e.kind)) {
      for (const [id, old] of this.events) {
        if (old.pubkey === e.pubkey && old.kind === e.kind && (!isAddressable(e.kind) || dTag(old) === dTag(e))) {
          if (old.created_at > e.created_at) return;
          this.events.delete(id);
        }
      }
    }
    this.events.set(e.id, e);
    this.stats.stored++;
  }
}
const relays = set.map((p, i) => new Relay(i, p));

function sender(ws, relay) {
  // Every frame waits its latency; without `reorder` a frame never overtakes the one before.
  let last = 0;
  return (frame) => {
    const [lo, hi] = relay.profile.latency ?? [0, 0];
    let at = Date.now() + lo + rand() * (hi - lo);
    if (!relay.profile.reorder) at = Math.max(at, last);
    last = at;
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    }, at - Date.now());
  };
}

for (const relay of relays) {
  const server = (TLS ? https.createServer.bind(null, TLS) : http.createServer)((req, res) => {
    // NIP-11, for clients that ask.
    res.writeHead(200, { "content-type": "application/nostr+json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ name: `hostile-${relay.index}`, supported_nips: [1, 11], limitation: { max_limit: relay.profile.cap ?? 5000 } }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    relay.stats.sockets++;
    if (relay.profile.blackhole) return;
    const send = sender(ws, relay);
    const subs = new Map();
    const drop = () => {
      if (!chance(relay.profile.disconnect ?? 0)) return;
      relay.stats.disconnects++;
      setTimeout(() => ws.terminate(), 50);
    };
    ws.on("message", (raw) => {
      if (relay.profile.blackhole) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const [type] = msg;
      if (type === "EVENT") {
        const e = msg[1];
        relay.stats.events++;
        if (!e || !verifyEvent(e)) return send(["OK", e?.id ?? "", false, "invalid: bad signature"]);
        if (chance(relay.profile.okFalse ?? 0)) {
          relay.stats.refused++;
          return send(["OK", e.id, false, "blocked: hostile relay"]);
        }
        if (chance(relay.profile.okLie ?? 0)) {
          relay.stats.lied++;
          return send(["OK", e.id, true, ""]);
        }
        const fresh = !relay.events.has(e.id);
        relay.store(e);
        if (chance(relay.profile.okSilent ?? 0)) relay.stats.silent++;
        else send(["OK", e.id, true, fresh ? "" : "duplicate: already have it"]);
        if (fresh) {
          for (const sub of relay.subs) {
            if (!sub.filters.some((f) => matches(f, e)) || chance(relay.profile.liveDrop ?? 0)) continue;
            sub.send(["EVENT", sub.id, e]);
          }
        }
        drop();
      } else if (type === "REQ") {
        const [, id, ...filters] = msg;
        relay.stats.reqs++;
        const old = subs.get(id);
        if (old) relay.subs.delete(old);
        const sub = { id, filters, send };
        subs.set(id, sub);
        relay.subs.add(sub);
        const seen = new Set();
        const out = [];
        for (const f of filters) {
          const hits = [...relay.events.values()].filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
          const limit = Math.min(f.limit ?? Infinity, relay.profile.cap ?? Infinity);
          let n = 0;
          for (const e of hits) {
            if (n >= limit) break;
            if (seen.has(e.id)) continue;
            seen.add(e.id);
            if (chance(relay.profile.omit ?? 0)) {
              relay.stats.withheld++;
              continue;
            }
            out.push(e);
            n++;
          }
        }
        for (const e of out) {
          send(["EVENT", id, e]);
          if (chance(relay.profile.dup ?? 0)) send(["EVENT", id, e]);
        }
        relay.stats.served += out.length;
        send(["EOSE", id]);
        drop();
      } else if (type === "CLOSE") {
        const sub = subs.get(msg[1]);
        if (sub) relay.subs.delete(sub);
        subs.delete(msg[1]);
      }
    });
    ws.on("close", () => {
      for (const sub of subs.values()) relay.subs.delete(sub);
    });
  });
  server.listen(relay.port, "localhost");
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    if (req.method === "GET" && url.pathname === "/stats") {
      return json(res, 200, relays.map((r) => ({ url: r.url, profile: r.profile, ...r.stats, held: r.events.size })));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const authors = url.searchParams.get("authors")?.split(",");
      const kinds = url.searchParams.get("kinds")?.split(",").map(Number);
      const which = url.searchParams.get("relay");
      const out = new Map();
      for (const r of relays) {
        if (which !== null && String(r.index) !== which) continue;
        for (const e of r.events.values()) if ((!authors || authors.includes(e.pubkey)) && (!kinds || kinds.includes(e.kind))) out.set(e.id, e);
      }
      return json(res, 200, [...out.values()]);
    }
    if (req.method === "POST" && url.pathname === "/heal") {
      for (const r of relays) if (!r.profile.blackhole || input.blackholes) r.profile = CALM;
      return json(res, 200, { healed: true });
    }
    if (req.method === "POST" && url.pathname === "/profile") {
      relays[input.relay].profile = input.profile;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      for (const r of relays) r.reset();
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "not found" });
  })
  .listen(CONTROL, "127.0.0.1", () => {
    console.log(JSON.stringify({ control: CONTROL, relays: relays.map((r) => ({ url: r.url, profile: r.profile })) }));
  });
