/**
 * The escaped bundle must mean exactly what it meant, hold nothing above
 * U+00FF (so V8 stores it one byte per character), and keep its sourcemap
 * pointing at the same tokens.
 */
import { describe, expect, it } from "vitest";

import { escapeWide, rawTemplateAtRisk, shiftMappings } from "./oneByteScripts";

const evaluate = (code: string): unknown => new Function(`return (${code});`)();

describe("oneByteScripts", () => {
  it("escapes strings, templates and regexes to the same values, Latin-1 untouched", () => {
    const src = '["… — ’", `tag ${"✓"} 😀`, /[…—]/u.test("—"), /\\…/.test("…"), "café"]';
    const { code } = escapeWide(src);
    expect(/[\u0100-\uffff]/.test(code)).toBe(false);
    expect(code).toContain("café");
    expect(evaluate(code)).toEqual(evaluate(src));
  });

  it("leaves code with nothing to escape as it is", () => {
    const src = 'const a = "plain";';
    expect(escapeWide(src)).toEqual({ code: src, escapedAt: new Map() });
  });

  it("flags a String.raw template that escaping would change", () => {
    expect(rawTemplateAtRisk("String.raw`a…b`")).toBe(true);
    expect(rawTemplateAtRisk("String.raw`ab`; const x = '…'")).toBe(false);
    // Asked twice: no state carried between calls.
    expect(rawTemplateAtRisk("String.raw`a…b`")).toBe(true);
  });

  it("shifts generated columns past each escaped unit, on that line only", () => {
    // Line 0: tokens at columns 0, 4 and 8, with an escaped unit at column 2.
    // Line 1: nothing escaped. VLQ: A=0, I=4, C=1 (source fields 0,0,0 → "AAAA").
    const mappings = "AAAA,IAAA,IAAA;AAAA";
    const shifted = shiftMappings(mappings, new Map([[0, [2]]]));
    // Columns 0, 9, 13: the first token sits before the escape, the others move by 5.
    expect(shifted).toBe("AAAA,SAAA,IAAA;AAAA");
  });
});
