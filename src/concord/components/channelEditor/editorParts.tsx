import { Check, Minus, Shield, Users, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { AvatarInitial } from "@/components/AvatarInitial";
import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Textarea } from "@/components/ui/textarea";
import { ChannelTypeStrip } from "@/concord/components/ChannelTypeStrip";
import { EVERYONE, memberFrom, RULE_GROUPS, ruleState, targetKey, type RuleState } from "@/concord/components/channelEditor/editorDraft";
import { GROUP_LABEL, SHEET_ROW, SHEET_TILE, well, type Surface } from "@/concord/components/channelEditor/editorStyles";
import type { EditorModel, EditorTarget } from "@/concord/components/channelEditor/useChannelEditor";
import type { EditorConfirm } from "@/concord/components/channelEditor/useEditorFlow";
import { useMemberSearch } from "@/concord/components/channelEditor/useMemberSearch";
import { CHANNEL_TOPIC_MAX_BYTES } from "@/concord/lib/channelSeal";
import { PERMISSION_LABELS, Permissions } from "@/concord/lib/roles";
import { NAME_MAX_BYTES, utf8Len } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** The sheet on touch, the two-column pane otherwise. */
export type EditorVariant = "sheet" | "pane";

/** Members rendered in the picker before a search has to narrow them. */
const MEMBER_CAP = 50;

export function MemberName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <DisplayName pubkey={pubkey} name={name || pubkey.slice(0, 8)} />;
}

export function MemberAvatar({ pubkey, className, fallbackClassName }: { pubkey: string; className?: string; fallbackClassName?: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    // The name beside it says who this is.
    <Avatar aria-hidden className={cn("shrink-0", className)}>
      <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt="" />
      <AvatarFallback className={cn("bg-muted font-semibold text-muted-foreground", fallbackClassName)}>
        <AvatarInitial name={name} pubkey={pubkey} />
      </AvatarFallback>
    </Avatar>
  );
}

type Named = Pick<EditorTarget, "kind" | "name" | "pubkey" | "color">;

export function TargetLead({ target, variant }: { target: Named; variant: EditorVariant }) {
  if (target.kind === "member" && target.pubkey) {
    return variant === "sheet" ? (
      <MemberAvatar pubkey={target.pubkey} className="size-10" fallbackClassName="text-sm" />
    ) : (
      <MemberAvatar pubkey={target.pubkey} className="-mx-1 size-6" fallbackClassName="text-2xs" />
    );
  }
  const Icon = target.kind === "everyone" ? Users : Shield;
  const icon = (
    <Icon
      className={cn(variant === "sheet" ? "size-5" : "size-4 shrink-0", !target.color && "text-muted-foreground")}
      style={target.color ? { color: target.color } : undefined}
    />
  );
  return variant === "sheet" ? <span className={SHEET_TILE}>{icon}</span> : icon;
}

export function TargetLabel({ target }: { target: Named }) {
  if (target.kind === "member" && target.pubkey) return <MemberName pubkey={target.pubkey} />;
  return <span style={target.color ? { color: target.color } : undefined}>{target.name}</span>;
}

/** What a target's rule comes to, in a few words. */
export function TargetSummary({ view, others }: { view: RuleState; others: number }) {
  if (others === 0) {
    if (view === "allow") return <FormattedMessage id="channelEditor.summary.canView" defaultMessage="Can view" />;
    if (view === "deny") return <FormattedMessage id="channelEditor.summary.cannotView" defaultMessage="Can't view" />;
    return <FormattedMessage id="channelEditor.summary.none" defaultMessage="No changes" />;
  }
  if (view === "allow") {
    return (
      <FormattedMessage
        id="channelEditor.summary.canViewAnd"
        defaultMessage="Can view, {count, plural, one {# change} other {# changes}}"
        values={{ count: others }}
      />
    );
  }
  if (view === "deny") {
    return (
      <FormattedMessage
        id="channelEditor.summary.cannotViewAnd"
        defaultMessage="Can't view, {count, plural, one {# change} other {# changes}}"
        values={{ count: others }}
      />
    );
  }
  return (
    <FormattedMessage id="channelEditor.summary.changes" defaultMessage="{count, plural, one {# change} other {# changes}}" values={{ count: others }} />
  );
}

function TriState({ value, onChange, disabled, name }: { value: RuleState; onChange: (state: RuleState) => void; disabled?: boolean; name: string }) {
  const intl = useIntl();
  const options: Array<{ state: RuleState; icon: typeof X; on: string; label: string }> = [
    { state: "deny", icon: X, on: "bg-destructive/20 text-destructive", label: intl.formatMessage({ id: "channelEditor.rule.deny", defaultMessage: "Deny" }) },
    { state: "inherit", icon: Minus, on: "bg-secondary text-foreground", label: intl.formatMessage({ id: "channelEditor.rule.inherit", defaultMessage: "Inherit" }) },
    { state: "allow", icon: Check, on: "bg-primary/20 text-primary", label: intl.formatMessage({ id: "channelEditor.rule.allow", defaultMessage: "Allow" }) },
  ];
  return (
    <span role="group" aria-label={name} className="flex shrink-0 gap-0.5">
      {options.map(({ state, icon: Icon, on, label }) => (
        <button
          key={state}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={value === state}
          disabled={disabled}
          onClick={() => onChange(state)}
          className={cn(
            "flex size-7 items-center justify-center clip-corner transition-colors disabled:opacity-50 touch:size-11",
            value === state ? on : "text-muted-foreground hover:bg-secondary",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </span>
  );
}

const GROUP_NAMES = {
  messages: <FormattedMessage id="channelEditor.group.messages" defaultMessage="Messages" />,
  voice: <FormattedMessage id="channelEditor.group.voice" defaultMessage="Voice" />,
  moderation: <FormattedMessage id="channelEditor.group.moderation" defaultMessage="Moderation" />,
} as const;

/** One target's rule: every overwritable bit allowed, denied or left to its Roles. */
export function RuleGroups({ model, target, variant }: { model: EditorModel; target: EditorTarget; variant: EditorVariant }) {
  const scope = model.scope.kind;
  const sheet = variant === "sheet";
  const disabled = !model.canManageRoles || model.busy;
  // Said only to someone who manages Roles: anyone else sees the rules as a read-only list.
  const refusal = model.canManageRoles && !model.unkeyed ? target.refusal : undefined;
  return (
    <div className={sheet ? undefined : "space-y-4"}>
      {refusal && (
        <p className={cn("text-xs text-muted-foreground", sheet && "px-3 pb-1 pt-2")}>
          {refusal === "bits" ? (
            <FormattedMessage id="channelEditor.rule.beyondYou" defaultMessage="This rule sets a permission you don't hold, so it isn't yours to change." />
          ) : (
            <FormattedMessage id="channelEditor.rule.outOfReach" defaultMessage="You can only set permissions for roles and members beneath you." />
          )}
        </p>
      )}
      {RULE_GROUPS.map((group) => (
        <div key={group.id} className={sheet ? undefined : "space-y-2"}>
          <div className={cn(GROUP_LABEL, sheet && "px-3 pb-1 pt-2")}>{GROUP_NAMES[group.id]}</div>
          <div className={sheet ? undefined : "space-y-1 rounded-lg bg-secondary/40 p-2"}>
            {group.bits.map((bit) => {
              const label = PERMISSION_LABELS.find((l) => l.bit === bit)?.label ?? "";
              // A Private Channel is never `@everyone`'s to view (CORD-04 §8).
              const sealed = bit === Permissions.VIEW_CHANNEL && target.key === EVERYONE && model.values.isPrivate;
              const state = sealed ? "deny" : ruleState(target.rule, bit);
              const locked = (target.reach & bit) === 0n;
              // One bit out of reach in a rule that is otherwise theirs.
              const notHeld = locked && target.reach !== 0n && model.canManageRoles;
              return (
                <div key={bit.toString()} className={cn("flex items-center gap-3", sheet ? "min-h-11 px-3 py-0.5" : "px-1 py-1")}>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block font-medium", sheet ? "text-chat" : "text-sm")}>{label}</span>
                    {sealed ? (
                      <span className="block text-xs text-muted-foreground">
                        <FormattedMessage id="channelEditor.rule.sealed" defaultMessage="Hidden while the channel is private" />
                      </span>
                    ) : state !== "inherit" ? (
                      <span className={cn("block text-xs", state === "deny" ? "text-destructive" : "text-primary")}>
                        {state === "deny" ? (
                          <FormattedMessage
                            id="channelEditor.rule.denied"
                            defaultMessage="{scope, select, category {Denied in this category} other {Denied in this channel}}"
                            values={{ scope }}
                          />
                        ) : (
                          <FormattedMessage
                            id="channelEditor.rule.allowed"
                            defaultMessage="{scope, select, category {Allowed in this category} other {Allowed in this channel}}"
                            values={{ scope }}
                          />
                        )}
                      </span>
                    ) : notHeld ? (
                      <span className="block text-xs text-muted-foreground">
                        <FormattedMessage id="channelEditor.rule.notHeld" defaultMessage="You don't hold this permission" />
                      </span>
                    ) : null}
                  </span>
                  <TriState name={label} value={state} disabled={disabled || sealed || locked} onChange={(next) => model.setRule(target.key, bit, next)} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function EditorField({ label, htmlFor, children }: { label: ReactNode; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className={cn("block", GROUP_LABEL)}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** Name, and for a Channel its topic and type. */
export function GeneralFields({ model, surface }: { model: EditorModel; surface: Surface }) {
  const intl = useIntl();
  const id = useId();
  const disabled = !model.canManageChannels || model.busy;
  const topicBytes = utf8Len(model.values.topic.trim());
  return (
    <>
      <EditorField htmlFor={`${id}-name`} label={<FormattedMessage id="channelEditor.name" defaultMessage="Name" />}>
        <Input
          id={`${id}-name`}
          value={model.values.name}
          onChange={(e) => model.setName(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          maxLength={NAME_MAX_BYTES}
        />
      </EditorField>
      {model.scope.kind === "channel" && (
        <>
          <EditorField htmlFor={`${id}-topic`} label={<FormattedMessage id="channelEditor.topic" defaultMessage="Topic" />}>
            <Textarea
              id={`${id}-topic`}
              value={model.values.topic}
              onChange={(e) => model.setTopic(e.target.value)}
              disabled={disabled}
              placeholder={intl.formatMessage({ id: "channelEditor.topicPlaceholder", defaultMessage: "What's this channel about?" })}
              className="min-h-[72px] resize-none"
            />
            {topicBytes > CHANNEL_TOPIC_MAX_BYTES && (
              <p className="text-xs text-destructive">
                <FormattedMessage
                  id="channelEditor.topicTooLong"
                  defaultMessage="Too long: {bytes} of {max} bytes."
                  values={{ bytes: topicBytes, max: CHANNEL_TOPIC_MAX_BYTES }}
                />
              </p>
            )}
          </EditorField>
          <div className="space-y-1.5">
            <div className={GROUP_LABEL}>
              <FormattedMessage id="channelEditor.type" defaultMessage="Type" />
            </div>
            <ChannelTypeStrip value={model.values.view} onChange={model.setView} disabled={disabled} className={well(surface)} />
          </div>
        </>
      )}
    </>
  );
}

/** Roles and members not yet listed, to tick and add. */
export function TargetPicker({ model, variant, onDone }: { model: EditorModel; variant: EditorVariant; onDone: (added?: string) => void }) {
  const intl = useIntl();
  const sheet = variant === "sheet";
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const q = query.trim().toLowerCase();
  const roles = model.candidates.roles.filter((r) => !q || r.name.toLowerCase().includes(q));
  const found = useMemberSearch(model.candidates.members, query);
  // A member who isn't on the memberlist yet can still be named by key.
  const typed = memberFrom(query);
  const isOwner = typed !== undefined && typed === model.ownerHex;
  const listed = typed !== undefined && model.targets.some((t) => t.pubkey === typed);
  const members = typed && !isOwner && !listed && !found.includes(typed) ? [typed, ...found] : found;
  const toggle = (key: string, on: boolean) => setPicked((p) => (on ? [...p, key] : p.filter((k) => k !== key)));

  const row = (key: string, target: Named, sub?: ReactNode) => {
    const id = `pick-${key}`;
    const open = model.mayTarget(key);
    return (
      <label
        key={key}
        htmlFor={id}
        className={cn(
          open ? "cursor-pointer" : "opacity-50",
          sheet ? cn(SHEET_ROW, "text-foreground") : cn("flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors", open && "hover:bg-secondary/70"),
        )}
      >
        <TargetLead target={target} variant={variant} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <TargetLabel target={target} />
          </span>
          {open ? (
            sub && <span className="block truncate text-xs font-normal text-muted-foreground">{sub}</span>
          ) : (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              <FormattedMessage id="channelEditor.picker.outOfReach" defaultMessage="Not beneath your role" />
            </span>
          )}
        </span>
        <Checkbox id={id} checked={picked.includes(key)} disabled={!open} onCheckedChange={(on) => toggle(key, on === true)} />
      </label>
    );
  };
  const heading = (children: ReactNode) => <div className={cn(GROUP_LABEL, sheet ? "px-3 pb-1 pt-2" : "px-2 pb-1 pt-2")}>{children}</div>;

  return (
    <>
      <div className={sheet ? "shrink-0 px-5 pb-1" : undefined}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={intl.formatMessage({ id: "channelEditor.picker.search", defaultMessage: "Search roles and members" })}
        />
      </div>
      <div className={sheet ? "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-1" : "max-h-80 overflow-y-auto rounded-lg bg-secondary/40 p-1"}>
        {roles.length > 0 && heading(<FormattedMessage id="channelEditor.picker.roles" defaultMessage="Roles" />)}
        {roles.map((r) =>
          row(
            r.key,
            { kind: "role", name: r.name, color: r.color },
            <FormattedMessage id="channelEditor.picker.holders" defaultMessage="{count, plural, one {# member} other {# members}}" values={{ count: r.holders }} />,
          ),
        )}
        {members.length > 0 && heading(<FormattedMessage id="channelEditor.picker.members" defaultMessage="Members" />)}
        {members.slice(0, MEMBER_CAP).map((pk) => row(targetKey({ kind: "member", id: pk }), { kind: "member", pubkey: pk }))}
        {members.length > MEMBER_CAP && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            <FormattedMessage id="channelEditor.picker.more" defaultMessage="Search to find more members." />
          </p>
        )}
        {roles.length === 0 && members.length === 0 && (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            {isOwner ? (
              <FormattedMessage id="channelEditor.picker.owner" defaultMessage="The owner holds every permission everywhere." />
            ) : listed ? (
              <FormattedMessage id="channelEditor.picker.listed" defaultMessage="They're already listed." />
            ) : q ? (
              <FormattedMessage id="channelEditor.picker.empty" defaultMessage="Nobody matches. A member can also be added by npub." />
            ) : (
              <FormattedMessage id="channelEditor.picker.none" defaultMessage="There's nobody else to add. A member can also be added by npub." />
            )}
          </p>
        )}
      </div>
      <div className={sheet ? "flex shrink-0 items-center gap-2 px-5 pt-2 pb-[var(--safe-area-pad-bottom,0.75rem)]" : "flex justify-end gap-2"}>
        {!sheet && (
          <Button type="button" variant="ghost" className="clip-corner-lg" onClick={() => onDone()}>
            <FormattedMessage {...common.cancel} />
          </Button>
        )}
        <Button
          type="button"
          className={cn("clip-corner-lg", sheet && "flex-1")}
          disabled={picked.length === 0}
          onClick={() => {
            model.addTargets(picked);
            onDone(picked[0]);
          }}
        >
          <FormattedMessage id="channelEditor.picker.add" defaultMessage="{count, plural, =0 {Add} other {Add #}}" values={{ count: picked.length }} />
        </Button>
      </div>
    </>
  );
}

/** What a confirmation spells out before the editor acts. */
export function ConfirmText({ model, kind }: { model: EditorModel; kind: EditorConfirm }) {
  const name = model.base.name;
  if (kind === "delete") {
    return model.scope.kind === "channel" ? (
      <FormattedMessage id="channelEditor.confirm.deleteChannel" defaultMessage="Delete #{name}? Its id is never reused." values={{ name }} />
    ) : (
      <FormattedMessage
        id="channelEditor.confirm.deleteCategory"
        defaultMessage="Delete {name}? Its channels stay, outside any category. Deleting a category can't be undone."
        values={{ name }}
      />
    );
  }
  return model.ranked ? (
    <FormattedMessage
      id="channelEditor.confirm.rotate"
      defaultMessage="Rotate #{name}'s key? It gets a fresh key delivered only to members its permissions let in right now. Anyone else, including someone who kept a key from an earlier setting, loses access to what's said next."
      values={{ name }}
    />
  ) : (
    <FormattedMessage
      id="channelEditor.confirm.rotateLegacy"
      defaultMessage="Rotate #{name}'s key? It gets a fresh key delivered only to members who hold one of its roles right now. Anyone else, including someone who kept a key from an earlier setting, loses access to what's said next."
      values={{ name }}
    />
  );
}
