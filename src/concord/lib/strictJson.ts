/**
 * JSON read the way Vector's serde reads Control content, so the two clients
 * accept the same editions: a repeated top-level key, a lone surrogate, or an
 * integer field written as anything but an integer literal refuses the content.
 * Integer fields come back as a `bigint` read off their source text by a parser
 * of our own, so the answer doesn't hang on the engine's JSON.parse source text
 * access, which iOS before 18.4 and older Android WebViews lack.
 */

/** What an integer field holds when its source isn't an integer literal. */
export const NOT_AN_INTEGER = Symbol("not-an-integer");

const LONE_SURROGATE = /\p{Cs}/u;

/** serde_json's recursion limit: entering a 128th nested array or object fails. */
const MAX_DEPTH = 127;

/** Objects that repeated a key: a serde struct refuses one, a `Value` map keeps the last. */
const repeatedKeys = new WeakSet<object>();

/** Whether `v` is an object {@link parseStrictObject} read with a repeated key. */
export function hadRepeatedKeys(v: unknown): boolean {
  return typeof v === "object" && v !== null && repeatedKeys.has(v);
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// A raw control character is invalid inside a JSON string (RFC 8259 §7).
// eslint-disable-next-line no-control-regex
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

/**
 * A number written as a float or with an exponent, kept apart from an integer as serde_json's
 * `Value` keeps an f64 apart from a u64: `as_u64` reads none of them. Serializes as its number.
 */
export class JsonFloat {
  constructor(readonly value: number) {}
  toJSON(): number {
    return this.value;
  }
}

/** RFC 8259 JSON, as JSON.parse reads it, but integer fields read off their source. */
function parseJsonText(text: string, intKeys: ReadonlySet<string>, everyNumber = false): unknown {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`bad JSON at ${i}`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const token = (re: RegExp): string => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) fail();
    i = re.lastIndex;
    return m![0];
  };
  const literal = (word: string, v: unknown) => {
    if (!text.startsWith(word, i)) fail();
    i += word.length;
    return v;
  };
  const value = (key: string | undefined, depth: number): unknown => {
    ws();
    const ch = text[i];
    if (ch === "{") {
      if (depth >= MAX_DEPTH) fail();
      i++;
      const out: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        ws();
        const k = JSON.parse(token(STRING)) as string;
        ws();
        if (text[i++] !== ":") fail();
        const v = value(k, depth + 1);
        if (Object.prototype.hasOwnProperty.call(out, k)) repeatedKeys.add(out);
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        const sep = text[i++];
        if (sep === "}") return out;
        if (sep !== ",") fail();
      }
    }
    if (ch === "[") {
      if (depth >= MAX_DEPTH) fail();
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(undefined, depth + 1));
        ws();
        const sep = text[i++];
        if (sep === "]") return out;
        if (sep !== ",") fail();
      }
    }
    if (ch === '"') return JSON.parse(token(STRING));
    if (ch === "t") return literal("true", true);
    if (ch === "f") return literal("false", false);
    if (ch === "n") return literal("null", null);
    const source = token(NUMBER);
    if (everyNumber) return /^-?\d+$/.test(source) && source !== "-0" ? Number(source) : new JsonFloat(Number(source));
    // serde_json reads `-0` as a float.
    if (key !== undefined && intKeys.has(key)) return /^-?\d+$/.test(source) && source !== "-0" ? BigInt(source) : NOT_AN_INTEGER;
    return Number(source);
  };
  const v = value(undefined, 0);
  ws();
  if (i !== text.length) fail();
  return v;
}

function hasLoneSurrogate(v: unknown): boolean {
  if (typeof v === "string") return LONE_SURROGATE.test(v);
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => LONE_SURROGATE.test(k) || hasLoneSurrogate(x));
  return false;
}

/**
 * Parse an object, or undefined when serde wouldn't: not an object, a repeated
 * top-level key, or a lone surrogate anywhere. Values under `intKeys` that are
 * numbers become a `bigint`, or {@link NOT_AN_INTEGER} for a float or exponent form.
 */
export function parseStrictObject(content: string, intKeys: ReadonlySet<string> = new Set()): Record<string, unknown> | undefined {
  let v: unknown;
  try {
    v = parseJsonText(content, intKeys);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || repeatedKeys.has(v)) return undefined;
  if (hasLoneSurrogate(v)) return undefined;
  return v as Record<string, unknown>;
}

/** An array of strings, or undefined when serde's `Vec<String>` wouldn't read it (a lone surrogate included). */
export function parseStrictStringArray(content: string): string[] | undefined {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || LONE_SURROGATE.test(s))) return undefined;
  return v as string[];
}

/**
 * Any JSON value as serde_json's `Value` reads it (Vector's ledgers): integers as numbers, a
 * float or exponent form as a {@link JsonFloat}, undefined on a lone surrogate or past the depth.
 */
export function parseStrictValue(content: string): unknown {
  let v: unknown;
  try {
    v = parseJsonText(content, new Set(), true);
  } catch {
    return undefined;
  }
  return hasLoneSurrogate(v) ? undefined : v;
}

/** An integer field read by {@link parseStrictObject} within `[0, max]`, else undefined. */
export function strictUint(v: unknown, max: bigint): bigint | undefined {
  return typeof v === "bigint" && v >= 0n && v <= max ? v : undefined;
}

/**
 * The value of a machinery tag that may appear at most once (counting tags that
 * carry a value), or `null` when it repeats — Vector's `unique_tag`.
 */
export function uniqueTag(tags: string[][], name: string): string | undefined | null {
  let found: string | undefined;
  for (const t of tags) {
    if (t.length < 2 || t[0] !== name) continue;
    if (found !== undefined) return null;
    found = t[1];
  }
  return found;
}
