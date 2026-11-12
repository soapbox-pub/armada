#!/usr/bin/env node
/**
 * Concord community dumper — read-only test/analysis harness.
 *
 * Resolves a Concord invite link, discovers its public channels, and pulls the
 * decrypted Chat Plane history out of the community's relays. It writes NOTHING
 * to any relay: no join, no profile, no message — the exact opposite of
 * `scripts/spambot.mjs`, whose CORD-01/02/05 derivations this mirrors so the two
 * stay in step (any fix to the key schedule or invite format lands in both).
 *
 * The point is to inspect what a real member's timeline actually contains —
 * chiefly for moderation/anti-spam work: what `src/concord/lib/floodCluster.ts`
 * would and would not fold. It emits the timeline in the exact `OpenedChat`
 * shape that file consumes (`rumorId`, `author`, `kind`, `content`, `ms`,
 * `tags`, `channelIdHex`), so the JSON dump can be fed straight to the real
 * detector from a Vitest harness without any reshaping.
 *
 * Usage:
 *   node scripts/dump-community.mjs <invite-url> [options]
 *
 * The invite URL may also come from the ARMADA_INVITE env var or from
 * ~/.config/armada-spambot/invite (same lookup order as the spam bot).
 *
 * Options:
 *   --json [file]      Write the full rumor dump as JSON (default: stdout).
 *                      With no path, prints to stdout; the human summary then
 *                      goes to stderr so a pipe stays clean.
 *   --channel <name>   Only this channel (by name, case-insensitive). Repeatable.
 *   --since <hours>    Only rumors newer than this many hours (default: all).
 *   --limit <n>        Per-(channel,epoch) relay REQ limit (default: 5000).
 *   --epochs <n>       Scan epochs [max(0,current-n) .. current] to follow
 *                      history across rekeys (default: 4; 0 = current only).
 *   --kinds <a,b,...>  Only these rumor kinds (default: all Chat Plane kinds).
 *   --timeout <ms>     Per-relay REQ timeout (default: 20000).
 *
 * Env vars, for the awkward communities:
 *   INCLUDE_PRIVATE=1        Also read channels the control plane marks private.
 *   CONTROL_EPOCH_SCAN=<n>   Fold the control plane at root_epoch..root_epoch+n
 *                            too — each epoch has its own control-stream pubkey,
 *                            so a channel created after a rekey is invisible at
 *                            the invite's root epoch alone (default: 0).
 *   EXTRA_CHANNELS=id:name,… Read channel ids whose control-plane DEFINITION the
 *                            bundle relays never served (a data-availability gap
 *                            that hides the channel from discovery). The stream
 *                            key derives from community_root + id, so the
 *                            timeline reads even when the name never resolved.
 *
 * Exit status is non-zero on a resolution failure so it is usable in a pipe.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { getConversationKey, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// CORD-02 Appendix A key derivations (mirrors src/concord/lib/derive.ts and
// the copy in scripts/spambot.mjs — keep the three in step)
// ---------------------------------------------------------------------------

const te = new TextEncoder();
const td = new TextDecoder();
const ZERO32 = new Uint8Array(32);

const KIND_INVITE_BUNDLE = 33301;
const KIND_WRAP = 1059;
const KIND_SEAL_ENCRYPTED = 20013;
const KIND_SEAL_PLAINTEXT = 20014;
const KIND_EDITION = 3308;

const VSK_INVITE_LIVE = "6";
const VSK_INVITE_REVOKED = "9";

const RELAY_DICTIONARY = {
  1: "wss://jskitty.com/nostr",
  2: "wss://asia.vectorapp.io/nostr",
  3: "wss://relay.ditto.pub",
  4: "wss://relay.dreamith.to",
};
const STOCK_RELAYS = Object.values(RELAY_DICTIONARY);
const INCLUDE_PRIVATE = process.env.INCLUDE_PRIVATE === "1";

function buildInfo(label, id32, epoch) {
  const l = te.encode(label);
  const out = new Uint8Array(l.length + 1 + 32 + (epoch !== undefined ? 8 : 0));
  out.set(l, 0);
  out[l.length] = 0;
  out.set(id32, l.length + 1);
  if (epoch !== undefined) {
    new DataView(out.buffer).setBigUint64(l.length + 33, BigInt(epoch), false);
  }
  return out;
}

const hkdf32 = (ikm, info) => hkdf(sha256, ikm, new Uint8Array(0), info, 32);

function hkdfToSecretKey(ikm, baseInfo) {
  const first = hkdf32(ikm, baseInfo);
  if (secp256k1.utils.isValidSecretKey(first)) return first;
  for (let c = 0; c <= 0xff; c++) {
    const info = new Uint8Array([...baseInfo, c]);
    const seed = hkdf32(ikm, info);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  throw new Error("unreachable: no valid secret key in 257 HKDF rounds");
}

function groupKey(secretHex, label, idHex, epoch) {
  const sk = hkdfToSecretKey(
    hexToBytes(secretHex),
    buildInfo(label, hexToBytes(idHex), BigInt(epoch)),
  );
  const pk = bytesToHex(schnorr.getPublicKey(sk));
  return { sk, pk, convKey: getConversationKey(sk, pk) };
}

const channelGroupKey = (rootHex, channelIdHex, epoch) =>
  groupKey(rootHex, "concord/channel", channelIdHex, epoch);
const controlGroupKey = (rootHex, communityIdHex, epoch) =>
  groupKey(rootHex, "concord/control", communityIdHex, epoch);
const inviteBundleKey = (token) =>
  hkdf32(token, buildInfo("concord/invite-key", ZERO32));

function communityIdOf(ownerHex, saltHex) {
  const pre = new Uint8Array([
    ...te.encode("concord/community"),
    ...hexToBytes(ownerHex),
    ...hexToBytes(saltHex),
  ]);
  return bytesToHex(sha256(pre));
}

const verifyCommunityId = (idHex, ownerHex, saltHex) =>
  communityIdOf(ownerHex, saltHex) === idHex.toLowerCase();

// ---------------------------------------------------------------------------
// CORD-05 invite link parsing (mirrors src/concord/lib/invite.ts)
// ---------------------------------------------------------------------------

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(
    Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64"),
  );
}

function decodeFragment(fragment) {
  const bytes = b64urlDecode(fragment.trim());
  let o = 0;
  if (bytes[o++] !== 4) throw new Error("unsupported fragment version");
  const flags = bytes[o++];
  const relays = [];
  if (flags & 1) {
    relays.push(...STOCK_RELAYS);
  } else {
    const count = bytes[o++];
    for (let i = 0; i < count; i++) {
      const lead = bytes[o++];
      if (lead >= 1 && lead <= 254) {
        if (RELAY_DICTIONARY[lead]) relays.push(RELAY_DICTIONARY[lead]);
      } else {
        const len = bytes[o++];
        const text = td.decode(bytes.slice(o, o + len));
        o += len;
        relays.push(lead === 255 ? text : `wss://${text}`);
      }
    }
  }
  const token = bytes.slice(o, o + 16);
  o += 16;
  if (token.length !== 16 || o !== bytes.length) {
    throw new Error("malformed fragment");
  }
  return { token, relays };
}

function parseInvite(url) {
  const u = new URL(url);
  const naddr = decodeURIComponent(
    u.pathname.replace(/^\/invite\//, "").replace(/\/$/, ""),
  );
  const d = nip19.decode(naddr);
  if (d.type !== "naddr" || d.data.kind !== KIND_INVITE_BUNDLE || d.data.identifier !== "") {
    throw new Error("not a Concord invite link");
  }
  const { token, relays } = decodeFragment(u.hash.slice(1));
  return { linkSigner: d.data.pubkey, token, bootstrapRelays: relays, naddr };
}

// ---------------------------------------------------------------------------
// Minimal read-only relay pool with NIP-42 auth
// ---------------------------------------------------------------------------

function log(...args) {
  console.error(new Date().toISOString(), ...args);
}

class RelayConn {
  constructor(url, getAuthSigners) {
    this.url = url;
    this.getAuthSigners = getAuthSigners;
    this.ws = null;
    this.subs = new Map();
    this.challenge = undefined;
    this.dead = false;
  }

  connect(timeoutMs = 10000) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    this.dead = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error(`connect timeout ${this.url}`));
      }, timeoutMs);
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`ws error ${this.url}: ${e.message ?? "error"}`));
      });
      ws.addEventListener("close", () => {
        this.dead = true;
        for (const [, sub] of this.subs) sub.onEose?.("closed");
        this.subs.clear();
      });
      ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    switch (msg[0]) {
      case "AUTH":
        this.challenge = msg[1];
        this.sendAuth();
        break;
      case "EVENT": {
        const sub = this.subs.get(msg[1]);
        sub?.onEvent?.(msg[2]);
        break;
      }
      case "EOSE": {
        const sub = this.subs.get(msg[1]);
        this.subs.delete(msg[1]);
        sub?.onEose?.("eose");
        break;
      }
      case "CLOSED": {
        const sub = this.subs.get(msg[1]);
        this.subs.delete(msg[1]);
        // auth-required: answer the challenge and let the caller retry.
        if (this.challenge) this.sendAuth();
        sub?.onEose?.(`closed: ${msg[2] ?? ""}`);
        break;
      }
      case "NOTICE":
        log(`NOTICE ${this.url}: ${msg[1]}`);
        break;
    }
  }

  sendAuth() {
    if (!this.challenge) return;
    const seen = new Set();
    for (const finalize of this.getAuthSigners()) {
      const auth = finalize(this.url, this.challenge);
      if (!auth || seen.has(auth.pubkey)) continue;
      seen.add(auth.pubkey);
      this.send(["AUTH", auth]);
    }
  }

  send(frame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  request(filter, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const subId = `s${Math.random().toString(36).slice(2, 12)}`;
      const events = [];
      const timer = setTimeout(() => {
        this.subs.delete(subId);
        this.send(["CLOSE", subId]);
        resolve(events);
      }, timeoutMs);
      this.subs.set(subId, {
        onEvent: (ev) => events.push(ev),
        onEose: () => {
          clearTimeout(timer);
          resolve(events);
        },
      });
      this.send(["REQ", subId, filter]);
    });
  }

  close() {
    this.dead = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

class RelayPool {
  constructor(getAuthSigners) {
    this.conns = new Map();
    this.getAuthSigners = getAuthSigners;
  }

  async get(url) {
    let conn = this.conns.get(url);
    if (!conn || conn.dead) {
      conn?.close();
      conn = new RelayConn(url, this.getAuthSigners);
      this.conns.set(url, conn);
      await conn.connect();
    }
    return conn;
  }

  /** Query urls with filter, merge + dedupe by id. */
  async queryAll(urls, filter, timeoutMs = 20000) {
    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const conn = await this.get(url);
        let evs = await conn.request(filter, timeoutMs);
        // A relay that gated the REQ returns CLOSED before EOSE; retry once now
        // that onMessage has answered the challenge.
        if (evs.length === 0 && conn.challenge) {
          evs = await conn.request(filter, timeoutMs);
        }
        return evs;
      }),
    );
    const byId = new Map();
    for (const r of results) {
      if (r.status === "fulfilled") for (const ev of r.value) byId.set(ev.id, ev);
      else log(`query failed: ${r.reason?.message ?? r.reason}`);
    }
    return [...byId.values()];
  }

  closeAll() {
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
  }
}

// ---------------------------------------------------------------------------
// Bundle resolution + channel discovery (mirrors spambot.mjs)
// ---------------------------------------------------------------------------

async function resolveBundle(pool, invite) {
  const filter = {
    kinds: [KIND_INVITE_BUNDLE],
    authors: [invite.linkSigner],
    "#d": [""],
    limit: 5,
  };
  let events = await pool.queryAll(invite.bootstrapRelays, filter);
  if (events.length === 0 && !invite.bootstrapRelays.every((r) => STOCK_RELAYS.includes(r))) {
    events = await pool.queryAll(STOCK_RELAYS, filter);
  }
  events = events.filter(verifyEvent).sort((a, b) => b.created_at - a.created_at);
  for (const event of events) {
    const vsk = event.tags.find((t) => t[0] === "vsk")?.[1];
    if (vsk === VSK_INVITE_REVOKED) throw new Error("invite link has been revoked");
    if (vsk !== VSK_INVITE_LIVE) continue;
    const bundle = JSON.parse(nip44Decrypt(event.content, inviteBundleKey(invite.token)));
    if (!verifyCommunityId(bundle.community_id, bundle.owner, bundle.owner_salt)) {
      throw new Error("bundle community_id mismatch");
    }
    return bundle;
  }
  throw new Error("no live invite bundle found on bootstrap relays");
}

/** Fold the control plane and return public, non-deleted channels. */
async function discoverChannels(pool, bundle) {
  const editions = new Map();
  const scanTo = bundle.root_epoch + Number(process.env.CONTROL_EPOCH_SCAN ?? 0);
  for (let epoch = bundle.root_epoch; epoch <= scanTo; epoch++) {
    const readKey = controlGroupKey(bundle.community_root, bundle.community_id, epoch);
    // A split epoch's address is the staff signer's pk, named by the bundle (CORD-02 §5).
    const address = epoch === bundle.root_epoch && bundle.control_pk ? bundle.control_pk : readKey.pk;
    const wraps = await pool.queryAll(
      bundle.relays,
      { kinds: [KIND_WRAP], authors: [address] },
      20000,
    );
    let folded = 0;
    for (const wrap of wraps) {
      if (wrap.pubkey !== address || !verifyEvent(wrap)) continue;
      try {
        const seal = JSON.parse(nip44Decrypt(wrap.content, readKey.convKey));
        if (seal.kind !== KIND_SEAL_PLAINTEXT) continue;
        const rumor = JSON.parse(seal.content);
        if (rumor.kind !== KIND_EDITION) continue;
        const tag = (n) => rumor.tags.find((t) => t[0] === n)?.[1];
        const vsk = tag("vsk");
        const eid = tag("eid");
        const ev = Number(tag("ev"));
        if (!vsk || !eid || !Number.isFinite(ev)) continue;
        folded++;
        const prev = editions.get(eid);
        if (!prev || ev > prev.ev) editions.set(eid, { ev, vsk, content: rumor.content });
      } catch {
        // not decryptable / malformed — skip
      }
    }
    if (scanTo > bundle.root_epoch) {
      log(`control epoch ${epoch}: ${wraps.length} wraps, ${folded} editions folded`);
    }
  }
  const channels = [];
  for (const [eid, ed] of editions) {
    if (ed.vsk !== "2") continue;
    try {
      const def = JSON.parse(ed.content);
      if (def.deleted || (def.private && !INCLUDE_PRIVATE)) continue;
      channels.push({ id: eid, name: def.name ?? "channel" });
    } catch {
      // skip
    }
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Chat Plane readback: open every wrap at a channel's stream address
// ---------------------------------------------------------------------------

/** Reconstruct the ms timestamp: created_at*1000 + the 0..999 `ms` tag. */
function rumorMs(rumor) {
  const raw = rumor.tags.find((t) => t[0] === "ms")?.[1];
  let offset = 0;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 999) offset = n;
  }
  return rumor.created_at * 1000 + offset;
}

/**
 * Open one channel across a range of epochs, returning `OpenedChat`-shaped rows.
 * Each epoch has its own stream key derived from the community root, so history
 * spanning a rekey needs every held epoch queried (CORD-03 §3).
 */
async function readChannel(pool, bundle, channel, opts) {
  const seen = new Set();
  const rows = [];
  const hi = bundle.root_epoch;
  const lo = Math.max(0, hi - opts.epochs);
  for (let epoch = hi; epoch >= lo; epoch--) {
    const stream = channelGroupKey(bundle.community_root, channel.id, epoch);
    // A relay caps a single REQ (commonly 500-1000 events), and the inner rumor
    // kind is encrypted so it can't be filtered server-side — every kind-1059
    // wrap counts against that cap. Page backwards by `until` on the wrap's
    // created_at until a short page (or the --since floor) ends the epoch.
    const PAGE = Math.min(opts.limit, 1000);
    let until;
    let epochWraps = 0;
    let opened = 0;
    for (;;) {
    const filter = { kinds: [KIND_WRAP], authors: [stream.pk], limit: PAGE };
    if (opts.since) filter.since = Math.floor(opts.since / 1000);
    if (until !== undefined) filter.until = until;
    const wraps = await pool.queryAll(bundle.relays, filter, opts.timeout);
    epochWraps += wraps.length;
    let oldest = Infinity;
    for (const wrap of wraps) {
      if (wrap.created_at < oldest) oldest = wrap.created_at;
      if (wrap.pubkey !== stream.pk || !verifyEvent(wrap)) continue;
      try {
        const seal = JSON.parse(nip44Decrypt(wrap.content, stream.convKey));
        if (seal.kind !== KIND_SEAL_ENCRYPTED || !verifyEvent(seal)) continue;
        const rumor = JSON.parse(nip44Decrypt(seal.content, stream.convKey));
        // CORD-03 §3: the rumor must commit the channel/epoch its key decrypted.
        const chTag = rumor.tags.find((t) => t[0] === "channel")?.[1];
        if (chTag && chTag !== channel.id) continue;
        if (rumor.pubkey !== seal.pubkey) continue;
        if (seen.has(rumor.id)) continue;
        seen.add(rumor.id);
        const ms = rumorMs(rumor);
        if (opts.since && ms < opts.since) continue;
        if (opts.kinds && !opts.kinds.has(rumor.kind)) continue;
        rows.push({
          rumorId: rumor.id,
          author: rumor.pubkey,
          kind: rumor.kind,
          content: rumor.content,
          tags: rumor.tags,
          ms,
          createdAt: rumor.created_at,
          channelIdHex: channel.id,
          channelName: channel.name,
          epoch,
        });
        opened++;
      } catch {
        // wrong epoch key / malformed — skip
      }
    }
    // A short page (relay had fewer than it caps at) is the end of this epoch.
    // Otherwise step `until` to just before the oldest wrap and page again;
    // guard against a relay that ignores `until` (oldest didn't move).
    if (wraps.length < PAGE || oldest === Infinity) break;
    const next = oldest - 1;
    if (until !== undefined && next >= until) break;
    until = next;
    }
    log(`  #${channel.name} epoch ${epoch}: ${epochWraps} wraps, ${opened} opened`);
    if (epochWraps === 0 && epoch < hi) break; // no history this far back
  }
  rows.sort((a, b) => a.ms - b.ms || (a.rumorId < b.rumorId ? -1 : 1));
  return rows;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    invite: undefined,
    json: undefined, // undefined = no json; "" = stdout; "path" = file
    channels: [],
    since: undefined,
    limit: 5000,
    epochs: 4,
    kinds: undefined,
    timeout: 20000,
  };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case "--json":
        opts.json = args[0] && !args[0].startsWith("--") ? args.shift() : "";
        break;
      case "--channel":
        opts.channels.push(String(args.shift()).toLowerCase());
        break;
      case "--since":
        opts.since = Date.now() - Number(args.shift()) * 3600 * 1000;
        break;
      case "--limit":
        opts.limit = Number(args.shift());
        break;
      case "--epochs":
        opts.epochs = Number(args.shift());
        break;
      case "--kinds":
        opts.kinds = new Set(String(args.shift()).split(",").map(Number));
        break;
      case "--timeout":
        opts.timeout = Number(args.shift());
        break;
      default:
        if (a?.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        opts.invite = a;
    }
  }
  if (!opts.invite) opts.invite = process.env.ARMADA_INVITE;
  if (!opts.invite) {
    try {
      opts.invite = readFileSync(join(homedir(), ".config", "armada-spambot", "invite"), "utf8").trim();
    } catch {
      /* no invite file */
    }
  }
  if (!opts.invite) {
    throw new Error("no invite: pass the invite URL as an argument, set ARMADA_INVITE, or write it to ~/.config/armada-spambot/invite");
  }
  return opts;
}

function summarize(rows) {
  const byAuthor = new Map();
  for (const r of rows) byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
  const span = rows.length
    ? `${new Date(rows[0].ms).toISOString()} .. ${new Date(rows[rows.length - 1].ms).toISOString()}`
    : "(empty)";
  log(`  ${rows.length} rumors from ${byAuthor.size} authors, ${span}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const invite = parseInvite(opts.invite);
  log(`invite: signer ${invite.linkSigner.slice(0, 12)}…, bootstrap: ${invite.bootstrapRelays.join(", ")}`);

  // Read-only: the only signer we ever offer is a NIP-42 auth over the stream
  // keys we derive (some relays gate historic 1059 reads behind AUTH). We never
  // publish. Filled in once the bundle + channels resolve.
  let authFinalizers = [];
  const pool = new RelayPool(() => authFinalizers);

  const bundle = await resolveBundle(pool, invite);
  log(`community: "${bundle.name}" id=${bundle.community_id.slice(0, 12)}… epoch=${bundle.root_epoch}`);
  log(`relays: ${bundle.relays.join(", ")}`);

  // Control-plane reads may be AUTH-gated too; the control key doesn't depend
  // on channel discovery, so authorize with it before folding the control plane.
  authFinalizers = buildAuthFinalizers(bundle, []);
  let channels = await discoverChannels(pool, bundle);
  // Manually add channel ids whose control-plane definition wasn't served by the
  // bundle relays (data-availability gap) — we hold community_root, so the
  // stream key derives from the id alone. `id:name` pairs, comma-separated.
  if (process.env.EXTRA_CHANNELS) {
    for (const spec of process.env.EXTRA_CHANNELS.split(",")) {
      const [id, name] = spec.split(":");
      if (id && !channels.some((c) => c.id === id)) channels.push({ id, name: name ?? id.slice(0, 8) });
    }
  }
  if (opts.channels.length) {
    channels = channels.filter((c) => opts.channels.includes(c.name.toLowerCase()));
  }
  log(`channels: ${channels.map((c) => `#${c.name}`).join(", ") || "(none)"}`);
  if (channels.length === 0) throw new Error("no channels to read");

  // NIP-42: sign the challenge with each channel's stream key + the control key.
  authFinalizers = buildAuthFinalizers(bundle, channels);

  const all = [];
  for (const channel of channels) {
    const rows = await readChannel(pool, bundle, channel, opts);
    summarize(rows);
    all.push(...rows);
  }
  all.sort((a, b) => a.ms - b.ms || (a.rumorId < b.rumorId ? -1 : 1));

  pool.closeAll();

  log(`total: ${all.length} rumors across ${channels.length} channel(s)`);

  if (opts.json === "") {
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
  } else if (opts.json) {
    writeFileSync(opts.json, JSON.stringify(all, null, 2) + "\n");
    log(`wrote ${all.length} rumors to ${opts.json}`);
  }
}

/** NIP-42 auth events over the stream keys (some relays gate historic reads). */
function buildAuthFinalizers(bundle, channels) {
  const KIND_AUTH = 22242;
  const sks = [
    controlGroupKey(bundle.community_root, bundle.community_id, bundle.root_epoch).sk,
    ...channels.map((c) => channelGroupKey(bundle.community_root, c.id, bundle.root_epoch).sk),
  ];
  return sks.map((sk) => {
    const pubkey = getPublicKey(sk);
    return (relayUrl, challenge) => ({
      ...finalizeEvent(
        {
          kind: KIND_AUTH,
          content: "",
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          created_at: Math.floor(Date.now() / 1000),
        },
        sk,
      ),
      pubkey,
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${e.message}`);
    process.exit(1);
  });
}

export { parseInvite, resolveBundle, discoverChannels, readChannel };
