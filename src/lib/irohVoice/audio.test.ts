import { describe, expect, it } from "vitest";

import { MAX_DELAY_S, Playhead, TARGET_DELAY_S } from "@/lib/irohVoice/audio";

describe("a peer's playhead", () => {
  it("takes sequences forward only, across the 16-bit wrap", () => {
    const p = new Playhead();
    expect(p.accept(65534)).toBe(true);
    expect(p.accept(65535)).toBe(true);
    expect(p.accept(0)).toBe(true);
    expect(p.accept(65535), "overtaken in flight").toBe(false);
    expect(p.accept(0), "a duplicate").toBe(false);
    expect(p.accept(3), "a gap is fine").toBe(true);
  });

  it("plays frames back to back, restarting at the target delay after a gap or a backlog", () => {
    const p = new Playhead();
    expect(p.place(10, 0.02)).toBeCloseTo(10 + TARGET_DELAY_S);
    expect(p.place(10.005, 0.02)).toBeCloseTo(10 + TARGET_DELAY_S + 0.02);
    expect(p.place(20, 0.02), "after silence").toBeCloseTo(20 + TARGET_DELAY_S);
    let at = 0;
    for (let i = 0; i < 40; i++) at = p.place(20, 0.02);
    expect(at - 20).toBeLessThanOrEqual(MAX_DELAY_S + 0.02);
  });
});
