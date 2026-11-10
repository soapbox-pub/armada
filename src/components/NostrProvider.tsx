import React, { useEffect, useMemo, useRef } from "react";
import { NostrEvent, NostrFilter, NPool, NRelay1, NSecSigner } from "@nostrify/nostrify";
import { nip19 } from "nostr-tools";
import { NostrContext } from "@nostrify/react";
import { NUser, useNostrLogin } from "@nostrify/react/login";
import type { NostrSigner } from "@nostrify/types";

import { EventStoreContext, type EventStoreContextType } from "@/contexts/EventStoreContext";
import { broadcastWriteRelays, userReadRelays, userWriteRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCachedNip29Servers } from "@/hooks/useCachedNip29Servers";
import { poolReqTargets } from "@/lib/poolRouting";
import { VerifiedRelay } from "@/lib/verifiedRelay";
import { appEventStore } from "@/lib/db/mainEventStore";
import { detachableClient, NostrBatcher } from "@/lib/NostrBatcher";
import { AndroidNativeSigner } from "@/lib/androidNativeSigner";
import { authCooldownMs, nextAuthStreak, type AuthStreak } from "@/lib/authCooldown";
import { Nip46Signer } from "@/lib/nip46Signer";
import { getNip46Transport } from "@/lib/nip46Transport";
import { normalizeRelayUrl } from "@/lib/platform";
import { logNostrEvent, logNostrReq } from "@/lib/nostrQueryLog";
import { logRelayOpen } from "@/lib/relayConnectionLog";
import { emitRelayReopened } from "@/lib/relayReopen";
import { noteRelayClosed, noteRelayOpened } from "@/lib/relayHealth";
import { onDesktopResume } from "@/lib/desktop";
import { logSync } from "@/lib/syncLog";
import {
  claimStreamAuths,
  noteAuthResult,
  noteRelayChallenged,
  noteStreamAuthSent,
  onStreamAuthStale,
  onStreamKeysAdded,
  resetRelayAuth,
  signStreamAuths,
  signStreamAuthsChunked,
  streamPubkeysForRelay,
  claimStaleWave,
} from "@/concord/lib/streamAuth";
import { nowSecs } from "@/lib/relayClock";

interface NostrProviderProps {
  children: React.ReactNode;
}

/**
 * Head start for the user signer on a NIP-42 challenge before falling back to
 * a locally-signed stream key; only slow NIP-46 bunkers exceed it (their AUTH is sent out-of-band).
 */
const USER_AUTH_HEADSTART_MS = 1_200;

/** NIP-59 gift-wrap kinds. See `wire/ingest.ts` WRAP_KINDS. */
const WRAP_KINDS = new Set([1059, 21059]);

/**
 * Skip Schnorr verification for gift-wraps. Their outer sig is from an
 * ephemeral or group-shared stream key, so it proves nothing; authenticity
 * comes from NIP-44 plus the seal signature and rumor bindings checked in the
 * decrypt path. All other kinds keep full verification.
 */
function isWrap(event: NostrEvent): boolean {
  return WRAP_KINDS.has(event.kind);
}

/**
 * App-wide relay pool (ported from Ditto): NIP-42 AUTH on every relay,
 * batched queries cached in IndexedDB. Generic traffic goes to the GENERAL
 * relays, not every joined server (see `poolReqTargets`); group traffic
 * should use `nostr.relay(serverUrl)`.
 */
const NostrProvider: React.FC<NostrProviderProps> = (props) => {
  const { children } = props;
  const { config } = useAppContext();
  const { logins } = useNostrLogin();

  const pool = useRef<NPool | undefined>(undefined);

  // App-wide event store, the `main` ArmadaDB tenant (src/lib/db/mainEventStore.ts).
  const eventStore = useRef<EventStoreContextType | undefined>(undefined);
  if (eventStore.current === undefined) {
    const store = appEventStore();
    // Pay the backend's cold-open penalty (~2.5s IndexedDB stall on Android) now.
    void store.then((s) => s.query([{ kinds: [0], limit: 1 }])).catch(() => undefined);
    eventStore.current = store;
    // Concord rumor tenants open per community on first read.
  }

  // Servers stay in the pool so an air-gapped deployment works with zero app
  // relays. They come from the folded 10009 snapshot because this provider
  // can't call `useUserGroupList`.
  const cachedServers = useCachedNip29Servers(logins[0]?.pubkey);
  const activePubkey = logins[0]?.pubkey;

  // App relays (unless off) + joined servers, which are never gated.
  const basePoolRelays = useMemo(() => {
    const urls = new Set<string>();
    if (config.useAppRelays) {
      for (const url of config.appRelays) {
        const normalized = normalizeRelayUrl(url);
        if (normalized) urls.add(normalized);
      }
    }
    for (const url of cachedServers) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return urls;
  }, [config.useAppRelays, config.appRelays, cachedServers]);

  // With `useUserRelays` on, fold in the user's NIP-65 read/write relays (only ever adds).
  const poolReadRelays = useMemo(() => {
    const urls = new Set(basePoolRelays);
    // The general pool isn't author-routed yet, so reads include NIP-65 write relays too.
    for (const url of userReadRelays(config, activePubkey)) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    for (const url of userWriteRelays(config, activePubkey)) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [basePoolRelays, config, activePubkey]);

  const poolWriteRelays = useMemo(() => {
    const urls = new Set(basePoolRelays);
    for (const url of userWriteRelays(config, activePubkey)) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    // Write-only relays appear ONLY here: never subscribed or queried. Gated with
    // app relays, since turning those off means "keep my data off app relays".
    for (const url of broadcastWriteRelays(config)) urls.add(url);
    return [...urls];
  }, [basePoolRelays, config, activePubkey]);

  const poolReadRelaysRef = useRef(poolReadRelays);
  useEffect(() => {
    poolReadRelaysRef.current = poolReadRelays;
  }, [poolReadRelays]);

  const poolWriteRelaysRef = useRef(poolWriteRelays);
  useEffect(() => {
    poolWriteRelaysRef.current = poolWriteRelays;
  }, [poolWriteRelays]);

  // The base pool WITHOUT joined servers; generic REQs route here (see poolReqTargets).
  const poolGeneralRelays = useMemo(() => {
    const urls = new Set<string>();
    if (config.useAppRelays) {
      for (const url of config.appRelays) {
        const normalized = normalizeRelayUrl(url);
        if (normalized) urls.add(normalized);
      }
    }
    for (const url of userReadRelays(config, activePubkey)) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    for (const url of userWriteRelays(config, activePubkey)) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config, activePubkey]);

  const poolGeneralRelaysRef = useRef(poolGeneralRelays);
  useEffect(() => {
    poolGeneralRelaysRef.current = poolGeneralRelays;
  }, [poolGeneralRelays]);

  // NIP-50 search relays; falls back to the pool when none configured.
  const searchRelays = useMemo(() => {
    const urls = new Set<string>();
    for (const url of config.searchRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config.searchRelays]);

  const searchRelaysRef = useRef(searchRelays);
  useEffect(() => {
    searchRelaysRef.current = searchRelays;
  }, [searchRelays]);

  // Read lazily by the pool's AUTH callback so it always uses the latest signer.
  const signerRef = useRef<NostrSigner | undefined>(undefined);
  // Reuse a signature when a relay re-issues the identical challenge.
  const authCacheRef = useRef<Map<string, { challenge: string; event: NostrEvent; signedAt: number }>>(new Map());
  // Collapse concurrent challenges onto one sign (the cache is only set after signing).
  const authInFlightRef = useRef<Map<string, Promise<NostrEvent>>>(new Map());
  // Hold new signs until this time, so re-challenging relays can't flood the signer.
  // Survives socket reopen: a flapping socket is exactly the flood (see authCooldown.ts).
  const authCooldownRef = useRef<Map<string, number>>(new Map());
  const authStreakRef = useRef<Map<string, AuthStreak>>(new Map());
  // Whether the signer shows the user each signature (anything but a local key).
  const signerPromptsRef = useRef(false);

  // Concord auths as derived stream keys: a kind-1059 REQ passes a gating relay
  // only once every `authors` entry is authenticated.
  const openRelaysRef = useRef<Map<string, { relay: NRelay1; challenge?: string }>>(new Map());

  /**
   * Send NIP-42 AUTH frames for this relay's stream pubkeys, signed in batches
   * in the EC worker pool. Aborts if the socket reopens (dead nonce). The
   * relay's OK marks keys authenticated (streamAuth ack state).
   */
  const sendStreamAuths = async (
    entry: { relay: NRelay1; challenge?: string },
    url: string,
    pubkeys?: string[],
  ) => {
    const challenge = entry.challenge;
    if (!challenge) return;
    for await (const chunk of signStreamAuthsChunked(challenge, url, pubkeys)) {
      if (entry.challenge !== challenge) return; // stale nonce — a fresh challenge will re-cover
      for (const ev of chunk) {
        try {
          entry.relay.socket.send(JSON.stringify(["AUTH", ev]));
          // Mark pending ONLY after send: a half-open socket drops the frame, and a
          // pending key whose OK never comes wedges streamAuthsSettled.
          noteStreamAuthSent(url, ev.id, ev.pubkey);
        } catch {
          // Socket not open; the next auth-required round re-sends.
        }
      }
    }
  };

  /**
   * On socket reopen (#45), reset NIP-42 state (NRelay1 carries stale auth
   * across reconnects) and ack our raw stream AUTHs from `OK` frames.
   * Also retransmits NRelay1's pending EVENTs: it re-issues subs on reconnect
   * but not unacked EVENTs, so a write into a half-open socket would be lost
   * (a 60s hang for NIP-46). Duplicates are idempotent.
   */
  const watchSocketReopen = (relay: NRelay1, url: string) => {
    const internals = relay as unknown as {
      authRetriedSubs?: Set<string>;
      authRetriedEvents?: Set<string>;
      authPromise?: Promise<void>;
      pendingEvents?: Map<string, NostrEvent>;
      socket: NRelay1["socket"];
    };
    const onOpen = () => {
      noteRelayOpened(url);
      internals.authRetriedSubs?.clear();
      internals.authRetriedEvents?.clear();
      internals.authPromise = undefined;
      authCacheRef.current.delete(url);
      authInFlightRef.current.delete(url);
      resetRelayAuth(url); // the old session's AUTH acks died with the socket
      const entry = openRelaysRef.current.get(url);
      if (entry) entry.challenge = undefined; // the old socket's nonce is dead
      // Anything still pending never reached the relay or lost its OK.
      const pending = internals.pendingEvents;
      if (pending?.size) {
        logSync("auth", `socket reopened for ${url} — retransmitting ${pending.size} pending EVENT(s)`);
        for (const ev of pending.values()) {
          try {
            relay.socket.send(JSON.stringify(["EVENT", ev]));
          } catch {
            // Socket flapped again; the next reopen retransmits.
          }
        }
      }
      // Standing consumers should re-REQ: their re-issued subs may have raced AUTH (see relayReopen.ts).
      emitRelayReopened(url);
    };
    const onClose = () => noteRelayClosed(url);
    // Prefix check first so the wrap firehose isn't double-parsed.
    const onMessage = (...args: unknown[]) => {
      const data = args
        .map((a) => (a as { data?: unknown } | undefined)?.data)
        .find((d): d is string => typeof d === "string");
      if (!data?.startsWith('["OK"')) return;
      try {
        const [, id, ok, message] = JSON.parse(data) as [string, string, boolean, unknown];
        if (typeof id === "string") {
          noteAuthResult(url, id, ok === true, typeof message === "string" ? message : undefined);
        }
      } catch { /* ignore */ }
    };
    const attach = (socket: NRelay1["socket"]) => {
      try {
        const s = socket as unknown as {
          addEventListener(type: string, listener: (...args: unknown[]) => void): void;
        };
        s.addEventListener("open", onOpen);
        s.addEventListener("message", onMessage);
        s.addEventListener("close", onClose);
      } catch { /* ignore */ }
    };
    // NRelay1.wake() REPLACES relay.socket; intercept the assignment to watch the new one.
    let currentSocket = relay.socket;
    attach(currentSocket);
    try {
      Object.defineProperty(relay, "socket", {
        configurable: true,
        enumerable: true,
        get: () => currentSocket,
        set: (socket: NRelay1["socket"]) => {
          currentSocket = socket;
          attach(socket);
        },
      });
    } catch {
      // Non-configurable in some runtime; the original socket is still watched.
    }
  };

  // websocket-ts treats close() as final and NRelay1 only rebuilds on next
  // send, so wake() immediately. Idle-closed sockets are skipped.
  const reconnectAllRelays = (reason: string) => {
    for (const [url, entry] of openRelaysRef.current) {
      const internals = entry.relay as unknown as { closedByUser: boolean; wake(): void };
      if (internals.closedByUser || entry.relay.socket.closedByUser) continue;
      logSync("auth", `${reason} — reconnecting ${url}`);
      entry.challenge = undefined; // the old socket's nonce dies with it
      try {
        entry.relay.socket.close();
        internals.wake();
      } catch {
        // Socket already dead; its reconnect re-authenticates.
      }
    }
  };


  // `open()` reads refs lazily, so building before signer/relays finalize is safe.
  if (!pool.current) {
    pool.current = new NPool({
      open(url: string) {
        // `new WebSocket("/")` resolves against the page URL, so junk relay strings
        // would open a socket to our own origin.
        if (!/^wss?:\/\/[^/]/i.test(url)) {
          throw new TypeError(`Refusing to open non-relay URL: ${JSON.stringify(url)}`);
        }
        logRelayOpen(url);
        const relay: NRelay1 = new VerifiedRelay(url, {
          // Other kinds are verified by the relay inbox in batches on the worker pool.
          skipVerify: isWrap,
          // NIP-42: sign kind 22242. A slow NIP-46 bunker is kept off the critical path
          // by the stream-key head-start race below.
          auth: async (challenge: string) => {
            // Remember the challenge for later stream keys and authenticate held ones now.
            const entry = openRelaysRef.current.get(url) ?? { relay };
            entry.challenge = challenge;
            openRelaysRef.current.set(url, entry);
            noteRelayChallenged(url, challenge);
            const streamPks = streamPubkeysForRelay(url);
            const unsent = claimStreamAuths(url);
            logSync(
              "auth",
              `NIP-42 challenge from ${url} — signing user + ${unsent.length}/${streamPks.length} stream key(s)`,
            );
            void sendStreamAuths(entry, url, unsent);

            /**
             * Sign the user's kind-22242, guarded for slow bunkers: reuse on an identical
             * challenge, collapse concurrent bursts, and within the cooldown DELAY (not
             * refuse) — NRelay1 gives each sub one auth-retry per socket, so a dropped
             * challenge would kill a gated sub. A delayed sign uses the latest challenge.
             */
            const signUserAuth = (): Promise<NostrEvent> => {
              const signer = signerRef.current;
              if (!signer) {
                return Promise.reject(new Error("AUTH failed: no signer available (user not logged in)"));
              }
              const cached = authCacheRef.current.get(url);
              if (cached && cached.challenge === challenge) {
                return Promise.resolve(cached.event);
              }
              const inFlight = authInFlightRef.current.get(url);
              if (inFlight) return inFlight;
              const wait = (authCooldownRef.current.get(url) ?? 0) - Date.now();
              if (wait > 0) logSync("auth", `user AUTH for ${url} held ${Math.round(wait / 1000)}s by cooldown`);
              const signing: Promise<NostrEvent> = (wait > 0
                ? new Promise<void>((resolve) => setTimeout(resolve, wait))
                : Promise.resolve()
              ).then(() => {
                // A reopen during the hold started a newer attempt; one sign answers both.
                const newer = authInFlightRef.current.get(url);
                if (newer && newer !== signing) return newer;
                const current = openRelaysRef.current.get(url)?.challenge ?? challenge;
                const liveSigner = signerRef.current;
                if (!liveSigner) {
                  throw new Error("AUTH failed: no signer available (user not logged in)");
                }
                // Held from the ASK, not the answer: a prompt nobody answers never settles,
                // and a reopen meanwhile would otherwise start another one unheld.
                const now = Date.now();
                const streak = nextAuthStreak(authStreakRef.current.get(url), now);
                authStreakRef.current.set(url, streak);
                authCooldownRef.current.set(url, now + authCooldownMs(streak.count, signerPromptsRef.current));
                return liveSigner.signEvent({
                  kind: 22242,
                  content: "",
                  tags: [
                    ["relay", url],
                    ["challenge", current],
                  ],
                  created_at: nowSecs(),
                }).then((ev) => {
                  authCacheRef.current.set(url, { challenge: current, event: ev, signedAt: Date.now() });
                  return ev;
                });
              }).finally(() => {
                if (authInFlightRef.current.get(url) === signing) authInFlightRef.current.delete(url);
              });
              authInFlightRef.current.set(url, signing);
              return signing;
            };

            const userSign = signUserAuth();
            userSign.catch(() => undefined);
            if (streamPks.length === 0) {
              // No stream keys here (e.g. NIP-29): only the user identity can satisfy the gate.
              return userSign;
            }

            // Keep the bunker off the reconnect path: after a short head start, resolve
            // with a local stream-key 22242 and deliver the user's AUTH out-of-band
            // (ditto-relay accepts AUTH for the socket's lifetime).
            const fast = await Promise.race([
              userSign.then((ev) => ev, () => undefined),
              new Promise<undefined>((r) => setTimeout(() => r(undefined), USER_AUTH_HEADSTART_MS)),
            ]);
            if (fast) return fast;
            void userSign.then((ev) => {
              const live = openRelaysRef.current.get(url);
              try {
                live?.relay.socket.send(JSON.stringify(["AUTH", ev]));
              } catch {
                // Socket flapped; the next challenge re-signs.
              }
            }).catch(() => undefined);
            logSync("auth", `user sign is slow for ${url} — answering the challenge with a stream key, user AUTH to follow`);
            const [streamEv] = signStreamAuths(challenge, url, [streamPks[0]]);
            return streamEv;
          },
        });
        const existing = openRelaysRef.current.get(url);
        openRelaysRef.current.set(url, { relay, challenge: existing?.challenge });
        watchSocketReopen(relay, url);
        return relay;
      },
      reqRouter(filters: NostrFilter[]): Map<string, NostrFilter[]> {
        if (filters.some((f) => "search" in f)) {
          const targets = searchRelaysRef.current.length > 0
            ? searchRelaysRef.current
            : poolReadRelaysRef.current;
          const routed = new Map(targets.map((url) => [url, filters]));
          logNostrReq([...routed.keys()], filters, "search");
          return routed;
        }
        // Servers see pool-wide REQs only when the filter concerns them
        // (poolReqTargets); fanning to all servers would multiply every event per relay.
        const targets = poolReqTargets(
          filters,
          poolGeneralRelaysRef.current,
          poolReadRelaysRef.current,
        );
        const routed = new Map(targets.map((url) => [url, filters]));
        logNostrReq([...routed.keys()], filters, "pool");
        return routed;
      },
      eventRouter(event: NostrEvent) {
        const relays = [...poolWriteRelaysRef.current];
        logNostrEvent(relays, event);
        return relays;
      },
      eoseTimeout: 300,
    });
  }

  const currentLogin = logins[0];
  const currentSigner = useMemo(() => {
    if (!currentLogin) return undefined;
    try {
      switch (currentLogin.type) {
        case "nsec":
          return NUser.fromNsecLogin(currentLogin).signer;
        case "bunker": {
          // Dedicated plain-WebSocket NIP-46 transport, never the relay pool, whose
          // sockets wedged remote signs on Android (see nip46Transport.ts).
          const clientSk = nip19.decode(currentLogin.data.clientNsec) as { type: "nsec"; data: Uint8Array };
          return new Nip46Signer({
            transport: getNip46Transport(
              currentLogin.data.bunkerPubkey,
              currentLogin.data.relays ?? [],
            ),
            bunkerPubkey: currentLogin.data.bunkerPubkey,
            clientSigner: new NSecSigner(clientSk.data),
          });
        }
        case "extension":
          return NUser.fromExtensionLogin(currentLogin).signer;
        case "x-android-signer": {
          // NIP-55 (Amber etc.), seeded with the known pubkey to skip getPublicKey.
          // AUTH-only signer; each sign is an intent round-trip, so treated as slow.
          const { packageName } = currentLogin.data as { packageName: string };
          return new AndroidNativeSigner(packageName, currentLogin.pubkey);
        }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }, [currentLogin]);

  signerRef.current = currentSigner;
  signerPromptsRef.current = currentLogin !== undefined && currentLogin.type !== "nsec";

  // NIP-42 has no un-auth: a socket authed as account A keeps A's grants after
  // switching to B. Bounce every socket on an account-to-account switch.
  const prevPubkeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const pubkey = currentLogin?.pubkey;
    const prev = prevPubkeyRef.current;
    prevPubkeyRef.current = pubkey;
    if (prev === pubkey) return;
    // The next account owes nothing for this one's prompts.
    authCooldownRef.current.clear();
    authStreakRef.current.clear();
    if (!prev || !pubkey) return;
    reconnectAllRelays("account switched");
  }, [currentLogin?.pubkey]);

  // After suspend, Chromium often keeps frozen sockets OPEN with dead TCP. The
  // desktop shell relays an OS resume signal; rebuild every socket.
  useEffect(() => {
    return onDesktopResume(() => reconnectAllRelays("resumed from suspend"));
    // Reads only refs and a stable render-body closure; provider-lifetime.
  }, []);

  // Backstop for resume detection: Flatpak has no system bus so `powerMonitor`
  // never fires. A wall-clock jump across an interval tick means we woke.
  // Bouncing is idempotent; the threshold only needs to beat hidden-tab throttling.
  useEffect(() => {
    const PERIOD_MS = 30_000;
    const WAKE_GAP_MS = 90_000;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (gap > WAKE_GAP_MS) {
        reconnectAllRelays(`wall-clock jump (${Math.round(gap / 1000)}s)`);
      }
    }, PERIOD_MS);
    return () => clearInterval(id);
    // Reads only refs and a stable render-body closure; provider-lifetime.
  }, []);

  const batcher = useRef<NostrBatcher | undefined>(undefined);
  if (!batcher.current && pool.current) {
    batcher.current = new NostrBatcher(pool.current, eventStore.current);
  }

  useEffect(() => {
    return () => {
      // Closing poisons every captured relay handle, so nothing outside may hold a pool reference.
      pool.current?.close();
    };
  }, []);

  // Authenticate newly registered stream keys on open sockets: ditto-relay's
  // challenge is valid for the socket's lifetime and its authed set only grows.
  useEffect(() => {
    return onStreamKeysAdded((added) => {
      for (const [url, entry] of openRelaysRef.current) {
        if (!entry.challenge) continue;
        const pks = claimStreamAuths(url, added);
        if (pks.length === 0) continue;
        logSync("auth", `authenticating ${pks.length} late stream key(s) on ${url}`);
        void sendStreamAuths(entry, url, pks);
      }
    });
    // Reads only refs; stable for the provider's lifetime.
  }, []);

  // Self-heal: streamAuthsSettled fires this when a stream key stays unacked
  // past the stale window. Re-send AUTHs on the live socket (half-open sockets never reopen).
  useEffect(() => {
    return onStreamAuthStale((url) => {
      const entry = openRelaysRef.current.get(url);
      if (!entry?.challenge) return;
      // Only unacked keys not already being sent; waves back off (streamAuthsSettled).
      const pks = claimStaleWave(url);
      if (pks.length === 0) return;
      logSync("auth", `stream auth went stale for ${url} — re-sending ${pks.length} AUTH frame(s)`);
      void sendStreamAuths(entry, url, pks);
    });
    // Reads only refs; stable for the provider's lifetime.
  }, []);

  // Memoized: `useNostr()` is the most-read context, so a fresh literal
  // re-renders nearly everything. Bound functions (see `detachableClient`)
  // so consumers can lift methods off `nostr` without losing `this`.
  const nostrValue = useMemo(
    () => {
      const client = (batcher.current ?? pool.current) as unknown as NPool;
      return { nostr: detachableClient(client) };
    },
    // Safe: both refs are lazily set in the render body above and never reassigned.
    [],
  );

  return (
    <NostrContext.Provider value={nostrValue}>
      <EventStoreContext.Provider value={eventStore.current}>
        {children}
      </EventStoreContext.Provider>
    </NostrContext.Provider>
  );
};

export default NostrProvider;
