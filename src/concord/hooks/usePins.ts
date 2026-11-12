import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  citationFor,
  invalidateControl,
  publishEdition,
  useControlFold,
} from "@/concord/hooks/useControlPlane";
import { buildEditionRumor } from "@/concord/lib/edition";
import { bytesToHex, pinsLocator } from "@/concord/lib/derive";
import { KIND_DELETE, KIND_EDIT, VSK_PINS } from "@/concord/lib/kinds";
import {
  PIN_MAX_CONTENT_BYTES,
  PIN_MAX_ENTRIES,
  buildPinEntryOrReason,
  isPlaceholderSeal,
  partitionDeletedPins,
  readPinList,
  unconfirmedWrite,
  withProvenEdit,
  serializePublicPinList,
  serializeSealedPinList,
  verifyPinEntry,
  type PinBuildFailure,
  type PinEntry,
  type VerifiedPin,
} from "@/concord/lib/pins";

import { isAuthorized, Permissions } from "@/concord/lib/roles";
import { editionHash } from "@/concord/lib/version";
import { fetchChatSeal } from "@/concord/lib/chatSeal";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { defineMessages, t } from "@/i18n";

/** A pin as this client holds it: the entry, plus the id it was proven to carry. */
interface HeldPin {
  rumorId: string;
  entry: PinEntry;
}

const PIN_FAILURE_MESSAGE = defineMessages<PinBuildFailure>({
  "no-seal": {
    id: "usePins.failure.noSeal",
    defaultMessage: "This message's original signature wasn't kept, so it can't be proven. Messages received from now on can be pinned.",
  },
  pending: {
    id: "usePins.failure.pending",
    defaultMessage: "This message is still being sent. Try pinning it again in a moment.",
  },
  "not-encrypted": { id: "usePins.failure.notEncrypted", defaultMessage: "Only chat messages can be pinned." },
  "bad-payload": {
    id: "usePins.failure.badPayload",
    defaultMessage: "This message is from an epoch whose keys you no longer hold.",
  },
  unverifiable: {
    id: "usePins.failure.unverifiable",
    defaultMessage: "This message failed verification, so pinning it would publish an unprovable claim.",
  },
});


/**
 * A Channel's pins (CORD-04 §7). The list rides the Control Plane, so it
 * survives rotations. Every rendered pin is VERIFIED here (seal signature, MAC
 * under disclosed keys, decryption, author equality, channel binding).
 */
export function usePins(
  community: Community | undefined,
  channel: Channel | undefined,
  /** The channel's opened rows, so a keyed client can apply Edits locally (§7). */
  opened?: Map<string, OpenedEvent>,
) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);

  const eidHex = useMemo(
    () => (community && channel ? bytesToHex(pinsLocator(community.id, channel.id)) : undefined),
    [community, channel],
  );
  const head = eidHex ? folded?.pinLists.get(eidHex) : undefined;

  /** Verified pins, newest first; memoized on raw content since verification is costly. */
  const pins = useMemo<VerifiedPin[]>(() => {
    if (!head || !channel) return [];
    const { entries } = readList(head.content, channel);
    const out: VerifiedPin[] = [];
    for (const entry of entries) {
      const verified = verifyPinEntry(entry, channel.idHex);
      if (verified) out.push(verified); // a failed entry is dropped ALONE
    }
    return out.sort((a, b) => b.ms - a.ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.content, channel?.idHex, channel?.streams.length]);

  /** The list exists but is sealed under an epoch key we never held. */
  const dark = useMemo(() => {
    if (!head || !channel) return false;
    return readList(head.content, channel).sealed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.content, channel?.idHex, channel?.streams.length]);

  /**
   * Edits this client can read but the entry doesn't carry (§7), keyed by pinned
   * rumor id. A keyed member MUST show the revision; a curator can push the proof.
   */
  const localEdits = useMemo(() => {
    const out = new Map<string, { opened: OpenedEvent; content: string; ms: number }>();
    if (!opened || pins.length === 0) return out;
    const pinned = new Map(pins.map((p) => [p.rumorId, p]));
    for (const ev of opened.values()) {
      if (ev.kind !== KIND_EDIT) continue;
      const target = ev.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      const pin = pinned.get(target);
      if (!pin || ev.author !== pin.author) continue;
      // Newer than the entry's proof and any sibling edit picked so far.
      if (pin.edited && ev.ms <= pin.edited.ms) continue;
      const prev = out.get(target);
      if (prev && prev.ms >= ev.ms) continue;
      out.set(target, { opened: ev, content: ev.content, ms: ev.ms });
    }
    return out;
  }, [opened, pins]);

  /**
   * Deletes this client holds (§7): self-erasure outranks curation, so a held
   * delete hides the entry immediately — otherwise the pin (carried by compaction)
   * would outlive the deletion.
   */
  const deletes = useMemo(
    () => [...(opened?.values() ?? [])].filter((e) => e.kind === KIND_DELETE),
    [opened],
  );
  const { alive, killed } = useMemo(() => partitionDeletedPins(pins, deletes), [pins, deletes]);

  /** Verified pins with locally-readable Edits applied; `staleEdit` marks unprovable ones. */
  const view = useMemo(
    () =>
      alive.map((p) => {
        const local = localEdits.get(p.rumorId);
        return local
          ? { ...p, content: local.content, edited: { content: local.content, ms: local.ms }, staleEdit: true }
          : { ...p, staleEdit: false };
      }),
    [alive, localEdits],
  );

  // Never publish from a view we couldn't READ: a replace-entire edition would drop
  // unseen entries. Either the list is sealed under an unheld epoch (`dark`) or
  // the fold served no edition for this entity this round (`incomplete`).
  const unreadable = dark || Boolean(eidHex && folded?.incomplete.includes(eidHex));
  const canPin =
    Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.PIN_MESSAGES)) &&
    !unreadable;

  /**
   * Our own last write, held until the fold catches up. Writes are replace-entire
   * and the fold lags, so we chain off our own (locally hashable) edition or a
   * second quick write would erase the first.
   */
  const written = useRef<{ eid: string; version: bigint; hash: Uint8Array; held: HeldPin[] } | undefined>(undefined);
  // Keyed by entity, not cleared on switch: a queued op for the old channel would
  // repopulate it after any clear.
  const mineHere = () => (written.current?.eid === eidHex ? written.current : undefined);

  /** The head as we best know it: our own write while it outranks the fold. */
  const knownHead = () => {
    const foldedHead = eidHex ? folded?.heads.get(eidHex) : undefined;
    return unconfirmedWrite(mineHere(), foldedHead, eidHex) ? mineHere() : foldedHead;
  };

  /** The list to build the next write from — ours if the fold hasn't caught up. */
  const currentPins = (): HeldPin[] =>
    unconfirmedWrite(mineHere(), eidHex ? folded?.heads.get(eidHex) : undefined, eidHex) ??
    pins.map((p) => ({ rumorId: p.rumorId, entry: p.entry }));

  // Serialized: concurrent writes lose pins.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = <T,>(op: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(op, op);
    queue.current = next.catch(() => undefined);
    return next;
  };

  /** Publish the list, replaced entire — the only write shape (§7). */
  const publish = async (held: HeldPin[]) => {
    if (!user || !community || !channel || !eidHex) throw new Error(t({ id: "usePins.notReady", defaultMessage: "Not ready." }));
    const entries = held.map((h) => h.entry);
    const content = channel.isPrivate
      ? serializeSealedPinList(entries, channel.current.group.convKey, channel.current.epoch)
      : serializePublicPinList(entries);
    const prior = knownHead();
    const entityId = pinsLocator(community.id, channel.id);
    const version = prior ? prior.version + 1n : 1n;
    await publishEdition(
      nostr,
      community,
      user.signer,
      buildEditionRumor({
        vsk: VSK_PINS,
        entityId,
        content,
        actorPubkey: user.pubkey,
        version,
        prevHash: prior?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    );
    written.current = {
      eid: eidHex,
      version,
      hash: editionHash(entityId, version, prior?.hash, new TextEncoder().encode(content)),
      held,
    };
    if (community) invalidateControl(queryClient, community.idHex);
  };

  const pin = useMutation<void, Error, { opened: OpenedEvent }>({
    mutationFn: ({ opened }) => serialize(async () => {
      if (!channel) throw new Error(t({ id: "usePins.notReady", defaultMessage: "Not ready." }));
      const current = currentPins();
      if (current.length >= PIN_MAX_ENTRIES) {
        throw new Error(t({ id: "usePins.limitReached", defaultMessage: "This channel already has {max} pins. Unpin one first." }, { max: PIN_MAX_ENTRIES }));
      }
      // The epoch the message was written under.
      const epoch = epochOf(opened);
      const stream = channel.streams.find((s) => (epoch === undefined ? false : s.epoch === epoch)) ?? channel.current;
      // Store rows have no seal and just-sent rows a PLACEHOLDER; pinning needs the real one.
      const needsSeal = !opened.seal || isPlaceholderSeal(opened.seal);
      const withSeal = needsSeal
        ? { ...opened, seal: community ? await fetchChatSeal(nostr, community, channel, opened, epoch) : undefined }
        : opened;
      const { entry, reason } = buildPinEntryOrReason(withSeal, stream.group.convKey);
      if (!entry) throw new Error(t(PIN_FAILURE_MESSAGE[reason ?? "unverifiable"]));
      if (current.some((h) => h.rumorId === opened.rumorId)) return; // already pinned
      await publish([{ rumorId: opened.rumorId, entry }, ...current]);
    }),
  });

  const unpin = useMutation<void, Error, { rumorId: string }>({
    mutationFn: ({ rumorId }) =>
      serialize(async () => {
        await publish(currentPins().filter((h) => h.rumorId !== rumorId));
      }),
  });

  /**
   * Settle what the list owes keyless readers: drop author-erased entries and
   * attach the newest provable Edit, in one replace-entire write. Attach only
   * edits NEWER than the entry's, or the pin would silently revert.
   */
  const refreshEdits = useMutation<number, Error, void>({
    mutationFn: () => serialize(async () => {
      if (!channel || !community) return 0;
      const erased = new Set(killed.map((p) => p.rumorId));
      if (localEdits.size === 0 && erased.size === 0) return 0;
      let changed = 0;
      const next: HeldPin[] = [];
      for (const p of currentPins()) {
        // Drop erased messages from the head: compaction re-wraps it verbatim into
        // every future epoch.
        if (erased.has(p.rumorId)) {
          changed += 1;
          continue;
        }
        const local = localEdits.get(p.rumorId);
        if (!local) {
          next.push(p);
          continue;
        }
        const epoch = epochOf(local.opened);
        const stream =
          channel.streams.find((s) => (epoch === undefined ? false : s.epoch === epoch)) ?? channel.current;
        // Store rows lack the seal; proving a revision needs the Edit's seal.
        const opened =
          local.opened.seal && !isPlaceholderSeal(local.opened.seal)
            ? local.opened
            : { ...local.opened, seal: await fetchChatSeal(nostr, community, channel, local.opened, epoch) };
        const withEdit = withProvenEdit(p.entry, opened, stream.group.convKey);
        // Compare CONTENT: withProvenEdit always returns a fresh object.
        if (withEdit.edit?.keys !== p.entry.edit?.keys) changed += 1;
        next.push({ rumorId: p.rumorId, entry: withEdit });
      }
      if (changed > 0) await publish(next);
      return changed;
    }),
  });

  /**
   * Push revisions to keyless readers automatically. A random delay collapses
   * simultaneous curators into one publisher and coalesces an author's burst of edits.
   */
  // Depend on a STRING: the Map/mutation change identity most renders, and the
  // effect would re-arm forever without firing.
  const editSignature = useMemo(
    () =>
      [
        ...[...localEdits.entries()].map(([id, e]) => `e${id}:${e.ms}`),
        ...killed.map((p) => `d${p.rumorId}`),
      ]
        .sort()
        .join("|"),
    [localEdits, killed],
  );
  // The affected author acts at once; other curators wait (CORD-04 §7, Vector `run_pin_duty`).
  const me = user?.pubkey;
  const mine = me !== undefined && (killed.some((p) => p.author === me) || [...localEdits.values()].some((e) => e.opened.author === me));
  const pushed = useRef("");
  const runPush = useRef<() => Promise<unknown>>(async () => undefined);
  useEffect(() => {
    runPush.current = () => refreshEdits.mutateAsync();
  });
  useEffect(() => {
    if (!canPin || !editSignature) return;
    // One attempt per distinct set of stale revisions: a failure must not spin.
    if (pushed.current === editSignature) return;
    const timer = setTimeout(() => {
      // Marked done only on success so a brief outage doesn't drop the §7 obligation;
      // the signature bounds re-firing.
      void runPush.current().then(
        () => {
          pushed.current = editSignature;
        },
        () => undefined,
      );
    }, mine ? 0 : 3_000 + Math.floor(Math.random() * 12_000));
    return () => clearTimeout(timer);
  }, [canPin, editSignature, mine]);

  // A rotation leaves the list sealed under a key members let in at the new epoch never
  // held: re-sealed under the current one, by any curator holding it, after a short
  // random delay (CORD-06 §3 rotation duties).
  const sealedEpoch = useMemo(() => {
    if (!head || !channel?.isPrivate) return undefined;
    try {
      const raw = JSON.parse(head.content) as { epoch?: unknown; sealed?: unknown };
      return typeof raw.epoch === "string" && /^(0|[1-9][0-9]*)$/.test(raw.epoch) && typeof raw.sealed === "string" ? BigInt(raw.epoch) : undefined;
    } catch {
      return undefined;
    }
  }, [head, channel?.isPrivate]);
  const resealOwed = canPin && pins.length > 0 && sealedEpoch !== undefined && channel !== undefined && sealedEpoch < channel.current.epoch;
  const resealRef = useRef<() => Promise<unknown>>(async () => undefined);
  useEffect(() => {
    resealRef.current = () => serialize(() => publish(currentPins()));
  });
  useEffect(() => {
    if (!resealOwed) return;
    const timer = setTimeout(() => void resealRef.current().catch(() => undefined), 3_000 + Math.floor(Math.random() * 12_000));
    return () => clearTimeout(timer);
  }, [resealOwed, channel?.current.epoch]);

  const pinnedIds = useMemo(() => new Set(alive.map((p) => p.rumorId)), [alive]);
  const isPinned = useCallback((rumorId: string) => pinnedIds.has(rumorId), [pinnedIds]);

  return {
    pins: view,
    /** Pins whose revision this client sees but the entry can't prove yet. */
    staleEdits: localEdits.size,
    /** Pins their author erased, hidden here and dropped from the head shortly. */
    deletedPins: killed.length,
    refreshEdits: refreshEdits.mutateAsync,
    isRefreshingEdits: refreshEdits.isPending,
    /** Sealed under an epoch we never held: pins exist but are unreadable. */
    dark,
    canPin,
    isPinned,
    pin: pin.mutateAsync,
    isPinning: pin.isPending,
    unpin: unpin.mutateAsync,
    isUnpinning: unpin.isPending,
    /** Remaining budget, which is the real ceiling for a private channel (§7). */
    remaining: { entries: Math.max(0, PIN_MAX_ENTRIES - alive.length), bytes: PIN_MAX_CONTENT_BYTES },
  };
}

/** Decode a list, handing it the key for whichever epoch it was sealed at. */
function readList(content: string, channel: Channel) {
  return readPinList(content, (epoch) => channel.streams.find((s) => s.epoch === epoch)?.group.convKey);
}

function epochOf(opened: OpenedEvent): bigint | undefined {
  for (const t of opened.tags) {
    if (t[0] === "epoch" && /^(0|[1-9][0-9]*)$/.test(t[1] ?? "")) return BigInt(t[1]);
  }
  return undefined;
}
