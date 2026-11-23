import { Waypoints } from "lucide-react";
import { useContext } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsNavContext } from "@/components/settings/settingsNav";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useIntl } from "@/i18n";

/** Settings › Direct messages. */
export function DirectMessageSettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const nav = useContext(SettingsNavContext);
  const dmRelayCount = config.dmRelays.length;

  return (
    <>
      <SettingsGroup id="dms">
        {/* Empties every DM subscription's relay set; deletes no conversations and keeps the 10050. */}
        <SettingsRow
          label={intl.formatMessage({ id: "directMessageSettings.turnOff", defaultMessage: "Turn off direct messages" })}
          description={intl.formatMessage({ id: "directMessageSettings.turnOffDescription", defaultMessage: "Stop receiving DMs on all your devices. Existing conversations are kept." })}
        >
          <Switch
            checked={config.dmsDisabled}
            onCheckedChange={(dmsDisabled) => updateConfig((current) => ({ ...current, dmsDisabled }))}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* With DMs disabled, only the master toggle remains. */}
      {!config.dmsDisabled && (
        <>
          <SettingsGroup title={intl.formatMessage({ id: "directMessageSettings.inbox", defaultMessage: "Inbox" })}>
            {/* Display only: hiding the request tier drops no messages. */}
            <SettingsRow
              label={intl.formatMessage({ id: "directMessageSettings.requests", defaultMessage: "Message requests" })}
              description={intl.formatMessage({ id: "directMessageSettings.requestsDescription", defaultMessage: "Show DMs from strangers under Requests. Off hides them." })}
            >
              <Switch
                checked={config.showDmRequests}
                onCheckedChange={(showDmRequests) => updateConfig((current) => ({ ...current, showDmRequests }))}
              />
            </SettingsRow>
            <SettingsRow
              label={intl.formatMessage({ id: "directMessageSettings.previews", defaultMessage: "Message previews" })}
              description={intl.formatMessage({ id: "directMessageSettings.previewsDescription", defaultMessage: "Show the latest message under each conversation in your DM list." })}
            >
              <Switch
                checked={config.showDmPreviews}
                onCheckedChange={(showDmPreviews) => updateConfig((current) => ({ ...current, showDmPreviews }))}
              />
            </SettingsRow>
            <SettingsRow
              label={intl.formatMessage({ id: "directMessageSettings.recentRail", defaultMessage: "Recent DMs in the rail" })}
              description={intl.formatMessage({ id: "directMessageSettings.recentRailDescription", defaultMessage: "Show unread DMs at the top of the server rail." })}
            >
              <Switch
                checked={config.showRecentRailDms}
                onCheckedChange={(showRecentRailDms) => updateConfig((current) => ({ ...current, showRecentRailDms }))}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup
            title={intl.formatMessage({ id: "directMessageSettings.filtering", defaultMessage: "Filtering" })}
            footer={intl.formatMessage({ id: "directMessageSettings.linkFilterFooter", defaultMessage: "Requests from people outside your communities that contain a link are always filtered. Filtered conversations never notify you and stay under Message requests, out of the way." })}
          >
            <SettingsRow
              label={intl.formatMessage({ id: "directMessageSettings.blockNonMembers", defaultMessage: "Only people in my communities" })}
              description={intl.formatMessage({ id: "directMessageSettings.blockNonMembersDescription", defaultMessage: "Filter every request from someone who isn't in one of your communities. People you follow or have written to always get through." })}
            >
              <Switch
                checked={config.blockNonMemberDms}
                onCheckedChange={(blockNonMemberDms) => updateConfig((current) => ({ ...current, blockNonMemberDms }))}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup footer={intl.formatMessage({ id: "directMessageSettings.relaysFooter", defaultMessage: "Where messages from other Nostr apps arrive." })}>
            <SettingsRow
              icon={Waypoints}
              tone="accent2"
              label={intl.formatMessage({ id: "directMessageSettings.messageRelays", defaultMessage: "Message relays" })}
              value={dmRelayCount ? intl.formatNumber(dmRelayCount) : intl.formatMessage({ id: "directMessageSettings.none", defaultMessage: "None" })}
              chevron
              onClick={() => nav.open("relays")}
            />
          </SettingsGroup>
        </>
      )}
    </>
  );
}
