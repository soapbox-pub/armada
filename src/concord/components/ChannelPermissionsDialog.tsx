import { Check, KeyRound, Loader2, Minus, Shield, User, Users, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useEffect, useMemo, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { useRankedRoles } from "@/concord/hooks/useRankedRoles";
import { categoryOrder, rankedOrder, sameTarget } from "@/concord/lib/rankedWrites";
import { colorToHex, OVERWRITABLE, PERMISSION_LABELS, type OverwriteTarget } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

type State = "allow" | "inherit" | "deny";

const targetKey = (t: OverwriteTarget) => (t.kind === "everyone" ? "everyone" : `${t.kind}:${t.id}`);
const targetOf = (key: string): OverwriteTarget => {
  if (key === "everyone") return { kind: "everyone" };
  const [kind, id] = key.split(":");
  return kind === "role" ? { kind: "role", id } : { kind: "member", id };
};

/** A member typed as an npub, nprofile or hex key; undefined if it names nobody. */
function memberFrom(raw: string): string | undefined {
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

function MemberName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <DisplayName pubkey={pubkey} name={name || pubkey.slice(0, 8)} />;
}

/**
 * A Channel's or Category's permission overwrites on the vsk-13 Roster (CORD-04 §8):
 * per target, each channel bit allowed, denied or left to inherit; and for a Channel,
 * whether it follows its Category's rules instead of its own.
 */
export function ChannelPermissionsDialog({
  community,
  scope,
  onOpenChange,
}: {
  community: Community;
  /** The Channel or Category being edited; undefined closes the dialog. */
  scope: { idHex: string; kind: "channel" | "category"; name: string } | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const intl = useIntl();
  const { folded, setOverwrite, setSync, isSaving } = useRankedRoles(community);
  const { coalesced } = useGuestbook(community);
  const [typed, setTyped] = useState("");
  const roster = folded?.roster;
  const scopeHex = scope?.idHex.toLowerCase();
  const rules = useMemo(() => (roster?.overwrites ?? []).filter((o) => o.scope === scopeHex), [roster, scopeHex]);
  const roles = useMemo(() => (folded ? rankedOrder(folded) : []), [folded]);
  const categories = useMemo(() => (folded ? categoryOrder(folded) : []), [folded]);
  const syncedTo = scope?.kind === "channel" && scopeHex ? roster?.syncs?.[scopeHex] : undefined;
  const bits = useMemo(() => PERMISSION_LABELS.filter((l) => (l.bit & OVERWRITABLE) === l.bit), []);

  const [selected, setSelected] = useState<string>("everyone");
  const [draft, setDraft] = useState<{ allow: bigint; deny: bigint }>({ allow: 0n, deny: 0n });
  const [error, setError] = useState<string | null>(null);

  const current = rules.find((o) => sameTarget(o.target, targetOf(selected)));
  useEffect(() => {
    setDraft({ allow: current?.allow ?? 0n, deny: current?.deny ?? 0n });
    setError(null);
  }, [selected, current?.allow, current?.deny]);
  useEffect(() => {
    if (scope) setSelected("everyone");
  }, [scope?.idHex]); // eslint-disable-line react-hooks/exhaustive-deps

  const members = useMemo(() => {
    const out = new Set<string>();
    // Everyone a rule could name: the memberlist, every Grantee, and who a rule names (Vector `access_candidates`).
    for (const [pk, m] of coalesced ?? []) if (m.state === "join") out.add(pk);
    for (const g of roster?.grants ?? []) out.add(g.member);
    for (const o of rules) if (o.target.kind === "member") out.add(o.target.id);
    if (folded) out.delete(folded.ownerHex);
    return [...out];
  }, [roster, rules, folded, coalesced]);

  const labelOf = (key: string) => {
    const target = targetOf(key);
    if (target.kind === "everyone") return "@everyone";
    if (target.kind === "role") return roles.find((r) => r.roleId === target.id)?.name ?? target.id.slice(0, 8);
    return <MemberName pubkey={target.id} />;
  };

  const stateOf = (bit: bigint): State => ((draft.allow & bit) !== 0n ? "allow" : (draft.deny & bit) !== 0n ? "deny" : "inherit");
  const setState = (bit: bigint, s: State) =>
    setDraft((d) => ({ allow: s === "allow" ? d.allow | bit : d.allow & ~bit, deny: s === "deny" ? d.deny | bit : d.deny & ~bit }));

  const save = async (allow: bigint, deny: bigint) => {
    if (!scopeHex) return;
    setError(null);
    try {
      await setOverwrite({ scope: scopeHex, target: targetOf(selected), allow, deny });
      toast({ title: t({ id: "channelPermissions.saved", defaultMessage: "Permissions saved" }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "channelPermissions.saveFailed", defaultMessage: "Couldn't save the permissions." }));
    }
  };

  const changeSync = async (value: string) => {
    if (!scopeHex) return;
    setError(null);
    try {
      await setSync({ channelIdHex: scopeHex, category: value === "own" ? undefined : value });
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "channelPermissions.syncFailed", defaultMessage: "Couldn't change where the permissions come from." }));
    }
  };

  const listed = new Set(rules.map((o) => targetKey(o.target)));
  const addable = [
    ...(!listed.has("everyone") ? ["everyone"] : []),
    ...roles.map((r) => `role:${r.roleId}`).filter((k) => !listed.has(k)),
    ...members.map((m) => `member:${m}`).filter((k) => !listed.has(k)),
  ];
  const shown = [...new Set(["everyone", ...rules.map((o) => targetKey(o.target)), selected])];
  const unchanged = draft.allow === (current?.allow ?? 0n) && draft.deny === (current?.deny ?? 0n);

  const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
  const field = "bg-background/40 border-transparent";

  return (
    <Dialog open={Boolean(scope)} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "channelPermissions.title", defaultMessage: "Permissions" })}
        contentClassName="grid gap-4"
      >
        <ChromeDialogHeader
          icon={KeyRound}
          className="mb-2"
          title={
            scope?.kind === "category" ? (
              <FormattedMessage id="channelPermissions.categoryHeading" defaultMessage="{name} permissions" values={{ name: scope.name }} />
            ) : (
              <FormattedMessage id="channelPermissions.channelHeading" defaultMessage="#{name} permissions" values={{ name: scope?.name ?? "" }} />
            )
          }
          description={
            scope?.kind === "category" ? (
              <FormattedMessage id="channelPermissions.categoryDescription" defaultMessage="Rules here apply to every channel synced to this category." />
            ) : (
              <FormattedMessage
                id="channelPermissions.channelDescription"
                defaultMessage="Allow or deny a permission here for everyone, a role or a member, on top of what their roles give them."
              />
            )
          }
        />

        {scope?.kind === "channel" && (
          <div className="space-y-1.5">
            <Label htmlFor="channel-sync" className={fieldLabel}>
              <FormattedMessage id="channelPermissions.follows" defaultMessage="Permissions come from" />
            </Label>
            <Select value={syncedTo ?? "own"} onValueChange={(v) => void changeSync(v)} disabled={isSaving}>
              <SelectTrigger id="channel-sync" className={field}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="own">
                  <FormattedMessage id="channelPermissions.own" defaultMessage="This channel's own rules" />
                </SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.idHex} value={c.idHex}>
                    <FormattedMessage id="channelPermissions.syncedTo" defaultMessage="The {category} category" values={{ category: c.name || c.idHex.slice(0, 8) }} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {syncedTo && (
              <p className="clip-corner-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                <FormattedMessage
                  id="channelPermissions.syncedHint"
                  defaultMessage="While synced, the category's rules apply here. The rules below are kept and apply again if you switch back."
                />
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          <span className={fieldLabel}>
            <FormattedMessage id="channelPermissions.targets" defaultMessage="Roles and members" />
          </span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup">
            {shown.map((key) => {
              const target = targetOf(key);
              const tint = target.kind === "role" ? colorToHex(roles.find((r) => r.roleId === target.id)?.color ?? 0) : undefined;
              return (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={key === selected}
                  variant={key === selected ? "default" : "secondary"}
                  className="max-w-full gap-1.5 clip-corner touch:h-11"
                  onClick={() => setSelected(key)}
                >
                  {target.kind === "everyone" ? <Users className="size-3.5" /> : target.kind === "role" ? <Shield className="size-3.5" style={tint && key !== selected ? { color: tint } : undefined} /> : <User className="size-3.5" />}
                  <span className="truncate">{labelOf(key)}</span>
                </Button>
              );
            })}
          </div>
          {addable.length > 0 && (
            <Select value="" onValueChange={setSelected}>
              <SelectTrigger className={field} aria-label={intl.formatMessage({ id: "channelPermissions.addTarget", defaultMessage: "Add a role or member" })}>
                <SelectValue placeholder={intl.formatMessage({ id: "channelPermissions.addTarget", defaultMessage: "Add a role or member" })} />
              </SelectTrigger>
              <SelectContent>
                {addable.map((key) => (
                  <SelectItem key={key} value={key}>
                    {labelOf(key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const pk = memberFrom(typed);
              if (!pk) return setError(t({ id: "channelPermissions.badMember", defaultMessage: "That isn't an npub or a public key." }));
              if (pk === folded?.ownerHex) return setError(t({ id: "rankedWrites.ownerEverywhere", defaultMessage: "The owner holds every permission everywhere." }));
              setTyped("");
              setSelected(`member:${pk}`);
            }}
          >
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={intl.formatMessage({ id: "channelPermissions.memberPlaceholder", defaultMessage: "Or a member's npub" })}
              aria-label={intl.formatMessage({ id: "channelPermissions.memberPlaceholder", defaultMessage: "Or a member's npub" })}
              autoComplete="off"
              className={field}
            />
            <Button type="submit" variant="secondary" className="clip-corner-lg" disabled={!typed.trim()}>
              <FormattedMessage {...common.add} />
            </Button>
          </form>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className={cn(fieldLabel, "min-w-0 truncate")}>{labelOf(selected)}</span>
            {current && (
              <Button type="button" size="sm" variant="ghost" className="shrink-0 text-destructive hover:text-destructive" disabled={isSaving} onClick={() => void save(0n, 0n)}>
                <FormattedMessage id="channelPermissions.removeRule" defaultMessage="Remove rule" />
              </Button>
            )}
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg bg-secondary/40 p-2">
            {bits.map(({ bit, label, hint }) => {
              const s = stateOf(bit);
              const choice = (value: State, icon: React.ReactNode, name: string, on: string) => (
                <button
                  type="button"
                  aria-label={name}
                  aria-pressed={s === value}
                  title={name}
                  disabled={isSaving}
                  onClick={() => setState(bit, value)}
                  className={cn("flex size-7 touch:size-11 items-center justify-center clip-corner transition-colors", s === value ? on : "text-muted-foreground hover:bg-secondary")}
                >
                  {icon}
                </button>
              );
              return (
                <div key={bit.toString()} className="flex items-center gap-3 px-1 py-1">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                  <span className="flex shrink-0 gap-0.5">
                    {choice("deny", <X className="size-4" />, intl.formatMessage({ id: "channelPermissions.deny", defaultMessage: "Deny" }), "bg-destructive/20 text-destructive")}
                    {choice("inherit", <Minus className="size-4" />, intl.formatMessage({ id: "channelPermissions.inherit", defaultMessage: "Inherit" }), "bg-secondary text-foreground")}
                    {choice("allow", <Check className="size-4" />, intl.formatMessage({ id: "channelPermissions.allow", defaultMessage: "Allow" }), "bg-primary/20 text-primary")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <ChromeDialogFooter className="mt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            <FormattedMessage {...common.close} />
          </Button>
          <Button type="button" disabled={isSaving || unchanged} onClick={() => void save(draft.allow, draft.deny)}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            <FormattedMessage {...common.save} />
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
