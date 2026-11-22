import { describe, expect, it } from "vitest";

import { frameCss, nameStyleCss, readUltra, ULTRA_FIELD, withUltra } from "@/lib/ultra";

describe("readUltra", () => {
  it("reads a membership and its presets", () => {
    expect(readUltra({ [ULTRA_FIELD]: { since: 5, name: "gold", frame: "ice", effect: "hearts" } }))
      .toEqual({ since: 5, name: "gold", frame: "ice", effect: "hearts" });
  });

  it("drops presets this build doesn't know rather than guessing", () => {
    expect(readUltra({ [ULTRA_FIELD]: { since: 5, name: "<script>", frame: "constructor", effect: 3 } }))
      .toEqual({ since: 5, name: undefined, frame: undefined, effect: undefined });
  });

  it("is absent for profiles without it or with junk", () => {
    expect(readUltra(undefined)).toBeUndefined();
    expect(readUltra({ name: "ana" })).toBeUndefined();
    expect(readUltra({ [ULTRA_FIELD]: true })).toBeUndefined();
    expect(readUltra({ [ULTRA_FIELD]: ["x"] })).toBeUndefined();
  });
});

describe("withUltra", () => {
  it("sets and removes only its own field", () => {
    const profile = { name: "ana", picture: "https://x/a.png", shape: "🐙", custom: 1 };
    const on = withUltra(profile, { since: 9, name: "aurora" });
    expect(on).toEqual({ ...profile, [ULTRA_FIELD]: { since: 9, name: "aurora" } });
    expect(withUltra(on, undefined)).toEqual(profile);
    expect(profile).not.toHaveProperty(ULTRA_FIELD);
  });
});

describe("styles", () => {
  it("hands rows the same object every time", () => {
    expect(nameStyleCss("aurora")).toBe(nameStyleCss("aurora"));
    expect(frameCss("gold")).toBe(frameCss("gold"));
    expect(frameCss("gold", true)).toBe(frameCss("gold", true));
    expect(frameCss("gold", true)).not.toBe(frameCss("gold"));
    expect(nameStyleCss(undefined)).toBeUndefined();
  });
});
