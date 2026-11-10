import { NSecSigner } from "@nostrify/nostrify";
import { getPow } from "nostr-tools/nip13";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppSigner } from "@/lib/AppSigner";
import {
  DEFAULT_POW_DIFFICULTY,
  defaultPowDifficulty,
  finalizePowEvent,
  minePow,
  parsePowDifficulty,
  powDifficulty,
  PowNSecSigner,
  setPowDifficulty,
} from "@/lib/pow";

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const template = (kind = 1, tags: string[][] = [["p", "ab".repeat(32)]]) => ({
  kind,
  content: "hello \"world\" ✓",
  tags,
  created_at: 1_700_000_000,
});

afterEach(() => {
  setPowDifficulty(undefined);
  vi.unstubAllGlobals();
});

describe("minePow", () => {
  it("adds a nonce tag that gives the signed id the target difficulty", async () => {
    const mined = await minePow(template(), pubkey, 10);
    const event = finalizeEvent(mined, sk);
    expect(verifyEvent(event)).toBe(true);
    expect(getPow(event.id)).toBeGreaterThanOrEqual(10);
    expect(event.tags.at(-1)).toEqual(["nonce", expect.stringMatching(/^\d+$/), "10"]);
    expect(event.tags.slice(0, -1)).toEqual(template().tags);
    expect(event.created_at).toBe(template().created_at);
  });

  it("replaces a nonce tag the template already carries", async () => {
    const mined = await minePow(template(1, [["nonce", "x", "30"], ["t", "a"]]), pubkey, 4);
    expect(mined.tags.filter(([name]) => name === "nonce")).toHaveLength(1);
    expect(mined.tags[0]).toEqual(["t", "a"]);
  });

  it("mines an event with no other tags", async () => {
    const event = finalizeEvent(await minePow(template(1, []), pubkey, 8), sk);
    expect(getPow(event.id)).toBeGreaterThanOrEqual(8);
  });

  it("leaves the template alone at difficulty 0", async () => {
    const t = template();
    expect(await minePow(t, pubkey, 0)).toBe(t);
  });

  it("uses the current difficulty by default", async () => {
    setPowDifficulty(6);
    const event = await finalizePowEvent(template(), sk);
    expect(event.tags.at(-1)?.[2]).toBe("6");
    expect(getPow(event.id)).toBeGreaterThanOrEqual(6);
  });
});

describe("difficulty", () => {
  it("parses whole, non-negative bit counts and clamps the top", () => {
    expect(parsePowDifficulty("12")).toBe(12);
    expect(parsePowDifficulty(0)).toBe(0);
    expect(parsePowDifficulty("99")).toBe(32);
    for (const bad of ["", " ", "abc", "-1", "2.5", 2.5, null, undefined]) {
      expect(parsePowDifficulty(bad)).toBeUndefined();
    }
  });

  it("follows window.ENV until the user picks a value", () => {
    vi.stubGlobal("window", { ENV: { POW_DIFFICULTY: "3" } });
    expect(defaultPowDifficulty()).toBe(3);
    expect(powDifficulty()).toBe(3);
    setPowDifficulty(0);
    expect(powDifficulty()).toBe(0);
  });

  it("falls back to the built-in default for an unusable value", () => {
    vi.stubGlobal("window", { ENV: { POW_DIFFICULTY: "lots" } });
    expect(defaultPowDifficulty()).toBe(DEFAULT_POW_DIFFICULTY);
  });
});

describe("signers", () => {
  it("AppSigner mines published kinds and leaves seals and credentials alone", async () => {
    setPowDifficulty(6);
    const signer = new AppSigner(new NSecSigner(sk), pubkey);
    const note = await signer.signEvent(template(1));
    expect(getPow(note.id)).toBeGreaterThanOrEqual(6);
    for (const kind of [13, 20013, 20014, 22242, 24242, 27235, 9734]) {
      const event = await signer.signEvent(template(kind));
      expect(event.tags.some(([name]) => name === "nonce"), `kind ${kind}`).toBe(false);
    }
  });

  it("mines to a difficulty the event asks for, above the user's", async () => {
    setPowDifficulty(0);
    const signer = new AppSigner(new NSecSigner(sk), pubkey);
    const boost = await signer.signEvent(template(1985, [["nonce", "", "8"]]));
    expect(getPow(boost.id)).toBeGreaterThanOrEqual(8);
    expect(boost.tags.filter(([name]) => name === "nonce")).toHaveLength(1);

    setPowDifficulty(10);
    expect(getPow((await signer.signEvent(template(1985, [["nonce", "", "4"]]))).id)).toBeGreaterThanOrEqual(10);
  });

  it("PowNSecSigner mines", async () => {
    setPowDifficulty(6);
    const event = await new PowNSecSigner(sk).signEvent(template(30078, [["d", "x"]]));
    expect(verifyEvent(event)).toBe(true);
    expect(getPow(event.id)).toBeGreaterThanOrEqual(6);
  });
});
