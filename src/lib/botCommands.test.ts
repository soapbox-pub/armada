import { describe, expect, it } from "vitest";

import {
  addressedBots,
  argReason,
  botCommandPick,
  botTag,
  buildInvocationText,
  commandLine,
  draftNamesCommand,
  invocationTags,
  normalizeUser,
  parseBotManifest,
  parseInvocation,
  usageLine,
  validateInvocation,
  type BotCommandEntry,
  type BotManifest,
} from "@/lib/botCommands";
import concordiaManifest from "@/test/fixtures/concordia-manifest.json";

/** A real, checksum-valid npub (Concordia's). */
const NPUB = "npub1avtqttls0ysfgkrv2vecyc0pxg52938skncsjkyu7h23qdru9g5ss5t0rs";
const BOT_A = "eb1605aff0792094586c53338261e13228a2c4f0b4f109589cf5d510347c2a29";
const BOT_B = "1111111111111111111111111111111111111111111111111111111111111111";

/**
 * The manifest from the spec's own example. Every parser claiming conformance
 * must read these bytes the same way, so it doubles as a cross-implementation
 * vector against Vector's Rust parser.
 */
const SPEC_MANIFEST = JSON.stringify({
  v: 1,
  commands: [
    {
      name: "price",
      description: "Get a coin price",
      args: [
        {
          name: "asset",
          type: "choice",
          description: "Which coin",
          required: true,
          choices: ["btc", "xmr", "pivx"],
        },
      ],
    },
    {
      name: "say",
      description: "Echo",
      args: [
        { name: "count", type: "int", description: "", required: true },
        { name: "text", type: "string", description: "", required: false },
      ],
    },
  ],
});

function entriesOf(manifest: BotManifest, bot = BOT_A): BotCommandEntry[] {
  return manifest.commands.map((command) => ({ bot, command }));
}

const specEntries = () => entriesOf(parseBotManifest(SPEC_MANIFEST)!);

/** A manifest with one command, built around a single argument spec. */
function manifestWith(arg: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    commands: [{ name: "cmd", description: "", args: [arg] }],
  });
}

describe("parseBotManifest", () => {
  it("reads the spec's example manifest", () => {
    const m = parseBotManifest(SPEC_MANIFEST);
    expect(m).toBeDefined();
    expect(m!.v).toBe(1);
    expect(m!.commands.map((c) => c.name)).toEqual(["price", "say"]);
    expect(m!.commands[0].args[0]).toEqual({
      name: "asset",
      type: "choice",
      description: "Which coin",
      required: true,
      choices: ["btc", "xmr", "pivx"],
    });
  });

  it("applies defaults for omitted description/required/args/commands", () => {
    const m = parseBotManifest(JSON.stringify({ v: 1, commands: [{ name: "ping" }] }));
    expect(m!.commands[0]).toEqual({ name: "ping", description: "", args: [] });
    expect(parseBotManifest(JSON.stringify({ v: 1 }))!.commands).toEqual([]);
  });

  it("ignores unknown fields rather than rejecting them", () => {
    const m = parseBotManifest(
      JSON.stringify({
        v: 1,
        futureField: "ignored",
        commands: [{ name: "ping", description: "", args: [], somethingNew: 7 }],
      }),
    );
    expect(m!.commands[0]).toEqual({ name: "ping", description: "", args: [] });
  });

  it("hides a command that uses an unknown argument type, keeping the rest", () => {
    // Forward compatibility: the day the spec adds a 7th type and one bot adopts
    // it, an older client must not lose that bot's OTHER commands. The command
    // can't be part-rendered (positions would shift), so it's dropped whole.
    const m = parseBotManifest(
      JSON.stringify({
        v: 1,
        commands: [
          { name: "ping", args: [] },
          { name: "pay", args: [{ name: "amt", type: "int" }, { name: "when", type: "duration" }] },
          { name: "roll", args: [{ name: "sides", type: "int" }] },
        ],
      }),
    );
    expect(m).toBeDefined();
    expect(m!.commands.map((c) => c.name)).toEqual(["ping", "roll"]);
  });

  it("does not let an unknown type carrying choices reject the manifest", () => {
    // A known non-choice arg with choices is malformed and fatal; an UNKNOWN one
    // has rules we can't know, so its command is simply hidden, not fatal.
    const m = parseBotManifest(
      JSON.stringify({
        v: 1,
        commands: [
          { name: "ok", args: [] },
          { name: "future", args: [{ name: "x", type: "money", choices: ["usd", "eur"] }] },
        ],
      }),
    );
    expect(m!.commands.map((c) => c.name)).toEqual(["ok"]);
  });

  it("still rejects the WHOLE manifest for a genuine structural error", () => {
    // Graceful degrade is only for unknown types. A real violation (choices on a
    // KNOWN non-choice type) is a malformed producer and fails fail-closed.
    const json = JSON.stringify({
      v: 1,
      commands: [{ name: "cmd", args: [{ name: "x", type: "int", choices: ["1"] }] }],
    });
    expect(parseBotManifest(json)).toBeUndefined();
  });

  it("rejects malformed JSON", () => {
    expect(parseBotManifest("{not json")).toBeUndefined();
  });

  it("rejects a version it does not implement", () => {
    expect(parseBotManifest(JSON.stringify({ v: 2, commands: [] }))).toBeUndefined();
  });

  it.each([
    ["an uppercase name", "Price"],
    ["a space in the name", "get price"],
    ["a name over 32 chars", "a".repeat(33)],
    ["an empty name", ""],
  ])("rejects %s", (_label, name) => {
    expect(parseBotManifest(JSON.stringify({ v: 1, commands: [{ name }] }))).toBeUndefined();
  });

  it("rejects duplicate command names", () => {
    const json = JSON.stringify({ v: 1, commands: [{ name: "a" }, { name: "a" }] });
    expect(parseBotManifest(json)).toBeUndefined();
  });

  it("rejects duplicate argument names within a command", () => {
    const json = JSON.stringify({
      v: 1,
      commands: [{ name: "cmd", args: [{ name: "x", type: "int" }, { name: "x", type: "int" }] }],
    });
    expect(parseBotManifest(json)).toBeUndefined();
  });

  it("rejects more than 64 commands", () => {
    const commands = Array.from({ length: 65 }, (_, i) => ({ name: `cmd${i}` }));
    expect(parseBotManifest(JSON.stringify({ v: 1, commands }))).toBeUndefined();
  });

  it("rejects more than 8 arguments", () => {
    const args = Array.from({ length: 9 }, (_, i) => ({ name: `a${i}`, type: "string" }));
    const json = JSON.stringify({ v: 1, commands: [{ name: "cmd", args }] });
    expect(parseBotManifest(json)).toBeUndefined();
  });

  it("rejects a description over 200 bytes", () => {
    const json = JSON.stringify({ v: 1, commands: [{ name: "cmd", description: "x".repeat(201) }] });
    expect(parseBotManifest(json)).toBeUndefined();
  });

  it("rejects a manifest over 32768 bytes", () => {
    // 64 commands each carrying a 200-byte description clears the size cap while
    // breaking no per-field rule, so only the total-size check can catch it.
    const commands = Array.from({ length: 64 }, (_, i) => ({
      name: `cmd${i}`,
      description: "x".repeat(200),
      args: Array.from({ length: 8 }, (_, j) => ({
        name: `arg${j}`,
        type: "string",
        description: "y".repeat(200),
      })),
    }));
    const json = JSON.stringify({ v: 1, commands });
    expect(json.length).toBeGreaterThan(32768);
    expect(parseBotManifest(json)).toBeUndefined();
  });

  it.each([
    ["a choice arg with no choices", { name: "a", type: "choice", choices: [] }],
    ["a choice arg with over 32 choices", { name: "a", type: "choice", choices: Array.from({ length: 33 }, (_, i) => `c${i}`) }],
    ["a choice value over 32 bytes", { name: "a", type: "choice", choices: ["x".repeat(33)] }],
    ["an empty choice value", { name: "a", type: "choice", choices: [""] }],
    ["choices on a non-choice arg", { name: "a", type: "int", choices: ["1"] }],
  ])("rejects %s", (_label, arg) => {
    expect(parseBotManifest(manifestWith(arg))).toBeUndefined();
  });

  it("rejects a required argument that follows an optional one", () => {
    // Positional text cannot express a hole, so this ordering would be ambiguous.
    const json = JSON.stringify({
      v: 1,
      commands: [
        {
          name: "cmd",
          args: [
            { name: "a", type: "string", required: false },
            { name: "b", type: "string", required: true },
          ],
        },
      ],
    });
    expect(parseBotManifest(json)).toBeUndefined();
  });
});

describe("parseInvocation", () => {
  it("reads every invocation in the spec's example table", () => {
    const e = specEntries();

    expect(parseInvocation("/price btc", e)).toMatchObject({ args: ["btc"] });
    // Greedy trailing string: no quoting needed for a multi-word tail.
    expect(parseInvocation("/say 3 hello there", e)).toMatchObject({ args: ["3", "hello there"] });
    expect(parseInvocation('/say 1 "quoted, with spaces"', e)).toMatchObject({
      args: ["1", "quoted, with spaces"],
    });
  });

  it("folds the command word but never the argument values", () => {
    const e = specEntries();
    expect(parseInvocation("/PRICE btc", e)?.command.name).toBe("price");
    expect(parseInvocation("/Price btc", e)?.command.name).toBe("price");
    // A choice is matched exactly, so an uppercased VALUE is a validation
    // failure rather than a silent match.
    const parsed = parseInvocation("/price BTC", e)!;
    expect(parsed.args).toEqual(["BTC"]);
    expect(validateInvocation(parsed.command, parsed.args)).toBe("asset: not one of btc, xmr, pivx");
  });

  it("is not an invocation when the command is unknown", () => {
    // Ordinary chat must still send: `/shrug` is not this bot's business.
    expect(parseInvocation("/shrug", specEntries())).toBeUndefined();
    expect(parseInvocation("hello /price btc", specEntries())).toBeUndefined();
    expect(parseInvocation("no slash here", specEntries())).toBeUndefined();
  });

  it("is not an invocation when a quote is left open", () => {
    expect(parseInvocation('/say 1 "never closed', specEntries())).toBeUndefined();
  });

  it("is not an invocation when the command word itself is quoted", () => {
    expect(parseInvocation('/"price" btc', specEntries())).toBeUndefined();
  });

  it("is not an invocation when a value exceeds the 1024-byte wire cap", () => {
    expect(parseInvocation(`/say 1 ${"a".repeat(1025)}`, specEntries())).toBeUndefined();
    expect(parseInvocation(`/say 1 ${"a".repeat(1024)}`, specEntries())).toBeDefined();
  });

  it("measures that cap in bytes, not characters", () => {
    // Each of these is 4 bytes, so 300 of them clear 1024 bytes at 300 chars.
    expect(parseInvocation(`/say 1 ${"🙂".repeat(300)}`, specEntries())).toBeUndefined();
  });

  it("stops at the last supplied argument", () => {
    expect(parseInvocation("/say 3", specEntries())?.args).toEqual(["3"]);
  });

  it("prefers the bot the user actually picked when two declare the same name", () => {
    const m = parseBotManifest(SPEC_MANIFEST)!;
    const entries = [...entriesOf(m, BOT_A), ...entriesOf(m, BOT_B)];
    expect(parseInvocation("/price btc", entries)?.bot).toBe(BOT_A);
    expect(parseInvocation("/price btc", entries, BOT_B)?.bot).toBe(BOT_B);
  });
});

describe("buildInvocationText", () => {
  it("quotes only what needs quoting", () => {
    expect(buildInvocationText("price", ["btc"])).toBe("/price btc");
    expect(buildInvocationText("say", ["3", "hello there"])).toBe('/say 3 "hello there"');
    expect(buildInvocationText("say", ["1", ""])).toBe('/say 1 ""');
  });

  it("escapes quotes and backslashes", () => {
    expect(buildInvocationText("say", ['a "b" c'])).toBe('/say "a \\"b\\" c"');
    expect(buildInvocationText("say", ["back\\slash here"])).toBe('/say "back\\\\slash here"');
  });

  it("round-trips every value back through the parser", () => {
    const e = specEntries();
    for (const values of [
      ["1", "plain"],
      ["2", "with spaces"],
      ["3", 'has "quotes" inside'],
      ["4", "back\\slash"],
      ["5", ""],
    ]) {
      const text = buildInvocationText("say", values);
      expect(parseInvocation(text, e)?.args, text).toEqual(values);
    }
  });
});

describe("botCommandPick (what a menu pick does)", () => {
  const command = (args: Record<string, unknown>[]) =>
    parseBotManifest(JSON.stringify({ v: 1, commands: [{ name: "model", args }] }))!.commands[0];

  it("sends a command that declares no arguments", () => {
    expect(botCommandPick(command([]))).toEqual({ kind: "send" });
  });

  it("drafts a command whose only argument is free text, required or not", () => {
    for (const required of [false, true]) {
      expect(botCommandPick(command([{ name: "name", type: "string", required }])))
        .toEqual({ kind: "draft", text: "/model " });
    }
  });

  it("opens typed fields for a single typed argument or several arguments", () => {
    expect(botCommandPick(command([{ name: "n", type: "int" }]))).toEqual({ kind: "fields" });
    expect(botCommandPick(command([{ name: "a", type: "string" }, { name: "b", type: "string" }])))
      .toEqual({ kind: "fields" });
    const roll = parseBotManifest(JSON.stringify(concordiaManifest))!.commands.find((c) => c.name === "roll")!;
    expect(botCommandPick(roll)).toEqual({ kind: "fields" });
  });
});

describe("draftNamesCommand (whether a menu pick still routes the draft)", () => {
  it("holds while the draft still begins with the picked command", () => {
    expect(draftNamesCommand("/model ", "model")).toBe(true);
    expect(draftNamesCommand("/model gpt-5", "model")).toBe(true);
    expect(draftNamesCommand("/Model gpt-5", "model")).toBe(true);
    expect(draftNamesCommand("/model", "model")).toBe(true);
  });

  it("lapses once the draft names something else", () => {
    expect(draftNamesCommand("", "model")).toBe(false);
    expect(draftNamesCommand("/", "model")).toBe(false);
    expect(draftNamesCommand("/mode", "model")).toBe(false);
    expect(draftNamesCommand("/models", "model")).toBe(false);
    expect(draftNamesCommand("/poll Lunch?", "model")).toBe(false);
    expect(draftNamesCommand("model", "model")).toBe(false);
  });
});

describe("argReason", () => {
  const arg = (over: Record<string, unknown>) =>
    parseBotManifest(manifestWith({ name: "a", ...over }))!.commands[0].args[0];

  it("types integers", () => {
    const spec = arg({ type: "int" });
    expect(argReason(spec, "42")).toBeUndefined();
    expect(argReason(spec, "-7")).toBeUndefined();
    expect(argReason(spec, "4.2")).toBe("not an integer");
    expect(argReason(spec, "abc")).toBe("not an integer");
  });

  it("types numbers", () => {
    const spec = arg({ type: "number" });
    expect(argReason(spec, "4.2")).toBeUndefined();
    expect(argReason(spec, "-0.5")).toBeUndefined();
    expect(argReason(spec, "abc")).toBe("not a number");
    expect(argReason(spec, " ")).toBe("not a number");
  });

  it("types booleans loosely, as the spec requires", () => {
    const spec = arg({ type: "bool" });
    for (const v of ["true", "false", "yes", "no", "1", "0", "TRUE", "No"]) {
      expect(argReason(spec, v), v).toBeUndefined();
    }
    expect(argReason(spec, "maybe")).toBe("not a boolean");
  });

  it("types choices exactly", () => {
    const spec = arg({ type: "choice", choices: ["btc", "xmr", "pivx"] });
    expect(argReason(spec, "btc")).toBeUndefined();
    expect(argReason(spec, "doge")).toBe("not one of btc, xmr, pivx");
  });

  it("accepts free text for a string", () => {
    expect(argReason(arg({ type: "string" }), "anything at all")).toBeUndefined();
  });

  it("types users, accepting the NIP-21 URI as well as a bare npub", () => {
    const spec = arg({ type: "user" });
    expect(argReason(spec, NPUB)).toBeUndefined();
    expect(argReason(spec, `nostr:${NPUB}`)).toBeUndefined();
    expect(argReason(spec, "not-an-npub")).toBe("not an npub");
    // A prefix check alone would pass this; only the checksum catches it.
    expect(argReason(spec, NPUB.slice(0, -1) + "q")).toBe("not an npub");
  });
});

describe("parity with the reference parser", () => {
  const arg = (over: Record<string, unknown>) =>
    parseBotManifest(manifestWith({ name: "a", ...over }))!.commands[0].args[0];

  it("rejects an integer outside signed 64-bit range", () => {
    // A bot parses this into an i64 and rejects it, so waving it through here
    // would break the promise that a validated command actually runs.
    expect(argReason(arg({ type: "int" }), "99999999999999999999")).toBe("not an integer");
    expect(argReason(arg({ type: "int" }), "9223372036854775807")).toBeUndefined();
  });

  it("rejects JavaScript's own numeric literal forms, which a bot will not take", () => {
    const spec = arg({ type: "number" });
    expect(argReason(spec, "0x1f")).toBe("not a number");
    expect(argReason(spec, "0b101")).toBe("not a number");
    expect(argReason(spec, " 12 ")).toBe("not a number");
    expect(argReason(spec, "1e3")).toBeUndefined();
  });

  it("splits tokens on ASCII whitespace only, as the reference does", () => {
    const m = parseBotManifest(JSON.stringify(concordiaManifest))!;
    const e = entriesOf(m);
    // A non-breaking space (mobile keyboards and pasted text produce these) is
    // NOT a separator: the whole run is one token, exactly as a bot reads it.
    const parsed = parseInvocation("/calc 1\u00A0add 2", e)!;
    expect(parsed.args).toEqual(["1\u00A0add", "2"]);
    expect(validateInvocation(parsed.command, parsed.args)).toBe("a: not a number");
  });

  it("treats a quoted empty string as a value supplied, not a value missing", () => {
    const m = parseBotManifest(JSON.stringify(concordiaManifest))!;
    // `/announce <title:string> <body:string>` — a bot accepts an empty title,
    // so refusing it here would reject an invocation the spec calls legal.
    const parsed = parseInvocation('/announce "" body', entriesOf(m))!;
    expect(parsed.args).toEqual(["", "body"]);
    expect(validateInvocation(parsed.command, parsed.args)).toBeUndefined();
  });

  it("flags an unpicked command two bots both answer to, rather than choosing one", () => {
    const m = parseBotManifest(SPEC_MANIFEST)!;
    const entries = [...entriesOf(m, BOT_A), ...entriesOf(m, BOT_B)];
    // Typed, not picked: tagging either bot would order the other to stay silent.
    expect(parseInvocation("/price btc", entries)?.ambiguous).toBe(true);
    // Picked from one bot's section: unambiguous, and it routes there.
    expect(parseInvocation("/price btc", entries, BOT_B)?.ambiguous).toBe(false);
    // Only one bot declares it: never ambiguous.
    expect(parseInvocation("/price btc", entriesOf(m, BOT_A))?.ambiguous).toBe(false);
  });
});

describe("normalizeUser", () => {
  it("strips the nostr: URI scheme down to the bare npub a bot expects", () => {
    expect(normalizeUser(`nostr:${NPUB}`)).toBe(NPUB);
    expect(normalizeUser(NPUB)).toBe(NPUB);
    expect(normalizeUser("nostr:npub1garbage")).toBeUndefined();
  });
});

describe("validateInvocation", () => {
  const price = () => parseBotManifest(SPEC_MANIFEST)!.commands[0];
  const say = () => parseBotManifest(SPEC_MANIFEST)!.commands[1];

  it("reports a missing required argument", () => {
    expect(validateInvocation(price(), [])).toBe("asset: required");
  });

  it("reports the spec's worked example byte for byte", () => {
    // The spec states `/price doge` yields exactly this.
    expect(validateInvocation(price(), ["doge"])).toBe("asset: not one of btc, xmr, pivx");
  });

  it("passes a well-typed invocation", () => {
    expect(validateInvocation(price(), ["btc"])).toBeUndefined();
    expect(validateInvocation(say(), ["3", "hello there"])).toBeUndefined();
    // The optional tail may simply be absent.
    expect(validateInvocation(say(), ["3"])).toBeUndefined();
  });

  it("reports the first bad argument by name", () => {
    expect(validateInvocation(say(), ["notanint"])).toBe("count: not an integer");
  });
});

describe("usageLine", () => {
  it("renders required and optional arguments distinctly", () => {
    const m = parseBotManifest(SPEC_MANIFEST)!;
    // The exact second line of the error a conforming bot replies with.
    expect(usageLine(m.commands[0])).toBe("/price <asset:choice>");
    expect(usageLine(m.commands[1])).toBe("/say <count:int> [text:text]");
  });

  it("renders a command with no arguments", () => {
    const m = parseBotManifest(JSON.stringify({ v: 1, commands: [{ name: "ping" }] }))!;
    expect(usageLine(m.commands[0])).toBe("/ping");
  });
});

/**
 * A real manifest, published by a real bot (Concordia) built on a different
 * stack — the Rust reference implementation. These assertions are the point
 * where the two implementations either agree on the wire format or don't, so
 * they are worth more than any hand-written fixture.
 */
describe("interoperability with the reference implementation", () => {
  const manifest = () => parseBotManifest(JSON.stringify(concordiaManifest));
  const entries = () => entriesOf(manifest()!);
  const commandNamed = (name: string) => manifest()!.commands.find((c) => c.name === name)!;

  it("accepts a manifest produced by the other implementation", () => {
    const m = manifest();
    expect(m).toBeDefined();
    expect(m!.commands).toHaveLength(20);
  });

  it("covers every argument type the spec defines", () => {
    const used = new Set(manifest()!.commands.flatMap((c) => c.args.map((a) => a.type)));
    expect([...used].sort()).toEqual(["bool", "choice", "int", "number", "string", "user"]);
  });

  it("reads a command that uses all six types at once", () => {
    // `/typetest <text> <count> <ratio> <loud> <who> <color>`
    const npub = NPUB;
    const text = buildInvocationText("typetest", ["hello world", "3", "1.5", "yes", npub, "green"]);
    expect(text).toBe(`/typetest "hello world" 3 1.5 yes ${npub} green`);

    const parsed = parseInvocation(text, entries())!;
    expect(parsed.command.name).toBe("typetest");
    expect(parsed.args).toEqual(["hello world", "3", "1.5", "yes", npub, "green"]);
    expect(validateInvocation(parsed.command, parsed.args)).toBeUndefined();
  });

  it("carries multi-byte choice values, which are capped in bytes not characters", () => {
    // `/react` offers emoji choices; ❤️ alone is six bytes.
    const parsed = parseInvocation("/react 🔥", entries())!;
    expect(validateInvocation(parsed.command, parsed.args)).toBeUndefined();
    expect(validateInvocation(commandNamed("react"), ["🙃"])).toBe("emoji: not one of 🔥, 👍, ❤️, 😂, 🫡");
  });

  it("quotes a two-part announcement so both halves survive the round trip", () => {
    const text = buildInvocationText("announce", ["Big news", "Meeting at 5pm"]);
    expect(text).toBe('/announce "Big news" "Meeting at 5pm"');
    expect(parseInvocation(text, entries())?.args).toEqual(["Big news", "Meeting at 5pm"]);
  });

  it("lets an optional trailing argument simply be absent", () => {
    // `/roll [sides:int]` — no argument at all is a complete invocation.
    const parsed = parseInvocation("/roll", entries())!;
    expect(parsed.args).toEqual([]);
    expect(validateInvocation(parsed.command, parsed.args)).toBeUndefined();
    expect(validateInvocation(commandNamed("roll"), ["20"])).toBeUndefined();
    expect(validateInvocation(commandNamed("roll"), ["d20"])).toBe("sides: not an integer");
  });

  it("renders the usage lines a conforming bot would echo back on error", () => {
    expect(usageLine(commandNamed("ping"))).toBe("/ping");
    expect(usageLine(commandNamed("roll"))).toBe("/roll [sides:int]");
    expect(usageLine(commandNamed("calc"))).toBe("/calc <a:number> <op:choice> <b:number>");
    expect(usageLine(commandNamed("greet"))).toBe("/greet <who:npub> <style:choice> [times:int]");
  });
});

describe("commandLine (how an invocation renders in the timeline)", () => {
  const tagged = [botTag(BOT_A)];

  it("reads an addressed invocation as an action, with its arguments as written", () => {
    const line = commandLine(`/greet nostr:${NPUB} pirate 1`, tagged);
    expect(line).toEqual({ name: "greet", bot: BOT_A, args: `nostr:${NPUB} pirate 1` });
  });

  it("reads a bare command as an action even when it names no bot", () => {
    expect(commandLine("/ping", [])).toEqual({ name: "ping", bot: undefined, args: "" });
  });

  it("NEVER hides text a person actually wrote", () => {
    // The whole safety of this rule: an untagged `/word` with prose after it is
    // a sentence, not a command, and collapsing it would swallow what was said.
    expect(commandLine("/shrug I give up on this", [])).toBeUndefined();
    expect(commandLine("/me waves at everyone", [])).toBeUndefined();
    expect(commandLine("check /roll out", [])).toBeUndefined();
    expect(commandLine("no slash at all", [])).toBeUndefined();
  });

  it("reads arguments as part of the action once a bot is named, since they were meant for it", () => {
    expect(commandLine("/roll 20", tagged)).toEqual({ name: "roll", bot: BOT_A, args: "20" });
  });

  it("folds the command word, so a valid invocation cannot render as prose", () => {
    // The parser accepts `/PING`, so the renderer must recognise it too.
    expect(commandLine("/PING", [])).toEqual({ name: "ping", bot: undefined, args: "" });
    expect(commandLine("/Roll 20", tagged)).toEqual({ name: "roll", bot: BOT_A, args: "20" });
  });

  // A 1:1 DM sends invocations untagged, so the timeline recognises them by the
  // bot's declared command set instead of a tag.
  const known = new Set(["announce", "roll"]);

  it("promotes an untagged invocation with arguments when the bot declares it", () => {
    expect(commandLine("/announce meow meowers", [], known)).toEqual({ name: "announce", bot: undefined, args: "meow meowers" });
  });

  it("folds the command word against the known set too", () => {
    expect(commandLine("/Announce hello", [], known)).toEqual({ name: "announce", bot: undefined, args: "hello" });
  });

  it("still hides nothing: an undeclared /word with prose stays text", () => {
    expect(commandLine("/shrug I give up", [], known)).toBeUndefined();
  });
});

describe("the bot routing tag", () => {
  it("carries the hex pubkey", () => {
    expect(botTag(BOT_A)).toEqual(["bot", BOT_A]);
  });

  it("reads the addressed bots back, deduped", () => {
    const tags = [["h", "group"], botTag(BOT_A), botTag(BOT_B), botTag(BOT_A)];
    expect(addressedBots(tags)).toEqual([BOT_A, BOT_B]);
  });

  it("treats an untagged message as a broadcast", () => {
    expect(addressedBots([["h", "group"]])).toEqual([]);
  });

  it("caps how many bots one message may address", () => {
    const tags = Array.from({ length: 12 }, (_, i) => botTag(String(i).repeat(64)));
    expect(addressedBots(tags)).toHaveLength(8);
  });
});

describe("invocationTags (room vs 1:1 DM routing)", () => {
  it("tags a room invocation with the chosen bot", () => {
    expect(invocationTags(BOT_A)).toEqual([["bot", BOT_A]]);
  });

  it("sends a DM invocation untagged — the recipient IS the bot", () => {
    expect(invocationTags(BOT_A, { dm: true })).toEqual([]);
  });

  it("round-trips: a room invocation reads back as addressed, a DM as broadcast", () => {
    expect(addressedBots(invocationTags(BOT_A))).toEqual([BOT_A]);
    expect(addressedBots(invocationTags(BOT_A, { dm: true }))).toEqual([]);
  });
});
