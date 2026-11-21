/**
 * `/roll` dice: the expression grammar, the roll, and the message it sends.
 *
 * A roll travels as ordinary chat text that reads well in any client
 * (`🎲 2d6+3 → 4, 5 = 12 — fireball`), behind a zero-width marker like `/me`'s.
 * Armada re-derives everything from that text and renders dice only when the
 * numbers are consistent; the result is still the sender's own claim.
 */

export const DICE_PREFIX = "\u200b🎲 ";

export const MAX_DICE = 20;
export const MAX_SIDES = 1000;
export const MAX_CONSTANT = 1000;

export type DiceTerm =
  | { sign: 1 | -1; count: number; sides: number }
  | { sign: 1 | -1; constant: number };

export interface RolledDie {
  sides: number;
  value: number;
  sign: 1 | -1;
}

export interface DiceRoll {
  /** Canonical expression, e.g. `2d6+1d4-2`. */
  expression: string;
  dice: RolledDie[];
  /** Sum of the signed constants. */
  modifier: number;
  total: number;
  label?: string;
}

export type DiceExpressionResult =
  | { ok: true; terms: DiceTerm[] }
  | { ok: false; reason: "invalid" | "limits" };

const TERM = /([+-]?)(\d*)(?:(d)(\d+))?/iy;

/** The signed terms of `2d6+1d4-2` (spaces allowed), each within the limits. */
export function parseDiceTerms(src: string): DiceExpressionResult {
  const s = src.replace(/\s+/g, "").toLowerCase();
  if (!s) return { ok: false, reason: "invalid" };
  const terms: DiceTerm[] = [];
  let pos = 0;
  while (pos < s.length) {
    TERM.lastIndex = pos;
    const m = TERM.exec(s);
    if (!m || m[0] === "" || m.index !== pos) return { ok: false, reason: "invalid" };
    const [, signStr, countStr, d, sidesStr] = m;
    if (terms.length > 0 && !signStr) return { ok: false, reason: "invalid" };
    const sign = signStr === "-" ? -1 : 1;
    if (d) {
      const count = countStr ? Number(countStr) : 1;
      const sides = Number(sidesStr);
      if (count < 1 || sides < 2) return { ok: false, reason: "invalid" };
      if (count > MAX_DICE || sides > MAX_SIDES) return { ok: false, reason: "limits" };
      terms.push({ sign, count, sides });
    } else {
      if (!countStr) return { ok: false, reason: "invalid" };
      const constant = Number(countStr);
      if (constant > MAX_CONSTANT) return { ok: false, reason: "limits" };
      terms.push({ sign, constant });
    }
    pos += m[0].length;
  }
  return { ok: true, terms };
}

/** Parse `2d6+1d4-2` (spaces allowed). A lone number `N` means `1dN`. */
export function parseDiceExpression(src: string): DiceExpressionResult {
  const parsed = parseDiceTerms(src);
  if (!parsed.ok) return parsed;
  const { terms } = parsed;
  if (terms.length === 1 && "constant" in terms[0] && terms[0].sign === 1) {
    const sides = terms[0].constant;
    if (sides < 2) return { ok: false, reason: "invalid" };
    if (sides > MAX_SIDES) return { ok: false, reason: "limits" };
    return { ok: true, terms: [{ sign: 1, count: 1, sides }] };
  }
  if (!terms.some((term) => "sides" in term)) return { ok: false, reason: "invalid" };
  if (terms.reduce((n, term) => n + ("count" in term ? term.count : 0), 0) > MAX_DICE) {
    return { ok: false, reason: "limits" };
  }
  return { ok: true, terms };
}

export function formatDiceExpression(terms: DiceTerm[]): string {
  return terms
    .map((term, i) => {
      const body = "sides" in term ? `${term.count}d${term.sides}` : String(term.constant);
      return term.sign === -1 ? `-${body}` : i === 0 ? body : `+${body}`;
    })
    .join("");
}

/** A uniform integer in [1, sides], by rejection sampling so no face is favored. */
export function rollDie(sides: number): number {
  const limit = Math.floor(0x1_0000_0000 / sides) * sides;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return (buf[0] % sides) + 1;
  }
}

export function rollDice(terms: DiceTerm[], label?: string, roll: (sides: number) => number = rollDie): DiceRoll {
  const dice: RolledDie[] = [];
  let modifier = 0;
  for (const term of terms) {
    if ("sides" in term) {
      for (let i = 0; i < term.count; i++) dice.push({ sides: term.sides, value: roll(term.sides), sign: term.sign });
    } else {
      modifier += term.sign * term.constant;
    }
  }
  const total = dice.reduce((sum, die) => sum + die.sign * die.value, modifier);
  const cleanLabel = label?.replace(/\s+/g, " ").trim();
  return { expression: formatDiceExpression(terms), dice, modifier, total, label: cleanLabel || undefined };
}

/** The total is implied when it is just the one die. */
function totalIsImplied(roll: Pick<DiceRoll, "dice" | "modifier">): boolean {
  return roll.dice.length === 1 && roll.dice[0].sign === 1 && roll.modifier === 0;
}

export function formatRollMessage(roll: DiceRoll): string {
  const values = roll.dice.map((die) => die.value).join(", ");
  const total = totalIsImplied(roll) ? "" : ` = ${roll.total}`;
  const label = roll.label ? ` — ${roll.label}` : "";
  return `${DICE_PREFIX}${roll.expression} → ${values}${total}${label}`;
}

const MESSAGE = /^([0-9d+-]+) → (\d+(?:, \d+)*)(?: = (-?\d+))?(?: — (.+))?$/;

/** The roll a chat message carries, or undefined unless every number adds up. */
export function parseRollMessage(content: string): DiceRoll | undefined {
  if (!content.startsWith(DICE_PREFIX)) return undefined;
  const m = MESSAGE.exec(content.slice(DICE_PREFIX.length));
  if (!m) return undefined;
  const parsed = parseDiceExpression(m[1]);
  if (!parsed.ok || formatDiceExpression(parsed.terms) !== m[1]) return undefined;
  const values = m[2].split(", ").map(Number);
  let i = 0;
  const roll = rollDice(parsed.terms, m[4], () => values[i++]);
  if (i !== values.length || roll.dice.some((die) => die.value < 1 || die.value > die.sides)) return undefined;
  if (m[3] === undefined ? !totalIsImplied(roll) : Number(m[3]) !== roll.total) return undefined;
  return roll;
}

/** Split a `/roll` argument into its leading expression and the label after it. */
export function splitRollArgument(arg: string): { expression: string; label: string } {
  const term = String.raw`(?:\d*\s*d\s*\d+|\d+)`;
  const m = new RegExp(String.raw`^\s*((?:[+-]\s*)?${term}(?:\s*[+-]\s*${term})*)?`, "i").exec(arg);
  const expression = (m?.[1] ?? "").trim();
  // "2d6+3fire" is a typo, not the expression "2d6+3" labelled "fire".
  const rest = arg.slice(m?.[0].length ?? 0);
  if (expression && rest && !/^\s/.test(rest)) return { expression: arg.trim(), label: "" };
  return { expression, label: rest.trim() };
}
