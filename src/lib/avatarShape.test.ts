import { describe, expect, it } from "vitest";

import { drawEmojiMask } from "@/lib/avatarShape";

/**
 * A canvas whose fonts draw every emoji 100px wide, joining ZWJ sequences only
 * when `joins`; records what was drawn.
 */
function fakeCanvas(joins: boolean) {
  const drawn: string[] = [];
  const width = (text: string) => {
    const parts = text.split("\u200d").length;
    return 100 * (joins ? 1 : parts);
  };
  const ctx = {
    font: "",
    textAlign: "",
    textBaseline: "",
    measureText: (text: string) => ({ width: width(text) }),
    fillText: (text: string) => drawn.push(text),
    // One opaque pixel, so the mask isn't empty.
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      data[(Math.floor(h / 2) * w + Math.floor(w / 2)) * 4 + 3] = 255;
      return { data, width: w, height: h };
    },
    drawImage: () => {},
    putImageData: () => {},
  };
  const create = () => ({ getContext: () => ctx }) as unknown as OffscreenCanvas;
  return { drawn, create };
}

describe("drawEmojiMask", () => {
  it("draws a ZWJ sequence the fonts can join whole", () => {
    const { drawn, create } = fakeCanvas(true);
    drawEmojiMask("❤️‍🔥", create);
    expect(drawn).toEqual(["❤️‍🔥"]);
  });

  it("draws only the first part of a sequence the fonts would split", () => {
    const { drawn, create } = fakeCanvas(false);
    drawEmojiMask("❤️‍🔥", create);
    expect(drawn).toEqual(["❤️"]);
  });

  it("names the system emoji fonts and the bundled Twemoji ahead of the generic family", () => {
    const fonts: string[] = [];
    const { create } = fakeCanvas(true);
    const canvas = create();
    const ctx = canvas.getContext("2d") as unknown as { font: string };
    const recording = () => ({ getContext: () => new Proxy(ctx, { set: (t, k, v) => { if (k === "font") fonts.push(v); return Reflect.set(t, k, v); } }) }) as unknown as OffscreenCanvas;
    drawEmojiMask("🛡️", recording);
    expect(fonts[0]).toMatch(/"Noto Color Emoji".*"Armada Twemoji", serif$/);
  });
});
