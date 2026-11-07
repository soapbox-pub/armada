// Browser-side seed harness for a populated Concord community, used by
// `scripts/perf-profile.mjs` (bulk, `__armadaSeedConcord`) and by
// `e2e/landing-screenshots.spec.ts` (a scripted conversation with roles,
// categories, replies, reactions and threads, `__armadaSeedConcordScript`).
//
// Mints a real community (CORD-01 ids and keys), writes its genesis control
// editions — sealed and wrapped exactly as `publishEdition` does, then opened
// and stored through the production `writeOpened` — and fills its channels
// with chat rumors through `writeRumors`, the writer the decode path feeds. The
// viewer's membership goes where `useCommunityList` reads it: the folded cache
// AND a real kind-33302 fragment in `main`, since without the fragment the
// list query can settle empty before the folded cache is read.
//
// Nothing here touches a relay. The community names an unroutable relay, and
// the harness answers whatever the app sends it.
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, nip44 } from "nostr-tools";

import { buildConcordCommentTags } from "@/concord/lib/chat";
import { withChannelCategory } from "@/concord/lib/channelCategory";
import { withChannelView } from "@/concord/lib/channelView";
import { mintCommunity } from "@/concord/lib/community";
import { toJoinMaterial, communityListFoldKey, type CommunityList } from "@/concord/lib/communityList";
import {
  buildChannelEdition,
  buildGrantEdition,
  buildMetadataEdition,
  buildRoleEdition,
  currentControlWriteGroup,
  sealEdition,
} from "@/concord/lib/control";
import { encryptImageBlob } from "@/concord/lib/image";
import { KIND_COMMENT, KIND_COMMUNITY_LIST_FRAG, KIND_REACTION } from "@/concord/lib/kinds";
import { fragment, serializeFragList } from "@/concord/lib/listFrag";
import { EVERYONE_DEFAULT, hexToColor } from "@/concord/lib/roles";
import { writeOpened, writeRumors } from "@/concord/lib/rumorStore";
import { buildRumor, channelBindingTags, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import { channelGroupKey, editionBinding, everyoneLocator } from "@/concord/lib/derive";
import { buildEditionRumor } from "@/concord/lib/edition";
import { everyoneToJSON, VSK_RANKED_ROLE } from "@/concord/lib/roster";
import { KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { queryChannelRumors, readStreamCursor } from "@/concord/lib/rumorStore";
import { writeFolded } from "@/lib/foldedCache";
import { appEventStore } from "@/lib/db/mainEventStore";

import type { OpenedChat } from "@/concord/lib/chat";
import type { NostrEvent } from "nostr-tools";
import type { Community, ImagePointer } from "@/concord/lib/types";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface ConcordSeedPayload {
  /** The viewer's secret key, hex. They own the community. */
  sk: string;
  /** Other members' pubkeys, hex — the authors that aren't the viewer. */
  others: string[];
  /** Messages per channel; the first channel is the big one. */
  channelSizes: number[];
  /** Line pool; varied so the flood heuristic sees conversation, not spam. */
  lines: string[];
  /**
   * Seed the community as a fresh device holds it: every message becomes a real
   * wrap (returned, for the harness relay to serve), and only each channel's
   * newest `localNewest` are stored. Every message is the viewer's, since only
   * the viewer can sign a seal here.
   */
  relayHistory?: { localNewest: number };
  /** Switch the community to the vsk-13 Roster (CORD-04 §2), so the owner's background duties keep running. */
  ranked?: boolean;
}

export interface ConcordSeedResult {
  communityId: string;
  channelIds: string[];
  /** With `relayHistory`: every chat wrap, for the harness relay. */
  wraps?: NostrEvent[];
}

declare global {
  interface Window {
    __armadaSeedConcord?: (payload: ConcordSeedPayload) => Promise<ConcordSeedResult>;
    __armadaSeedConcordScript?: (payload: ScriptedSeedPayload) => Promise<ScriptedSeedResult>;
    __armadaConcordCoverage?: typeof concordCoverage;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function random32(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function seed(p: ConcordSeedPayload): Promise<ConcordSeedResult> {
  const sk = hexToBytes(p.sk);
  const signer = { signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk) };
  const self = finalizeEvent({ kind: 1, content: "", tags: [], created_at: 0 }, sk).pubkey;
  localStorage.setItem(`armada:relay-prompt-shown:${self}`, "1");

  const { community, generalChannelId } = mintCommunity("Perf Harbor", self, ["wss://relay.invalid"]);
  const control = currentControlWriteGroup(community);
  const channelIds = [generalChannelId, ...p.channelSizes.slice(1).map(() => random32())];

  // Genesis: the metadata edition, then one edition per channel.
  const genesis = [
    buildMetadataEdition(community.id, { name: community.name, relays: community.relays }, { actorPubkey: self, version: 1n }),
    ...channelIds.map((id, i) =>
      buildChannelEdition(id, { name: i === 0 ? "general" : `channel-${i}`, private: false }, { actorPubkey: self, version: 1n }),
    ),
  ];
  if (p.ranked) {
    const legacy = channelIds.map((id) => bytesToHex(id)).sort();
    genesis.push(
      buildEditionRumor({
        vsk: VSK_RANKED_ROLE,
        entityId: everyoneLocator(community.id),
        version: 1n,
        content: everyoneToJSON(EVERYONE_DEFAULT, legacy),
        actorPubkey: self,
        binding: editionBinding(community.id),
      }),
    );
  }
  const opened = await Promise.all(genesis.map(async (r) => openWrap(await sealEdition(r, control, signer), control)));
  await writeOpened(community.idHex, opened, "control", { refounded: false });

  // Chat: spread over ~90 days, mostly the viewer (exempt from flood folding).
  const nowMs = Date.now() - 60_000;
  const span = 90 * 24 * 3600 * 1000;
  const wraps: NostrEvent[] = [];
  for (const [ci, size] of p.channelSizes.entries()) {
    const channelIdHex = bytesToHex(channelIds[ci]);
    const batch: OpenedChat[] = [];
    for (let i = 0; i < size; i++) {
      const author = p.relayHistory || i % 3 === 0 || p.others.length === 0 ? self : p.others[i % p.others.length];
      const ms = Math.floor(nowMs - span + (span * i) / size);
      const content = `${p.lines[(i + ci) % p.lines.length]} (#${i})`;
      const rumor = buildRumor({ kind: 9, content, tags: channelBindingTags(channelIdHex, 0n), pubkey: author, ms });
      batch.push({
        rumorId: rumor.id,
        author,
        kind: 9,
        content,
        tags: rumor.tags,
        ms,
        createdAt: rumor.created_at,
        channelIdHex,
        epoch: 0n,
      });
      if (p.relayHistory) {
        // The production wrap, re-signed at the message's own time (CORD-01: never backdated).
        const group = channelGroupKey(community.root, channelIds[ci], 0);
        const w = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, signer), group);
        wraps.push(finalizeEvent({ kind: w.kind, content: w.content, tags: w.tags, created_at: rumor.created_at }, group.sk));
      }
    }
    const local = p.relayHistory ? batch.slice(-p.relayHistory.localNewest) : batch;
    for (let i = 0; i < local.length; i += 500) await writeRumors(community.idHex, local.slice(i, i + 500));
  }

  await writeMembership(community, sk, self);
  return { communityId: community.idHex, channelIds: channelIds.map(bytesToHex), ...(p.relayHistory ? { wraps } : {}) };
}

/** Per channel: rumors on this device, and whether its history walk reached the bottom. */
async function concordCoverage(communityId: string, channelIds: string[]) {
  return Promise.all(channelIds.map(async (id) => ({
    stored: (await queryChannelRumors(communityId, id, { limit: 100_000 })).length,
    exhausted: Boolean((await readStreamCursor(id))?.exhausted),
  })));
}

/**
 * Membership: the folded cache the list boots from, and a real fragment.
 * `communities` in rail order.
 */
async function writeMembership(community: Community | Community[], sk: Uint8Array, self: string): Promise<void> {
  const communities = Array.isArray(community) ? community : [community];
  const list: CommunityList = {
    entries: communities.map((c, i) => {
      const jm = toJoinMaterial(c, { relays: c.relays });
      return { community_id: c.idHex, seed: jm, current: jm, added_at: Date.now() - (communities.length - i) * 1000 };
    }),
    tombstones: [],
  };
  await writeFolded(communityListFoldKey(self), { event: null, list });
  const [frag] = fragment(list);
  const content = nip44.v2.encrypt(serializeFragList(frag), nip44.v2.utils.getConversationKey(sk, self));
  const event = finalizeEvent(
    { kind: KIND_COMMUNITY_LIST_FRAG, tags: [["d", "0"]], content, created_at: Math.floor(Date.now() / 1000) },
    sk,
  );
  await (await appEventStore()).event(event);
}

// ── Scripted communities (landing screenshots) ──────────────────────────────

/** One rumor in a scripted channel. */
export interface ScriptedMessage {
  /** A local handle other messages can point at (replies, reactions, threads). */
  key?: string;
  /** Index into the community's `channels`. */
  channel: number;
  /** Author pubkey, hex. */
  author: string;
  /** 9 (message, the default), 7 (reaction) or 1111 (thread reply). */
  kind?: number;
  content: string;
  /** Seconds before now. */
  agoSec: number;
  /** Inline (NIP-C7 `q`) reply to the message with this key. */
  quote?: string;
  /** A reaction's target, or a thread reply's parent, by key. */
  target?: string;
  tags?: string[][];
}

export interface ScriptedCommunity {
  name: string;
  description?: string;
  /** Icon image as SVG markup, encrypted into a real pointer (see `seedIcon`). */
  iconSvg?: string;
  channels: Array<{ name: string; category?: string; forum?: boolean }>;
  /** Server-scope roles, highest authority first; `members` are pubkeys (hex). */
  roles?: Array<{ name: string; color: string; members: string[]; hoist?: boolean }>;
  messages: ScriptedMessage[];
}

export interface ScriptedSeedPayload {
  /** The viewer's secret key, hex. They own every community. */
  sk: string;
  /** Rail order; the first is the one the screenshots open. */
  communities: ScriptedCommunity[];
}

export interface ScriptedSeedResult {
  communities: Array<{ communityId: string; channelIds: string[] }>;
}

/**
 * An icon behind a real, encrypted CORD-02 pointer, with its plaintext already
 * in the content-addressed cache `decryptImageBytes` reads before it fetches
 * anything, so the app renders it through the production path and the
 * pointer's unroutable URL is never dialed.
 */
async function seedIcon(svg: string): Promise<ImagePointer> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const { key, nonce, hash } = await encryptImageBlob(blob);
  const cache = await caches.open("concord-images");
  await cache.put(`/${hash}`, new Response(blob, { headers: { "Content-Type": "image/svg+xml" } }));
  return { url: `https://blossom.invalid/${hash}`, key, nonce, hash };
}

async function seedScripted(p: ScriptedSeedPayload): Promise<ScriptedSeedResult> {
  const sk = hexToBytes(p.sk);
  const signer = { signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk) };
  const self = finalizeEvent({ kind: 1, content: "", tags: [], created_at: 0 }, sk).pubkey;
  localStorage.setItem(`armada:relay-prompt-shown:${self}`, "1");

  const minted: Community[] = [];
  const results: ScriptedSeedResult["communities"] = [];
  const nowMs = Date.now();

  for (const spec of p.communities) {
    const { community, generalChannelId } = mintCommunity(spec.name, self, ["wss://relay.invalid"]);
    const control = currentControlWriteGroup(community);
    const channelIds = spec.channels.map((_, i) => (i === 0 ? generalChannelId : random32()));
    const common = { actorPubkey: self, version: 1n };

    const roles = (spec.roles ?? []).map((r, i) => ({
      role: {
        roleId: bytesToHex(random32()),
        name: r.name,
        position: i + 1,
        permissions: 0n,
        scope: { kind: "server" as const },
        color: hexToColor(r.color),
        ...(r.hoist ? { display: true } : {}),
      },
      members: r.members,
    }));
    const grants = new Map<string, string[]>();
    for (const { role, members } of roles) {
      for (const m of members) grants.set(m, [...(grants.get(m) ?? []), role.roleId]);
    }

    const genesis = [
      buildMetadataEdition(
        community.id,
        {
          name: spec.name,
          relays: community.relays,
          ...(spec.description ? { description: spec.description } : {}),
          ...(spec.iconSvg ? { icon: await seedIcon(spec.iconSvg) } : {}),
        },
        common,
      ),
      ...spec.channels.map((ch, i) => {
        let metadata = withChannelCategory({ name: ch.name, private: false }, ch.category);
        if (ch.forum) metadata = withChannelView(metadata, "forum");
        return buildChannelEdition(channelIds[i], metadata, common);
      }),
      ...roles.map(({ role }) => buildRoleEdition(role, common)),
      ...[...grants].map(([member, roleIds]) => buildGrantEdition(community.id, { member, roleIds }, common)),
    ];
    const opened = await Promise.all(genesis.map(async (r) => openWrap(await sealEdition(r, control, signer), control)));
    await writeOpened(community.idHex, opened, "control", { refounded: false });

    // Chat, in script order so a key is always defined before it is pointed at.
    const byKey = new Map<string, NostrRumor>();
    const batch: OpenedChat[] = [];
    for (const m of spec.messages) {
      const kind = m.kind ?? 9;
      const channelIdHex = bytesToHex(channelIds[m.channel]);
      const tags = [...channelBindingTags(channelIdHex, 0n)];
      const target = m.target ? byKey.get(m.target) : undefined;
      if (m.target && !target) throw new Error(`unknown target ${m.target}`);
      if (kind === KIND_COMMENT && target) tags.push(...buildConcordCommentTags(target));
      if (kind === KIND_REACTION && target) tags.push(["e", target.id], ["p", target.pubkey]);
      if (m.quote) {
        const parent = byKey.get(m.quote);
        if (!parent) throw new Error(`unknown quote ${m.quote}`);
        tags.push(["q", parent.id, "", parent.pubkey]);
      }
      if (m.tags) tags.push(...m.tags);
      const ms = nowMs - m.agoSec * 1000;
      const rumor = buildRumor({ kind, content: m.content, tags, pubkey: m.author, ms });
      if (m.key) byKey.set(m.key, rumor);
      batch.push({
        rumorId: rumor.id,
        author: m.author,
        kind,
        content: m.content,
        tags: rumor.tags,
        ms,
        createdAt: rumor.created_at,
        channelIdHex,
        epoch: 0n,
      });
    }
    await writeRumors(community.idHex, batch);

    minted.push(community);
    results.push({ communityId: community.idHex, channelIds: channelIds.map(bytesToHex) });
  }

  await writeMembership(minted, sk, self);
  return { communities: results };
}

window.__armadaSeedConcord = seed;
window.__armadaSeedConcordScript = seedScripted;
window.__armadaConcordCoverage = concordCoverage;
