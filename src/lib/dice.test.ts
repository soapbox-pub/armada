import { describe, expect, it } from "vitest";

import {
  DICE_PREFIX,
  formatRollMessage,
  parseDiceExpression,
  parseRollMessage,
  rollDice,
  rollDie,
  splitRollArgument,
} from "@/lib/dice";
import { POLYHEDRAL_SIDES, getPolyhedron } from "@/lib/diceGeometry";
import { findSlashCommand } from "@/lib/slashCommands";

const ctx = { canModerate: false, resolvePubkey: () => undefined };

function terms(src: string) {
  const parsed = parseDiceExpression(src);
  if (!parsed.ok) throw new Error(`unparsed: ${src}`);
  return parsed.terms;
}

describe("parseDiceExpression", () => {
  it("reads dice, constants and signs", () => {
    expect(terms("2d6 + 1d4 - 2")).toEqual([
      { sign: 1, count: 2, sides: 6 },
      { sign: 1, count: 1, sides: 4 },
      { sign: -1, constant: 2 },
    ]);
    expect(terms("d20")).toEqual([{ sign: 1, count: 1, sides: 20 }]);
  });

  it("treats a lone number as a die of that many sides", () => {
    expect(terms("100")).toEqual([{ sign: 1, count: 1, sides: 100 }]);
  });

  it("refuses nonsense and over-large rolls", () => {
    for (const bad of ["", "d", "2d", "2x6", "d6d6", "+", "0d6", "1d1", "-5", "1+2"]) {
      expect(parseDiceExpression(bad), bad).toEqual({ ok: false, reason: "invalid" });
    }
    expect(parseDiceExpression("21d6")).toEqual({ ok: false, reason: "limits" });
    expect(parseDiceExpression("1d1001")).toEqual({ ok: false, reason: "limits" });
    expect(parseDiceExpression("10d6+11d6")).toEqual({ ok: false, reason: "limits" });
  });
});

describe("rollDie", () => {
  it("stays within its faces", () => {
    for (let i = 0; i < 500; i++) {
      const v = rollDie(6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });
});

describe("roll messages", () => {
  const fixed = (values: number[]) => {
    let i = 0;
    return () => values[i++];
  };

  it("round-trips a roll through its text", () => {
    const roll = rollDice(terms("2d6+1d4-2"), "  fire\nball ", fixed([4, 5, 3]));
    const text = formatRollMessage(roll);
    expect(text).toBe(`${DICE_PREFIX}2d6+1d4-2 → 4, 5, 3 = 10 — fire ball`);
    expect(parseRollMessage(text)).toEqual(roll);
  });

  it("leaves the total implied for one die", () => {
    const text = formatRollMessage(rollDice(terms("d20"), undefined, fixed([17])));
    expect(text).toBe(`${DICE_PREFIX}1d20 → 17`);
    expect(parseRollMessage(text)?.total).toBe(17);
  });

  it("rejects text whose numbers don't add up", () => {
    for (const body of [
      "1d20 → 21",
      "2d6 → 4 = 4",
      "2d6 → 4, 5 = 10",
      "1d6+2 → 4",
      "d20 → 4",
      "1d20 → 0",
    ]) {
      expect(parseRollMessage(DICE_PREFIX + body), body).toBeUndefined();
    }
    expect(parseRollMessage("🎲 1d20 → 17")).toBeUndefined();
  });
});

describe("splitRollArgument", () => {
  it("separates the expression from a label", () => {
    expect(splitRollArgument("2d6 + 3 fireball")).toEqual({ expression: "2d6 + 3", label: "fireball" });
    expect(splitRollArgument("stealth check")).toEqual({ expression: "", label: "stealth check" });
    expect(splitRollArgument("")).toEqual({ expression: "", label: "" });
  });

  it("keeps a typo whole so it is reported, not labelled", () => {
    expect(splitRollArgument("2x6")).toEqual({ expression: "2x6", label: "" });
  });
});

describe("/roll", () => {
  const roll = findSlashCommand("roll")!;

  it("rolls a d20 by default", () => {
    const result = roll.run("", ctx);
    expect(result.type).toBe("send");
    if (result.type === "send") expect(parseRollMessage(result.text)?.expression).toBe("1d20");
  });

  it("is also /dice", () => {
    expect(findSlashCommand("dice")).toBe(roll);
  });

  const sent = (arg: string) => {
    const result = roll.run(arg, ctx);
    if (result.type !== "send") throw new Error(`${arg}: ${result.type}`);
    return parseRollMessage(result.text)!;
  };

  it("reads a roll typed in the usage line's brackets", () => {
    expect(sent("[2d6+3]").expression).toBe("2d6+3");
    expect(sent("(2d4) sneak").label).toBe("sneak");
  });

  it("refuses dice it can't read rather than rolling a d20", () => {
    expect(roll.run("[2d6", ctx).type).toBe("error");
    expect(roll.run("{2d6}", ctx).type).toBe("error");
    expect(sent("dragon breath").expression).toBe("1d20");
  });

  it("expands a preset, upcast and with extras", () => {
    expect(sent("fireball")).toMatchObject({ expression: "8d6", label: "fireball" });
    expect(sent("Fireball 5 the goblins")).toMatchObject({ expression: "10d6", label: "fireball the goblins" });
    expect(sent("magic_missile 3").expression).toBe("5d4+5");
    expect(sent("cure-wounds 2 +3").expression).toBe("2d8+3");
    expect(sent("disintegrate 9").expression).toBe("19d6+40");
    expect(roll.run("fireball 2", ctx).type).toBe("error");
    expect(sent("finger-of-death 8").expression).toBe("7d8+30");
    expect(roll.run("fireball 10", ctx).type).toBe("error");
  });

  it("reports a bad roll instead of sending it", () => {
    expect(roll.run("2x6", ctx).type).toBe("error");
    expect(roll.run("50d6", ctx).type).toBe("error");
  });
});

describe("dice geometry", () => {
  it.each(POLYHEDRAL_SIDES)("d%i has one planar outward face per number", (sides) => {
    const poly = getPolyhedron(sides)!;
    expect(poly.faces.map((f) => f.label).sort((a, b) => a - b)).toEqual(Array.from({ length: sides }, (_, i) => i + 1));
    for (const face of poly.faces) {
      const pts = face.vertices.map((i) => poly.vertices[i]);
      const d = pts.map((p) => p[0] * face.normal[0] + p[1] * face.normal[1] + p[2] * face.normal[2]);
      expect(d[0]).toBeGreaterThan(0.1);
      for (const x of d) expect(x).toBeCloseTo(d[0], 6);
    }
  });
});
