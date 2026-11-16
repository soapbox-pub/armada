import { Capacitor } from "@capacitor/core";
import type { NostrEvent, NostrSigner } from "@nostrify/types";
import { createElement } from "react";

import { NudgeToastContent, type SignerAppLink } from "@/components/SignerToastContent";
import { toast } from "@/hooks/useToast";
import { defineMessages, t, type MessageDescriptor } from "@/i18n";
import { type BtcSigner, hasBtcSigning } from "@/lib/bitcoin-signers";

/** Show the nudge once the signer has answered nothing for this long with work pending. */
const NUDGE_DELAY_MS = 4_000;

/**
 * Reject the op after this long: the only fence for NIP-07 extensions. A
 * remote signer passes its own (`hardTimeoutMs`) above Nip46Signer's budget,
 * so a user still on their way to approve isn't cut off.
 */
const HARD_TIMEOUT_MS = 65_000;

/** Minimum gap between nudge toasts. */
const NUDGE_THROTTLE_MS = 8_000;

type OpType = "sign" | "encrypt" | "decrypt";

/** Context-specific nudge toast titles (Armada's kinds). */
const NUDGE_OVERRIDES: Record<number, MessageDescriptor> = defineMessages({
  0: { id: "signerWithNudge.approve.profile", defaultMessage: "Approve profile update" },
  1: { id: "signerWithNudge.approve.post", defaultMessage: "Approve post" },
  3: { id: "signerWithNudge.approve.contacts", defaultMessage: "Approve contact list update" },
  7: { id: "signerWithNudge.approve.reaction", defaultMessage: "Approve reaction" },
  9: { id: "signerWithNudge.approve.message", defaultMessage: "Approve message" },
  13: { id: "signerWithNudge.approve.directMessage", defaultMessage: "Approve direct message" },
  1059: { id: "signerWithNudge.approve.directMessage", defaultMessage: "Approve direct message" },
  9734: { id: "signerWithNudge.approve.zapRequest", defaultMessage: "Approve zap request" },
  9735: { id: "signerWithNudge.approve.zap", defaultMessage: "Approve zap" },
  10009: { id: "signerWithNudge.approve.serverList", defaultMessage: "Approve server list update" },
  // Concord: messages, reactions and Joins are all 20013 seals; the template
  // can't tell which (the rumor is encrypted), so name what they share.
  20013: { id: "signerWithNudge.approve.communityActivity", defaultMessage: "Approve community activity" },
  20014: { id: "signerWithNudge.approve.communityUpdate", defaultMessage: "Approve community update" },
  33302: { id: "signerWithNudge.approve.communityMembership", defaultMessage: "Approve community membership" },
  24242: { id: "signerWithNudge.approve.uploadAuth", defaultMessage: "Approve file upload auth" },
  30078: { id: "signerWithNudge.approve.appSettings", defaultMessage: "Approve app settings" },
});

function approveTitle(kind: number | undefined, opType: OpType): string {
  if (kind !== undefined && NUDGE_OVERRIDES[kind]) return t(NUDGE_OVERRIDES[kind]);
  if (opType === "encrypt") return t({ id: "signerWithNudge.approve.encryption", defaultMessage: "Approve encryption" });
  if (opType === "decrypt") return t({ id: "signerWithNudge.approve.decryption", defaultMessage: "Approve decryption" });
  return t({ id: "signerWithNudge.approve.signing", defaultMessage: "Approve signing" });
}

/** Sentinels for control flow inside Promise.race. */
const CANCEL = Symbol("cancel");
const TIMEOUT = Symbol("timeout");

type Signal = typeof CANCEL | typeof TIMEOUT;

function isIos(): boolean {
  if (Capacitor.getPlatform() === "ios") return true;
  if (typeof navigator === "undefined") return false;
  // iPadOS Safari reports itself as a Mac; only the touch points give it away.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function isAndroid(): boolean {
  if (Capacitor.getPlatform() === "android") return true;
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

const CLAVE: SignerAppLink = {
  href: "clave://",
  get label() {
    return t({ id: "signerWithNudge.openClave", defaultMessage: "Open Clave" });
  },
};
const AEGIS: SignerAppLink = {
  href: "aegis://",
  get label() {
    return t({ id: "signerWithNudge.openAegis", defaultMessage: "Open Aegis" });
  },
};

/** The iOS signer app, read off the session's relays: Aegis runs a local relay, Clave uses relay.powr.build. */
function iosSignerApp(relays: string[]): SignerAppLink | undefined {
  const hosts = relays.flatMap((url) => {
    try {
      return [new URL(url).hostname];
    } catch {
      return [];
    }
  });
  if (hosts.some((h) => h === "localrelay.link" || h === "127.0.0.1" || h === "localhost")) return AEGIS;
  if (hosts.includes("relay.powr.build")) return CLAVE;
  return undefined;
}

/**
 * Links that bring a NIP-46 signer app to the front. On iOS each app has its own
 * scheme, so both are offered when the relays don't say which. None on desktop.
 */
export function signerAppLinks(signerRelays: string[] = []): SignerAppLink[] {
  if (isAndroid()) return [{ href: "nostrsigner:", label: t({ id: "signerWithNudge.openSigner", defaultMessage: "Open signer" }) }];
  if (isIos()) {
    const app = iosSignerApp(signerRelays);
    return app ? [app] : [CLAVE, AEGIS];
  }
  return [];
}

function showNudgeToast(opts: {
  kind: number | undefined;
  opType: OpType;
  isBunkerConnected: (() => boolean) | undefined;
  remote: boolean;
  signerRelays: string[] | undefined;
  durationMs: number;
  onCancel: () => void;
}): ShownNudge {
  const { kind, opType, isBunkerConnected, remote, signerRelays, durationMs, onCancel } = opts;
  const relayOk = isBunkerConnected ? isBunkerConnected() : true;

  let title: string;
  let descriptionText: string;

  if (!relayOk) {
    title = t({ id: "signerWithNudge.relayUnreachable", defaultMessage: "Signer relay unreachable" });
    descriptionText = t({ id: "signerWithNudge.checkConnection", defaultMessage: "Check your connection and try again." });
  } else if (remote) {
    title = approveTitle(kind, opType);
    // An auto-approving push signer (Clave) still needs waking when it falls behind.
    descriptionText = t({ id: "signerWithNudge.remoteWaiting", defaultMessage: "Your signer hasn't answered yet. Open it to approve the request, or to wake it if it signs automatically." });
  } else {
    title = approveTitle(kind, opType);
    descriptionText = t({ id: "signerWithNudge.approveInSigner", defaultMessage: "Approve the request in your signer." });
  }

  // Mutable ref so the component's onCancel can dismiss its own toast.
  const dismissRef: { fn: (() => void) | undefined } = { fn: undefined };

  const description = createElement(NudgeToastContent, {
    description: descriptionText,
    openSigner: remote && relayOk ? signerAppLinks(signerRelays) : [],
    onCancel: () => { dismissRef.fn?.(); onCancel(); },
  });

  // Finite so Radix swipe-to-dismiss works on mobile; as long as the op may wait.
  const { id, dismiss, update } = toast({ title, description, duration: durationMs });
  dismissRef.fn = dismiss;

  return {
    dismiss,
    // The same toast turns into the confirmation, so it never stacks a second one.
    confirm: (opType) => {
      update({ id, title: approvedTitle(opType), description: undefined, variant: "success", duration: CONFIRM_MS });
      setTimeout(dismiss, CONFIRM_MS);
    },
  };
}

interface ShownNudge {
  dismiss: () => void;
  confirm: (opType: OpType) => void;
}

/** How long a nudge shows its confirmation before it goes. */
const CONFIRM_MS = 1_500;

function approvedTitle(opType: OpType): string {
  return opType === "encrypt"
    ? t({ id: "signerWithNudge.approved.encryption", defaultMessage: "Encryption approved" })
    : opType === "decrypt"
      ? t({ id: "signerWithNudge.approved.decryption", defaultMessage: "Decryption approved" })
      : t({ id: "signerWithNudge.approved.signing", defaultMessage: "Signing approved" });
}

interface PendingOp {
  kind: number | undefined;
  opType: OpType;
  cancel: () => void;
}

/**
 * One nudge per STALL of a signer, shared by all its ops. Remote signers serve
 * requests one at a time, so a per-op timer fires on queue wait alone; this
 * clock restarts whenever any op settles, and only a signer that has stopped
 * answering is nudged.
 */
class Nudger {
  readonly #isBunkerConnected: (() => boolean) | undefined;
  readonly #remote: boolean;
  readonly #signerRelays: string[] | undefined;
  readonly hardTimeoutMs: number;
  readonly #pending = new Set<PendingOp>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #shown: ShownNudge | undefined;
  #lastShownAt = -Infinity;

  constructor(
    isBunkerConnected: (() => boolean) | undefined,
    remote: boolean,
    signerRelays: string[] | undefined,
    hardTimeoutMs: number,
  ) {
    this.#isBunkerConnected = isBunkerConnected;
    this.#remote = remote;
    this.#signerRelays = signerRelays;
    this.hardTimeoutMs = hardTimeoutMs;
  }

  begin(op: PendingOp): void {
    this.#pending.add(op);
    if (this.#timer === undefined && !this.#shown) this.#arm(NUDGE_DELAY_MS);
  }

  /** `approved`: it resolved with a value, which confirms a nudge actually shown. */
  end(op: PendingOp, approved: boolean): void {
    this.#pending.delete(op);
    this.#disarm();
    if (this.#shown) {
      if (approved) this.#shown.confirm(op.opType);
      else this.#shown.dismiss();
      this.#shown = undefined;
    }
    if (this.#pending.size > 0) this.#arm(NUDGE_DELAY_MS);
  }

  #arm(ms: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#show();
    }, ms);
  }

  #disarm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #show(): void {
    // The oldest pending op is the one the signer is stuck on.
    const head = this.#pending.values().next().value;
    if (!head) return;
    // Throttled, not dropped: a stall inside the window is nudged when it ends.
    const wait = this.#lastShownAt + NUDGE_THROTTLE_MS - Date.now();
    if (wait > 0) return this.#arm(wait);
    this.#lastShownAt = Date.now();
    this.#shown = showNudgeToast({
      kind: head.kind,
      opType: head.opType,
      isBunkerConnected: this.#isBunkerConnected,
      remote: this.#remote,
      signerRelays: this.#signerRelays,
      durationMs: this.hardTimeoutMs,
      // The rest are queued behind the stalled one, so skip them all.
      onCancel: () => {
        for (const op of [...this.#pending]) op.cancel();
      },
    });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Run `op` under `nudger`, with a cancel button and a hard timeout. */
async function runWithNudge<T>(
  op: () => Promise<T>,
  nudger: Nudger,
  kind: number | undefined,
  opType: OpType,
): Promise<T> {
  type Outcome =
    | { tag: "value"; value: T }
    | { tag: "error"; error: unknown }
    | { tag: "signal"; signal: Signal };

  const cancelSignal = deferred<typeof CANCEL>();
  const timeoutSignal = deferred<typeof TIMEOUT>();
  const pending: PendingOp = { kind, opType, cancel: () => cancelSignal.resolve(CANCEL) };
  const hardTimer = setTimeout(() => timeoutSignal.resolve(TIMEOUT), nudger.hardTimeoutMs);
  nudger.begin(pending);

  const opOutcome: Promise<Outcome> = op().then(
    (value): Outcome => ({ tag: "value", value }),
    (error): Outcome => ({ tag: "error", error }),
  );

  const signalOutcome: Promise<Outcome> = Promise.race([
    cancelSignal.promise,
    timeoutSignal.promise,
  ]).then((signal): Outcome => ({ tag: "signal", signal }));

  const outcome = await Promise.race([opOutcome, signalOutcome]);
  clearTimeout(hardTimer);
  nudger.end(pending, outcome.tag === "value");

  if (outcome.tag === "value") return outcome.value;

  if (outcome.tag === "error") {
    throw outcome.error;
  }

  switch (outcome.signal) {
    case CANCEL:
      throw new Error("Signing cancelled by user");
    case TIMEOUT:
      throw new Error("Signer timed out");
  }
}

/** The AppSigner decrypt-cache peek, forwarded so bulkDecryptGate keeps working. */
interface DecryptCachePeek {
  isDecryptCached(method: "nip04" | "nip44", counterparty: string, ciphertext: string): Promise<boolean>;
}

/**
 * Wrap a signer with slow-remote-signer UX (ported from ditto): a nudge toast
 * once it has answered nothing for 4s, a hard timeout, and one confirmation
 * when a shown nudge's stall ends in a signature. nip04/nip44 pass through
 * un-nudged (bulk decrypts are consent-gated by bulkDecryptGate). `signPsbt`
 * and AppSigner's `isDecryptCached` are forwarded.
 *
 * @param isBunkerConnected - Checked at nudge time; false shows a relay-unreachable warning.
 * @param opts.remote - A NIP-46 signer: the nudge explains where to approve.
 * @param opts.signerRelays - The bunker session's relays, which name its iOS signer app.
 * @param opts.hardTimeoutMs - Overrides the 65s fence (a NIP-46 signer waits longer).
 */
export function signerWithNudge(
  signer: NostrSigner,
  isBunkerConnected?: () => boolean,
  opts?: { remote?: boolean; signerRelays?: string[]; hardTimeoutMs?: number },
): NostrSigner {
  const nudger = new Nudger(
    isBunkerConnected,
    opts?.remote ?? false,
    opts?.signerRelays,
    opts?.hardTimeoutMs ?? HARD_TIMEOUT_MS,
  );
  function run<T>(op: () => Promise<T>, kind: number | undefined, opType: OpType): Promise<T> {
    return runWithNudge(op, nudger, kind, opType);
  }

  const wrapped: NostrSigner = {
    getPublicKey: () => run(() => signer.getPublicKey(), undefined, "sign"),
    signEvent: (event: NostrEvent) => run(() => signer.signEvent(event), event.kind, "sign"),
  };

  if (signer.getRelays) {
    const getRelays = signer.getRelays.bind(signer);
    wrapped.getRelays = () => run(() => getRelays(), undefined, "sign");
  }

  // Crypto passes through: per-ciphertext nudges would spam during inbox sweeps. Read
  // through, not copied: a NIP-07 signer only learns what it lacks once the extension injects.
  Object.defineProperties(wrapped, {
    nip04: { get: () => signer.nip04, enumerable: true },
    nip44: { get: () => signer.nip44, enumerable: true },
  });

  if (hasBtcSigning(signer)) {
    const btcSigner = signer;
    (wrapped as BtcSigner).signPsbt = (psbtHex: string) =>
      run(() => btcSigner.signPsbt(psbtHex), undefined, "sign");
  }

  // bulkDecryptGate needs the cache peek to tell cache hits from signer calls.
  const peekable = signer as Partial<DecryptCachePeek>;
  if (typeof peekable.isDecryptCached === "function") {
    (wrapped as NostrSigner & DecryptCachePeek).isDecryptCached =
      peekable.isDecryptCached.bind(signer);
  }

  unwrapped.set(wrapped, signer);
  return wrapped;
}

const unwrapped = new WeakMap<NostrSigner, NostrSigner>();

/**
 * The signer under a {@link signerWithNudge} wrapper, for signs the user didn't
 * start (a background NIP-42 AUTH): those must not ask them to approve anything.
 */
export function withoutNudge(signer: NostrSigner): NostrSigner {
  return unwrapped.get(signer) ?? signer;
}
