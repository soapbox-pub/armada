import { Loader2, ShieldOff } from "lucide-react";
import { useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { useModeration } from "@/concord/hooks/useModeration";
import type { Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { tryNpubEncode } from "@/lib/safeNip19";

/** CORD-04 §4 banlist; the ONLY unban surface since the roster fold hides banned members. */
export function BannedView({ community }: { community: Community }) {
  const intl = useIntl();
  const { banned, unban, canBan } = useModeration(community, []);
  const [pending, setPending] = useState<string | null>(null);

  const handleUnban = async (pubkey: string) => {
    setPending(pubkey);
    try {
      await unban({ target: pubkey });
      toast({
        title: t({ id: "bannedView.unbanned", defaultMessage: "Member unbanned" }),
        description: t({ id: "bannedView.unbannedDescription", defaultMessage: "They can take part in the community again." }),
      });
    } catch (e) {
      toast({
        title: t({ id: "bannedView.unbanFailed", defaultMessage: "Couldn't unban" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPending(null);
    }
  };

  const list = [...banned].sort();

  return (
    <SettingsGroup
      title={intl.formatMessage({ id: "bannedView.title", defaultMessage: "Banned" })}
      footer={intl.formatMessage({ id: "bannedView.intro", defaultMessage: "Banned members are silenced and hidden for everyone in this community. Unbanning lets them take part again." })}
    >
      {list.length === 0 ? (
        <SettingsRow>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="bannedView.empty" defaultMessage="Nobody is banned." />
          </p>
        </SettingsRow>
      ) : (
        list.map((pubkey) => (
          <BannedRow
            key={pubkey}
            pubkey={pubkey}
            canUnban={canBan(pubkey)}
            busy={pending === pubkey}
            onUnban={() => void handleUnban(pubkey)}
          />
        ))
      )}
    </SettingsGroup>
  );
}

function BannedRow({
  pubkey,
  canUnban,
  busy,
  onUnban,
}: {
  pubkey: string;
  canUnban: boolean;
  busy: boolean;
  onUnban: () => void;
}) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  const npub = tryNpubEncode(pubkey);
  return (
    <SettingsRow className="flex items-center gap-3">
      <UserAvatar pubkey={pubkey} metadata={author.data?.metadata} imeta={author.data?.imeta?.picture} name={name} className="size-8 shrink-0" fallbackClassName="text-xs" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">
          <DisplayName pubkey={pubkey} name={name} />
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : pubkey.slice(0, 16)}
        </div>
      </div>
      {canUnban && (
        <Button type="button" size="sm" variant="secondary" className="clip-corner-lg h-8 shrink-0 touch:h-11" disabled={busy} onClick={onUnban}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldOff className="size-3.5" />}
          <FormattedMessage id="bannedView.unban" defaultMessage="Unban" />
        </Button>
      )}
    </SettingsRow>
  );
}
