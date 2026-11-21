/**
 * Built-in named rolls for `/roll`: `/roll fireball`, `/roll fireball 5` (cast
 * with a 5th-level slot), `/roll cure-wounds +3` (plus a modifier). Shaped like
 * a bot manifest's command list. Damage dice are from the SRD 5.1 (CC-BY-4.0).
 *
 * A preset only expands into an ordinary expression with the preset's name as
 * its label, so other clients need to know nothing about it.
 */

import {
  MAX_CONSTANT,
  MAX_DICE,
  parseDiceTerms,
  splitRollArgument,
  type DiceTerm,
} from "@/lib/dice";

export interface RollPreset {
  /** `[a-z0-9-]`, typed after `/roll`. */
  name: string;
  roll: string;
  /** The lowest spell slot; a slot above it adds `upcast` per level. */
  level?: number;
  upcast?: string;
}

export const ROLL_PRESETS: readonly RollPreset[] = [
  { name: "burning-hands", roll: "3d6", level: 1, upcast: "1d6" },
  { name: "cure-wounds", roll: "1d8", level: 1, upcast: "1d8" },
  { name: "guiding-bolt", roll: "4d6", level: 1, upcast: "1d6" },
  { name: "healing-word", roll: "1d4", level: 1, upcast: "1d4" },
  { name: "hellish-rebuke", roll: "2d10", level: 1, upcast: "1d10" },
  { name: "inflict-wounds", roll: "3d10", level: 1, upcast: "1d10" },
  { name: "magic-missile", roll: "3d4+3", level: 1, upcast: "1d4+1" },
  { name: "sleep", roll: "5d8", level: 1, upcast: "2d8" },
  { name: "thunderwave", roll: "2d8", level: 1, upcast: "1d8" },
  { name: "shatter", roll: "3d8", level: 2, upcast: "1d8" },
  { name: "fireball", roll: "8d6", level: 3, upcast: "1d6" },
  { name: "lightning-bolt", roll: "8d6", level: 3, upcast: "1d6" },
  { name: "ice-storm", roll: "2d8+4d6", level: 4, upcast: "1d8" },
  { name: "cone-of-cold", roll: "8d8", level: 5, upcast: "1d8" },
  { name: "mass-cure-wounds", roll: "3d8", level: 5, upcast: "1d8" },
  { name: "disintegrate", roll: "10d6+40", level: 6, upcast: "3d6" },
  { name: "finger-of-death", roll: "7d8+30", level: 7 },
];

const MAX_SLOT = 9;

const squash = (word: string) => word.toLowerCase().replace(/[-_]/g, "");

export function findRollPreset(word: string): RollPreset | undefined {
  const key = squash(word);
  return ROLL_PRESETS.find((preset) => squash(preset.name) === key);
}

/** Like dice of a sign are pooled and constants summed, so `8d6+1d6+1d6` reads `10d6`. */
function pool(terms: DiceTerm[]): DiceTerm[] {
  const dice: Extract<DiceTerm, { sides: number }>[] = [];
  let constant = 0;
  for (const term of terms) {
    if (!("sides" in term)) {
      constant += term.sign * term.constant;
      continue;
    }
    const same = dice.find((d) => d.sides === term.sides && d.sign === term.sign);
    if (same) same.count += term.count;
    else dice.push({ ...term });
  }
  return constant === 0 ? dice : [...dice, { sign: constant < 0 ? -1 : 1, constant: Math.abs(constant) }];
}

function termsOf(src: string): DiceTerm[] {
  const parsed = parseDiceTerms(src);
  if (!parsed.ok) throw new Error(`bad preset roll: ${src}`);
  return parsed.terms;
}

export type PresetRollResult =
  | { ok: true; terms: DiceTerm[]; label: string }
  | { ok: false; reason: "invalid" | "limits" }
  | { ok: false; reason: "level"; preset: RollPreset };

/** The roll `/roll <preset> [slot] [+extra] [label]` asks for, or undefined when it names no preset. */
export function presetRoll(arg: string): PresetRollResult | undefined {
  const head = /^\s*([a-z][\w-]*)/i.exec(arg);
  const preset = head && findRollPreset(head[1]);
  if (!preset) return undefined;
  let rest = arg.slice(head[0].length);

  const terms = termsOf(preset.roll);
  const slotMatch = /^\s+(\d+)(?=\s|$)/.exec(rest);
  if (slotMatch) {
    const slot = Number(slotMatch[1]);
    if (preset.level === undefined || slot < preset.level || slot > MAX_SLOT) return { ok: false, reason: "level", preset };
    if (preset.upcast) for (let i = preset.level; i < slot; i++) terms.push(...termsOf(preset.upcast));
    rest = rest.slice(slotMatch[0].length);
  }

  // Anything added on must be signed (`+3`, `-1d4`), so it can't be mistaken for a slot.
  let label = rest.trim();
  if (/^\s*[+-]/.test(rest)) {
    const split = splitRollArgument(rest);
    const extra = parseDiceTerms(split.expression);
    if (!extra.ok) return extra;
    terms.push(...extra.terms);
    label = split.label;
  }

  const pooled = pool(terms);
  const dice = pooled.reduce((n, term) => n + ("count" in term ? term.count : 0), 0);
  const constant = pooled.find((term) => "constant" in term);
  if (dice > MAX_DICE || (constant && "constant" in constant && constant.constant > MAX_CONSTANT)) {
    return { ok: false, reason: "limits" };
  }
  return { ok: true, terms: pooled, label: label ? `${preset.name} ${label}` : preset.name };
}
