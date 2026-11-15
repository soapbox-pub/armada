import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { Capacitor } from "@capacitor/core";
import type { NostrSigner } from "@nostrify/types";

import { toast } from "@/hooks/useToast";
import { signerWithNudge } from "@/lib/signerWithNudge";

const h = vi.hoisted(() => ({ update: vi.fn(), dismiss: vi.fn() }));

vi.mock("@/hooks/useToast", () => ({
  toast: vi.fn(() => ({ id: "t", dismiss: h.dismiss, update: h.update })),
}));

const toastMock = vi.mocked(toast);

/** A controllable latch standing in for a pending upstream signer op. */
function gate(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A minimal upstream signer whose signEvent is externally controlled. */
function makeUpstream() {
  const g = gate();
  const upstream: NostrSigner = {
    getPublicKey: vi.fn(async () => {
      await g.promise;
      return "ab".repeat(32);
    }),
    signEvent: vi.fn(async (t) => {
      await g.promise;
      return { ...(t as object), id: "x", pubkey: "ab".repeat(32), sig: "s" } as never;
    }),
    nip44: {
      encrypt: vi.fn(async (_p: string, pt: string) => `ct:${pt}`),
      decrypt: vi.fn(async (_p: string, ct: string) => `pt:${ct}`),
    },
  };
  return { upstream, gate: g };
}

const TEMPLATE = { kind: 9, content: "hi", tags: [], created_at: 1_700_000_000 };

beforeEach(() => {
  vi.useFakeTimers();
  toastMock.mockClear();
  h.update.mockClear();
  h.dismiss.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("signerWithNudge", () => {
  it("passes fast ops straight through without nudging", async () => {
    const { upstream, gate } = makeUpstream();
    gate.resolve();
    const wrapped = signerWithNudge(upstream);

    await expect(wrapped.getPublicKey()).resolves.toBe("ab".repeat(32));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("nudges after 4s on a slow op, then turns the same toast into a brief confirmation", async () => {
    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream, () => true);

    const p = wrapped.signEvent(TEMPLATE);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Approve message" }),
    );

    gate.resolve();
    await expect(p).resolves.toMatchObject({ id: "x" });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t", title: "Signing approved", variant: "success", description: undefined }),
    );
    expect(h.dismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses without a confirmation when the op fails", async () => {
    await vi.advanceTimersByTimeAsync(9_000);
    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream, () => true);

    const p = wrapped.signEvent(TEMPLATE);
    await vi.advanceTimersByTimeAsync(4_000);
    gate.reject(new Error("rejected"));
    await expect(p).rejects.toThrow("rejected");
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("warns about relay connectivity instead when no bunker socket is open", async () => {
    // Clear the throttle window left by the previous test's nudge.
    await vi.advanceTimersByTimeAsync(9_000);

    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream, () => false);

    const p = wrapped.signEvent(TEMPLATE);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Signer relay unreachable" }),
    );

    gate.resolve();
    await expect(p).resolves.toBeTruthy();
  });

  it("hard-times-out an op that never settles", async () => {
    await vi.advanceTimersByTimeAsync(9_000);

    const { upstream } = makeUpstream(); // gate never resolved
    const wrapped = signerWithNudge(upstream, () => true);

    const p = wrapped.getPublicKey();
    const assertion = expect(p).rejects.toThrow("Signer timed out");
    await vi.advanceTimersByTimeAsync(65_000);
    await assertion;
  });

  type NudgeCall = {
    title: string;
    duration: number;
    description: { props: { description: string; openSigner: { href: string; label: string }[] } };
  };

  async function remoteNudge(platform: string, relayOk = true, remote = true, signerRelays?: string[]): Promise<NudgeCall> {
    const platformSpy = vi.spyOn(Capacitor, "getPlatform").mockReturnValue(platform);
    onTestFinished(() => platformSpy.mockRestore());
    await vi.advanceTimersByTimeAsync(9_000);
    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream, () => relayOk, { remote, signerRelays, hardTimeoutMs: 300_000 });
    const p = wrapped.signEvent({ ...TEMPLATE, kind: 20013 });
    await vi.advanceTimersByTimeAsync(4_000);
    const call = toastMock.mock.calls.at(-1)![0] as unknown as NudgeCall;
    gate.resolve();
    await p;
    return call;
  }

  it("tells a NIP-46 user to open their signer, naming no particular app", async () => {
    const call = await remoteNudge("web");
    expect(call.title).toBe("Approve community activity");
    expect(call.description.props.description).toMatch(/Open it/);
    expect(call.description.props.description).not.toMatch(/Amber|Always/);
    // The toast lasts as long as the request may.
    expect(call.duration).toBe(300_000);
    // A desktop browser has no signer app to open.
    expect(call.description.props.openSigner).toEqual([]);
  });

  it("offers to open Amber's bunker queue on Android", async () => {
    const call = await remoteNudge("android");
    expect(call.description.props.openSigner).toEqual([{ href: "nostrsigner:", label: "Open signer" }]);
  });

  it("on iOS, opens the signer app the bunker's relays name", async () => {
    const clave = await remoteNudge("ios", true, true, ["wss://relay.powr.build/"]);
    expect(clave.description.props.openSigner).toEqual([{ href: "clave://", label: "Open Clave" }]);
    const aegis = await remoteNudge("ios", true, true, ["wss://localrelay.link:28443"]);
    expect(aegis.description.props.openSigner).toEqual([{ href: "aegis://", label: "Open Aegis" }]);
    const aegisLoopback = await remoteNudge("ios", true, true, ["ws://127.0.0.1:8081"]);
    expect(aegisLoopback.description.props.openSigner).toEqual([{ href: "aegis://", label: "Open Aegis" }]);
  });

  it("on iOS, offers both signer apps when the relays don't say which", async () => {
    const call = await remoteNudge("ios", true, true, ["wss://relay.damus.io/"]);
    expect(call.description.props.openSigner.map((l) => l.href)).toEqual(["clave://", "aegis://"]);
  });

  it("offers no signer link when the signer relay is down, or for a non-NIP-46 signer", async () => {
    expect((await remoteNudge("android", false)).description.props.openSigner).toEqual([]);
    expect((await remoteNudge("android", true, false)).description.props.openSigner).toEqual([]);
  });

  it("lets a NIP-46 signature wait past the 65s fence, up to its own", async () => {
    await vi.advanceTimersByTimeAsync(9_000);
    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream, () => true, { remote: true, hardTimeoutMs: 300_000 });

    const p = wrapped.signEvent(TEMPLATE);
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);

    gate.resolve(); // approved two minutes in
    await expect(p).resolves.toMatchObject({ id: "x" });
  });

  it("propagates underlying signer errors", async () => {
    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream);

    const p = wrapped.getPublicKey();
    const assertion = expect(p).rejects.toThrow("user rejected");
    gate.reject(new Error("user rejected"));
    await assertion;
  });

  it("passes crypto through unwrapped (no per-ciphertext nudges)", () => {
    const { upstream } = makeUpstream();
    const wrapped = signerWithNudge(upstream);
    expect(wrapped.nip44).toBe(upstream.nip44);
  });

  it("forwards isDecryptCached and signPsbt from the underlying signer", async () => {
    const { upstream, gate } = makeUpstream();
    gate.resolve();
    const peek = vi.fn(async (_m: string, _cp: string, _ct: string) => true);
    const signPsbt = vi.fn(async (hex: string) => `signed:${hex}`);
    const rich = Object.assign(upstream, { isDecryptCached: peek, signPsbt });

    const wrapped = signerWithNudge(rich) as NostrSigner & {
      isDecryptCached: typeof peek;
      signPsbt: typeof signPsbt;
    };

    await expect(wrapped.isDecryptCached("nip44", "cp", "ct")).resolves.toBe(true);
    expect(peek).toHaveBeenCalledWith("nip44", "cp", "ct");
    await expect(wrapped.signPsbt("deadbeef")).resolves.toBe("signed:deadbeef");
    expect(signPsbt).toHaveBeenCalledWith("deadbeef");
  });
});
