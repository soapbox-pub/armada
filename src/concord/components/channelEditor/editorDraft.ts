import { nip19 } from "nostr-tools";

import { OVERWRITABLE, Permissions, type OverwriteTarget } from "@/concord/lib/roles";
import type { ChannelView } from "@/concord/lib/types";

export type RuleState = "allow" | "inherit" | "deny";

/** One target's overwrite in the scope being edited (CORD-04 §8). */
export interface Rule {
  allow: bigint;
  deny: bigint;
}

export const NO_RULE: Rule = { allow: 0n, deny: 0n };
export const EVERYONE = "everyone";

export const targetKey = (t: OverwriteTarget) => (t.kind === "everyone" ? EVERYONE : `${t.kind}:${t.id.toLowerCase()}`);
export const targetOf = (key: string): OverwriteTarget => {
  if (key === EVERYONE) return { kind: "everyone" };
  const [kind, id] = key.split(":");
  return kind === "role" ? { kind: "role", id } : { kind: "member", id };
};

/** A member typed as an npub, nprofile or hex key; undefined if it names nobody. */
export function memberFrom(raw: string): string | undefined {
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  try {
    const d = nip19.decode(v.replace(/^nostr:/, ""));
    if (d.type === "npub") return d.data;
    if (d.type === "nprofile") return d.data.pubkey;
  } catch {
    // not bech32
  }
  return undefined;
}

/** The overwritable bits as the editor lists them; a bit outside {@link OVERWRITABLE} is never shown. */
export const RULE_GROUPS: ReadonlyArray<{ id: "messages" | "voice" | "moderation"; bits: readonly bigint[] }> = [
  {
    id: "messages",
    bits: [
      Permissions.VIEW_CHANNEL,
      Permissions.SEND_MESSAGES,
      Permissions.SEND_IN_THREADS,
      Permissions.ATTACH_FILES,
      Permissions.ADD_REACTIONS,
      Permissions.READ_MESSAGE_HISTORY,
    ],
  },
  { id: "voice", bits: [Permissions.CONNECT, Permissions.SPEAK, Permissions.VIDEO, Permissions.PRIORITY_SPEAKER] },
  {
    id: "moderation",
    bits: [
      Permissions.MANAGE_MESSAGES,
      Permissions.MUTE_MEMBERS,
      Permissions.DEAFEN_MEMBERS,
      Permissions.MOVE_MEMBERS,
      Permissions.MODERATE_MEMBERS,
    ],
  },
].map((g) => ({ ...g, bits: g.bits.filter((b) => (b & OVERWRITABLE) === b) })) as ReadonlyArray<{
  id: "messages" | "voice" | "moderation";
  bits: readonly bigint[];
}>;

export const ruleState = (rule: Rule, bit: bigint): RuleState =>
  (rule.allow & bit) !== 0n ? "allow" : (rule.deny & bit) !== 0n ? "deny" : "inherit";

export const withRuleState = (rule: Rule, bit: bigint, state: RuleState): Rule => ({
  allow: state === "allow" ? rule.allow | bit : rule.allow & ~bit,
  deny: state === "deny" ? rule.deny | bit : rule.deny & ~bit,
});

const isEmpty = (rule: Rule | undefined) => !rule || (rule.allow === 0n && rule.deny === 0n);
const sameRule = (a: Rule | undefined, b: Rule | undefined) => (a?.allow ?? 0n) === (b?.allow ?? 0n) && (a?.deny ?? 0n) === (b?.deny ?? 0n);

function popcount(v: bigint): number {
  let n = 0;
  for (let x = v; x > 0n; x >>= 1n) if ((x & 1n) === 1n) n += 1;
  return n;
}

/** What a target row says of its rule: whether it can view, and how many other bits it sets. */
export function summarize(rule: Rule): { view: RuleState; others: number } {
  return { view: ruleState(rule, Permissions.VIEW_CHANNEL), others: popcount((rule.allow | rule.deny) & ~Permissions.VIEW_CHANNEL) };
}

/** A scope as the control fold has it. */
export interface EditorBase {
  kind: "channel" | "category";
  name: string;
  topic: string;
  view: ChannelView;
  /** The Category filed under: its id on the vsk-13 Roster, its name otherwise. */
  category: string | undefined;
  /** The Category whose overwrites the Channel follows instead of its own. */
  syncedTo: string | undefined;
  isPrivate: boolean;
  rules: Readonly<Record<string, Rule>>;
}

/** The editor's unsaved changes: each field an override of the fold, absent while untouched. */
export interface EditorDraft {
  name?: string;
  topic?: string;
  view?: ChannelView;
  /** `null` files the Channel under no Category. */
  category?: string | null;
  synced?: boolean;
  isPrivate?: boolean;
  rules: Readonly<Record<string, Rule>>;
  /** Targets listed with no rule yet. */
  added: readonly string[];
}

export const EMPTY_DRAFT: EditorDraft = { rules: {}, added: [] };

export interface EditorValues {
  name: string;
  topic: string;
  view: ChannelView;
  category: string | undefined;
  synced: boolean;
  isPrivate: boolean;
}

export function editorValues(base: EditorBase, draft: EditorDraft): EditorValues {
  const category = draft.category === undefined ? base.category : (draft.category ?? undefined);
  return {
    name: draft.name ?? base.name,
    topic: draft.topic ?? base.topic,
    view: draft.view ?? base.view,
    category,
    // A Channel follows the Category it is filed under, so one outside any follows none.
    synced: category !== undefined && (draft.synced ?? base.syncedTo !== undefined),
    isPrivate: draft.isPrivate ?? base.isPrivate,
  };
}

export const ruleOf = (base: EditorBase, draft: EditorDraft, key: string): Rule => draft.rules[key] ?? base.rules[key] ?? NO_RULE;

/** The targets listed: `@everyone`, then whoever a rule names or was just added, in a stable order. */
export function targetKeys(base: EditorBase, draft: EditorDraft): string[] {
  const keys = new Set<string>([EVERYONE]);
  for (const key of Object.keys(base.rules)) if (!isEmpty(ruleOf(base, draft, key))) keys.add(key);
  for (const key of draft.added) keys.add(key);
  for (const key of Object.keys(draft.rules)) if (!isEmpty(draft.rules[key])) keys.add(key);
  return [...keys];
}

export type EditorStep =
  | { kind: "rename"; name: string }
  | { kind: "topic"; topic: string }
  | { kind: "view"; view: ChannelView }
  | { kind: "category"; category: string | undefined }
  | { kind: "public" }
  | { kind: "rules"; sync?: { category: string | undefined }; overwrites: Array<{ target: OverwriteTarget; allow: bigint; deny: bigint }> }
  | { kind: "private" };

/** Names a step by what it writes, so a retry skips the ones that landed. */
export const stepKey = (step: EditorStep): string =>
  JSON.stringify(step, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/**
 * What saving the draft writes, in the order it is written. Rules land while the
 * Channel is still public, so the key minted on going private reaches everyone they
 * let in; a Channel going public flips first, so its rules rotate no key.
 */
export function pendingSteps(base: EditorBase, draft: EditorDraft): EditorStep[] {
  const now = editorValues(base, draft);
  const steps: EditorStep[] = [];
  const name = now.name.trim();
  if (name && name !== base.name) steps.push({ kind: "rename", name });
  if (base.kind === "channel") {
    if (now.topic.trim() !== base.topic) steps.push({ kind: "topic", topic: now.topic.trim() });
    if (now.view !== base.view) steps.push({ kind: "view", view: now.view });
    if (now.category !== base.category) steps.push({ kind: "category", category: now.category });
    if (base.isPrivate && !now.isPrivate) steps.push({ kind: "public" });
  }
  const syncTo = now.synced ? now.category : undefined;
  const sync = base.kind === "channel" && syncTo !== base.syncedTo ? { category: syncTo } : undefined;
  // A synced Channel's own rules are out of use, and out of sight: leave them as they are.
  const overwrites = now.synced
    ? []
    : Object.keys(draft.rules)
        .filter((key) => !sameRule(draft.rules[key], base.rules[key]))
        .map((key) => ({ target: targetOf(key), ...draft.rules[key] }));
  if (sync || overwrites.length > 0) steps.push({ kind: "rules", ...(sync ? { sync } : {}), overwrites });
  if (base.kind === "channel" && !base.isPrivate && now.isPrivate) steps.push({ kind: "private" });
  return steps;
}
