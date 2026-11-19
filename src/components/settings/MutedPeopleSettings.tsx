import { Loader2, UserCheck } from "lucide-react";
import { useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useMutedPubkeys, useUnmuteUser } from "@/hooks/useMuteList";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t } from "@/i18n";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";

const NO_TAGS: string[][] = [];

function MutedRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, pubkey);
  const npub = tryNpubEncode(pubkey);
  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : pubkey.slice(0, 16);
  const unmute = useUnmuteUser();
  const [busy, setBusy] = useState(false);

  const onUnmute = async () => {
    setBusy(true);
    try {
      await unmute.mutateAsync(pubkey);
      toast({
        title: t({ id: "mutedPeopleSettings.unblocked", defaultMessage: "Unblocked" }),
        description: t({ id: "mutedPeopleSettings.unblockedDescription", defaultMessage: "You'll see {name} again." }, { name: displayName }),
      });
    } catch (e) {
      toast({
        title: t({ id: "mutedPeopleSettings.unblockFailed", defaultMessage: "Couldn't unblock" }),
        description: e instanceof Error ? e.message : t({ id: "mutedPeopleSettings.unblockFailedDescription", defaultMessage: "Failed to update your block list." }),
        variant: "destructive",
      });
      setBusy(false);
    }
    // On success the row unmounts, so `busy` is never cleared.
  };

  return (
    <SettingsRow className="flex items-center gap-3">
      <UserAvatar
        pubkey={pubkey}
        metadata={metadata}
        imeta={author.data?.imeta?.picture}
        name={displayName}
        className="size-8 shrink-0"
        fallbackClassName="text-xs"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">
          <DisplayName pubkey={pubkey} name={displayName} tags={author.data?.event?.tags ?? NO_TAGS} metadata={metadata} />
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">{shortNpub}</div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="clip-corner-lg h-8 shrink-0"
        disabled={busy}
        onClick={onUnmute}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
        <FormattedMessage id="mutedPeopleSettings.unblock" defaultMessage="Unblock" />
      </Button>
    </SettingsRow>
  );
}

/**
 * The only place to review mutes: muting is quiet everywhere else, so a
 * misclick would otherwise be invisible and permanent. Shows both NIP-44
 * private and public kind-10000 entries.
 */
export function MutedPeopleSettings() {
  const { mutedPubkeys, ready } = useMutedPubkeys();
  const pubkeys = [...mutedPubkeys].sort();

  if (!ready) {
    return (
      <SettingsRow>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <FormattedMessage id="mutedPeopleSettings.loading" defaultMessage="Loading your block list…" />
        </div>
      </SettingsRow>
    );
  }

  if (pubkeys.length === 0) {
    return (
      <SettingsRow>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="mutedPeopleSettings.empty" defaultMessage="You haven't blocked anyone." />
        </p>
      </SettingsRow>
    );
  }

  return (
    <>
      {pubkeys.map((pubkey) => (
        <MutedRow key={pubkey} pubkey={pubkey} />
      ))}
    </>
  );
}
