/**
 * Rotation handling at the hook level (CORD-05 §2/§4, CORD-06 §2/§3):
 *
 *   - `useRekeyWatch`'s ADOPT branch re-posts the adopting member's OWN live
 *     links at the fresh keys — only each creator holds a link's `signer_sk`
 *     (CORD-05 §4), so the Refounder alone can't refresh everyone's — while a
 *     link revoked on one device is never resurrected by another device's
 *     stale-but-newer Invite List copy (tombstones win terminally).
 *
 *   - `useChannelRekeyWatch` receives channel-scoped rotations (CORD-06 §2):
 *     adopts a fresh channel key from an authorized rotator, drops a channel
 *     it was removed from, and ignores an unauthorized rotator outright.
 *
 *   - `useRefound` rotates every held Private Channel (CORD-06 §3), sealed
 *     under the PRIOR root, delivering blobs to the keep-set only, and vends
 *     the post-rotation keys through its list snapshot and bundle refresh.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { getConversationKey } from "nostr-tools/nip44";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useSyncExternalStore, type ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { rehydrateCommunity } from "@/concord/lib/communityList";
import { refoundJournal, refoundJournalReady, writeRefoundJournal } from "@/concord/lib/refoundJournal";
import { buildGrantEdition, buildRoleEdition, currentControlWriteGroup, sealEdition } from "@/concord/lib/control";
import { adminRole, Permissions, type Role } from "@/concord/lib/roles";
import {
  baseRekeyGroupKey,
  bytesToHex,
  channelRekeyGroupKey,
  epochKeyCommitment,
  grantLocator,
  hex32,
  random32,
} from "@/concord/lib/derive";
import type { AuthorityCitation } from "@/concord/lib/edition";
import {
  mintLinkSigner,
  mintToken,
  parseBundleEvent,
  type InviteBundle,
} from "@/concord/lib/invite";
import { KIND_INVITE_LIST, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import {
  base64ToBytes,
  buildRekeyRumors,
  bytesToBase64,
  decodeWrappedKey,
  encodeWrappedKey,
  findBlob,
  groupRotations,
  myLocator,
  parseRekey,
  type RekeyBlob,
} from "@/concord/lib/rekey";
import { _configureAuthWaitForTests } from "@/concord/lib/planeSync";
import { openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { CommunityListEntry, JoinMaterial } from "@/concord/lib/communityList";
import type { Community, PrivateChannelKey } from "@/concord/lib/types";
import { openChannelSeal, sealChannelMetadata } from "@/concord/lib/channelSeal";
import { readChannelContent } from "@/concord/lib/control";

import { useChannelRekey, useChannelRekeyWatch, useLinkRefreshWatch, useRefound, useRefoundResume, useRekeyWatch } from "./useRekey";

import type { NUser } from "@nostrify/react/login";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  user: undefined as unknown,
  folded: undefined as unknown,
  entry: undefined as unknown,
  updateList: undefined as unknown,
  /** useDissolved's answer: `null` known alive, a ms dissolved, `undefined` still asking. */
  dissolved: null as number | null | undefined,
  editions: [] as Array<{ content: string; tags: string[][] }>,
  /** What the store folds to, when it holds more than the rendered fold. */
  stored: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded }),
  useDissolved: () => ({ data: h.dissolved }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: { content: string; tags: string[][] }) => {
    h.editions.push(rumor);
  },
  foldStoredControl: async () => h.stored ?? h.folded,
  withControlWrite: (_id: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => h.entry,
  useUpdateCommunityList: () => ({ mutateAsync: h.updateList }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RELAY = "wss://relay.test";

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

// FakeRelay never challenges NIP-42, so the sweep's auth gate can only ever
// poll out its 8s cap — once per Refounding. Same seam the other plane-sync
// suites use.
beforeAll(() => {
  _configureAuthWaitForTests({ maxWaitMs: 0 });
});

class FakeRelay {
  events: NostrEvent[] = [];
  published: NostrEvent[] = [];
  queries: Filter[] = [];
  /** Reject any publish whose author matches — a relay refusing one step. */
  refuseAuthor: string | undefined;
  /** Reject whatever this says to: a relay going away partway through. */
  refuse: ((ev: NostrEvent) => boolean) | undefined;

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.queries.push(...filters);
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      for (const ev of this.events) {
        const ok =
          (!f.kinds || f.kinds.includes(ev.kind)) &&
          (!f.authors || f.authors.includes(ev.pubkey)) &&
          (f.since === undefined || ev.created_at >= f.since) &&
          (f.until === undefined || ev.created_at <= f.until);
        if (ok) out.set(ev.id, ev);
      }
    }
    return [...out.values()].sort((a, b) => b.created_at - a.created_at).slice(0, filters[0]?.limit);
  }

  async event(ev: NostrEvent): Promise<void> {
    if (this.refuseAuthor && ev.pubkey === this.refuseAuthor) throw new Error("relay refused");
    if (this.refuse?.(ev)) throw new Error("relay refused");
    this.published.push(ev);
    this.events.push(ev);
  }
}

function member(sk = generateSecretKey()) {
  return {
    sk,
    pubkey: getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    nip44encrypt: (counterparty: string, plaintext: string) =>
      nip44Encrypt(plaintext, getConversationKey(sk, counterparty)),
    nip44decrypt: (counterparty: string, ciphertext: string) =>
      nip44Decrypt(ciphertext, getConversationKey(sk, counterparty)),
  };
}

function asNUser(m: ReturnType<typeof member>): NUser {
  return {
    pubkey: m.pubkey,
    signer: {
      signEvent: m.signEvent,
      nip44: {
        encrypt: async (pk: string, pt: string) => m.nip44encrypt(pk, pt),
        decrypt: async (pk: string, ct: string) => m.nip44decrypt(pk, ct),
      },
    },
  } as unknown as NUser;
}

const nowSecs = () => Math.floor(Date.now() / 1000);

function jmOf(c: Community, ownerPk: string): JoinMaterial {
  return {
    community_id: c.idHex,
    owner: ownerPk,
    owner_salt: bytesToHex(c.ownerSalt),
    community_root: bytesToHex(c.root),
    root_epoch: Number(c.rootEpoch),
    channels: c.privateChannels.map((ch) => ({
      id: bytesToHex(ch.id),
      key: bytesToHex(ch.key),
      epoch: Number(ch.epoch),
      name: ch.name,
    })),
    relays: c.relays,
    name: c.name,
  };
}

/** A complete, authorized, continuity-valid base rotation to the next epoch. */
async function rotationWraps(
  rotator: ReturnType<typeof member>,
  c: Community, // at the PRIOR epoch
  newRoot: Uint8Array,
  recipients: string[],
  publishMs: number,
  authority?: AuthorityCitation,
): Promise<NostrEvent[]> {
  const newEpoch = c.rootEpoch + 1n;
  const address = baseRekeyGroupKey(c.root, c.id, newEpoch);
  const prevCommit = bytesToHex(epochKeyCommitment(c.rootEpoch, c.root));
  const plain = bytesToBase64(encodeWrappedKey(new Uint8Array(32), newEpoch, newRoot));
  const blobs: RekeyBlob[] = recipients.map((pk) => ({
    locator: myLocator(rotator.pubkey, pk, "0".repeat(64), newEpoch),
    wrapped: rotator.nip44encrypt(pk, plain),
  }));
  const wraps: NostrEvent[] = [];
  for (const rumor of buildRekeyRumors(
    rotator.pubkey,
    { scope: { kind: "root" }, newEpoch, prevEpoch: c.rootEpoch, prevCommit },
    blobs,
    publishMs,
    authority,
  )) {
    wraps.push(await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, rotator), address));
  }
  return wraps;
}

/**
 * The control editions that entitle `memberPks` to `channelId`: the access
 * Role scoped to the channel, and the owner's Grant of it to each member.
 *
 * A Private Channel's scoped Roles ARE its access list (CORD-04 §2,
 * channelAccess.ts), and `useRefound` folds the plane itself rather than
 * trusting the rendered one — so a channel rotation's recipients are decided
 * by editions that actually landed, not by the injected fold. The Role carries
 * no permission bits: read access is key possession, never a permission
 * (CORD-04 §1).
 */
async function channelAccessEditions(
  community: Community,
  owner: ReturnType<typeof member>,
  channelId: Uint8Array,
  memberPks: string[],
): Promise<NostrEvent[]> {
  const control = currentControlWriteGroup(community);
  const roleId = bytesToHex(random32());
  const role: Role = {
    roleId,
    name: "sec",
    position: 5,
    permissions: 0n,
    scope: { kind: "channel", channelId: bytesToHex(channelId) },
    color: 0,
  };
  const out = [
    await sealEdition(buildRoleEdition(role, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
  ];
  for (const pk of memberPks) {
    out.push(
      await sealEdition(
        buildGrantEdition(community.id, { member: pk, roleIds: [roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    );
  }
  return out;
}

function foldedFor(ownerPk: string, icon?: InviteBundle["icon"], creatorPk?: string) {
  // Optionally grant a non-owner CREATE_INVITE (an admin role), so a link
  // creator's own bundle refresh is authorized — the honest-client gate on
  // useLinkRefreshWatch requires positive authority, not mere link possession.
  const roleId = "aa".repeat(32);
  const roster = creatorPk
    ? { roles: [adminRole(roleId)], grants: [{ member: creatorPk, roleIds: [roleId] }] }
    : { roles: [], grants: [] };
  return {
    ownerHex: ownerPk,
    banned: new Set<string>(),
    roster,
    metadata: { name: "Fleet", relays: [], ...(icon ? { icon } : {}) },
    headEditions: new Map(),
  } as unknown;
}

/**
 * A fold where `rotator` and `peer` hold the SAME admin role (equal rank,
 * position 1) under a third-party owner, with the rotator's Grant head synced
 * so their citation resolves — isolating CORD-06 §Authority's outrank rule
 * from the permission and citation gates in front of it.
 */
function peerAdminsFold(ownerPk: string, communityId: Uint8Array, rotatorPk: string, peerPk: string) {
  const roleId = "aa".repeat(32);
  const grantEid = bytesToHex(grantLocator(communityId, hex32(rotatorPk)));
  const grantHash = random32();
  const citation: AuthorityCitation = { entityId: hex32(grantEid), version: 1n, editionHash: grantHash };
  const fold = {
    ownerHex: ownerPk,
    banned: new Set<string>(),
    roster: {
      roles: [adminRole(roleId)],
      grants: [
        { member: rotatorPk, roleIds: [roleId] },
        { member: peerPk, roleIds: [roleId] },
      ],
    },
    metadata: { name: "Fleet", relays: [] },
    heads: new Map([[grantEid, { version: 1n, hash: grantHash }]]),
    headEditions: new Map(),
  } as unknown;
  return { fold, citation };
}

/** A complete channel-scoped rotation (CORD-06 §2/§3), sealed under `root`. */
async function channelRotationWraps(
  rotator: ReturnType<typeof member>,
  root: Uint8Array, // the community_root the rekey is sealed under (the PRIOR one for a Refounding)
  ch: Pick<PrivateChannelKey, "id" | "key" | "epoch">,
  newKey: Uint8Array,
  recipients: string[],
  publishMs: number,
  authority?: AuthorityCitation,
): Promise<NostrEvent[]> {
  const chNext = ch.epoch + 1n;
  const address = channelRekeyGroupKey(root, ch.id, chNext);
  const chIdHex = bytesToHex(ch.id);
  const plain = bytesToBase64(encodeWrappedKey(ch.id, chNext, newKey));
  const blobs: RekeyBlob[] = recipients.map((pk) => ({
    locator: myLocator(rotator.pubkey, pk, chIdHex, chNext),
    wrapped: rotator.nip44encrypt(pk, plain),
  }));
  const wraps: NostrEvent[] = [];
  for (const rumor of buildRekeyRumors(
    rotator.pubkey,
    {
      scope: { kind: "channel", channelId: ch.id },
      newEpoch: chNext,
      prevEpoch: ch.epoch,
      prevCommit: bytesToHex(epochKeyCommitment(ch.epoch, ch.key)),
    },
    blobs,
    publishMs,
    authority,
  )) {
    wraps.push(await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, rotator), address));
  }
  return wraps;
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

// ── useRekeyWatch: creator-side bundle refresh on adoption ─────────────────

describe("useRekeyWatch (CORD-05 §2 / CORD-06 §2)", () => {
  it(
    "adopting a rotation re-posts the member's OWN live links at the fresh keys — never a revoked one",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const me = member(); // a link-creating member, NOT the Refounder
      const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const newRoot = random32();
      const wraps = await rotationWraps(owner, community, newRoot, [owner.pubkey, me.pubkey], Date.now());

      // My Invite List, two device copies: device 1 revoked link B (tombstone,
      // older copy); device 2 — offline since before the revocation — wrote a
      // NEWER copy still listing B live. The refresh must post A and never B
      // (tombstones union and win terminally, CORD-05 §4).
      const linkA = mintLinkSigner();
      const linkB = mintLinkSigner();
      const tokenA = mintToken();
      const tokenB = mintToken();
      const listEntry = (token: Uint8Array, link: { sk: Uint8Array }) => ({
        token: bytesToHex(token),
        signer_sk: bytesToHex(link.sk),
        community_id: community.idHex,
        url: "",
        created_at: 1,
      });
      const listCopy = (list: object, createdAt: number) =>
        finalizeEvent(
          {
            kind: KIND_INVITE_LIST,
            content: nip44Encrypt(JSON.stringify(list), getConversationKey(me.sk, me.pubkey)),
            tags: [],
            created_at: createdAt,
          },
          me.sk,
        );
      const older = listCopy(
        { entries: [listEntry(tokenA, linkA)], tombstones: [{ token: bytesToHex(tokenB), community_id: community.idHex }] },
        nowSecs() - 100,
      );
      const newer = listCopy(
        { entries: [listEntry(tokenA, linkA), listEntry(tokenB, linkB)], tombstones: [] },
        nowSecs() - 50,
      );

      const relay = new FakeRelay();
      relay.events = [...wraps];
      h.pool = {
        relay: () => relay,
        query: async (filters: Filter[]) =>
          filters.some((f) => f.kinds?.includes(KIND_INVITE_LIST)) ? [newer, older] : [],
      };
      h.user = asNUser(me);
      const icon = { url: "https://cdn.example/icon.png", key: "6b".repeat(32), nonce: "6e".repeat(16), hash: "68".repeat(32) };
      h.folded = foldedFor(owner.pubkey, icon);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useRekeyWatch(community), { wrapper });

      // My blob is in the rotation: I adopt the new epoch…
      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-current",
              current: expect.objectContaining({ root_epoch: 1, community_root: bytesToHex(newRoot) }),
            }),
          ),
        { timeout: 10_000 },
      );

      // …and my live link's coordinate receives the refreshed bundle vending
      // the CURRENT keys — with the community icon intact (a refresh must not
      // degrade the link preview).
      await waitFor(() => expect(relay.published.some((e) => e.pubkey === linkA.pk)).toBe(true), {
        timeout: 10_000,
      });
      const refreshed = relay.published.find((e) => e.pubkey === linkA.pk)!;
      const vended = parseBundleEvent(refreshed, linkA.pk, tokenA, Date.now());
      expect(vended.root_epoch).toBe(1);
      expect(vended.community_root).toBe(bytesToHex(newRoot));
      expect(vended.icon).toEqual(icon);

      // The revoked link stays dead even though the NEWEST list copy carried
      // it live — a stale device can never resurrect a revoked link.
      await new Promise((r) => setTimeout(r, 150));
      expect(relay.published.some((e) => e.pubkey === linkB.pk)).toBe(false);
    },
  );

  it(
    "an EQUAL-RANK Refounder's exclusion is not honored (the Rotator must strictly outrank every removed target)",
    { timeout: 30_000 },
    async () => {
      // Same CORD-06 §Authority rule as the channel watcher: BAN is necessary
      // for a Refounding but not sufficient against ME — the Rotator must
      // strictly outrank every removed target, and a peer admin does not.
      // Their complete no-blob-for-me base rotation must not mark my
      // membership excluded.
      const owner = member();
      const me = member();
      const rotator = member();
      const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const { fold, citation } = peerAdminsFold(owner.pubkey, community.id, rotator.pubkey, me.pubkey);
      const wraps = await rotationWraps(rotator, community, random32(), [rotator.pubkey], Date.now(), citation);

      const relay = new FakeRelay();
      relay.events = [...wraps];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = fold;
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useRekeyWatch(community), { wrapper });

      await waitFor(
        () => expect(relay.queries.some((f) => f.kinds?.includes(1059))).toBe(true),
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(h.updateList).not.toHaveBeenCalledWith(expect.objectContaining({ type: "exclude" }));
    },
  );
});

// ── useRekeyWatch: stranded-joiner detection (CORD-05 §2 / CORD-06 §2) ──────

describe("useRekeyWatch stranded detection", () => {
  it(
    "a rotation PAST my epoch that predates my join and holds no blob for me marks me stranded",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const me = member();
      const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      // A complete `0→1` rotation carrying a blob ONLY for the owner, published
      // LONG before I joined — I landed on epoch 0 via a stale link. It advances
      // past the epoch I hold (0), so I'm stranded, not excluded.
      const staleMs = Date.now() - 60 * 60_000;
      const wraps = await rotationWraps(owner, community, random32(), [owner.pubkey], staleMs);

      const relay = new FakeRelay();
      relay.events = [...wraps];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      // I joined AFTER the rotation was published (stale-invite drop).
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: Date.now() } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useRekeyWatch(community), { wrapper });

      await waitFor(() => expect(result.current.stranded).toBe(true), { timeout: 10_000 });
      // Stranding is NOT exclusion: the entry is never marked excluded/removed.
      expect(h.updateList).not.toHaveBeenCalledWith(expect.objectContaining({ type: "exclude" }));
    },
  );
});

// ── useLinkRefreshWatch: creator-side stale-link roll-forward (CORD-05 §2) ──

describe("useLinkRefreshWatch", () => {
  afterEach(() => {
    h.dissolved = null;
  });

  /** A creator holding one live link for a community, mounted on the watch. */
  function mountCreatorWithLink() {
    const owner = member();
    const me = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const link = mintLinkSigner();
    const listEvent = finalizeEvent(
      {
        kind: KIND_INVITE_LIST,
        content: nip44Encrypt(
          JSON.stringify({
            entries: [
              { token: bytesToHex(mintToken()), signer_sk: bytesToHex(link.sk), community_id: community.idHex, url: "", created_at: 1 },
            ],
            tombstones: [],
          }),
          getConversationKey(me.sk, me.pubkey),
        ),
        tags: [],
        created_at: nowSecs() - 10,
      },
      me.sk,
    );
    const relay = new FakeRelay();
    let listReads = 0;
    h.pool = {
      relay: () => relay,
      query: async (filters: Filter[]) => {
        if (!filters.some((f) => f.kinds?.includes(KIND_INVITE_LIST))) return [];
        listReads += 1;
        return [listEvent];
      },
    };
    h.user = asNUser(me);
    h.folded = foldedFor(owner.pubkey, undefined, me.pubkey);
    const { wrapper } = makeWrapper();
    renderHook(() => useLinkRefreshWatch(community), { wrapper });
    return { relay, link, listReads: () => listReads };
  }

  it("never re-posts a dissolved community's links", { timeout: 30_000 }, async () => {
    h.dissolved = Date.now();
    const { relay, listReads } = mountCreatorWithLink();
    await new Promise((r) => setTimeout(r, 300));
    expect(listReads(), "not even the Invite List read").toBe(0);
    expect(relay.published).toHaveLength(0);
  });

  it("waits while the dissolved check is still asking", { timeout: 30_000 }, async () => {
    h.dissolved = undefined;
    const { relay, listReads } = mountCreatorWithLink();
    await new Promise((r) => setTimeout(r, 300));
    expect(listReads()).toBe(0);
    expect(relay.published).toHaveLength(0);
  });

  it(
    "a creator opening a community re-posts their live links at the current epoch",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const me = member(); // holds a live link, opened the community on a fresh device
      // The community is ALREADY on epoch 2 locally (e.g. rotated on another
      // device): the bundle the link vends must catch up to it.
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const rotatedRoot = random32();
      const community: Community = { ...base, root: rotatedRoot, rootEpoch: 2n };

      const link = mintLinkSigner();
      const token = mintToken();
      const listEvent = finalizeEvent(
        {
          kind: KIND_INVITE_LIST,
          content: nip44Encrypt(
            JSON.stringify({
              entries: [
                { token: bytesToHex(token), signer_sk: bytesToHex(link.sk), community_id: community.idHex, url: "", created_at: 1 },
              ],
              tombstones: [],
            }),
            getConversationKey(me.sk, me.pubkey),
          ),
          tags: [],
          created_at: nowSecs() - 10,
        },
        me.sk,
      );

      const relay = new FakeRelay();
      h.pool = {
        relay: () => relay,
        query: async (filters: Filter[]) =>
          filters.some((f) => f.kinds?.includes(KIND_INVITE_LIST)) ? [listEvent] : [],
      };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey, undefined, me.pubkey); // me holds CREATE_INVITE

      const { wrapper } = makeWrapper();
      renderHook(() => useLinkRefreshWatch(community), { wrapper });

      await waitFor(() => expect(relay.published.some((e) => e.pubkey === link.pk)).toBe(true), {
        timeout: 10_000,
      });
      const refreshed = relay.published.find((e) => e.pubkey === link.pk)!;
      const vended = parseBundleEvent(refreshed, link.pk, token, Date.now());
      // The link now vends the CURRENT epoch (2) and the rotated root — not the
      // dead epoch it was minted at.
      expect(vended.root_epoch).toBe(2);
      expect(vended.community_root).toBe(bytesToHex(rotatedRoot));
    },
  );
});

// ── useChannelRekeyWatch: per-channel adoption + removal (CORD-06 §2) ───────

describe("useChannelRekeyWatch (CORD-06 §2 channel rotations)", () => {
  function setupChannel() {
    const owner = member();
    const me = member();
    const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
    const community: Community = { ...base, privateChannels: [ch] };
    return { owner, me, community, ch };
  }

  it(
    "adopts a channel rotation carrying my blob: the channel moves to the fresh key at the next epoch",
    { timeout: 30_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      const newChKey = random32();
      const wraps = await channelRotationWraps(owner, community.root, ch, newChKey, [owner.pubkey, me.pubkey], Date.now());

      const relay = new FakeRelay();
      relay.events = [...wraps];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              communityId: community.idHex,
              channels: [
                expect.objectContaining({
                  id: bytesToHex(ch.id),
                  key: bytesToHex(newChKey),
                  epoch: 1,
                  name: "sec",
                }),
              ],
            }),
          ),
        { timeout: 10_000 },
      );
    },
  );

  it(
    "a complete channel rotation with NO blob for me (at/after my join) removes the channel from current",
    { timeout: 30_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      // Rotated AWAY from me: blob for the owner only, published after I joined.
      const wraps = await channelRotationWraps(owner, community.root, ch, random32(), [owner.pubkey], Date.now());

      const relay = new FakeRelay();
      relay.events = [...wraps];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      // Visible removal (§2): the channel drops out of `current`; `seed`
      // retains the original key (refreshChannels never touches it).
      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              communityId: community.idHex,
              channels: [],
            }),
          ),
        { timeout: 10_000 },
      );
    },
  );

  it(
    "a member who MISSED a rotation still learns they were removed (later epoch, not just +1)",
    { timeout: 30_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      // The channel rotated TWICE while I was away. I hold epoch 0, so the
      // epoch-1 address is stale history and epoch 2 is where the channel
      // actually lives — and neither carries a blob for me.
      const mid: PrivateChannelKey = { ...ch, key: random32(), epoch: 1n };
      const first = await channelRotationWraps(owner, community.root, ch, mid.key, [owner.pubkey], Date.now() - 1000);
      const second = await channelRotationWraps(owner, community.root, mid, random32(), [owner.pubkey], Date.now());

      const relay = new FakeRelay();
      // Only the LATER rotation is still served — the removal must not depend
      // on the one rotation my epoch could verify continuity against.
      relay.events = [...second];
      void first;
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              channels: [],
              // The cut is recorded at the epoch that actually excluded me.
              cuts: [expect.objectContaining({ id: bytesToHex(ch.id), epoch: 2 })],
            }),
          ),
        { timeout: 10_000 },
      );
    },
  );

  it(
    "catches up ACROSS a gap by walking the chain, ending on the newest verified key",
    { timeout: 30_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      // Two rotations happened while I was offline, and BOTH are still on the
      // relay — which is the "fetch the gap first" CORD-06 §2 prescribes. Each
      // one carries a blob for me, so every link is verifiable against the key
      // the previous link handed over.
      const midKey = random32();
      const mid: PrivateChannelKey = { ...ch, key: midKey, epoch: 1n };
      const finalKey = random32();
      const first = await channelRotationWraps(owner, community.root, ch, midKey, [owner.pubkey, me.pubkey], Date.now() - 1000);
      const second = await channelRotationWraps(owner, community.root, mid, finalKey, [owner.pubkey, me.pubkey], Date.now());

      const relay = new FakeRelay();
      relay.events = [...first, ...second];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              channels: [
                expect.objectContaining({
                  id: bytesToHex(ch.id),
                  key: bytesToHex(finalKey),
                  epoch: 2,
                  // Both superseded keys are retained: they read the history
                  // written under each earlier epoch (CORD-03 §3). Each
                  // carries its superseding rotation's publish time as the
                  // hard read cutoff.
                  priors: expect.arrayContaining([
                    expect.objectContaining({ key: bytesToHex(midKey), epoch: 1, retired_at: expect.any(Number) }),
                    expect.objectContaining({ key: bytesToHex(ch.key), epoch: 0, retired_at: expect.any(Number) }),
                  ]),
                }),
              ],
            }),
          ),
        { timeout: 10_000 },
      );
    },
  );

  it(
    "finishes a catch-up from the local store when the wire no longer re-serves the gap",
    { timeout: 30_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      // The same two-rotation gap as above, but split across two SESSIONS.
      // Session one ingests both rotations into the opened-event store and
      // advances the per-relay `since` cursor past them; session two therefore
      // sees nothing new on the wire and must complete the walk from the store
      // alone. This is the whole reason rotations are persisted: the window
      // heals a member who missed a rotation, and a member who missed one is
      // by definition not going to be handed it again on the next REQ.
      const midKey = random32();
      const mid: PrivateChannelKey = { ...ch, key: midKey, epoch: 1n };
      const finalKey = random32();
      const first = await channelRotationWraps(owner, community.root, ch, midKey, [owner.pubkey, me.pubkey], Date.now() - 1000);
      const second = await channelRotationWraps(owner, community.root, mid, finalKey, [owner.pubkey, me.pubkey], Date.now());

      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      // Session one: both rotations on the wire, ingested and cached.
      const online = new FakeRelay();
      online.events = [...first, ...second];
      h.pool = { relay: () => online, query: async () => [] };
      h.updateList = vi.fn(async () => {});
      const { wrapper: w1 } = makeWrapper();
      const session1 = renderHook(() => useChannelRekeyWatch(community), { wrapper: w1 });
      await waitFor(() => expect(h.updateList).toHaveBeenCalled(), { timeout: 10_000 });
      session1.unmount();

      // Session two: same held epoch (the list write is mocked, so nothing
      // moved), and the relay has nothing left to give.
      const offline = new FakeRelay();
      h.pool = { relay: () => offline, query: async () => [] };
      h.updateList = vi.fn(async () => {});
      const { wrapper: w2 } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper: w2 });

      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              channels: [
                expect.objectContaining({
                  id: bytesToHex(ch.id),
                  key: bytesToHex(finalKey),
                  epoch: 2,
                }),
              ],
            }),
          ),
        { timeout: 10_000 },
      );
    },
  );

  it(
    "does NOT adopt a far-ahead key whose chain it cannot verify (CORD-06 §2 continuity)",
    { timeout: 30_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      // A rotation at epoch 2 addressed to me, but built off an epoch-1 key I
      // never held and whose rotation is not on the relay — so `prevcommit`
      // proves nothing about the key in my hand. Waiving the check here is how
      // one rotator forks a lagging member onto a branch nobody can detect.
      const unseen: PrivateChannelKey = { ...ch, key: random32(), epoch: 1n };
      const forked = await channelRotationWraps(owner, community.root, unseen, random32(), [owner.pubkey, me.pubkey], Date.now());

      const relay = new FakeRelay();
      relay.events = [...forked];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      await waitFor(
        () => expect(relay.queries.some((f) => f.kinds?.includes(1059))).toBe(true),
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 200));
      // Neither adopted nor removed: someone addressed me, so this is a gap to
      // keep polling on, not a read-cut. Acting either way would be wrong.
      expect(h.updateList).not.toHaveBeenCalled();
    },
  );

  it(
    "retries a chain that stalled mid-window once the missing link arrives",
    { timeout: 60_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      // I hold epoch 0. Two rotations are reachable — epoch 1 (verifiable off
      // my key) and epoch 3 (addressed to me, but built off the epoch-2 key,
      // whose rotation hasn't arrived). So the walk adopts 1 and PARKS at 3,
      // which is the documented behaviour: neither adopt nor remove on a
      // rotation whose chain can't be proven, and keep polling.
      //
      // Keeping polling is the part being tested. The gap closing is not a
      // hypothetical — it is the ordinary case of a relay serving a page at a
      // time — and if the walk that stalled is never re-run, "keep polling"
      // buys nothing and the member is stuck one epoch behind for good.
      const k1 = random32();
      const k2 = random32();
      const k3 = random32();
      const at1: PrivateChannelKey = { ...ch, key: k1, epoch: 1n };
      const at2: PrivateChannelKey = { ...ch, key: k2, epoch: 2n };
      const r1 = await channelRotationWraps(owner, community.root, ch, k1, [owner.pubkey, me.pubkey], Date.now() - 2000);
      const r3 = await channelRotationWraps(owner, community.root, at2, k3, [owner.pubkey, me.pubkey], Date.now());

      const relay = new FakeRelay();
      relay.events = [...r1, ...r3]; // the epoch-2 link is missing, for now
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { queryClient, wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      // Stalls at the gap, having adopted only the link it could verify.
      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              channels: [expect.objectContaining({ key: bytesToHex(k1), epoch: 1 })],
            }),
          ),
        { timeout: 10_000 },
      );

      // The missing link shows up on the next poll. It is BUILT here, at the
      // moment it arrives, rather than up front with the others: `wrapSeal`
      // stamps a wrap with `Date.now()` and ignores the `publishMs` that dates
      // the rumor inside it, so a link built before r3 also carries a wrap
      // older than r3's. The first fetch advances this scope's per-relay
      // `since` cursor to the newest wrap it saw (r3's), and the watcher filters
      // the next poll on it — so whenever the second boundary happened to fall
      // between building the two, the late link was `since`-excluded from every
      // subsequent poll and the walk below could never see it. That is a race
      // against the wall clock, not the worker pool; building it now puts its
      // wrap at or after the cursor by construction.
      const r2 = await channelRotationWraps(owner, community.root, at1, k2, [owner.pubkey, me.pubkey], Date.now() - 1000);
      relay.events = [...r1, ...r2, ...r3];
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: ["concord", "chrekey"] });
      });

      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              channels: [expect.objectContaining({ key: bytesToHex(k3), epoch: 3 })],
            }),
          ),
        { timeout: 30_000 },
      );
    },
  );

  it(
    "an unauthorized rotator's channel rotation is ignored (key possession is never authority)",
    { timeout: 30_000 },
    async () => {
      const { owner, me, community, ch } = setupChannel();
      const mallory = member(); // holds the channel key, holds NO role
      const wraps = await channelRotationWraps(mallory, community.root, ch, random32(), [mallory.pubkey, me.pubkey], Date.now());

      const relay = new FakeRelay();
      relay.events = [...wraps];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = foldedFor(owner.pubkey); // mallory is neither owner nor BAN/MANAGE_CHANNELS holder
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      // Give the (unwanted) adoption a chance to fire.
      await waitFor(
        () => expect(relay.queries.some((f) => f.kinds?.includes(1059))).toBe(true),
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(h.updateList).not.toHaveBeenCalled();
    },
  );

  it(
    "an EQUAL-RANK rotator's exclusion is not honored (the Rotator must strictly outrank every removed target)",
    { timeout: 30_000 },
    async () => {
      // CORD-06 §Authority: holding MANAGE_CHANNELS is necessary but not
      // sufficient — "the Rotator must strictly outrank every removed target",
      // and equal cannot act on equal (CORD-04 §3). A receiver cannot see who
      // else a rotation kept or cut (locators are opaque), but it can always
      // judge the one removal that concerns it: its own. A peer admin's
      // complete no-blob-for-me rotation therefore must NOT read as my
      // removal, however valid its permission bits and citation are.
      const { owner, me, community, ch } = setupChannel();
      const rotator = member();
      const { fold, citation } = peerAdminsFold(owner.pubkey, community.id, rotator.pubkey, me.pubkey);
      const wraps = await channelRotationWraps(
        rotator, community.root, ch, random32(), [rotator.pubkey], Date.now(), citation,
      );

      const relay = new FakeRelay();
      relay.events = [...wraps];
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(me);
      h.folded = fold;
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper });

      await waitFor(
        () => expect(relay.queries.some((f) => f.kinds?.includes(1059))).toBe(true),
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 200));
      // Neither removed nor adopted: I keep my key and my channel.
      expect(h.updateList).not.toHaveBeenCalled();
    },
  );
});

// ── useChannelRekey: the standalone rotation behind role-gate revokes ───────

describe("useChannelRekey (standalone channel rotation, channel-access revoke)", () => {
  it(
    "end to end: the produced rotation re-keys the rotator and removes the revoked member",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const revoked = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };

      // The owner rotates the channel to themselves only (the revoke shape).
      const relay = new FakeRelay();
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jmOwner = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jmOwner, current: jmOwner, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useChannelRekey(community), { wrapper });
      await act(async () => {
        await result.current.rekeyChannel({ channelIdHex: bytesToHex(ch.id), keepRecipients: [], removedTargets: [] });
      });

      // The rotator adopts its own rotation immediately (epoch 1, fresh key).
      expect(h.updateList).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refresh-channels",
          communityId: community.idHex,
          channels: [expect.objectContaining({ id: bytesToHex(ch.id), epoch: 1 })],
        }),
      );
      expect(relay.published.length).toBeGreaterThan(0);

      // The revoked member's watch sees the complete no-blob rotation and
      // drops the channel from `current` — the room visibly disappears.
      const relay2 = new FakeRelay();
      relay2.events = [...relay.published];
      h.pool = { relay: () => relay2, query: async () => [] };
      h.user = asNUser(revoked);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper: w2 } = makeWrapper();
      renderHook(() => useChannelRekeyWatch(community), { wrapper: w2 });

      await waitFor(
        () =>
          expect(h.updateList).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refresh-channels",
              communityId: community.idHex,
              channels: [],
            }),
          ),
        { timeout: 10_000 },
      );
    },
  );

  it(
    "never merges into an earlier rotation of mine that handed the cut member a key: it steps past it",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const alice = member();
      const mallory = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };

      // A rotation of mine to epoch 1 planned on a roster that still had Mallory
      // (a duty, another tab), already out.
      const staleKey = random32();
      const relay = new FakeRelay();
      relay.events = await channelRotationWraps(owner, community.root, ch, staleKey, [owner.pubkey, alice.pubkey, mallory.pubkey], Date.now() - 1000);
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { result } = renderHook(() => useChannelRekey(community), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await result.current.rekeyChannel({ channelIdHex: bytesToHex(ch.id), keepRecipients: [alice.pubkey], removedTargets: [mallory.pubkey] });
      });

      // Nothing new at epoch 1, where it would have merged with Mallory's blob…
      const at1 = channelRekeyGroupKey(community.root, ch.id, 1n);
      expect(relay.published.some((e) => e.pubkey === at1.pk)).toBe(false);
      // …a rotation from the stale set's key to epoch 2, without her…
      const at2 = channelRekeyGroupKey(community.root, ch.id, 2n);
      const [rotation] = groupRotations(relay.published.filter((e) => e.pubkey === at2.pk).map((w) => parseRekey(openWrap(w, at2))));
      expect(rotation?.complete).toBe(true);
      expect(rotation.prevCommit).toBe(bytesToHex(epochKeyCommitment(1n, staleKey)));
      expect(findBlob(rotation, myLocator(owner.pubkey, alice.pubkey, bytesToHex(ch.id), 2n))).toBeDefined();
      expect(findBlob(rotation, myLocator(owner.pubkey, mallory.pubkey, bytesToHex(ch.id), 2n))).toBeUndefined();
      // …and both keys kept, so history at epoch 1 stays readable.
      expect(h.updateList).toHaveBeenCalledWith(expect.objectContaining({
        type: "refresh-channels",
        channels: [expect.objectContaining({
          epoch: 2,
          priors: [expect.objectContaining({ key: bytesToHex(staleKey), epoch: 1 }), expect.objectContaining({ key: bytesToHex(ch.key), epoch: 0 })],
        })],
      }));
    },
  );

  it(
    "an earlier rotation of mine that already left the cut member out is joined, not stepped past",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const mallory = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };
      const relay = new FakeRelay();
      const earlierKey = random32();
      relay.events = await channelRotationWraps(owner, community.root, ch, earlierKey, [owner.pubkey], Date.now() - 1000);
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { result } = renderHook(() => useChannelRekey(community), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await result.current.rekeyChannel({ channelIdHex: bytesToHex(ch.id), keepRecipients: [], removedTargets: [mallory.pubkey] });
      });
      expect(relay.published.some((e) => e.pubkey === channelRekeyGroupKey(community.root, ch.id, 2n).pk)).toBe(false);
      // At its key, not a second one minted here for the same epoch.
      expect(h.updateList).toHaveBeenCalledWith(expect.objectContaining({
        channels: [expect.objectContaining({ epoch: 1, key: bytesToHex(earlierKey) })],
      }));
    },
  );

  it("seals the channel's details again under the key it just minted, on ranked roles (Vector `reseal_rotated`)", async () => {
    const owner = member();
    const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
    const community: Community = { ...base, privateChannels: [ch] };
    const idHex = bytesToHex(ch.id);
    const headHash = random32();
    const sealed = readChannelContent(sealChannelMetadata({ name: "sec", private: true }, ch.key, ch.id, 0n, undefined))!.sealed!;
    h.pool = { relay: () => new FakeRelay(), query: async () => [] };
    h.user = asNUser(owner);
    h.editions = [];
    h.folded = {
      ...(foldedFor(owner.pubkey) as object),
      rankedRoster: true,
      channels: new Map([[idHex, { channelIdHex: idHex, name: "", isPrivate: true, deleted: false, metadata: { name: "", private: true }, sealed }]]),
      heads: new Map([[idHex, { version: 1n, hash: headHash }]]),
    };
    let adopted: PrivateChannelKey | undefined;
    h.updateList = vi.fn(async (a: { type: string; channels?: Array<{ id: string; key: string; epoch: number }> }) => {
      const c = a.channels?.[0];
      if (a.type === "refresh-channels" && c) adopted = { id: ch.id, key: hex32(c.key), epoch: BigInt(c.epoch), name: "sec" };
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useChannelRekey(community), { wrapper });
    await act(async () => {
      await result.current.rekeyChannel({ channelIdHex: idHex, keepRecipients: [], removedTargets: [] });
    });
    expect(adopted?.epoch).toBe(1n);
    const resealed = h.editions.map((e) => readChannelContent(e.content)?.sealed).find((x) => x?.epoch === 1n);
    expect(resealed, "a channel edition sealed at the new epoch").toBeDefined();
    expect(openChannelSeal({ ...resealed!, prevHex: bytesToHex(headHash) }, adopted!)?.metadata.name).toBe("sec");
  });

  it("reseals from the store's head, which holds a rename this device just made", async () => {
    const owner = member();
    const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
    const community: Community = { ...base, privateChannels: [ch] };
    const idHex = bytesToHex(ch.id);
    const fold = (name: string, version: bigint, hash: Uint8Array, prev?: Uint8Array) => ({
      ...(foldedFor(owner.pubkey) as object),
      rankedRoster: true,
      channels: new Map([[idHex, { channelIdHex: idHex, name: "", isPrivate: true, deleted: false, metadata: { name: "", private: true }, sealed: { ...readChannelContent(sealChannelMetadata({ name, private: true }, ch.key, ch.id, 0n, prev ? bytesToHex(prev) : undefined))!.sealed!, prevHex: prev ? bytesToHex(prev) : undefined } }]]),
      heads: new Map([[idHex, { version, hash }]]),
    });
    const [h1, h2] = [random32(), random32()];
    h.pool = { relay: () => new FakeRelay(), query: async () => [] };
    h.user = asNUser(owner);
    h.editions = [];
    h.folded = fold("sec", 1n, h1);
    h.stored = fold("renamed", 2n, h2, h1);
    let adopted: PrivateChannelKey | undefined;
    h.updateList = vi.fn(async (a: { type: string; channels?: Array<{ id: string; key: string; epoch: number }> }) => {
      const c = a.channels?.[0];
      if (a.type === "refresh-channels" && c) adopted = { id: ch.id, key: hex32(c.key), epoch: BigInt(c.epoch), name: "sec" };
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useChannelRekey(community), { wrapper });
    await act(async () => {
      await result.current.rekeyChannel({ channelIdHex: idHex, keepRecipients: [], removedTargets: [] });
    });
    h.stored = undefined;
    const reseal = h.editions.find((e) => readChannelContent(e.content)?.sealed?.epoch === 1n)!;
    expect(reseal.tags.find((t) => t[0] === "ep")?.[1]).toBe(bytesToHex(h2));
    expect(openChannelSeal({ ...readChannelContent(reseal.content)!.sealed!, prevHex: bytesToHex(h2) }, adopted!)?.metadata.name).toBe("renamed");
  });

  it("lets a moderator holding only Ban rotate a channel to sever a banned member, and nothing else (Vector `sever_banned_private_reads`)", async () => {
    const owner = member();
    const mod = member();
    const banned = member();
    const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
    const community: Community = { ...base, privateChannels: [ch] };
    const roleId = "bb".repeat(32);
    h.pool = { relay: () => new FakeRelay(), query: async () => [] };
    h.user = asNUser(mod);
    h.folded = {
      ownerHex: owner.pubkey,
      banned: new Set([banned.pubkey]),
      roster: { roles: [{ roleId, name: "Mods", position: 1, permissions: Permissions.BAN, scope: { kind: "server" }, color: 0 }], grants: [{ member: mod.pubkey, roleIds: [roleId] }] },
      metadata: { name: "Fleet", relays: [] },
      headEditions: new Map(),
    } as unknown;
    h.updateList = vi.fn(async () => {});
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useChannelRekey(community), { wrapper });
    expect(result.current.canRekeyChannel).toBe(false);
    expect(result.current.canSeverChannel).toBe(true);
    const args = { channelIdHex: bytesToHex(ch.id), keepRecipients: [owner.pubkey], removedTargets: [banned.pubkey] };
    await expect(result.current.rekeyChannel(args)).rejects.toThrow(/Manage-channels/);
    await act(async () => {
      await result.current.rekeyChannel({ ...args, forBan: true });
    });
    expect(h.updateList).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh-channels" }));
  });

  it(
    "re-posts the rotator's live invite links, and they vend no channel key at all",
    { timeout: 30_000 },
    async () => {
      // A private channel rotated by hand ("Rotate key"). The link bundle
      // still on the relay carries the pre-rotation key, so it has to be
      // re-posted (CORD-05 §2) — but at NO channel key rather than the fresh
      // one. A link's audience is whoever the URL reaches and holds no scoped
      // Role, so it is entitled to no Private Channel (CORD-03 §1).
      //
      // Re-vending here is the worst case of it: the rotation this refresh
      // follows exists to CUT somebody, the cut is recorded at the excluding
      // epoch, and the floor admits `epoch >= cut` so a genuine re-admission
      // still lands — so a bundle carrying the fresh key at that same epoch is
      // indistinguishable from one, and the removed member re-resolving their
      // link undoes the rotation that removed them.
      const owner = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };
      const fold = foldedFor(owner.pubkey) as { channels?: Map<string, unknown> };
      fold.channels = new Map([
        [bytesToHex(ch.id), { channelIdHex: bytesToHex(ch.id), name: "sec", isPrivate: true, deleted: false }],
      ]);

      const link = mintLinkSigner();
      const token = mintToken();
      const listEvent = finalizeEvent(
        {
          kind: KIND_INVITE_LIST,
          content: nip44Encrypt(
            JSON.stringify({
              entries: [
                { token: bytesToHex(token), signer_sk: bytesToHex(link.sk), community_id: community.idHex, url: "", created_at: 1 },
              ],
              tombstones: [],
            }),
            getConversationKey(owner.sk, owner.pubkey),
          ),
          tags: [],
          created_at: nowSecs() - 10,
        },
        owner.sk,
      );

      const relay = new FakeRelay();
      h.pool = {
        relay: () => relay,
        query: async (filters: Filter[]) =>
          filters.some((f) => f.kinds?.includes(KIND_INVITE_LIST)) ? [listEvent] : [],
      };
      h.user = asNUser(owner);
      h.folded = fold;
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useChannelRekey(community), { wrapper });
      await act(async () => {
        await result.current.rekeyChannel({ channelIdHex: bytesToHex(ch.id), keepRecipients: [], removedTargets: [] });
      });

      // Recover the key the rotation actually minted, from the rotator's blob.
      const chAddress = channelRekeyGroupKey(community.root, ch.id, 1n);
      const rotation = groupRotations(
        relay.published.filter((e) => e.pubkey === chAddress.pk).map((w) => parseRekey(openWrap(w, chAddress))),
      )[0];
      const ownBlob = findBlob(rotation, myLocator(owner.pubkey, owner.pubkey, bytesToHex(ch.id), 1n))!;
      const newChKey = decodeWrappedKey(
        base64ToBytes(owner.nip44decrypt(owner.pubkey, ownBlob.wrapped)),
        ch.id,
        1n,
      );

      await waitFor(
        () => expect(relay.published.some((e) => e.pubkey === link.pk)).toBe(true),
        { timeout: 10_000 },
      );
      const vended = parseBundleEvent(relay.published.filter((e) => e.pubkey === link.pk).at(-1)!, link.pk, token, Date.now());
      expect(vended.channels).toEqual([]);
      // The rotation really did mint a fresh key — it just travels by grant
      // (a Direct Invite to an entitled npub), never by link.
      expect(bytesToHex(newChKey)).not.toBe(bytesToHex(ch.key));
    },
  );
});

// ── useRefound: the Refounding rotates held Private Channels (CORD-06 §3) ──

describe("useRefound (CORD-06 §3 channel rotations)", () => {
  it(
    "a Refounding rekeys every held private channel under the PRIOR root and vends the fresh keys onward",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const alice = member();
      const mallory = member(); // the banned target
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };
      const priorRoot = community.root;

      // The refounder owns one live invite link (for the step-3b refresh).
      const link = mintLinkSigner();
      const token = mintToken();
      const listEvent = finalizeEvent(
        {
          kind: KIND_INVITE_LIST,
          content: nip44Encrypt(
            JSON.stringify({
              entries: [
                {
                  token: bytesToHex(token),
                  signer_sk: bytesToHex(link.sk),
                  community_id: community.idHex,
                  url: "",
                  created_at: 1,
                },
              ],
              tombstones: [],
            }),
            getConversationKey(owner.sk, owner.pubkey),
          ),
          tags: [],
          created_at: nowSecs() - 10,
        },
        owner.sk,
      );

      const relay = new FakeRelay();
      // Alice holds the Role scoped to #sec, so the rotation vends her its key.
      relay.events.push(...(await channelAccessEditions(community, owner, ch.id, [alice.pubkey])));
      h.pool = {
        relay: () => relay,
        query: async (filters: Filter[]) =>
          filters.some((f) => f.kinds?.includes(KIND_INVITE_LIST)) ? [listEvent] : [],
      };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useRefound(community), { wrapper });
      await act(async () => {
        await result.current.refound({ keep: [alice.pubkey], exclude: [mallory.pubkey] });
      });

      // A channel-scoped rotation was published at the channel's next-epoch
      // address, derived from the PRIOR community_root (CORD-06 §3: sealed
      // under the prior root so a base-race loser can still open it).
      const chAddress = channelRekeyGroupKey(priorRoot, ch.id, 1n);
      const chWraps = relay.published.filter((e) => e.pubkey === chAddress.pk);
      expect(chWraps.length).toBeGreaterThan(0);
      const sets = groupRotations(chWraps.map((w) => parseRekey(openWrap(w, chAddress))));
      expect(sets.length).toBe(1);
      const rotation = sets[0];
      expect(rotation.complete).toBe(true);
      expect(rotation.scopeIdHex).toBe(bytesToHex(ch.id));
      expect(rotation.prevCommit).toBe(bytesToHex(epochKeyCommitment(0n, ch.key)));

      // Alice's blob decodes to the fresh channel key — scope-bound inside the
      // ciphertext, so it can never be spliced onto another channel.
      const aliceBlob = findBlob(rotation, myLocator(owner.pubkey, alice.pubkey, bytesToHex(ch.id), 1n))!;
      expect(aliceBlob).toBeDefined();
      const newChKey = decodeWrappedKey(
        base64ToBytes(alice.nip44decrypt(owner.pubkey, aliceBlob.wrapped)),
        ch.id,
        1n,
      );

      // Mallory — the severed member — has NO blob in the rotation.
      expect(findBlob(rotation, myLocator(owner.pubkey, mallory.pubkey, bytesToHex(ch.id), 1n))).toBeUndefined();

      // The refounder's own list snapshot carries the rotated channel…
      expect(h.updateList).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refresh-current",
          current: expect.objectContaining({
            root_epoch: 1,
            channels: [
              expect.objectContaining({ id: bytesToHex(ch.id), key: bytesToHex(newChKey), epoch: 1 }),
            ],
          }),
        }),
      );

      // …and the link is NOT refreshed, because this rotation EXCLUDED someone.
      //
      // A refresh re-posts the current keys behind the SAME URL, and the URL is
      // a bearer credential: Mallory holds it exactly like everyone else the
      // link ever reached, so refreshing would hand her the fresh base root and
      // undo the severance the whole Refounding exists to perform. The reasoning
      // that already forces `channels: []` — at one epoch a cut and a
      // re-admission are indistinguishable — governs the BASE too, and unlike a
      // channel key the base is something every bundle must carry.
      //
      // CORD-05 §2 can call a refresh safe only because of the sequencing
      // around it: CORD-06 §3 refounds for a ban in a PRIVATE community, and
      // CORD-05 §5 makes Private mean the live-link registry is empty — so per
      // spec there are no links in existence at this point. Armada gets here
      // with the refounder's own links live (banShouldRotateMany vetoes only on
      // FOREIGN ones), so it leaves them stranded on the dead epoch: the link
      // stops working rather than reopening the door.
      expect(relay.published.filter((e) => e.pubkey === link.pk)).toEqual([]);
      // The rotated key still exists — it just travels by grant, not by link.
      expect(newChKey).toBeDefined();
    },
  );

  it(
    "vends each rotated channel to ITS entitled members, not to everyone the base rotation keeps",
    { timeout: 30_000 },
    async () => {
      // CORD-03 §1 defines a Private Channel as readable only by granted
      // role-holders. A Refounding rotates every held private channel at once
      // (CORD-06 §3), so rotating them all to the community-wide keep list
      // would publish, to every remaining member, the key to every private
      // channel they were never granted — a ban handing out the access it
      // exists to withdraw. Each channel's recipients are its own.
      const owner = member();
      const alice = member(); // holds the Role scoped to #sec
      const bob = member(); // an ordinary member, kept — but not of #sec
      const mallory = member(); // the banned target
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };
      const priorRoot = community.root;

      const relay = new FakeRelay();
      relay.events.push(...(await channelAccessEditions(community, owner, ch.id, [alice.pubkey])));
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useRefound(community), { wrapper });
      await act(async () => {
        await result.current.refound({ keep: [alice.pubkey, bob.pubkey], exclude: [mallory.pubkey] });
      });

      // The BASE rotation keeps both: Bob stays a member of the community and
      // reads every public channel at the new root.
      const baseAddress = baseRekeyGroupKey(priorRoot, community.id, 1n);
      const [baseRotation] = groupRotations(
        relay.published.filter((e) => e.pubkey === baseAddress.pk).map((w) => parseRekey(openWrap(w, baseAddress))),
      );
      expect(findBlob(baseRotation, myLocator(owner.pubkey, alice.pubkey, "0".repeat(64), 1n))).toBeDefined();
      expect(findBlob(baseRotation, myLocator(owner.pubkey, bob.pubkey, "0".repeat(64), 1n))).toBeDefined();
      expect(findBlob(baseRotation, myLocator(owner.pubkey, mallory.pubkey, "0".repeat(64), 1n))).toBeUndefined();

      // The CHANNEL rotation keeps only Alice. Bob finding no blob at his
      // locator across a complete rotation is how he learns he is not in #sec
      // — the same signal a removal gives, which is correct: he never was.
      const chAddress = channelRekeyGroupKey(priorRoot, ch.id, 1n);
      const [chRotation] = groupRotations(
        relay.published.filter((e) => e.pubkey === chAddress.pk).map((w) => parseRekey(openWrap(w, chAddress))),
      );
      expect(chRotation.complete).toBe(true);
      const chBlobOf = (pk: string) => findBlob(chRotation, myLocator(owner.pubkey, pk, bytesToHex(ch.id), 1n));
      expect(chBlobOf(alice.pubkey)).toBeDefined();
      expect(chBlobOf(bob.pubkey)).toBeUndefined();
      expect(chBlobOf(mallory.pubkey)).toBeUndefined();
      // The rotator holds every key they rotate whatever the roster says —
      // dropping themselves would leave nobody able to rotate #sec again.
      expect(chBlobOf(owner.pubkey)).toBeDefined();
    },
  );

  it(
    "retains each channel's pre-Refounding key, so the channel's history survives the rotation",
    { timeout: 30_000 },
    async () => {
      // A Refounding rotates every held private channel. CORD-03 §3 has a
      // client read a channel across every epoch key it holds, and CORD.md's
      // continuity rule says superseded channel keys are retained and carried
      // through every list write. Overwriting `key`/`epoch` in place drops the
      // only copy of the key that reads everything said before the rotation —
      // for every member, in every private channel, on every ban.
      const owner = member();
      const alice = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };

      const relay = new FakeRelay();
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useRefound(community), { wrapper });
      await act(async () => {
        await result.current.refound({ keep: [alice.pubkey], exclude: [member().pubkey] });
      });

      expect(h.updateList).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refresh-current",
          current: expect.objectContaining({
            channels: [
              expect.objectContaining({
                epoch: 1,
                // The severed key is retained WITH its read cutoff (the
                // rotation's publish time).
                priors: [
                  expect.objectContaining({ key: bytesToHex(ch.key), epoch: 0, retired_at: expect.any(Number) }),
                ],
              }),
            ],
          }),
        }),
      );
    },
  );

  it(
    "a rotation that fails AFTER the root roll still records the epoch, so the retry is a new rotation",
    { timeout: 30_000 },
    async () => {
      // The root roll is the commit: every keeper can already see and adopt it.
      // Leaving the local entry behind until the whole mutation finishes meant a
      // channel step failing left this client believing it was still at the
      // prior epoch — and the retry then rotated to the SAME
      // (newEpoch, prevCommit). groupRotations correlates on exactly that
      // tuple, so both attempts merged into ONE set and the member the retry
      // existed to remove found their blob from attempt one.
      const owner = member();
      const alice = member();
      const mallory = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };

      const relay = new FakeRelay();
      // Refuse only the channel rekey (step 2b), leaving the root roll landed.
      relay.refuseAuthor = channelRekeyGroupKey(community.root, ch.id, 1n).pk;
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      h.updateList = vi.fn(async () => {});
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useRefound(community), { wrapper });
      await act(async () => {
        await expect(
          result.current.refound({ keep: [alice.pubkey], exclude: [mallory.pubkey] }),
        ).rejects.toThrow();
      });

      // The root roll landed, so epoch 1 exists for every member…
      const rollAddress = baseRekeyGroupKey(community.root, community.id, 1n);
      expect(relay.published.some((e) => e.pubkey === rollAddress.pk), "the roll must have landed").toBe(true);
      // …and this client must have recorded it despite the later failure.
      expect(h.updateList, "the committed epoch must be recorded before the throw").toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refresh-current",
          current: expect.objectContaining({ root_epoch: 1 }),
        }),
      );
    },
  );
});

describe("useRefound progress", () => {
  it("reports each step in order, counting members, state and channels", { timeout: 30_000 }, async () => {
    const owner = member();
    const alice = member();
    const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
    const community: Community = { ...base, privateChannels: [ch] };
    const relay = new FakeRelay();
    relay.events.push(...(await channelAccessEditions(community, owner, ch.id, [alice.pubkey])));
    h.pool = { relay: () => relay, query: async () => [] };
    h.user = asNUser(owner);
    h.folded = foldedFor(owner.pubkey);
    h.updateList = vi.fn(async () => {});
    const jm = jmOf(community, owner.pubkey);
    h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

    const steps: Array<{ step: string; done?: number; total?: number }> = [];
    const { result } = renderHook(() => useRefound(community), { wrapper: makeWrapper().wrapper });
    await act(async () => {
      await result.current.refound({ keep: [alice.pubkey], exclude: [], onProgress: (p) => steps.push(p) });
    });

    const order = [...new Set(steps.map((p) => p.step))];
    expect(order).toEqual(["reading", "encrypting", "rolling", "carrying", "guestbook", "channels", "links", "saving"]);
    expect(steps.find((p) => p.step === "encrypting")).toMatchObject({ total: 2 });
    const carried = steps.filter((p) => p.step === "carrying");
    expect(carried.at(-1)!.done).toBe(carried.at(-1)!.total);
    expect(steps.find((p) => p.step === "channels")).toMatchObject({ done: 0, total: 1 });
  });
});

// ── A Refounding cut short finishes at its own epoch ──

describe("useRefound resumes what it committed", () => {
  /** The community as this device holds it once the roll's epoch was recorded (step 1a). */
  function adoptedFrom(updateList: ReturnType<typeof vi.fn>, communityIdHex: string): { community: Community; entry: CommunityListEntry } {
    const call = updateList.mock.calls.map((c) => c[0] as { type: string; current?: JoinMaterial }).find((a) => a.type === "refresh-current");
    expect(call?.current, "the roll's epoch must have been recorded").toBeDefined();
    const entry = { community_id: communityIdHex, seed: call!.current!, current: call!.current!, added_at: 1 } satisfies CommunityListEntry;
    return { community: rehydrateCommunity(entry)!, entry };
  }

  it(
    "a run cut off at a channel rotation finishes it on the next attempt, without rolling a second epoch",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const alice = member();
      const mallory = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };
      const priorRoot = community.root;

      const relay = new FakeRelay();
      relay.events.push(...(await channelAccessEditions(community, owner, ch.id, [alice.pubkey])));
      relay.refuseAuthor = channelRekeyGroupKey(priorRoot, ch.id, 1n).pk;
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      const updateList = vi.fn(async () => {});
      h.updateList = updateList;
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const first = renderHook(() => useRefound(community), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await expect(first.result.current.refound({ keep: [alice.pubkey], exclude: [mallory.pubkey] })).rejects.toThrow();
      });
      await refoundJournalReady();
      expect(refoundJournal(owner.pubkey, community.idHex)?.carried, "the state was carried before the channel failed").toBe(true);

      // Reopened: the device is at epoch 1, and the relay takes the channel now.
      const { community: adopted, entry } = adoptedFrom(updateList, community.idHex);
      expect(adopted.rootEpoch).toBe(1n);
      relay.refuseAuthor = undefined;
      h.entry = entry;
      updateList.mockClear();
      const second = renderHook(() => useRefound(adopted), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await second.result.current.refound({ keep: [alice.pubkey], exclude: [mallory.pubkey] });
      });

      // No second roll off the new root…
      expect(relay.published.some((e) => e.pubkey === baseRekeyGroupKey(adopted.root, community.id, 2n).pk)).toBe(false);
      // …the channel rotated under the PRIOR root, without Mallory…
      const chAddress = channelRekeyGroupKey(priorRoot, ch.id, 1n);
      const [rotation] = groupRotations(relay.published.filter((e) => e.pubkey === chAddress.pk).map((w) => parseRekey(openWrap(w, chAddress))));
      expect(rotation?.complete).toBe(true);
      expect(findBlob(rotation, myLocator(owner.pubkey, alice.pubkey, bytesToHex(ch.id), 1n))).toBeDefined();
      expect(findBlob(rotation, myLocator(owner.pubkey, mallory.pubkey, bytesToHex(ch.id), 1n))).toBeUndefined();
      // …the list moved forward at epoch 1 with the channel rotated, and the journal is spent.
      expect(updateList).toHaveBeenCalledWith(expect.objectContaining({
        type: "refresh-current",
        current: expect.objectContaining({ root_epoch: 1, channels: [expect.objectContaining({ id: bytesToHex(ch.id), epoch: 1 })] }),
      }));
      expect(refoundJournal(owner.pubkey, community.idHex)).toBeUndefined();
    },
  );

  it(
    "a run cut off while carrying the community's state carries it on the next attempt",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const alice = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };

      const relay = new FakeRelay();
      relay.events.push(...(await channelAccessEditions(community, owner, ch.id, [alice.pubkey])));
      // The relay goes away right after the roll.
      const rollPk = baseRekeyGroupKey(community.root, community.id, 1n).pk;
      relay.refuse = (ev) => ev.pubkey !== rollPk;
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      const updateList = vi.fn(async () => {});
      h.updateList = updateList;
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const first = renderHook(() => useRefound(community), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await expect(first.result.current.refound({ keep: [alice.pubkey], exclude: [] })).rejects.toThrow();
      });

      const { community: adopted, entry } = adoptedFrom(updateList, community.idHex);
      expect(adopted.controlPk).toBeDefined();
      // Nothing reached the new Control address: every keeper's fold would wait on it.
      expect(relay.published.some((e) => e.pubkey === adopted.controlPk)).toBe(false);

      // Reopened with no fold to render (the new epoch holds no state yet).
      relay.refuse = undefined;
      h.entry = entry;
      h.folded = undefined;
      const second = renderHook(() => useRefound(adopted), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await second.result.current.refound({ keep: [alice.pubkey], exclude: [] });
      });
      expect(relay.published.filter((e) => e.pubkey === adopted.controlPk).length).toBeGreaterThan(0);
      expect(relay.published.some((e) => e.pubkey === baseRekeyGroupKey(adopted.root, community.id, 2n).pk)).toBe(false);
      expect(refoundJournal(owner.pubkey, community.idHex)).toBeUndefined();
    },
  );

  it(
    "finishing an earlier run doesn't count as removing someone it never named",
    { timeout: 30_000 },
    async () => {
      const owner = member();
      const alice = member();
      const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
      const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
      const community: Community = { ...base, privateChannels: [ch] };
      const relay = new FakeRelay();
      relay.refuseAuthor = channelRekeyGroupKey(community.root, ch.id, 1n).pk;
      h.pool = { relay: () => relay, query: async () => [] };
      h.user = asNUser(owner);
      h.folded = foldedFor(owner.pubkey);
      const updateList = vi.fn(async () => {});
      h.updateList = updateList;
      const jm = jmOf(community, owner.pubkey);
      h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;

      const first = renderHook(() => useRefound(community), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await expect(first.result.current.refound({ keep: [alice.pubkey], exclude: [] })).rejects.toThrow();
      });
      const { community: adopted, entry } = adoptedFrom(updateList, community.idHex);
      relay.refuseAuthor = undefined;
      h.entry = entry;
      const second = renderHook(() => useRefound(adopted), { wrapper: makeWrapper().wrapper });
      await act(async () => {
        await expect(second.result.current.refound({ keep: [], exclude: [alice.pubkey] })).rejects.toThrow(/earlier key rotation/);
      });
      expect(refoundJournal(owner.pubkey, community.idHex)).toBeUndefined();
    },
  );
});

// ── Racing Refoundings converge on the lowest key (CORD-06 §3) ──

describe("useRekeyWatch converges a racing Refounding at the epoch it is on", () => {
  async function race() {
    const owner = member();
    const admin = member();
    const me = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const { fold, citation } = peerAdminsFold(owner.pubkey, community.id, admin.pubkey, member().pubkey);
    const [low, high] = [random32(), random32()].sort((a, b) => (bytesToHex(a) < bytesToHex(b) ? -1 : 1));
    const now = Date.now();
    const relay = new FakeRelay();
    relay.events = [
      ...(await rotationWraps(owner, community, high, [owner.pubkey, admin.pubkey, me.pubkey], now)),
      ...(await rotationWraps(admin, community, low, [owner.pubkey, admin.pubkey, me.pubkey], now + 1, citation)),
    ];
    const calls: Filter[][] = [];
    h.pool = {
      relay: () => ({
        query: async (filters: Filter[]) => {
          calls.push(filters);
          return relay.query(filters);
        },
        event: (ev: NostrEvent) => relay.event(ev),
      }),
      query: async () => [],
    };
    h.folded = fold;
    h.updateList = vi.fn(async () => {});
    return { owner, admin, me, community, low, high, calls };
  }

  /** `c` as a device holds it after adopting `key` at epoch 1. */
  function onKey(c: Community, key: Uint8Array, refounder: string, ownerPk: string) {
    const adopted: Community = {
      ...c,
      root: key,
      rootEpoch: 1n,
      heldRoots: [
        { epoch: 1n, key, refounder },
        ...c.heldRoots.map((r) => (r.epoch === 0n ? { ...r, retiredAt: nowSecs() } : r)),
      ],
      refounder,
    };
    const jm = jmOf(adopted, ownerPk);
    h.entry = { community_id: c.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;
    return adopted;
  }

  it("a member that adopted the higher key steps down to the lower one at the same epoch", { timeout: 30_000 }, async () => {
    const { owner, me, community, low, high } = await race();
    h.user = asNUser(me);
    const adopted = onKey(community, high, owner.pubkey, owner.pubkey);
    renderHook(() => useRekeyWatch(adopted), { wrapper: makeWrapper().wrapper });
    await waitFor(() =>
      expect(h.updateList).toHaveBeenCalledWith(expect.objectContaining({
        type: "refresh-current",
        current: expect.objectContaining({ root_epoch: 1, community_root: bytesToHex(low) }),
      })),
      { timeout: 10_000 },
    );
  });

  it("the losing rotator steps down too, and drops its unfinished carry", { timeout: 30_000 }, async () => {
    const { owner, community, low, high } = await race();
    h.user = asNUser(owner);
    const adopted = onKey(community, high, owner.pubkey, owner.pubkey);
    await refoundJournalReady();
    writeRefoundJournal(owner.pubkey, community.idHex, {
      newEpoch: "1", priorEpoch: "0", recipients: [owner.pubkey], exclude: [], rotatedAtMs: Date.now(), channelBase: {}, channels: [],
    });
    renderHook(() => useRekeyWatch(adopted), { wrapper: makeWrapper().wrapper });
    await waitFor(() =>
      expect(h.updateList).toHaveBeenCalledWith(expect.objectContaining({
        current: expect.objectContaining({ community_root: bytesToHex(low) }),
      })),
      { timeout: 10_000 },
    );
    expect(refoundJournal(owner.pubkey, community.idHex)).toBeUndefined();
  });

  it("reads the epoch it is on in the same request as the next one, not one of its own", { timeout: 30_000 }, async () => {
    const { owner, me, community, high, calls } = await race();
    h.user = asNUser(me);
    const adopted = onKey(community, high, owner.pubkey, owner.pubkey);
    renderHook(() => useRekeyWatch(adopted), { wrapper: makeWrapper().wrapper });
    await waitFor(() => expect(h.updateList).toHaveBeenCalled(), { timeout: 10_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].flatMap((f) => f.authors ?? []).sort()).toEqual(
      [baseRekeyGroupKey(adopted.root, community.id, 2n).pk, baseRekeyGroupKey(community.root, community.id, 1n).pk].sort(),
    );
  });

  it("stops reading the epoch it is on a day after the rotation", { timeout: 30_000 }, async () => {
    const { owner, me, community, high, calls } = await race();
    h.user = asNUser(me);
    const adopted = onKey(community, high, owner.pubkey, owner.pubkey);
    const old = { ...adopted, heldRoots: adopted.heldRoots.map((r) => (r.epoch === 0n ? { ...r, retiredAt: nowSecs() - 2 * 86_400 } : r)) };
    renderHook(() => useRekeyWatch(old), { wrapper: makeWrapper().wrapper });
    await waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    expect(calls[0].flatMap((f) => f.authors ?? [])).toEqual([baseRekeyGroupKey(adopted.root, community.id, 2n).pk]);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.updateList).not.toHaveBeenCalled();
  });

  it("the winner stays where it is", { timeout: 30_000 }, async () => {
    const { owner, me, community, low } = await race();
    h.user = asNUser(me);
    const adopted = onKey(community, low, owner.pubkey, owner.pubkey);
    renderHook(() => useRekeyWatch(adopted), { wrapper: makeWrapper().wrapper });
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.updateList).not.toHaveBeenCalled();
  });
});

// ── The resume duty must not take a live rotation for an interrupted one ──

describe("useRefoundResume beside a Refounding in progress", () => {
  /** ConcordPage's arrangement: both hooks on the community list, which a recorded epoch re-renders. */
  async function mountPage(opts: { refuse?: (ev: NostrEvent, community: Community) => boolean } = {}) {
    const owner = member();
    const alice = member();
    const { community: base } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    const ch: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "sec" };
    const community: Community = { ...base, privateChannels: [ch] };

    const relay = new FakeRelay();
    relay.events.push(...(await channelAccessEditions(community, owner, ch.id, [alice.pubkey])));
    if (opts.refuse) relay.refuse = (ev) => opts.refuse!(ev, community);
    // A relay answers a publish after a round trip, as a real one does.
    const publish = relay.event.bind(relay);
    relay.event = async (ev) => {
      await new Promise((r) => setTimeout(r, 10));
      return publish(ev);
    };
    h.pool = { relay: () => relay, query: async () => [] };
    h.user = asNUser(owner);
    h.folded = foldedFor(owner.pubkey);

    let current: Community = community;
    const listeners = new Set<() => void>();
    const jm = jmOf(community, owner.pubkey);
    h.entry = { community_id: community.idHex, seed: jm, current: jm, added_at: 1 } satisfies CommunityListEntry;
    h.updateList = vi.fn(async (action: { type: string; current?: JoinMaterial }) => {
      if (action.type !== "refresh-current" || !action.current) return;
      const entry = { community_id: community.idHex, seed: jm, current: action.current, added_at: 1 } satisfies CommunityListEntry;
      h.entry = entry;
      current = rehydrateCommunity(entry)!;
      for (const l of listeners) l();
    });
    const subscribe = (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    };
    const page = renderHook(
      () => {
        const c = useSyncExternalStore(subscribe, () => current);
        useRefoundResume(c);
        return useRefound(c);
      },
      { wrapper: makeWrapper().wrapper },
    );
    /** Long enough for anything the resume duty queued to land, then the page closes. */
    const settle = async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 3000));
      });
      page.unmount();
      await refoundJournalReady();
    };
    return { owner, alice, community, relay, page, settle, current: () => current };
  }

  it("one rotation moves the community exactly one epoch", { timeout: 30_000 }, async () => {
    const { owner, alice, community, relay, page, settle, current } = await mountPage();
    await act(async () => {
      await page.result.current.refound({ keep: [alice.pubkey], exclude: [] });
    });
    await settle();

    expect(current().rootEpoch).toBe(1n);
    expect(relay.published.some((e) => e.pubkey === baseRekeyGroupKey(current().root, community.id, 2n).pk)).toBe(false);
    expect(refoundJournal(owner.pubkey, community.idHex)).toBeUndefined();
  });

  it("two rotations started back to back move it exactly two epochs", { timeout: 30_000 }, async () => {
    const { owner, alice, community, page, settle, current } = await mountPage();
    await act(async () => {
      const first = page.result.current.refound({ keep: [alice.pubkey], exclude: [] });
      const second = page.result.current.refound({ keep: [alice.pubkey], exclude: [] });
      await Promise.allSettled([first, second]);
    });
    await settle();

    expect(current().rootEpoch).toBe(2n);
    expect(refoundJournal(owner.pubkey, community.idHex)).toBeUndefined();
  });

  it("a run that really was cut short is still finished at its own epoch", { timeout: 30_000 }, async () => {
    let down = true;
    // The relay goes away right after the roll, and comes back.
    const { owner, alice, community, relay, page, settle, current } = await mountPage({
      refuse: (ev, c) => down && ev.pubkey !== baseRekeyGroupKey(c.root, c.id, 1n).pk,
    });
    await act(async () => {
      await page.result.current.refound({ keep: [alice.pubkey], exclude: [] }).catch(() => undefined);
    });
    expect(current().rootEpoch).toBe(1n);
    expect(relay.published.some((e) => e.pubkey === current().controlPk)).toBe(false);

    // Reopened: the duty finishes the carry.
    down = false;
    page.rerender();
    await settle();

    expect(current().rootEpoch).toBe(1n);
    expect(relay.published.some((e) => e.pubkey === current().controlPk)).toBe(true);
    expect(relay.published.some((e) => e.pubkey === baseRekeyGroupKey(current().root, community.id, 2n).pk)).toBe(false);
    expect(refoundJournal(owner.pubkey, community.idHex)).toBeUndefined();
  });
});
