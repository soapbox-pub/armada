#!/usr/bin/env node
/**
 * Concord voice bots — call-UI test harness.
 *
 * Joins N throwaway members to a Concord channel's call (CORD-07) from an invite
 * link: each gets a kind-0 profile and a guestbook join, mints its own SFU token
 * from the blind broker with the channel's voice key (§2), connects to LiveKit in
 * a headless Chromium page with per-sender E2EE (§3), and heartbeats `joined`
 * presence (§4) so the client verifies it as a member. `left` is sent on exit.
 *
 * Usage:
 *   node scripts/voicebots.mjs <invite-url> [options]
 *
 * Options:
 *   --count <n>          Number of bots (default 4)
 *   --channel <name|id>  Channel name or id hex prefix (default "general"; first match)
 *   --broker <origin>    AV broker origin (default: community av_brokers, else https://armada.buzz)
 *   --audio              Publish a synthetic "talking" tone (drives speaking indicators)
 *   --video              Publish Chromium's fake camera pattern
 *   --reactions          Float a random emoji from a random bot every ~15s
 *   --hands              Bots raise/lower their hand now and then
 *   --dual               Also announce an iroh `joined` (§4 Transports) beside the brokered one,
 *                        as a bot simulcasting to Vector would, and now and then leave and rejoin
 *                        that side with a `left` naming `["transport","iroh"]`. The endpoint is
 *                        random and nothing listens on it, so Vector peers can't actually dial it
 *   --bridge             With --dual, tag the brokered `joined` `["bridge","iroh"]` (an Armada
 *                        extension: the bot claims to relay the peer-to-peer call into the SFU).
 *                        Presence only; no audio is relayed
 *   --headed             Show the Chromium window
 *
 * Needs Playwright's Chromium (`npx playwright install chromium`). Stop: Ctrl-C.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { chromium } from "playwright";

import {
  RelayPool,
  STOCK_RELAYS,
  buildInfo,
  buildRumor,
  channelGroupKey,
  groupKey,
  guestbookJoin,
  hkdf32,
  log,
  parseInvite,
  readControlEditions,
  resolveBundle,
} from "./spambot.mjs";

const KIND_SEAL_ENCRYPTED = 20013;
const KIND_WRAP_EPHEMERAL = 21059;
const KIND_VOICE_PRESENCE = 23313;
const KIND_HTTP_AUTH = 27235;
const KIND_PROFILE = 0;
const DEFAULT_BROKER = "https://av.armada.buzz";
const te = new TextEncoder();

const BOT_NAMES = [
  "Ada", "Basil", "Cleo", "Dmitri", "Esme", "Felix", "Greta", "Hugo", "Iris", "Jonah",
  "Kira", "Leo", "Mina", "Nico", "Opal", "Pavel", "Quinn", "Rosa", "Silas", "Tess",
];
const EMOJI = ["👍", "😂", "❤️", "🎉", "🔥", "👏", "😮", "🙌"];

// CORD-07 §1 derivations (mirror src/concord/lib/derive.ts).
const voiceGroupKey = (secretHex, channelIdHex, epoch) =>
  groupKey(secretHex, "concord/voice-signer", channelIdHex, epoch);
const voiceMediaKey = (secretHex, channelIdHex, epoch) =>
  hkdf32(hexToBytes(secretHex), buildInfo("concord/voice-media", hexToBytes(channelIdHex), BigInt(epoch)));
const voiceSenderKey = (mediaKey, identity) =>
  hkdf32(mediaKey, buildInfo("concord/voice-sender", sha256(te.encode(identity))));

function parseArgs(argv) {
  const opts = { count: 4, channel: "general", broker: null, audio: false, video: false, reactions: false, hands: false, dual: false, bridge: false, headed: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") opts.count = Number(argv[++i]);
    else if (a === "--channel") opts.channel = argv[++i];
    else if (a === "--broker") opts.broker = argv[++i];
    else if (a === "--audio") opts.audio = true;
    else if (a === "--video") opts.video = true;
    else if (a === "--reactions") opts.reactions = true;
    else if (a === "--hands") opts.hands = true;
    else if (a === "--dual") opts.dual = true;
    else if (a === "--bridge") opts.bridge = true;
    else if (a === "--headed") opts.headed = true;
    else rest.push(a);
  }
  opts.invite = rest[0] ?? process.env.ARMADA_INVITE;
  if (!opts.invite) throw new Error("usage: node scripts/voicebots.mjs <invite-url> [--count n] [--channel name]");
  if (!Number.isInteger(opts.count) || opts.count < 1) throw new Error("--count must be a positive integer");
  if (opts.bridge && !opts.dual) throw new Error("--bridge needs --dual");
  return opts;
}

function canonicalOrigin(input) {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:") return null;
    const port = url.port && url.port !== "443" ? `:${url.port}` : "";
    return `https://${url.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
}

/** §5 tie-break: smallest sha256(room || origin) first. */
function orderBrokers(roomHex, origins) {
  const rank = (o) => bytesToHex(sha256(new Uint8Array([...hexToBytes(roomHex), ...te.encode(o)])));
  return [...new Set(origins.map(canonicalOrigin).filter(Boolean))].sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
}

/** §2 token grant: kind-27235 signed by voice_key.sk, sent as `Concord <b64>`. */
async function fetchAvToken(origin, voice) {
  const url = `${origin}/.well-known/concord/av/${voice.pk}`;
  const grant = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      content: "",
      tags: [["u", url], ["method", "GET"], ["nonce", bytesToHex(generateSecretKey())]],
      created_at: Math.floor(Date.now() / 1000),
    },
    voice.sk,
  );
  const res = await fetch(url, {
    headers: { Authorization: `Concord ${Buffer.from(JSON.stringify(grant)).toString("base64")}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status} from ${origin}`);
  const data = await res.json();
  if (!data.token || !data.url || !data.identity) throw new Error(`malformed token response from ${origin}`);
  return { token: data.token, url: data.url, identity: data.identity, origin };
}

async function fetchAvTokenFromAny(origins, voice) {
  let lastError;
  for (const origin of origins) {
    try {
      return await fetchAvToken(origin, voice);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("no broker");
}

const IROH_RELAY = "https://use1-1.relay.n0.iroh.iroh.link./";

/** The tags a brokered `joined` carries beyond the binding. */
function brokeredTags(bot) {
  const tags = [["identity", bot.av.identity], ["broker", bot.av.origin]];
  if (bot.hand) tags.push(["hand", "1"]);
  if (bot.bridge && bot.iroh) tags.push(["bridge", "iroh"]);
  return tags;
}

/** §4 presence: kind-23313 rumor, sealed by the bot, in an ephemeral 21059 wrap at the channel address. */
function presenceWrap(bot, ctx, status, extra = [], side = brokeredTags) {
  const tags = [["channel", ctx.channel.id], ["epoch", String(ctx.epoch)]];
  if (status === "joined") tags.push(...side(bot));
  tags.push(...extra);
  const rumor = buildRumor({ kind: KIND_VOICE_PRESENCE, content: status, tags, pubkey: bot.pk, ms: Date.now() });
  const seal = finalizeEvent(
    {
      kind: KIND_SEAL_ENCRYPTED,
      content: nip44Encrypt(JSON.stringify(rumor), ctx.stream.convKey),
      tags: [],
      created_at: rumor.created_at,
    },
    bot.sk,
  );
  return finalizeEvent(
    {
      kind: KIND_WRAP_EPHEMERAL,
      content: nip44Encrypt(JSON.stringify(seal), ctx.stream.convKey),
      tags: [["p", getPublicKey(generateSecretKey())]],
      created_at: Math.floor(Date.now() / 1000),
    },
    ctx.stream.sk,
  );
}

async function announce(pool, ctx, bot, status, extra, side) {
  const res = await pool.publishToAny(ctx.relays, presenceWrap(bot, ctx, status, extra, side));
  if (!res.ok) log(`${bot.name}: presence ${status} rejected: ${res.message}`);
  return res.ok;
}

/** The iroh side of a dual bot: a `joined` naming its endpoint, or a `left` naming the transport alone. */
function announceIroh(pool, ctx, bot, status) {
  if (status === "left") return announce(pool, ctx, bot, "left", [["transport", "iroh"]]);
  return announce(pool, ctx, bot, "joined", [], (b) => [
    ["transport", "iroh"],
    ["endpoint", b.iroh.endpoint],
    ["relay", IROH_RELAY],
  ]);
}

const freshIroh = () => ({ endpoint: bytesToHex(generateSecretKey()) });

// ---------------------------------------------------------------------------
// Headless media client
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html><meta charset="utf-8"><title>voicebot</title>
<script src="/livekit.umd.js"></script>
<script>
const LK = window.LivekitClient;
class SenderKeyProvider extends LK.BaseKeyProvider {
  constructor() { super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 }); }
  async setSenderMaterial(hex, identity) {
    const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits", "deriveKey"]);
    this.onSetEncryptionKey(key, identity);
  }
}

// A tone whose gain follows a random talk/pause schedule, so the SFU's
// audio-level detection marks the bot as speaking in bursts.
function talkingTrack() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 140 + Math.random() * 120;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  const loop = () => {
    const talking = Math.random() < 0.35;
    const ms = talking ? 1500 + Math.random() * 4000 : 3000 + Math.random() * 9000;
    gain.gain.setTargetAtTime(talking ? 0.05 : 0, ctx.currentTime, 0.05);
    if (talking) osc.frequency.setTargetAtTime(120 + Math.random() * 160, ctx.currentTime, 0.3);
    setTimeout(loop, ms);
  };
  loop();
  return dest.stream.getAudioTracks()[0];
}

window.joinBot = async ({ url, token, identity, materialHex, audio, video }) => {
  const keyProvider = new SenderKeyProvider();
  const worker = new Worker("/e2ee.worker.mjs", { type: "module" });
  const room = new LK.Room({ e2ee: { keyProvider, worker }, dynacast: true });
  window.room = room;
  await keyProvider.setSenderMaterial(materialHex, identity);
  await room.setE2EEEnabled(true);
  room.on(LK.RoomEvent.Disconnected, (reason) => console.log("disconnected", reason));
  await room.connect(url, token, { autoSubscribe: false });
  if (audio) {
    await room.localParticipant.publishTrack(new LK.LocalAudioTrack(talkingTrack()), { source: LK.Track.Source.Microphone });
  }
  if (video) {
    const cam = await LK.createLocalVideoTrack({ resolution: LK.VideoPresets.h360.resolution });
    await room.localParticipant.publishTrack(cam, { source: LK.Track.Source.Camera });
  }
  return room.localParticipant.identity;
};
window.leaveBot = async () => { await window.room?.disconnect(); };
</script>`;

function startAssetServer() {
  const lk = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "livekit-client", "dist");
  const files = {
    "/": ["text/html", PAGE],
    "/livekit.umd.js": ["text/javascript", readFileSync(join(lk, "livekit-client.umd.js"))],
    "/e2ee.worker.mjs": ["text/javascript", readFileSync(join(lk, "livekit-client.e2ee.worker.mjs"))],
  };
  const server = createServer((req, res) => {
    const file = files[new URL(req.url, "http://x").pathname];
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file[0] }).end(file[1]);
  });
  // localhost so the page is a secure context (WebCrypto, encoded transforms).
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const invite = parseInvite(opts.invite);

  const bots = [];
  const pool = new RelayPool(() => bots.map((b) => b.sk));

  const bundle = await resolveBundle(pool, invite);
  log(`community "${bundle.name}" (${bundle.community_id.slice(0, 12)}…), relays: ${bundle.relays.join(", ")}`);

  const editions = await readControlEditions(pool, bundle);
  const channels = [];
  let metadata = {};
  for (const [eid, ed] of editions) {
    try {
      const def = JSON.parse(ed.content);
      if (ed.vsk === "0") metadata = def;
      if (ed.vsk === "2" && !def.deleted && !def.private) channels.push({ id: eid, name: def.name ?? "channel" });
    } catch { /* skip */ }
  }
  const want = opts.channel.toLowerCase().replace(/^#/, "");
  const matches = channels.filter((c) => c.name.toLowerCase() === want || c.id.startsWith(want));
  if (matches.length === 0) {
    throw new Error(`no public channel "${opts.channel}" (have: ${channels.map((c) => `#${c.name} ${c.id.slice(0, 8)}`).join(", ")})`);
  }
  if (matches.length > 1) {
    log(`"${opts.channel}" matches ${matches.length} channels (${matches.map((c) => c.id.slice(0, 8)).join(", ")}); using ${matches[0].id.slice(0, 8)} — pass --channel <id prefix> to choose`);
  }
  const channel = matches[0];

  // Public channels are keyed by community_root at the root epoch.
  const epoch = bundle.root_epoch;
  const voice = voiceGroupKey(bundle.community_root, channel.id, epoch);
  const mediaKey = voiceMediaKey(bundle.community_root, channel.id, epoch);
  const ctx = { channel, epoch, relays: bundle.relays, stream: channelGroupKey(bundle.community_root, channel.id, epoch) };

  const communityBrokers = Array.isArray(metadata.av_brokers) ? metadata.av_brokers : [];
  const brokers = opts.broker
    ? [canonicalOrigin(opts.broker)]
    : communityBrokers.length > 0
      ? orderBrokers(voice.pk, communityBrokers)
      : [DEFAULT_BROKER];
  log(`channel #${channel.name} (${channel.id.slice(0, 12)}…), room ${voice.pk.slice(0, 12)}…, brokers: ${brokers.join(", ")}`);

  const server = await startAssetServer();
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("leaving…");
    await Promise.allSettled(bots.filter((b) => b.av).map((b) => announce(pool, ctx, b, "left")));
    await Promise.allSettled(bots.map((b) => b.page?.evaluate(() => window.leaveBot()).catch(() => {})));
    await browser.close().catch(() => {});
    server.close();
    pool.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < opts.count; i++) {
    const sk = generateSecretKey();
    bots.push({
      sk,
      pk: getPublicKey(sk),
      name: `${names[i % names.length]} (bot)`,
      hand: false,
      iroh: opts.dual ? freshIroh() : null,
      bridge: opts.bridge,
    });
  }

  await Promise.all(
    bots.map(async (bot) => {
      const profile = finalizeEvent(
        {
          kind: KIND_PROFILE,
          content: JSON.stringify({ name: bot.name, about: "Armada voice test bot (scripts/voicebots.mjs)" }),
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
        },
        bot.sk,
      );
      const [p, g] = await Promise.all([
        pool.publishToAny([...new Set([...bundle.relays, ...STOCK_RELAYS])], profile),
        guestbookJoin(pool, bundle, bot),
      ]);
      if (!p.ok) log(`${bot.name}: profile rejected: ${p.message}`);
      if (!g.ok) log(`${bot.name}: guestbook join rejected: ${g.message}`);

      bot.av = await fetchAvTokenFromAny(brokers, voice);
      const context = await browser.newContext();
      bot.page = await context.newPage();
      bot.page.on("console", (m) => {
        if (m.type() === "error" || m.text().startsWith("disconnected")) log(`${bot.name} [page]: ${m.text()}`);
      });
      await bot.page.goto(base);
      // Announce before connecting so the client verifies the tile from the first frame.
      await announce(pool, ctx, bot, "joined");
      if (bot.iroh) await announceIroh(pool, ctx, bot, "joined");
      await bot.page.evaluate((args) => window.joinBot(args), {
        url: bot.av.url,
        token: bot.av.token,
        identity: bot.av.identity,
        materialHex: bytesToHex(voiceSenderKey(mediaKey, bot.av.identity)),
        audio: opts.audio,
        video: opts.video,
      });
      log(`${bot.name} joined (npub pk ${bot.pk.slice(0, 12)}…, sfu identity ${bot.av.identity}${bot.iroh ? ", also on iroh" : ""})`);

      // §4 heartbeat at 80–100% of 30s, each side's.
      const beat = async () => {
        if (shuttingDown) return;
        await announce(pool, ctx, bot, "joined").catch((e) => log(`${bot.name}: heartbeat error ${e.message}`));
        if (bot.iroh) await announceIroh(pool, ctx, bot, "joined").catch((e) => log(`${bot.name}: iroh heartbeat error ${e.message}`));
        setTimeout(beat, 30_000 * (0.8 + Math.random() * 0.2));
      };
      setTimeout(beat, 30_000 * (0.8 + Math.random() * 0.2));
    }),
  );
  log(`${bots.length} bot(s) in #${channel.name}. Ctrl-C to leave.`);

  while (!shuttingDown) {
    await sleep(15_000 * (0.5 + Math.random()));
    if (shuttingDown) break;
    if (opts.reactions) {
      const bot = pick(bots);
      await announce(pool, ctx, bot, "joined", [["react", pick(EMOJI), crypto.randomUUID()]]).catch(() => {});
    }
    if (opts.hands && Math.random() < 0.4) {
      const bot = pick(bots);
      bot.hand = !bot.hand;
      log(`${bot.name} ${bot.hand ? "raised" : "lowered"} their hand`);
      await announce(pool, ctx, bot, "joined").catch(() => {});
    }
    if (opts.dual && Math.random() < 0.3) {
      const bot = pick(bots);
      if (bot.iroh) {
        bot.iroh = null;
        log(`${bot.name} left the iroh side`);
        await announceIroh(pool, ctx, bot, "left").catch(() => {});
      } else {
        bot.iroh = freshIroh();
        log(`${bot.name} rejoined the iroh side`);
        await announceIroh(pool, ctx, bot, "joined").catch(() => {});
      }
      // The bridge tag rides the brokered side, so it follows the change at once.
      if (bot.bridge) await announce(pool, ctx, bot, "joined").catch(() => {});
    }
  }
}

main().catch((e) => {
  console.error(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
