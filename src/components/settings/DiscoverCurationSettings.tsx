import { Globe, List, Plus, RotateCcw, Users, X } from "lucide-react";
import { useState } from "react";

import { AvatarInitial } from "@/components/AvatarInitial";
import { InfoTip, SettingsRow } from "@/components/settings/SettingsSection";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDiscoverEveryoneAllowed } from "@/hooks/useDiscover";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import {
  ARMADA_DEVELOPERS,
  ARMADA_DEVELOPERS_ENTRY,
  BUILD_DISCOVER_CURATION,
  DISCOVER_CURATION_NONE,
  curationEntries,
  curationKey,
  isDevelopersEntry,
  parseDiscoverCuration,
  parseDiscoverCurations,
  storeCurationEntries,
} from "@/lib/discoverSource";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";
import { cn } from "@/lib/utils";

/** A pubkey's profile name, or a shortened npub while it has none. */
function OwnerName({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = data?.metadata?.name || data?.metadata?.display_name;
  if (name) return <span className="font-medium text-foreground">{name}</span>;
  const npub = tryNpubEncode(pubkey);
  return <span className="font-mono">{npub ? `${npub.slice(0, 12)}…` : pubkey.slice(0, 8)}</span>;
}

function OwnerAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  return (
    <Avatar shape={getAvatarShape(metadata)} className={cn("size-8 shrink-0", className)}>
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-primary text-3xs">
        <AvatarInitial name={name} pubkey={pubkey} />
      </AvatarFallback>
    </Avatar>
  );
}

/** The curators in effect, as stored entries: the override, else the build's. */
function entriesOf(stored: string): string[] {
  const value = stored.trim() || BUILD_DISCOVER_CURATION;
  return value.toLowerCase() === DISCOVER_CURATION_NONE ? [] : curationEntries(value);
}

/** What an entry dedupes by: the developers as one, a source by what it reads. */
function entryKey(entry: string): string {
  if (isDevelopersEntry(entry)) return ARMADA_DEVELOPERS_ENTRY;
  const parsed = parseDiscoverCuration(entry);
  return parsed.ok ? curationKey(parsed.curation) : entry;
}

/** One curator: who they are, and what of theirs Discover reads. Wraps, never truncates. */
function CuratorRow({ entry, onRemove }: { entry: string; onRemove: () => void }) {
  const intl = useIntl();
  const parsed = isDevelopersEntry(entry) ? undefined : parseDiscoverCuration(entry);
  let art;
  let body;
  if (isDevelopersEntry(entry)) {
    art = (
      <span className="flex shrink-0 -space-x-3">
        {ARMADA_DEVELOPERS.map((pk) => <OwnerAvatar key={pk} pubkey={pk} className="ring-2 ring-card" />)}
      </span>
    );
    body = (
      <>
        <p className="text-sm font-medium">
          <FormattedMessage id="discoverCuration.developers" defaultMessage="Armada Developers" />
        </p>
        <p className="break-words text-xs text-muted-foreground">
          <FormattedMessage
            id="discoverCuration.developersDetail"
            defaultMessage="{names}, and who they follow"
            values={{ names: intl.formatList(ARMADA_DEVELOPERS.map((pk) => <OwnerName key={pk} pubkey={pk} />), { type: "conjunction" }) }}
          />
        </p>
      </>
    );
  } else if (parsed?.ok && parsed.curation.type === "follows") {
    art = <OwnerAvatar pubkey={parsed.curation.pubkey} />;
    body = (
      <>
        <p className="break-words text-sm"><OwnerName pubkey={parsed.curation.pubkey} /></p>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage id="discoverCuration.seedDetail" defaultMessage="And who they follow" />
        </p>
      </>
    );
  } else if (parsed?.ok && parsed.curation.type === "list") {
    art = <IconTile icon={List} />;
    body = (
      <p className="break-words text-sm">
        <FormattedMessage
          id="discoverCuration.listBy"
          defaultMessage="A list by {name}"
          values={{ name: <OwnerName pubkey={parsed.curation.pubkey} /> }}
        />
      </p>
    );
  } else {
    art = <span className="size-8 shrink-0" />;
    body = (
      <>
        <p className="break-all font-mono text-xs">{entry}</p>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage id="discoverCuration.unreadable" defaultMessage="Couldn't read this entry" />
        </p>
      </>
    );
  }
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 clip-corner-lg bg-background/40">
      {art}
      <div className="min-w-0 flex-1 self-center">{body}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 touch:size-11 shrink-0 text-muted-foreground"
        aria-label={intl.formatMessage({ id: "discoverCuration.remove", defaultMessage: "Remove curator" })}
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
    </li>
  );
}

/** The unfiltered switch, while on: listed where curation lives, removed like a curator. */
function EveryoneRow({ onRemove }: { onRemove: () => void }) {
  const intl = useIntl();
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 clip-corner-lg bg-warning/10">
      <span className="flex size-8 shrink-0 items-center justify-center clip-corner-lg bg-warning/15 text-warning">
        <Globe className="size-4" />
      </span>
      <div className="min-w-0 flex-1 self-center">
        <p className="text-sm font-medium">
          <FormattedMessage id="discoverCuration.everyone" defaultMessage="Unfiltered" />
        </p>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage id="discoverCuration.everyoneDetail" defaultMessage="Anyone's listings. This device only." />
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 touch:size-11 shrink-0 text-muted-foreground"
        aria-label={intl.formatMessage({ id: "discoverCuration.removeEveryone", defaultMessage: "Turn off unfiltered" })}
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
    </li>
  );
}

function IconTile({ icon: Icon }: { icon: typeof Users }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center clip-corner-lg bg-secondary text-muted-foreground">
      <Icon className="size-4" />
    </span>
  );
}

/**
 * Discover's curators (`lib/discoverSource.ts`): whose picks, and whose follows'
 * picks, Discover shows besides the viewer's own network. Only changes what this
 * client reads.
 */
export function DiscoverCurationSettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  // Signed out Discover is never unvetted, so there's nothing to offer.
  const unfilteredOffered = useDiscoverEveryoneAllowed() && !!user;
  const overridden = config.discoverCuration.trim() !== "";
  const entries = entriesOf(config.discoverCuration);
  const hasDevelopers = entries.some(isDevelopersEntry);
  const unfiltered = unfilteredOffered && config.discoverUnfiltered && config.discoverCuration.trim().toLowerCase() === DISCOVER_CURATION_NONE;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmUnfiltered, setConfirmUnfiltered] = useState(false);

  const setCuration = (discoverCuration: string) => {
    updateConfig((current) => ({ ...current, discoverCuration }));
  };
  const setEntries = (next: string[]) => {
    setCuration(storeCurationEntries(next));
    // A stale switch must not come back on with the last curator removed.
    if (next.length === 0 && config.discoverUnfiltered) setUnfiltered(false);
  };
  const setUnfiltered = (discoverUnfiltered: boolean) => {
    updateConfig((current) => ({ ...current, discoverUnfiltered }));
  };

  const add = () => {
    const parsed = parseDiscoverCurations(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (parsed.none) {
      setCuration(DISCOVER_CURATION_NONE);
      if (unfilteredOffered && !config.discoverUnfiltered) setConfirmUnfiltered(true);
    } else {
      const seen = new Set(entries.map(entryKey));
      const added = curationEntries(draft).filter((entry) => {
        const key = entryKey(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setEntries([...entries, ...added]);
      // Unfiltered applies only with no curators.
      if (added.length > 0 && config.discoverUnfiltered) setUnfiltered(false);
    }
    setDraft("");
    setError(null);
  };

  return (
    <>
      {/* One group child, so the group draws no border between the label and its list. */}
      <div>
        <SettingsRow
          label={intl.formatMessage({ id: "discoverCuration.label", defaultMessage: "Curators" })}
          description={intl.formatMessage({
            id: "discoverCuration.description",
            defaultMessage: "Discover shows what your curators and the people they follow have shared, alongside your own network.",
          })}
        />
        {/* The list takes the row's full width, so names wrap instead of truncating. */}
        <SettingsRow className="pt-0">
          <div className="space-y-2">
            {entries.length > 0 ? (
              <ul className="space-y-1">
                {entries.map((entry, i) => (
                  <CuratorRow key={`${i}:${entry}`} entry={entry} onRemove={() => setEntries(entries.filter((_, j) => j !== i))} />
                ))}
              </ul>
            ) : unfiltered ? (
              <ul>
                <EveryoneRow onRemove={() => setUnfiltered(false)} />
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                <Users className="size-3.5 shrink-0" />
                <FormattedMessage id="discoverCuration.empty" defaultMessage="No curators. Only your network." />
                {unfilteredOffered && (
                  <InfoTip
                    label={intl.formatMessage({ id: "discoverCuration.unfilteredInfoLabel", defaultMessage: "About no curators" })}
                    className="-my-1"
                  >
                    <FormattedMessage
                      id="discoverCuration.unfilteredInfo"
                      defaultMessage="With no curators, Discover shows only what you, the people you follow and the people they follow have shared."
                    />{" "}
                    <span className="mt-2 block text-2xs text-muted-foreground/70">
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-muted-foreground"
                        onClick={() => setConfirmUnfiltered(true)}
                      >
                        <FormattedMessage id="discoverCuration.showEveryone" defaultMessage="Turn off filtering" />
                      </button>
                    </span>
                  </InfoTip>
                )}
              </p>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <Input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                placeholder={intl.formatMessage({ id: "discoverCuration.placeholder", defaultMessage: "npub1… or naddr1…" })}
                aria-label={intl.formatMessage({ id: "discoverCuration.addLabel", defaultMessage: "Add a curator" })}
                aria-invalid={error ? true : undefined}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-base md:text-sm bg-background/40 border-transparent"
              />
              <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
                <Plus className="size-4" />
                <FormattedMessage id="discoverCuration.add" defaultMessage="Add" />
              </Button>
            </form>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex flex-wrap -ml-2">
              {!hasDevelopers && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setEntries([ARMADA_DEVELOPERS_ENTRY, ...entries])}
                >
                  <Plus className="size-3.5 mr-1.5" />
                  <FormattedMessage id="discoverCuration.addDevelopers" defaultMessage="Add Armada Developers" />
                </Button>
              )}
              {overridden && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    setCuration("");
                    if (config.discoverUnfiltered) setUnfiltered(false);
                  }}
                >
                  <RotateCcw className="size-3.5 mr-1.5" />
                  <FormattedMessage id="discoverCuration.reset" defaultMessage="Reset to default" />
                </Button>
              )}
            </div>
          </div>
        </SettingsRow>
      </div>
      <AlertDialog open={confirmUnfiltered} onOpenChange={setConfirmUnfiltered}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <FormattedMessage id="discoverUnfiltered.confirmTitle" defaultMessage="Unfiltered Discover" />
            </AlertDialogTitle>
            <AlertDialogDescription>
              <FormattedMessage
                id="discoverUnfiltered.confirmDescription"
                defaultMessage="Armada does not review, moderate or endorse unfiltered listings. They may include spam, scams, and offensive or illegal content. You view them at your own risk; Armada and its developers are not responsible for them."
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <FormattedMessage {...common.cancel} />
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setCuration(DISCOVER_CURATION_NONE);
                setUnfiltered(true);
              }}
            >
              <FormattedMessage id="discoverUnfiltered.confirm" defaultMessage="I understand" />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
