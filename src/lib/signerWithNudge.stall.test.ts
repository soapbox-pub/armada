/**
 * The signer nudge toast as a slow remote signer serving a queue sees it: one
 * clock per signer that restarts whenever the signer answers, so queue wait
 * alone never nudges.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrSigner } from "@nostrify/types";

const h = vi.hoisted(() => ({
  /** Each toast's titles in order: an in-place update appends rather than adding a toast. */
  shown: [] as Array<{ titles: string[]; dismissed: boolean }>,
  skip: undefined as (() => void) | undefined,
}));

vi.mock("@/hooks/useToast", () => ({
  toast: vi.fn(({ title, description }: { title: string; description?: { props?: { onCancel?: () => void } } }) => {
    const entry = { titles: [title], dismissed: false };
    if (description?.props?.onCancel) h.skip = description.props.onCancel;
    h.shown.push(entry);
    return {
      id: String(h.shown.length),
      dismiss: () => { entry.dismissed = true; },
      update: ({ title: next }: { title: string }) => { entry.titles.push(next); },
    };
  }),
}));

/**
 * A remote signer that AUTO-APPROVES but is slow: the nth sign takes
 * `durations[n]` (the last repeats), served one at a time as a NIP-46 bunker
 * or a NIP-55 intent round-trip does. Nothing is waiting on the user.
 */
function slowSigner(...durations: number[]): NostrSigner {
  let queue: Promise<unknown> = Promise.resolve();
  let served = 0;
  const serve = <T>(make: () => T): Promise<T> => {
    const ms = durations[Math.min(served++, durations.length - 1)]!;
    const next = queue.then(() => new Promise<T>((r) => setTimeout(() => r(make()), ms)));
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    getPublicKey: () => serve(() => "ab".repeat(32)),
    signEvent: (t) => serve(() => ({ ...(t as object), id: "x", pubkey: "ab".repeat(32), sig: "s" }) as never),
  };
}

const message = (n = 0) => ({ kind: 9, content: `hi ${n}`, tags: [], created_at: 1_700_000_000 + n });

const titles = () => h.shown.flatMap((t) => t.titles);
/** A prompt still on screen. */
const prompting = () => h.shown.some((t) => t.titles.at(-1)!.startsWith("Approve") && !t.dismissed);
const toastCount = () => h.shown.length;

async function wrap(...durations: number[]) {
  const { signerWithNudge } = await import("@/lib/signerWithNudge");
  return signerWithNudge(slowSigner(...durations), () => true);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.shown.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the signer nudge with a slow, auto-approving signer", () => {
  it("a signer under the 4s delay shows nothing", async () => {
    const signer = await wrap(3_000);
    const sent = signer.signEvent(message());
    await vi.advanceTimersByTimeAsync(3_000);
    await sent;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(titles()).toEqual([]);
  });

  it("a burst queued behind a slow signer shows nothing while the signer keeps answering", async () => {
    const signer = await wrap(3_000);
    // Six messages in quick succession, each waiting for the one before: later
    // ones wait well past 4s, but the signer answers every 3s.
    const sends = Array.from({ length: 6 }, (_, n) => signer.signEvent(message(n)));
    await vi.advanceTimersByTimeAsync(6 * 3_000);
    await Promise.all(sends);
    expect(titles()).toEqual([]);
  });

  it("a stalled burst prompts once and confirms once", async () => {
    // The first sign stalls (an approval prompt in the signer); the rest flow.
    const signer = await wrap(10_000, 1_000);
    const sends = Array.from({ length: 4 }, (_, n) => signer.signEvent(message(n)));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(titles()).toEqual(["Approve message"]);
    await vi.advanceTimersByTimeAsync(6_000 + 3 * 1_000);
    await Promise.all(sends);
    expect(titles()).toEqual(["Approve message", "Signing approved"]);
    // One toast that changed in place, never a second one stacked on it.
    expect(toastCount()).toBe(1);
  });

  it("a stall inside the throttle window is prompted when the window ends, not dropped", async () => {
    // A 5s sign (prompted at 4s), then one that never answers.
    const signer = await wrap(5_000, 60_000);
    const first = signer.signEvent(message(1));
    void signer.signEvent(message(2)).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(titles()).toEqual(["Approve message", "Signing approved"]);
    expect(prompting()).toBe(false);
    // Stalled again from 5s; 9s is inside the 8s window from 4s, so it waits until 12s.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(prompting()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prompting()).toBe(true);
  });

  it("a sign whose prompt never showed lands without a confirmation", async () => {
    const signer = await wrap(5_000);
    const first = signer.signEvent(message(1));
    const second = signer.signEvent(message(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, second]);
    // One prompt (the first stall), one confirmation; the second answered 5s
    // after the first, before its own stall reached a shown prompt.
    expect(titles()).toEqual(["Approve message", "Signing approved"]);
  });

  it("an answer that is merely slow still prompts: the timer can't tell it from an approval", async () => {
    const signer = await wrap(5_000);
    const sent = signer.signEvent(message());
    await vi.advanceTimersByTimeAsync(5_000);
    await sent;
    expect(titles()).toEqual(["Approve message", "Signing approved"]);
  });

  it("a background sign through withoutNudge never prompts", async () => {
    // useNativeNotifications signs the Android service's NIP-42 AUTH this way.
    const { withoutNudge } = await import("@/lib/signerWithNudge");
    const signer = withoutNudge(await wrap(5_000));
    const auth = signer.signEvent({
      kind: 22242,
      content: "",
      tags: [["relay", "wss://relay.example"], ["challenge", "c"]],
      created_at: 1_700_000_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await auth;
    expect(titles()).toEqual([]);
  });

  it("Skip cancels the stalled sign and everything queued behind it", async () => {
    const signer = await wrap(60_000);
    const sends = [1, 2, 3].map((n) => signer.signEvent(message(n)));
    const settled = Promise.allSettled(sends);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(prompting()).toBe(true);
    h.skip!();
    const results = await settled;
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(prompting()).toBe(false);
    expect(titles()).toEqual(["Approve message"]);
  });

  it("withoutNudge leaves a plain signer as it is", async () => {
    const { withoutNudge } = await import("@/lib/signerWithNudge");
    const plain = slowSigner(1);
    expect(withoutNudge(plain)).toBe(plain);
  });
});
