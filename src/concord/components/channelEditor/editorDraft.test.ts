import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT,
  EVERYONE,
  NO_RULE,
  RULE_GROUPS,
  editorValues,
  memberFrom,
  pendingSteps,
  ruleOf,
  ruleState,
  stepKey,
  summarize,
  targetKey,
  targetKeys,
  targetOf,
  withRuleState,
  type EditorBase,
  type EditorDraft,
  type EditorStep,
} from "@/concord/components/channelEditor/editorDraft";
import { OVERWRITABLE, Permissions } from "@/concord/lib/roles";

const ROLE = "a".repeat(64);
const MEMBER = "e".repeat(64);
const CATEGORY = "b".repeat(64);
const OTHER = "d".repeat(64);
const ROLE_KEY = `role:${ROLE}`;
const MEMBER_KEY = `member:${MEMBER}`;

const base = (over: Partial<EditorBase> = {}): EditorBase => ({
  kind: "channel",
  name: "general",
  topic: "",
  view: "chat",
  category: undefined,
  syncedTo: undefined,
  isPrivate: false,
  rules: {},
  ...over,
});
const draft = (over: Partial<EditorDraft> = {}): EditorDraft => ({ ...EMPTY_DRAFT, ...over });
const kinds = (b: EditorBase, d: EditorDraft) => pendingSteps(b, d).map((s) => s.kind);

describe("targets", () => {
  it("round-trips a target through its key", () => {
    expect(targetKey({ kind: "everyone" })).toBe(EVERYONE);
    expect(targetOf(EVERYONE)).toEqual({ kind: "everyone" });
    expect(targetOf(targetKey({ kind: "role", id: ROLE }))).toEqual({ kind: "role", id: ROLE });
    expect(targetOf(targetKey({ kind: "member", id: MEMBER }))).toEqual({ kind: "member", id: MEMBER });
  });

  it("keys an id whatever its case", () => {
    expect(targetKey({ kind: "member", id: MEMBER.toUpperCase() })).toBe(MEMBER_KEY);
  });

  it("reads a member typed as hex, npub or nprofile", () => {
    expect(memberFrom(` ${MEMBER.toUpperCase()} `)).toBe(MEMBER);
    expect(memberFrom(nip19.npubEncode(MEMBER))).toBe(MEMBER);
    expect(memberFrom(`nostr:${nip19.nprofileEncode({ pubkey: MEMBER })}`)).toBe(MEMBER);
  });

  it("names nobody from anything else", () => {
    expect(memberFrom("")).toBeUndefined();
    expect(memberFrom("alice")).toBeUndefined();
    expect(memberFrom(nip19.noteEncode(MEMBER))).toBeUndefined();
    expect(memberFrom(MEMBER.slice(1))).toBeUndefined();
  });

  it("lists @everyone first, then whoever a rule names or was added", () => {
    const b = base({ rules: { [ROLE_KEY]: { allow: Permissions.SEND_MESSAGES, deny: 0n } } });
    expect(targetKeys(b, EMPTY_DRAFT)).toEqual([EVERYONE, ROLE_KEY]);
    expect(targetKeys(b, draft({ added: [MEMBER_KEY] }))).toEqual([EVERYONE, ROLE_KEY, MEMBER_KEY]);
  });

  it("drops a target whose rule was cleared", () => {
    const b = base({ rules: { [ROLE_KEY]: { allow: Permissions.SEND_MESSAGES, deny: 0n } } });
    expect(targetKeys(b, draft({ rules: { [ROLE_KEY]: NO_RULE } }))).toEqual([EVERYONE]);
  });

  it("lists a target given a rule without being added", () => {
    expect(targetKeys(base(), draft({ rules: { [MEMBER_KEY]: { allow: 0n, deny: Permissions.SPEAK } } }))).toEqual([EVERYONE, MEMBER_KEY]);
  });
});

describe("rules", () => {
  it("shows only overwritable bits, each once", () => {
    const bits = RULE_GROUPS.flatMap((g) => g.bits);
    expect(bits.length).toBeGreaterThan(0);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) expect(bit & OVERWRITABLE).toBe(bit);
  });

  it("reads a bit as allowed, denied or inherited", () => {
    const rule = { allow: Permissions.SEND_MESSAGES, deny: Permissions.SPEAK };
    expect(ruleState(rule, Permissions.SEND_MESSAGES)).toBe("allow");
    expect(ruleState(rule, Permissions.SPEAK)).toBe("deny");
    expect(ruleState(rule, Permissions.VIEW_CHANNEL)).toBe("inherit");
  });

  it("moves a bit between allow and deny, never leaving it in both", () => {
    const allowed = withRuleState(NO_RULE, Permissions.SPEAK, "allow");
    expect(allowed).toEqual({ allow: Permissions.SPEAK, deny: 0n });
    const denied = withRuleState(allowed, Permissions.SPEAK, "deny");
    expect(denied).toEqual({ allow: 0n, deny: Permissions.SPEAK });
    expect(withRuleState(denied, Permissions.SPEAK, "inherit")).toEqual(NO_RULE);
  });

  it("leaves a rule's other bits alone", () => {
    const rule = { allow: Permissions.SEND_MESSAGES, deny: Permissions.CONNECT };
    expect(withRuleState(rule, Permissions.SPEAK, "deny")).toEqual({ allow: Permissions.SEND_MESSAGES, deny: Permissions.CONNECT | Permissions.SPEAK });
  });

  it("summarizes a rule as its view and a count of the rest", () => {
    expect(summarize(NO_RULE)).toEqual({ view: "inherit", others: 0 });
    expect(summarize({ allow: Permissions.VIEW_CHANNEL, deny: 0n })).toEqual({ view: "allow", others: 0 });
    expect(summarize({ allow: Permissions.SEND_MESSAGES, deny: Permissions.VIEW_CHANNEL | Permissions.SPEAK })).toEqual({ view: "deny", others: 2 });
  });

  it("reads a rule from the draft before the fold", () => {
    const b = base({ rules: { [ROLE_KEY]: { allow: Permissions.SPEAK, deny: 0n } } });
    expect(ruleOf(b, EMPTY_DRAFT, ROLE_KEY)).toEqual({ allow: Permissions.SPEAK, deny: 0n });
    expect(ruleOf(b, draft({ rules: { [ROLE_KEY]: NO_RULE } }), ROLE_KEY)).toEqual(NO_RULE);
    expect(ruleOf(b, EMPTY_DRAFT, MEMBER_KEY)).toEqual(NO_RULE);
  });
});

describe("editorValues", () => {
  it("is the fold while nothing was touched", () => {
    const b = base({ name: "voice", topic: "hi", view: "voice", category: CATEGORY, syncedTo: CATEGORY, isPrivate: true });
    expect(editorValues(b, EMPTY_DRAFT)).toEqual({ name: "voice", topic: "hi", view: "voice", category: CATEGORY, synced: true, isPrivate: true });
  });

  it("lays the draft over it", () => {
    const now = editorValues(base({ category: CATEGORY }), draft({ name: "lobby", topic: "", category: OTHER, synced: true, isPrivate: true }));
    expect(now).toMatchObject({ name: "lobby", topic: "", category: OTHER, synced: true, isPrivate: true });
  });

  it("follows no category once filed under none", () => {
    const b = base({ category: CATEGORY, syncedTo: CATEGORY });
    expect(editorValues(b, draft({ category: null }))).toMatchObject({ category: undefined, synced: false });
    expect(editorValues(base(), draft({ synced: true })).synced).toBe(false);
  });
});

describe("pendingSteps", () => {
  it("writes nothing for an untouched draft", () => {
    expect(pendingSteps(base(), EMPTY_DRAFT)).toEqual([]);
    expect(pendingSteps(base(), draft({ added: [MEMBER_KEY] }))).toEqual([]);
  });

  it("writes nothing for a value put back", () => {
    const b = base({ topic: "hi", category: CATEGORY });
    expect(pendingSteps(b, draft({ name: " general ", topic: "hi ", view: "chat", category: CATEGORY, isPrivate: false }))).toEqual([]);
  });

  it("keeps the name when it is cleared", () => {
    expect(pendingSteps(base(), draft({ name: "   " }))).toEqual([]);
  });

  it("trims what it writes", () => {
    expect(pendingSteps(base(), draft({ name: " lobby ", topic: " hello " }))).toEqual([
      { kind: "rename", name: "lobby" },
      { kind: "topic", topic: "hello" },
    ]);
  });

  it("orders the steps so rules land before the channel goes private", () => {
    const d = draft({
      name: "lobby",
      topic: "hello",
      view: "voice",
      category: CATEGORY,
      isPrivate: true,
      rules: { [ROLE_KEY]: { allow: Permissions.VIEW_CHANNEL, deny: 0n } },
    });
    expect(kinds(base(), d)).toEqual(["rename", "topic", "view", "category", "rules", "private"]);
  });

  it("makes a channel public before its rules are written", () => {
    const d = draft({ isPrivate: false, rules: { [EVERYONE]: { allow: 0n, deny: Permissions.SEND_MESSAGES } } });
    expect(kinds(base({ isPrivate: true }), d)).toEqual(["public", "rules"]);
  });

  it("writes only the rules that changed", () => {
    const kept = { allow: Permissions.SPEAK, deny: 0n };
    const b = base({ rules: { [ROLE_KEY]: kept } });
    const d = draft({ rules: { [ROLE_KEY]: kept, [MEMBER_KEY]: { allow: 0n, deny: Permissions.SPEAK } } });
    expect(pendingSteps(b, d)).toEqual([{ kind: "rules", overwrites: [{ target: { kind: "member", id: MEMBER }, allow: 0n, deny: Permissions.SPEAK }] }]);
  });

  it("clears a removed target's rule", () => {
    const b = base({ rules: { [ROLE_KEY]: { allow: Permissions.SPEAK, deny: 0n } } });
    expect(pendingSteps(b, draft({ rules: { [ROLE_KEY]: NO_RULE } }))).toEqual([
      { kind: "rules", overwrites: [{ target: { kind: "role", id: ROLE }, allow: 0n, deny: 0n }] },
    ]);
  });

  it("syncs a channel to its category and leaves its own rules as they are", () => {
    const b = base({ category: CATEGORY });
    const d = draft({ synced: true, rules: { [EVERYONE]: { allow: 0n, deny: Permissions.SPEAK } } });
    expect(pendingSteps(b, d)).toEqual([{ kind: "rules", sync: { category: CATEGORY }, overwrites: [] }]);
  });

  it("unsyncs and writes the rules in one step", () => {
    const b = base({ category: CATEGORY, syncedTo: CATEGORY });
    const d = draft({ synced: false, rules: { [EVERYONE]: { allow: 0n, deny: Permissions.SPEAK } } });
    expect(pendingSteps(b, d)).toEqual([
      { kind: "rules", sync: { category: undefined }, overwrites: [{ target: { kind: "everyone" }, allow: 0n, deny: Permissions.SPEAK }] },
    ]);
  });

  it("follows the new category when a synced channel is moved", () => {
    const b = base({ category: CATEGORY, syncedTo: CATEGORY });
    expect(pendingSteps(b, draft({ category: OTHER }))).toEqual([
      { kind: "category", category: OTHER },
      { kind: "rules", sync: { category: OTHER }, overwrites: [] },
    ]);
  });

  it("stops following when a synced channel leaves every category", () => {
    const b = base({ category: CATEGORY, syncedTo: CATEGORY });
    expect(pendingSteps(b, draft({ category: null }))).toEqual([
      { kind: "category", category: undefined },
      { kind: "rules", sync: { category: undefined }, overwrites: [] },
    ]);
  });

  it("writes a category's name and rules, and nothing a channel has", () => {
    const b = base({ kind: "category", name: "Text" });
    const d = draft({ name: "Chat", topic: "x", view: "voice", isPrivate: true, rules: { [ROLE_KEY]: { allow: 0n, deny: Permissions.SPEAK } } });
    expect(kinds(b, d)).toEqual(["rename", "rules"]);
  });
});

describe("stepKey", () => {
  const rules = (allow: bigint): EditorStep => ({ kind: "rules", overwrites: [{ target: { kind: "everyone" }, allow, deny: 0n }] });

  it("names a step by what it writes", () => {
    expect(stepKey(rules(1n << 40n))).toBe(stepKey(rules(1n << 40n)));
    expect(stepKey(rules(1n << 40n))).not.toBe(stepKey(rules(1n << 41n)));
    expect(stepKey({ kind: "rename", name: "a" })).not.toBe(stepKey({ kind: "rename", name: "b" }));
    expect(stepKey({ kind: "private" })).not.toBe(stepKey({ kind: "public" }));
  });
});
