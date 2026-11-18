import type { NostrMetadata } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { FolderGit2, HelpCircle, Loader2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { SearchField } from "@/components/ui/search-field";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { searchGitRepositories, useGitRepositoryDirectory } from "@/hooks/useGitRepositoryDirectory";
import type { GitRepositoryAnnouncement } from "@/lib/gitActivity";
import { resolveGitRepositoryAnnouncement } from "@/lib/gitRepositoryResolver";
import { cn } from "@/lib/utils";

export interface PickedRepository {
  coordinate: string;
  relayHints: string[];
  displayName: string;
  identifier: string;
  owner: string;
}

/** Profile name or truncated npub — never "Anonymous". */
function useOwnerName(pubkey: string): string {
  const author = useAuthor(pubkey);
  return profileName(author.data?.metadata) ?? shortNpub(pubkey);
}

function profileName(metadata: NostrMetadata | undefined): string | undefined {
  return metadata?.name || metadata?.display_name || undefined;
}

function shortNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey).slice(0, 9);
  } catch {
    return pubkey.slice(0, 8);
  }
}

export function OwnerAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const name = useOwnerName(pubkey);
  return (
    <Avatar className={cn("size-8 shrink-0 border border-border/60", className)}>
      <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="text-3xs font-semibold">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** "owner / repo": same-named forks are otherwise indistinguishable. */
export function OwnerSlashRepo({ owner, name, className }: { owner: string; name: string; className?: string }) {
  const author = useAuthor(owner);
  const named = profileName(author.data?.metadata);
  return (
    <span className={cn("block truncate text-sm", className)}>
      <span className="text-muted-foreground">
        {named
          ? <DisplayName pubkey={owner} name={named} tags={author.data?.event?.tags ?? []} />
          : shortNpub(owner)}
      </span>
      <span className="text-muted-foreground/60"> / </span>
      <span className="font-semibold text-foreground">{name}</span>
    </span>
  );
}

function RepositoryRow({ repository, connected, onSelect }: { repository: GitRepositoryAnnouncement; connected: boolean; onSelect: () => void }) {
  const intl = useIntl();
  const subtitle = connected
    ? intl.formatMessage({ id: "repositoryPicker.alreadyConnected", defaultMessage: "Already connected to this community" })
    : repository.description;
  return (
    <button
      type="button"
      disabled={connected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 clip-corner px-2.5 py-2 text-left transition-colors",
        connected ? "opacity-50" : "hover:bg-foreground/[0.05]",
      )}
    >
      <OwnerAvatar pubkey={repository.owner} />
      <span className="min-w-0 flex-1">
        <OwnerSlashRepo owner={repository.owner} name={repository.name} />
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
    </button>
  );
}

/** Find a NIP-34 repository by searching the ngit directory or pasting an naddr / nostr:// address. */
export function RepositoryPicker({ connectedCoordinates, onSelect, autoFocus = true, className }: {
  connectedCoordinates: ReadonlySet<string>;
  onSelect: (repository: PickedRepository) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const intl = useIntl();
  const { nostr } = useNostr();
  const [query, setQuery] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const directory = useGitRepositoryDirectory(true);
  const looksLikeAddress = /^(naddr1|nostr:)/i.test(query.trim());
  const results = useMemo(
    () => (looksLikeAddress ? [] : searchGitRepositories(directory.data ?? [], query, 8)),
    [directory.data, query, looksLikeAddress],
  );

  const choose = useCallback((repository: GitRepositoryAnnouncement) => {
    setError(null);
    onSelect({
      coordinate: repository.address.coordinate,
      relayHints: repository.relays,
      displayName: repository.name,
      identifier: repository.identifier,
      owner: repository.owner,
    });
  }, [onSelect]);

  const resolveAddress = useCallback(async () => {
    setError(null);
    setResolving(true);
    try {
      const resolved = await resolveGitRepositoryAnnouncement(nostr, query.trim());
      if (connectedCoordinates.has(resolved.address.coordinate)) {
        setError(t({ id: "repositoryPicker.alreadyConnectedError", defaultMessage: "This repository is already connected." }));
        return;
      }
      onSelect({
        coordinate: resolved.address.coordinate,
        relayHints: resolved.relayHints,
        displayName: resolved.announcement.name,
        identifier: resolved.address.identifier,
        owner: resolved.address.owner,
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t({ id: "repositoryPicker.resolveFailed", defaultMessage: "Couldn't resolve that repository address." }),
      );
    } finally {
      setResolving(false);
    }
  }, [nostr, query, connectedCoordinates, onSelect]);

  return (
    <div className={cn("min-w-0 space-y-2.5", className)}>
      <div className="flex items-center gap-1">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={intl.formatMessage({ id: "repositoryPicker.searchPlaceholder", defaultMessage: "Search, or paste an address" })}
          autoFocus={autoFocus}
          disabled={resolving}
          busy={resolving}
          className="flex-1"
        />
        {/* Beside the field, not its `hint`: the hint is non-interactive and hides once typing starts. */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={intl.formatMessage({ id: "repositoryPicker.whatCanIPaste", defaultMessage: "What can I paste?" })}
                className="flex size-9 touch:size-11 shrink-0 items-center justify-center clip-corner-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <HelpCircle className="size-4" />
              </button>
            </TooltipTrigger>
            {/* Above the dialog this usually sits in (z-[250]). */}
            <TooltipContent side="top" className="z-[260] max-w-60 text-center text-xs">
              <FormattedMessage
                id="repositoryPicker.pasteHint"
                defaultMessage="Search the public ngit directory by name, or paste a repository address: an <mono>naddr1…</mono> or an <mono>nostr://</mono> remote from your git client."
                values={{ mono: (chunks) => <span className="font-mono">{chunks}</span> }}
              />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="max-h-64 min-w-0 space-y-0.5 overflow-y-auto clip-corner-lg bg-secondary/40 p-1">
        {looksLikeAddress ? (
          <button
            type="button"
            disabled={resolving}
            onClick={() => void resolveAddress()}
            className="flex w-full min-w-0 items-center gap-2.5 clip-corner px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.05]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center clip-corner bg-muted/60">
              {resolving ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <FolderGit2 className="size-4 text-muted-foreground" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{resolving
                  ? <FormattedMessage id="repositoryPicker.resolving" defaultMessage="Resolving address…" />
                  : <FormattedMessage id="repositoryPicker.useAddress" defaultMessage="Use this repository address" />}</span>
              <span className="block truncate text-xs text-muted-foreground">{query.trim()}</span>
            </span>
          </button>
        ) : directory.isLoading ? (
          <p className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <FormattedMessage id="repositoryPicker.loadingDirectory" defaultMessage="Loading the public repository directory…" />
          </p>
        ) : results.length > 0 ? (
          <>
            {!query.trim() && (
              <p className="px-2.5 pt-1.5 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                <FormattedMessage id="repositoryPicker.recentlyAnnounced" defaultMessage="Recently announced" />
              </p>
            )}
            {results.map((repository) => (
              <RepositoryRow
                key={repository.address.coordinate}
                repository={repository}
                connected={connectedCoordinates.has(repository.address.coordinate)}
                onSelect={() => choose(repository)}
              />
            ))}
          </>
        ) : (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            {directory.isError ? (
              <FormattedMessage
                id="repositoryPicker.directoryUnreachable"
                defaultMessage="Couldn't reach the repository directory. You can still paste an naddr or nostr:// address."
              />
            ) : (
              <FormattedMessage
                id="repositoryPicker.noMatches"
                defaultMessage="No repositories match. Try another name, or paste an naddr / nostr:// address."
              />
            )}
          </p>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
