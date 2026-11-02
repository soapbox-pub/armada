import { useQueryClient } from "@tanstack/react-query";
import { File as FileIcon, Hash, Pin, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { FormattedMessage, useIntl } from "@/i18n";
import { flattenLayout, mergeLayout } from "@/lib/railLayout";
import { chatRoute } from "@/lib/routes";
import {
  assignShareRoute,
  discardShare,
  hasShareTarget,
  onShareStashChanged,
  pendingSharePreview,
  stashShare,
  type SharePayload,
} from "@/lib/shareTarget";
import {
  buildSwitcherEntries,
  switcherLiveKeys,
  type SwitcherContext,
  type SwitcherEntries,
} from "@/lib/switcher";
import { AvatarInitial } from "@/components/AvatarInitial";

const EMPTY_ENTRIES: SwitcherEntries = { spaces: [], channels: [] };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One DM destination row: the peer's avatar + live display name. */
function DmDestination({
  peer,
  pinned,
  onSelect,
}: {
  peer: string;
  pinned: boolean;
  onSelect: () => void;
}) {
  const author = useAuthor(peer);
  const name = useScopedDisplayName(peer, author.data?.metadata);
  return (
    <CommandItem value={`${name} ${peer}`} onSelect={onSelect} className="touch:py-3">
      <Avatar className="mr-2 size-7 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="text-xs"><AvatarInitial name={name} /></AvatarFallback>
      </Avatar>
      <span className="truncate">
        <DisplayName pubkey={peer} name={name} />
      </span>
      {pinned && <Pin className="ml-2 size-3.5 shrink-0 text-muted-foreground" />}
    </CommandItem>
  );
}

/**
 * Share destination picker, for Android plain shares (payload staged by
 * `shareTarget.ts`) and the PWA Web Share Target (`title`/`text`/`url`
 * params). The pick routes the payload through the share stash to that
 * conversation's ChatComposer. Destinations use the quick switcher's
 * local-cache model ({@link buildSwitcherEntries}) plus DMs.
 */
export function SharePage() {
  const intl = useIntl();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Set by an in-app forward (the origin conversation); OS shares fall back to "/".
  const forwardFrom = (useLocation().state as { forwardFrom?: string } | null)?.forwardFrom;
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const liveServers = useNip29Servers();
  const communities = useLiveCommunities();
  const { conversations } = useDm17Conversations({ interactive: true });
  const { pinned } = usePinnedDms();

  // May land after mount: stream copies resolve in the background.
  const [nativeShare, setNativeShare] = useState<SharePayload | null>(pendingSharePreview);
  useEffect(() => onShareStashChanged(() => setNativeShare(pendingSharePreview())), []);

  // Merge Web Share Target params, skipping parts already in `text` (some apps duplicate the URL).
  const rawText = params.get("text") ?? "";
  const title = params.get("title") ?? "";
  const url = params.get("url") ?? "";
  const webText = useMemo(() => {
    const parts: string[] = [];
    if (title && !rawText.includes(title)) parts.push(title);
    if (rawText) parts.push(rawText);
    if (url && !rawText.includes(url)) parts.push(url);
    return parts.join("\n");
  }, [title, rawText, url]);

  const payload = useMemo<SharePayload>(
    () => nativeShare ?? { text: webText, files: [] },
    [nativeShare, webText],
  );
  const hasContent = payload.text.length > 0 || payload.files.length > 0;

  // Same rail-ordered construction as QuickSwitcher.
  const orderedKeys = useMemo(() => {
    const liveKeys = switcherLiveKeys(liveServers, communities);
    const live = new Set(liveKeys);
    return flattenLayout(mergeLayout(config.railLayout, liveKeys)).filter((key) => live.has(key));
  }, [liveServers, communities, config.railLayout]);
  const ctx = useMemo<SwitcherContext>(
    () => ({
      queryClient,
      eventStore,
      communities: new Map(communities.map((c) => [c.community_id, c])),
      self: user?.pubkey,
    }),
    [queryClient, eventStore, communities, user?.pubkey],
  );
  const [entries, setEntries] = useState<SwitcherEntries>(EMPTY_ENTRIES);
  useEffect(() => {
    let live = true;
    void buildSwitcherEntries(orderedKeys, ctx).then((e) => {
      if (live) setEntries(e);
    });
    return () => {
      live = false;
    };
  }, [orderedKeys, ctx]);

  // Pinned first, each block newest-first (like the DM list).
  const dmPeers = useMemo(() => {
    const pinnedSet = new Set(pinned);
    // 1:1 only: rows render as one person; groups would need the DM list's composite row.
    const byRecency = conversations.filter((c) => c.peers.length === 1).map((c) => c.peers[0]);
    const pinnedRanked = byRecency.filter((p) => pinnedSet.has(p));
    for (const p of pinned) if (!pinnedRanked.includes(p)) pinnedRanked.push(p);
    const rest = byRecency.filter((p) => !pinnedSet.has(p));
    return [...pinnedRanked, ...rest].map((peer) => ({ peer, pinned: pinnedSet.has(peer) }));
  }, [conversations, pinned]);

  const pick = (route: string) => {
    if (nativeShare) assignShareRoute(route);
    else stashShare(payload, route);
    navigate(route, { replace: true });
  };

  const dismiss = () => {
    discardShare();
    navigate(forwardFrom ?? "/", { replace: true });
  };

  return (
    <main className="flex-1 min-w-0 overflow-y-auto safe-area-top safe-area-bottom">
      <div className="mx-auto flex min-h-full max-w-xl flex-col gap-4 px-4 py-6">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold leading-tight">
            {forwardFrom
              ? <FormattedMessage id="sharePage.forwardTo" defaultMessage="Forward to…" />
              : <FormattedMessage id="sharePage.shareTo" defaultMessage="Share to…" />}
          </h1>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 touch:size-11"
            aria-label={intl.formatMessage({ id: "sharePage.dismiss", defaultMessage: "Dismiss" })}
            onClick={dismiss}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="bg-chrome clip-corner-lg p-3 space-y-2">
          {payload.text && (
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground/90 leading-relaxed">
              {payload.text}
            </p>
          )}
          {payload.files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatSize(f.size)}</span>
            </div>
          ))}
          {!hasContent && (
            <p className="text-sm italic text-muted-foreground">
              {hasShareTarget()
                ? <FormattedMessage id="sharePage.preparing" defaultMessage="Preparing shared content…" />
                : <FormattedMessage id="sharePage.nothingShared" defaultMessage="Nothing shared" />}
            </p>
          )}
        </div>

        <Command className="bg-chrome clip-corner-lg">
          <CommandInput placeholder={intl.formatMessage({ id: "sharePage.searchPlaceholder", defaultMessage: "Search conversations…" })} autoFocus />
          <CommandList className="max-h-none">
            <CommandEmpty>
              <FormattedMessage id="sharePage.empty" defaultMessage="No conversations found." />
            </CommandEmpty>
            {user && dmPeers.length > 0 && (
              <CommandGroup heading={intl.formatMessage({ id: "sharePage.directMessages", defaultMessage: "Direct messages" })}>
                {dmPeers.map(({ peer, pinned: isPinned }) => (
                  <DmDestination
                    key={peer}
                    peer={peer}
                    pinned={isPinned}
                    onSelect={() => pick(chatRoute({ kind: "dm", peer }))}
                  />
                ))}
              </CommandGroup>
            )}
            {entries.channels.length > 0 && (
              <CommandGroup heading={intl.formatMessage({ id: "sharePage.channels", defaultMessage: "Channels" })}>
                {entries.channels.map((c) => (
                  <CommandItem
                    key={c.key}
                    value={`${c.name} ${c.spaceName} ${c.id}`}
                    onSelect={() => pick(c.route)}
                    className="touch:py-3"
                  >
                    <Hash className="mr-2 size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                    <span className="ml-2 truncate text-xs text-muted-foreground">
                      {c.spaceName}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </div>
    </main>
  );
}

export default SharePage;
