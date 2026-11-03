import { LifeBuoy, SpellCheck, UserX } from "lucide-react";
import { useContext } from "react";

import { DiscoverCurationSettings } from "@/components/settings/DiscoverCurationSettings";
import { MediaPrivacySettings } from "@/components/settings/MediaPrivacySettings";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsNavContext } from "@/components/settings/settingsNav";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useIntl } from "@/i18n";

/** Settings › Privacy & safety: who and what is hidden, what loads without asking, and links. */
export function PrivacySettings() {
  const intl = useIntl();
  const none = intl.formatMessage({ id: "privacySettings.none", defaultMessage: "None" });
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const nav = useContext(SettingsNavContext);
  const { mutedPubkeys, ready } = useMutedPubkeys();

  return (
    <>
      {user && (
        <SettingsGroup
          title={intl.formatMessage({ id: "privacySettings.blocking", defaultMessage: "Blocking" })}
          info={intl.formatMessage({ id: "privacySettings.blockingInfo", defaultMessage: "Blocked people and muted words are hidden everywhere in Armada. Only you see these lists, and nobody is told." })}
        >
          {/* The only place to unblock: blocked people appear in no other list. */}
          <SettingsRow
            icon={UserX}
            tone="destructive"
            label={intl.formatMessage({ id: "privacySettings.blockedPeople", defaultMessage: "Blocked people" })}
            value={ready ? (mutedPubkeys.size ? intl.formatNumber(mutedPubkeys.size) : none) : undefined}
            chevron
            onClick={() => nav.open("blocked")}
          />
          <SettingsRow
            icon={SpellCheck}
            tone="warning"
            label={intl.formatMessage({ id: "privacySettings.mutedWords", defaultMessage: "Muted words" })}
            value={config.mutedWords.length ? intl.formatNumber(config.mutedWords.length) : none}
            chevron
            onClick={() => nav.open("muted-words")}
          />
        </SettingsGroup>
      )}

      <SettingsGroup id="media" title={intl.formatMessage({ id: "privacySettings.media", defaultMessage: "Media" })}>
        <MediaPrivacySettings />
      </SettingsGroup>

      <SettingsGroup id="links" title={intl.formatMessage({ id: "privacySettings.links", defaultMessage: "Links" })}>
        <SettingsRow
          label={intl.formatMessage({ id: "privacySettings.cleanLinks", defaultMessage: "Clean up links" })}
          description={intl.formatMessage({ id: "privacySettings.cleanLinksDescription", defaultMessage: "Strip tracking parameters like utm_ and ?si= from links." })}
        >
          <Switch
            checked={config.stripTrackingParams}
            onCheckedChange={(stripTrackingParams) =>
              updateConfig((current) => ({ ...current, stripTrackingParams }))}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup id="discover" title={intl.formatMessage({ id: "privacySettings.discover", defaultMessage: "Discover" })}>
        <SettingsRow
          label={intl.formatMessage({ id: "privacySettings.showDiscover", defaultMessage: "Show Discover button" })}
          description={intl.formatMessage({ id: "privacySettings.showDiscoverDescription", defaultMessage: "Show the compass in the server list. Off, Discover stays out of the way." })}
        >
          <Switch
            checked={config.showDiscover}
            onCheckedChange={(showDiscover) =>
              updateConfig((current) => ({ ...current, showDiscover }))}
          />
        </SettingsRow>
        <DiscoverCurationSettings />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          icon={LifeBuoy}
          tone="success"
          label={intl.formatMessage({ id: "privacySettings.helpSafety", defaultMessage: "Help & safety" })}
          description={intl.formatMessage({ id: "privacySettings.helpSafetyDescription", defaultMessage: "Blocking, hiding, muted words, reporting and getting help." })}
          to="/support"
        />
      </SettingsGroup>
    </>
  );
}
