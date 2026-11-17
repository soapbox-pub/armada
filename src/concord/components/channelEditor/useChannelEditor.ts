import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EMPTY_DRAFT,
  EVERYONE,
  NO_RULE,
  editorValues,
  pendingSteps,
  ruleOf,
  stepKey,
  summarize,
  targetKey,
  targetKeys,
  targetOf,
  withRuleState,
  type EditorBase,
  type EditorDraft,
  type EditorStep,
  type EditorValues,
  type Rule,
  type RuleState,
} from "@/concord/components/channelEditor/editorDraft";
import type { ApplyPhase, ApplySink } from "@/concord/components/accessReview/useApplyRun";
import { useCommunityManagement } from "@/concord/hooks/useCommunityActions";
import { useChannels } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { useRankedRoles } from "@/concord/hooks/useRankedRoles";
import { keyWork, reviewAccess, reviewMoves, withRules, type AccessReview } from "@/concord/lib/accessReview";
import { categoryKey, categoryNames } from "@/concord/lib/channelCategory";
import { bytesToHex } from "@/concord/lib/derive";
import { categoryOrder, maySync, overwriteReach, rankedOrder, scopeUnkeyed, type OverwriteReach } from "@/concord/lib/rankedWrites";
import { colorToHex, isAuthorized, Permissions } from "@/concord/lib/roles";
import { CHANNEL_TOPIC_MAX_BYTES } from "@/concord/lib/channelSeal";
import { NAME_MAX_BYTES, utf8Len, type ChannelView, type Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";

/** What the editor opens on. */
export interface EditorScope {
  /** A Channel's id; a Category's id on the vsk-13 Roster, its `categoryKey` otherwise. */
  idHex: string;
  kind: "channel" | "category";
  name: string;
  tab?: EditorTab;
}

export type EditorTab = "general" | "permissions";

/** The page's handlers for what the editor can't do from the control plane alone. */
export interface EditorOps {
  /** Channel-scoped access Roles of a legacy Roster, by Channel. */
  channelRoles?: ReadonlyMap<string, ReadonlyArray<{ id: string; name: string }>>;
  onRotateChannelKey?: (channelIdHex: string) => Promise<void>;
  onMintAccessRole?: (channelIdHex: string, name: string) => Promise<void>;
}

export interface EditorTarget {
  key: string;
  kind: "everyone" | "role" | "member";
  /** A Role's name; a member is named by the row that shows them. */
  name?: string;
  /** A member's pubkey. */
  pubkey?: string;
  color?: string;
  rule: Rule;
  /** `@everyone` never views a Private Channel, whatever its rule says. */
  view: RuleState;
  others: number;
  /** The bits the viewer may set or clear here; none with a `refusal` saying why. */
  reach: bigint;
  refusal?: OverwriteReach["refusal"];
}

/** What saving does to who can read the scope, and the steps it takes. */
export interface EditorReview {
  access: AccessReview;
  /** The Channel changes sides. */
  privacy?: "private" | "public";
  plan: ApplyPhase[];
}

export interface EditorModel {
  scope: EditorScope;
  me: string | undefined;
  /** The scope isn't in the fold: deleted, or not read yet. */
  missing: boolean;
  ranked: boolean;
  canManageChannels: boolean;
  canManageRoles: boolean;
  /** The sync switch is the viewer's to flip: every rule it swaps is one they could write. */
  canSync: boolean;
  /** A private Channel in the scope has no key on this device, so who reads it can't be changed from here. */
  unkeyed: boolean;
  /** A community keeps at least one Channel. */
  canDelete: boolean;
  base: EditorBase;
  values: EditorValues;
  /** Channels in the Category being edited. */
  channelCount: number;
  categories: ReadonlyArray<{ key: string; name: string }>;
  categoryName: string | undefined;
  setName: (name: string) => void;
  setTopic: (topic: string) => void;
  setView: (view: ChannelView) => void;
  setCategory: (key: string | undefined) => void;
  setSynced: (synced: boolean) => void;
  setPrivate: (isPrivate: boolean) => void;
  targets: EditorTarget[];
  setRule: (key: string, bit: bigint, state: RuleState) => void;
  removeTarget: (key: string) => void;
  addTargets: (keys: readonly string[]) => void;
  /** Whether the viewer may write a rule for a target not listed yet. */
  mayTarget: (key: string) => boolean;
  candidates: {
    roles: Array<{ key: string; name: string; color?: string; holders: number }>;
    members: string[];
  };
  ownerHex: string | undefined;
  /** Channels of the Category on rules of their own. */
  unsyncedCount: number;
  canSyncAll: boolean;
  syncAll: () => Promise<void>;
  /** The Channel's access Roles on a legacy Roster. */
  accessRoles: ReadonlyArray<{ id: string; name: string }>;
  /** Resolves true once the Role exists. */
  mintAccessRole?: (name: string) => Promise<boolean>;
  rotateKey?: () => Promise<void>;
  steps: EditorStep[];
  /** Set when saving moves someone's access or the Channel's privacy: shown and confirmed before it is written. */
  review: EditorReview | undefined;
  /** A Role's name, for saying what someone's access rests on. */
  roleName: (roleId: string) => string | undefined;
  /** A Channel of the scope, for naming it in the review. */
  channelInfo: (channelIdHex: string) => { name: string; isPrivate: boolean; view?: ChannelView };
  /** Rotates one Channel's key again after a save left it unrotated. */
  retryRotation?: (channelIdHex: string) => Promise<void>;
  dirty: boolean;
  /** A field is past its limit, so nothing can be saved yet. */
  invalid: boolean;
  saving: boolean;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** Resolves true once everything pending has been written. With a sink the steps and failures go to it, and a failure throws. */
  save: (sink?: ApplySink) => Promise<boolean>;
  reset: () => void;
  /** Resolves true once the Channel or Category is gone. */
  remove: () => Promise<boolean>;
  published: number;
  planned: number;
}

export const saveFailed = () => t({ id: "channelEditor.saveFailed", defaultMessage: "Couldn't save the changes." });

export const toastSaved = () => toast({ title: t({ id: "channelEditor.saved", defaultMessage: "Changes saved" }) });

/**
 * One Channel or Category as the editor shows it: the control fold with a draft
 * laid over it, and a Save that writes the difference step by step.
 */
export function useChannelEditor(community: Community, scope: EditorScope, ops: EditorOps = {}): EditorModel {
  const { user } = useCurrentUser();
  const ranked$ = useRankedRoles(community);
  const manage = useCommunityManagement(community);
  const { folded } = ranked$;
  const channels = useChannels(community, true);
  const { coalesced } = useGuestbook(community);
  const ranked = folded?.rankedRoster === true;
  const roster = folded?.roster;
  const scopeHex = scope.idHex.toLowerCase();
  const me = user?.pubkey;

  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channel = scope.kind === "channel" ? channels.find((c) => c.idHex === scopeHex) : undefined;
  const members = useMemo(
    () =>
      scope.kind === "category"
        ? channels.filter((c) => (ranked ? c.categoryId === scopeHex : c.category !== undefined && categoryKey(c.category) === scopeHex))
        : [],
    [scope.kind, channels, ranked, scopeHex],
  );
  const rankedCategory = scope.kind === "category" && ranked ? folded?.categories?.get(scopeHex) : undefined;
  const missing = scope.kind === "channel" ? !channel : ranked ? !rankedCategory || Boolean(rankedCategory.deleted) : members.length === 0;

  const rules = useMemo(() => {
    const out: Record<string, Rule> = {};
    for (const o of roster?.overwrites ?? []) if (o.scope === scopeHex) out[targetKey(o.target)] = { allow: o.allow, deny: o.deny };
    return out;
  }, [roster, scopeHex]);

  const base = useMemo<EditorBase>(
    () => ({
      kind: scope.kind,
      name: channel?.name ?? rankedCategory?.name ?? members[0]?.category?.trim() ?? scope.name,
      topic: channel?.topic ?? "",
      view: channel?.view ?? "chat",
      category: ranked ? channel?.categoryId : channel?.category?.trim() || undefined,
      syncedTo: ranked && scope.kind === "channel" ? roster?.syncs?.[scopeHex] : undefined,
      isPrivate: channel?.isPrivate ?? false,
      rules,
    }),
    [scope.kind, scope.name, channel, rankedCategory, members, ranked, roster, scopeHex, rules],
  );
  const values = useMemo(() => editorValues(base, draft), [base, draft]);

  const categories = useMemo(
    () =>
      ranked && folded
        ? categoryOrder(folded).map((c) => ({ key: c.idHex, name: c.name }))
        : categoryNames(channels, (c) => c.category).map((name) => ({ key: name, name })),
    [ranked, folded, channels],
  );
  const categoryName = categories.find((c) => c.key === values.category)?.name ?? (ranked ? undefined : values.category);

  const roles = useMemo(() => (ranked && folded ? rankedOrder(folded) : []), [ranked, folded]);
  const ownerHex = folded?.ownerHex;
  const canManageChannels = Boolean(me && roster && isAuthorized(roster, me, ownerHex, Permissions.MANAGE_CHANNELS));
  const canManageRoles = Boolean(ranked && me && roster && isAuthorized(roster, me, ownerHex, Permissions.MANAGE_ROLES));

  // What `applyRules` will refuse, asked up front so the controls say so instead of Save.
  const held = useMemo(() => new Set(community.privateChannels.map((k) => bytesToHex(k.id))), [community.privateChannels]);
  const unkeyed = Boolean(ranked && folded && scopeUnkeyed(folded, held, scopeHex));
  const reachOf = useCallback(
    (key: string): OverwriteReach => (folded && me && !unkeyed ? overwriteReach(folded, me, scopeHex, targetOf(key)) : { bits: 0n, refusal: "rank" }),
    [folded, me, unkeyed, scopeHex],
  );
  const maySyncTo = (category: string | undefined) =>
    Boolean(folded && me && scope.kind === "channel" && !(base.isPrivate && !held.has(scopeHex)) && maySync(folded, me, scopeHex, category));

  const targets = useMemo<EditorTarget[]>(
    () =>
      targetKeys(base, draft).map((key) => {
        const target = targetOf(key);
        const rule = ruleOf(base, draft, key);
        const reach = reachOf(key);
        const { view, others } = summarize(rule);
        const role = target.kind === "role" ? roles.find((r) => r.roleId === target.id) : undefined;
        return {
          key,
          kind: target.kind,
          name: target.kind === "everyone" ? "@everyone" : target.kind === "role" ? (role?.name ?? target.id.slice(0, 8)) : undefined,
          pubkey: target.kind === "member" ? target.id : undefined,
          color: role ? colorToHex(role.color) : undefined,
          rule,
          view: key === EVERYONE && values.isPrivate ? "deny" : view,
          others,
          reach: reach.bits,
          refusal: reach.refusal,
        };
      }),
    [base, draft, roles, values.isPrivate, reachOf],
  );

  const candidates = useMemo(() => {
    const listed = new Set(targetKeys(base, draft));
    const pubkeys = new Set<string>();
    // Everyone a rule could name: the memberlist and every Grantee (Vector `access_candidates`).
    for (const [pk, m] of coalesced ?? []) if (m.state === "join") pubkeys.add(pk);
    for (const g of roster?.grants ?? []) pubkeys.add(g.member);
    if (ownerHex) pubkeys.delete(ownerHex);
    return {
      roles: roles
        .filter((r) => !listed.has(targetKey({ kind: "role", id: r.roleId })))
        .map((r) => ({
          key: targetKey({ kind: "role", id: r.roleId }),
          name: r.name,
          color: colorToHex(r.color),
          holders: (roster?.grants ?? []).filter((g) => g.roleIds.includes(r.roleId)).length,
        })),
      members: [...pubkeys].filter((pk) => !listed.has(targetKey({ kind: "member", id: pk }))),
    };
  }, [base, draft, coalesced, roster, ownerHex, roles]);

  const all = useMemo(() => pendingSteps(base, draft), [base, draft]);
  const steps = useMemo(() => all.filter((s) => !applied.has(stepKey(s))), [all, applied]);
  // The fold agrees with the draft: what was written is no longer a step to skip.
  useEffect(() => {
    if (all.length === 0 && applied.size > 0) setApplied(new Set());
  }, [all.length, applied.size]);

  const patch = useCallback((change: Partial<EditorDraft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...change }));
  }, []);

  const setCategory = (key: string | undefined) => {
    // Filing a public Channel with no rules of its own has it follow the Category (CORD-04 §8).
    const follows =
      ranked && key !== undefined && draft.synced === undefined && !base.syncedTo && !values.isPrivate && Object.keys(rules).length === 0 && maySyncTo(key);
    patch({ category: key ?? null, ...(follows ? { synced: true } : {}) });
  };

  const setRule = (key: string, bit: bigint, state: RuleState) => {
    setError(null);
    setDraft((d) => ({ ...d, rules: { ...d.rules, [key]: withRuleState(ruleOf(base, d, key), bit, state) } }));
  };
  const removeTarget = (key: string) => {
    setError(null);
    setDraft((d) => ({ ...d, added: d.added.filter((k) => k !== key), rules: { ...d.rules, [key]: NO_RULE } }));
  };
  const addTargets = (keys: readonly string[]) => {
    setError(null);
    setDraft((d) => {
      const next = { ...d.rules };
      // On a Private Channel a target is added to be let in.
      for (const key of keys) {
        const rule = ruleOf(base, d, key);
        const letIn = values.isPrivate && rule.allow === 0n && rule.deny === 0n && (reachOf(key).bits & Permissions.VIEW_CHANNEL) !== 0n;
        if (letIn) next[key] = { allow: Permissions.VIEW_CHANNEL, deny: 0n };
      }
      return { ...d, rules: next, added: [...new Set([...d.added, ...keys])] };
    });
  };

  // Closed or switched away while it saved: the write goes on, and its failure would go unseen.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const report = (e: unknown, fallback: string) => {
    const message = e instanceof Error ? e.message : fallback;
    if (mounted.current) setError(message);
    else toast({ title: fallback, description: message, variant: "destructive" });
  };

  const review = useMemo<EditorReview | undefined>(() => {
    if (!roster) return undefined;
    const rulesStep = steps.find((s): s is Extract<EditorStep, { kind: "rules" }> => s.kind === "rules");
    const privacy = steps.some((s) => s.kind === "private") ? "private" : steps.some((s) => s.kind === "public") ? "public" : undefined;
    if (!rulesStep && !privacy) return undefined;
    const after = rulesStep ? withRules(roster, scopeHex, rulesStep) : roster;
    const scoped =
      scope.kind === "channel"
        ? [{ idHex: scopeHex, wasPrivate: base.isPrivate, isPrivate: privacy ? privacy === "private" : base.isPrivate }]
        : members.filter((c) => roster.syncs?.[c.idHex] === scopeHex).map((c) => ({ idHex: c.idHex, wasPrivate: c.isPrivate, isPrivate: c.isPrivate }));
    // Everyone a rule could let in or shut out (`accessCandidates`), with whoever this change names.
    const people = new Set<string>();
    for (const [pk, m] of coalesced ?? []) if (m.state === "join") people.add(pk);
    for (const g of roster.grants) people.add(g.member);
    for (const o of [...(roster.overwrites ?? []), ...(after.overwrites ?? [])]) if (o.target.kind === "member") people.add(o.target.id);
    const access = reviewAccess({ before: roster, after, ownerHex, banned: folded?.banned, members: [...people], channels: scoped });
    if (!privacy && !reviewMoves(access)) return undefined;
    const work = keyWork(access, me);
    const plan: ApplyPhase[] = [];
    if (steps.some((s) => s.kind !== "private")) plan.push("save");
    // A Channel on its way to Private has no key yet for its rules to move.
    if (!privacy && work.rotate.length) plan.push("rotate");
    if (!privacy && work.send.length) plan.push("send");
    if (privacy === "private") plan.push("private");
    return { access, privacy, plan };
  }, [roster, steps, scopeHex, scope.kind, base.isPrivate, members, coalesced, ownerHex, folded?.banned, me]);

  const run = async (step: EditorStep, sink?: ApplySink) => {
    switch (step.kind) {
      case "rename":
        if (scope.kind === "channel") return manage.renameChannel({ channelIdHex: scopeHex, name: step.name });
        if (ranked) return ranked$.renameCategory({ idHex: scopeHex, name: step.name });
        return manage.nameCategory({ channelIds: members.map((c) => c.idHex), name: step.name });
      case "topic":
        return manage.setChannelTopic({ channelIdHex: scopeHex, topic: step.topic });
      case "view":
        return manage.setChannelView({ channelIdHex: scopeHex, view: step.view });
      case "category":
        return manage.setChannelCategory({ channelIdHex: scopeHex, category: step.category, follow: false });
      case "public":
        return manage.publiciseChannel({ channelIdHex: scopeHex });
      case "rules":
        return ranked$.applyRules({
          scope: scopeHex,
          sync: step.sync,
          overwrites: step.overwrites,
          ...(sink ? { follow: { watch: sink.at, onSettled: sink.settled } } : {}),
        });
      case "private":
        await manage.privatiseChannel({ channelIdHex: scopeHex });
    }
  };

  const save = async (sink?: ApplySink): Promise<boolean> => {
    if (saving) return false;
    setError(null);
    setSaving(true);
    const done = new Set(applied);
    try {
      for (const step of steps) {
        sink?.at(step.kind === "private" ? "private" : "save");
        await run(step, sink);
        done.add(stepKey(step));
      }
      if (!sink) toastSaved();
      return true;
    } catch (e) {
      // Whoever is showing the run shows why it stopped.
      if (sink) throw e;
      report(e, saveFailed());
      return false;
    } finally {
      if (mounted.current) {
        setApplied(done);
        setSaving(false);
      }
    }
  };

  const guarded = async (work: () => Promise<void>, fallback: string): Promise<boolean> => {
    if (busy) return false;
    setError(null);
    setBusy(true);
    try {
      await work();
      return true;
    } catch (e) {
      report(e, fallback);
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const remove = () =>
    guarded(
      async () => {
        if (scope.kind === "channel") {
          await manage.deleteChannel({ channelIdHex: scopeHex });
          toast({ title: t({ id: "channelEditor.channelDeleted", defaultMessage: "Channel deleted" }) });
        } else if (ranked) {
          await ranked$.deleteCategory({ idHex: scopeHex });
        } else {
          // A legacy Category is only the Channels naming it.
          for (const c of members) await manage.setChannelCategory({ channelIdHex: c.idHex, category: undefined });
        }
      },
      scope.kind === "channel"
        ? t({ id: "channelEditor.deleteChannelFailed", defaultMessage: "Couldn't delete the channel." })
        : t({ id: "channelEditor.deleteCategoryFailed", defaultMessage: "Couldn't delete the category." }),
    );

  const unsynced = useMemo(
    () => (ranked && scope.kind === "category" ? members.filter((c) => roster?.syncs?.[c.idHex] !== scopeHex).map((c) => c.idHex) : []),
    [ranked, scope.kind, members, roster, scopeHex],
  );
  const canSyncAll = Boolean(
    folded && me && unsynced.every((id) => !(folded.channels.get(id)?.isPrivate && !held.has(id)) && maySync(folded, me, id, scopeHex)),
  );
  const syncAll = async () => {
    await guarded(async () => {
      await ranked$.syncChannels({ channelIds: unsynced, category: scopeHex });
      toast({ title: t({ id: "channelEditor.syncedAll", defaultMessage: "Channels synced to the category" }) });
    }, t({ id: "channelEditor.syncFailed", defaultMessage: "Couldn't sync the channels." }));
  };

  const { onRotateChannelKey, onMintAccessRole } = ops;
  const rotateKey =
    scope.kind === "channel" && base.isPrivate && onRotateChannelKey
      ? async () => {
          await guarded(async () => {
            await onRotateChannelKey(scopeHex);
            toast({ title: t({ id: "channelEditor.rotated", defaultMessage: "Channel key rotated" }) });
          }, t({ id: "channelEditor.rotateFailed", defaultMessage: "Couldn't rotate the key." }));
        }
      : undefined;
  const channelInfo = (idHex: string) => {
    const c = channels.find((x) => x.idHex === idHex);
    return { name: c?.name ?? base.name, isPrivate: c?.isPrivate ?? base.isPrivate, view: c?.view };
  };
  const mintAccessRole =
    scope.kind === "channel" && !ranked && base.isPrivate && onMintAccessRole
      ? (name: string) => guarded(() => onMintAccessRole(scopeHex, name), t({ id: "channelEditor.createRoleFailed", defaultMessage: "Couldn't create the role." }))
      : undefined;

  return {
    scope,
    me,
    missing,
    ranked,
    canManageChannels,
    canManageRoles,
    canSync: maySyncTo(values.synced ? undefined : values.category),
    unkeyed,
    canDelete: canManageChannels && (scope.kind === "category" || channels.length > 1),
    base,
    values,
    channelCount: members.length,
    categories,
    categoryName,
    setName: (name) => patch({ name }),
    setTopic: (topic) => patch({ topic }),
    setView: (view) => patch({ view }),
    setCategory,
    setSynced: (synced) => patch({ synced }),
    setPrivate: (isPrivate) => patch({ isPrivate }),
    targets,
    setRule,
    removeTarget,
    addTargets,
    mayTarget: (key) => reachOf(key).bits !== 0n,
    candidates,
    ownerHex,
    unsyncedCount: unsynced.length,
    canSyncAll,
    syncAll,
    accessRoles: ops.channelRoles?.get(scopeHex) ?? [],
    mintAccessRole,
    rotateKey,
    steps,
    review,
    roleName: (id) => roster?.roles.find((r) => r.roleId === id)?.name,
    channelInfo,
    retryRotation: onRotateChannelKey,
    dirty: steps.length > 0,
    invalid: utf8Len(values.name.trim()) > NAME_MAX_BYTES || utf8Len(values.topic.trim()) > CHANNEL_TOPIC_MAX_BYTES,
    saving,
    busy: busy || saving,
    error,
    clearError: () => setError(null),
    save,
    reset: () => {
      setError(null);
      setDraft(EMPTY_DRAFT);
    },
    remove,
    published: ranked$.published,
    planned: ranked$.planned,
  };
}
