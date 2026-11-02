import { useQueryClient } from "@tanstack/react-query";
import { useQueries } from "@tanstack/react-query";
import { Check, Loader2, Lock, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { SearchField } from "@/components/ui/search-field";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authorQueryOptions, useAuthor } from "@/hooks/useAuthor";
import { useEventStore } from "@/hooks/useEventStore";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { profileMatches, type SearchProfile } from "@/hooks/useSearchProfiles";
import { AvatarInitial } from "@/components/AvatarInitial";

/** Render cap before "Show all" (slicing, not virtualization). */
const RENDER_CAP = 50;

interface AddChannelMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelName: string;
  /** Community members WITHOUT access to the channel, per the control fold. */
  candidates: string[];
  /** The channel's scoped roles the viewer may grant (CORD-04 §2). */
  roles: Array<{ id: string; name: string }>;
  /** Grant one role to one member; the caller vends the key and toasts outcomes. */
  onAdd: (pubkey: string, roleId: string) => Promise<void>;
  isAdding: (pubkey: string, roleId: string) => boolean;
  /** Per LOCAL intent — the fold lags the publish. */
  hasRole: (pubkey: string, roleId: string) => boolean;
  holdsKey: boolean;
}

/**
 * Add members to a private channel by granting its scoped role (which vends
 * the key). Each row acts immediately since each grant can fail independently.
 */
export function AddChannelMembersDialog({
  open,
  onOpenChange,
  channelName,
  candidates,
  roles,
  onAdd,
  isAdding,
  hasRole,
  holdsKey,
}: AddChannelMembersDialogProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const [query, setQuery] = useState("");
  const [roleId, setRoleId] = useState<string | undefined>(roles[0]?.id);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setShowAll(false);
    setRoleId(roles[0]?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Granted rows stay in place (marked "Added") rather than vanishing mid-scroll.
  const ordered = useMemo(() => [...candidates].sort(), [candidates]);

  // Batch-resolve profiles so search sees every candidate, not just rendered rows.
  const resolved = open ? ordered : [];
  const profileResults = useQueries({
    queries: resolved.map((pk) => authorQueryOptions(queryClient, eventStore, pk)),
  });
  const profileKey = resolved
    .map((pk, i) => `${pk}:${profileResults[i]?.data?.metadata?.name ?? ""}:${profileResults[i]?.data?.metadata?.display_name ?? ""}:${profileResults[i]?.data?.metadata?.nip05 ?? ""}`)
    .join("|");
  const profileOf = useMemo(() => {
    const map = new Map<string, SearchProfile>();
    resolved.forEach((pk, i) => {
      const data = profileResults[i]?.data;
      if (data?.metadata && data.event) map.set(pk, { pubkey: pk, metadata: data.metadata, event: data.event });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((pk) => {
      const p = profileOf.get(pk);
      return (p && profileMatches(p, q)) || pk.startsWith(q);
    });
  }, [ordered, query, profileOf]);

  const visible = showAll ? matches : matches.slice(0, RENDER_CAP);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "addChannelMembersDialog.title", defaultMessage: "Add members to #{channelName}" }, { channelName })} contentClassName="grid gap-4">
        <ChromeDialogHeader
          icon={Lock}
          title={<FormattedMessage
            id="addChannelMembersDialog.heading"
            defaultMessage="add members to <channel>#{channelName}</channel>"
            values={{ channelName, channel: (chunks) => <span className="normal-case">{chunks}</span> }}
          />}
          description={roles.length === 1
            ? <FormattedMessage
              id="addChannelMembersDialog.grantsRole"
              defaultMessage="Adding grants the <role>{roleName}</role> role and sends them the channel key."
              values={{ roleName: roles[0].name, role: (chunks) => <span className="text-foreground">{chunks}</span> }}
            />
            : <FormattedMessage id="addChannelMembersDialog.grantsChosenRole" defaultMessage="Adding grants the chosen role and sends them the channel key." />}
          className="mb-2"
        />

        {!holdsKey && (
          <p className="clip-corner-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            <FormattedMessage
              id="addChannelMembersDialog.noKey"
              defaultMessage="You don't hold this channel's key, so members you add get the role but a member who does hold it has to share it before they can read."
            />
          </p>
        )}

        {roles.length > 1 && (
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={intl.formatMessage({ id: "addChannelMembersDialog.rolePlaceholder", defaultMessage: "Role to grant" })} />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {candidates.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            <FormattedMessage id="addChannelMembersDialog.everyoneHasAccess" defaultMessage="Everyone in the community already has access to this channel." />
          </p>
        ) : (
          <>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={intl.formatMessage({ id: "addChannelMembersDialog.searchPlaceholder", defaultMessage: "Search members" })}
              className="bg-background/40"
              autoFocus
            />

            {matches.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground"><FormattedMessage id="addChannelMembersDialog.noMatches" defaultMessage="No member matches." /></p>
            ) : (
              <ul className="-mx-2 max-h-72 overflow-y-auto">
                {visible.map((pk) => (
                  <CandidateRow
                    key={pk}
                    pubkey={pk}
                    added={roleId ? hasRole(pk, roleId) : false}
                    busy={roleId ? isAdding(pk, roleId) : false}
                    onAdd={roleId ? () => void onAdd(pk, roleId) : undefined}
                  />
                ))}
                {!showAll && matches.length > RENDER_CAP && (
                  <li className="px-2 py-1.5">
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline"
                      onClick={() => setShowAll(true)}
                    >
                      <FormattedMessage id="addChannelMembersDialog.showAll" defaultMessage="Show all {count}" values={{ count: matches.length }} />
                    </button>
                  </li>
                )}
              </ul>
            )}
          </>
        )}
      </ChromeDialogContent>
    </Dialog>
  );
}

function CandidateRow({ pubkey, added, busy, onAdd }: {
  pubkey: string;
  added: boolean;
  busy: boolean;
  onAdd?: () => void;
}) {
  const intl = useIntl();
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <li className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <Avatar className="size-8 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-3xs text-primary">
          <AvatarInitial name={name} pubkey={pubkey} />
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm">
        <DisplayName pubkey={pubkey} name={name} />
      </span>
      {added ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-success">
          <Check className="size-3.5" aria-hidden /> <FormattedMessage id="addChannelMembersDialog.added" defaultMessage="Added" />
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={busy || !onAdd}
          onClick={onAdd}
          aria-label={intl.formatMessage({ id: "addChannelMembersDialog.addMember", defaultMessage: "Add {name}" }, { name })}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
          <FormattedMessage {...common.add} />
        </Button>
      )}
    </li>
  );
}
