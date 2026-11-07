/**
 * A moderator's voice directive as `useVoicePresence` receives it (CORD-07 §7):
 * judged on arrival by the Roster as it stands, server-wide, from a signer holding
 * the bit who strictly outranks the target, and only on the target's current stay.
 */
import { act, renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { foldControlState } from "@/concord/lib/control";
import { channelGroupKey, random32 } from "@/concord/lib/derive";
import { KIND_SEAL_ENCRYPTED, KIND_VOICE_DIRECTIVE, KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import { Permissions } from "@/concord/lib/roles";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";
import { directiveTags, presenceTags, type VoiceDirective, type VoiceDirectiveVerb } from "@/concord/lib/voice";
import { rankedCommunity } from "@/test/concordEditions";

import { openWrap } from "@/concord/lib/stream";

import { clearVoicePresenceMemory, onVoiceDirective, useVoiceModeration, useVoicePresence } from "./useVoice";

const h = vi.hoisted(() => ({
  folded: undefined as unknown,
  deliver: [] as ((e: NostrEvent) => void)[],
  nostr: { relay: () => ({ event: async (e: NostrEvent) => void h.sent.push(e) }) },
  sent: [] as NostrEvent[],
  user: undefined as { pubkey: string; signer: unknown } | undefined,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.nostr }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: h.folded }),
}));
vi.mock("@/concord/lib/ephemeralSub", () => ({
  subscribeEphemeral: (_n: unknown, _url: string, _pk: string, apply: (e: NostrEvent) => void) => {
    h.deliver.push(apply);
    return () => undefined;
  },
}));

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

const CHANNEL = random32();

function setup(bits: bigint, opts: { banned?: boolean } = {}) {
  const mod = signer();
  const target = signer();
  const { c, base } = rankedCommunity(bits, { admin: mod.pubkey });
  const ban = opts.banned ? [c.edition({ vsk: "4", eid: c.banlistHex(), author: c.owner, content: [mod.pubkey] })] : [];
  h.folded = foldControlState([...base, ...ban], c.id, c.owner);
  const group = channelGroupKey(random32(), CHANNEL, 0);
  const channel = {
    id: CHANNEL,
    idHex: Buffer.from(CHANNEL).toString("hex"),
    isPrivate: false,
    current: { epoch: 0n, group },
    streams: [{ epoch: 0n, group }],
  } as unknown as Channel;
  const community = { id: c.id, idHex: c.idHex, relays: ["wss://relay.test"] } as unknown as Community;
  const deliver = (wrap: NostrEvent) =>
    act(() => {
      for (const apply of h.deliver) apply(wrap);
    });
  const send = async (who: ReturnType<typeof signer>, kind: number, tags: string[][], content = "", ms = Date.now()) => {
    const rumor = buildRumor({ kind, content, tags: [...channelBindingTags(channel.idHex, 0n), ...tags], pubkey: who.pubkey, ms });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, who), group, { ephemeral: true });
    deliver(wrap);
    return wrap;
  };
  const joined = () => send(target, KIND_VOICE_PRESENCE, presenceTags("joined", "id-target", "https://av.test", {}), "joined");
  const directive = (verb: VoiceDirectiveVerb, by = mod, ms?: number) => send(by, KIND_VOICE_DIRECTIVE, directiveTags(target.pubkey, verb), "", ms);
  const left = () => send(target, KIND_VOICE_PRESENCE, presenceTags("left"), "left");
  const sentVerbs = () => h.sent.map((w) => openWrap(w, group)).filter((o) => o.kind === KIND_VOICE_DIRECTIVE).map((o) => o.tags.find((t) => t[0] === "do")?.[1]);
  return { community, channel, mod, target, joined, left, directive, deliver, sentVerbs };
}

describe("a moderator's voice directive on arrival (CORD-07 §7)", () => {
  beforeEach(() => {
    h.deliver = [];
    h.sent = [];
    h.user = undefined;
  });

  it("server-mutes the target for everyone, and tells the call", async () => {
    const s = setup(Permissions.MUTE_MEMBERS);
    const heard: VoiceDirective[] = [];
    const stop = onVoiceDirective(s.channel.current.group.pk, (d) => heard.push(d));
    const { result } = renderHook(() => useVoicePresence(s.community, s.channel));
    await s.joined();
    await s.directive("mute");
    expect(result.current.present.find((p) => p.author === s.target.pubkey)?.serverMuted).toBe(true);
    expect(heard.map((d) => d.verb)).toEqual(["mute"]);
    await s.directive("unmute");
    expect(result.current.present.find((p) => p.author === s.target.pubkey)?.serverMuted).toBeFalsy();
    stop();
  });

  it("ignores a signer without the directive's bit, server-wide", async () => {
    const s = setup(Permissions.DEAFEN_MEMBERS);
    const { result } = renderHook(() => useVoicePresence(s.community, s.channel));
    await s.joined();
    await s.directive("mute");
    expect(result.current.present.find((p) => p.author === s.target.pubkey)?.serverMuted).toBeFalsy();
  });

  it("ignores a banned signer, and one the target outranks", async () => {
    const banned = setup(Permissions.MUTE_MEMBERS, { banned: true });
    const { result } = renderHook(() => useVoicePresence(banned.community, banned.channel));
    await banned.joined();
    await banned.directive("mute");
    expect(result.current.present.find((p) => p.author === banned.target.pubkey)?.serverMuted).toBeFalsy();

    h.deliver = [];
    const s = setup(Permissions.MUTE_MEMBERS);
    const r2 = renderHook(() => useVoicePresence(s.community, s.channel));
    await s.joined();
    // The target can't mute themselves upward: nobody strictly outranks themselves.
    await s.directive("mute", s.target);
    expect(r2.result.current.present.find((p) => p.author === s.target.pubkey)?.serverMuted).toBeFalsy();
  });

  it("refuses a re-wrapped old joined once the stay it ended has aged out (CORD-07 §4)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const s = setup(Permissions.MUTE_MEMBERS);
      const { result } = renderHook(() => useVoicePresence(s.community, s.channel));
      const old = await s.joined();
      vi.advanceTimersByTime(1000);
      await s.left();
      act(() => void vi.advanceTimersByTime(120_000));
      s.deliver(old);
      expect(result.current.present.map((p) => p.author)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acts on nobody not in the call", async () => {
    const s = setup(Permissions.MUTE_MEMBERS);
    const heard: VoiceDirective[] = [];
    const stop = onVoiceDirective(s.channel.current.group.pk, (d) => heard.push(d));
    renderHook(() => useVoicePresence(s.community, s.channel));
    await s.directive("mute");
    expect(heard).toEqual([]);
    stop();
  });
});

describe("a moderator's standing directives (CORD-07 §7, Vector `reassert_voice_directives`)", () => {
  beforeEach(() => {
    h.deliver = [];
    h.sent = [];
  });

  it("re-asserts a mute when its target rejoins, until a newer lift from anyone", async () => {
    const s = setup(Permissions.MUTE_MEMBERS);
    h.user = { pubkey: s.mod.pubkey, signer: s.mod };
    renderHook(() => useVoicePresence(s.community, s.channel));
    const { result } = renderHook(() => useVoiceModeration(s.community, s.channel));
    await s.joined();
    await act(async () => {
      expect(await result.current.send(s.target.pubkey, "mute")).toBe(true);
    });
    expect(s.sentVerbs()).toEqual(["mute"]);
    // The relays hand this device its own directive back.
    s.deliver(h.sent[h.sent.length - 1]);

    await s.left();
    await s.joined();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(s.sentVerbs()).toEqual(["mute", "mute"]);
    s.deliver(h.sent[h.sent.length - 1]);

    // A newer unmute is heard; this device no longer stands behind its mute.
    await s.directive("unmute");
    await s.left();
    await s.joined();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(s.sentVerbs()).toEqual(["mute", "mute"]);
    h.user = undefined;
  });

  it("re-asserts once when two surfaces (the call and the roster) hold the same Channel", async () => {
    const s = setup(Permissions.MUTE_MEMBERS);
    h.user = { pubkey: s.mod.pubkey, signer: s.mod };
    renderHook(() => useVoicePresence(s.community, s.channel));
    const { result } = renderHook(() => useVoiceModeration(s.community, s.channel));
    renderHook(() => useVoiceModeration(s.community, s.channel));
    await s.joined();
    await act(async () => {
      await result.current.send(s.target.pubkey, "mute");
    });
    await s.left();
    await s.joined();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(s.sentVerbs()).toEqual(["mute", "mute"]);
    h.user = undefined;
  });

  it("keeps standing behind a mute when an older lift arrives (CORD-07 §7)", async () => {
    const s = setup(Permissions.MUTE_MEMBERS);
    h.user = { pubkey: s.mod.pubkey, signer: s.mod };
    renderHook(() => useVoicePresence(s.community, s.channel));
    const { result } = renderHook(() => useVoiceModeration(s.community, s.channel));
    await s.joined();
    await act(async () => {
      expect(await result.current.send(s.target.pubkey, "mute")).toBe(true);
    });
    s.deliver(h.sent[h.sent.length - 1]);
    // An unmute this device's mute already outdates, sent a moment before it.
    await s.directive("unmute", s.mod, Date.now() - 2000);
    await s.left();
    await s.joined();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(s.sentVerbs()).toEqual(["mute", "mute"]);
    h.user = undefined;
  });

  it("forgets the mutes it stood behind at logout", async () => {
    const s = setup(Permissions.MUTE_MEMBERS);
    h.user = { pubkey: s.mod.pubkey, signer: s.mod };
    renderHook(() => useVoicePresence(s.community, s.channel));
    const { result } = renderHook(() => useVoiceModeration(s.community, s.channel));
    await s.joined();
    await act(async () => {
      expect(await result.current.send(s.target.pubkey, "mute")).toBe(true);
    });
    clearVoicePresenceMemory();
    await s.left();
    await s.joined();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(s.sentVerbs()).toEqual(["mute"]);
    h.user = undefined;
  });

  it("refuses to send what the Roster doesn't allow", async () => {
    const s = setup(Permissions.DEAFEN_MEMBERS);
    h.user = { pubkey: s.mod.pubkey, signer: s.mod };
    const { result } = renderHook(() => useVoiceModeration(s.community, s.channel));
    expect(result.current.may(s.target.pubkey, "mute")).toBe(false);
    await act(async () => {
      expect(await result.current.send(s.target.pubkey, "mute")).toBe(false);
    });
    expect(h.sent).toEqual([]);
    h.user = undefined;
  });
});
