import { useEffect, useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormattedMessage, useIntl } from "@/i18n";
import {
  getDesktopWebUpdateState,
  restartForDesktopWebUpdate,
  setDesktopWebUpdateChannel,
  type DesktopWebUpdateState,
} from "@/lib/desktop";

import type { WebUpdateChannel } from "@/lib/desktopUpdate";

/**
 * Which web deploys the desktop app follows (electron/webUpdateChannel.js).
 * Hidden on the web, on shells without the setting, and on store editions,
 * whose code comes from the store.
 */
export function WebUpdateSettings() {
  const intl = useIntl();
  const [state, setState] = useState<DesktopWebUpdateState | null>(null);

  useEffect(() => {
    let active = true;
    void getDesktopWebUpdateState().then((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!state) return null;

  const label = intl.formatMessage({ id: "webUpdateSettings.label", defaultMessage: "App updates" });
  const description = intl.formatMessage(
    {
      id: "webUpdateSettings.description",
      defaultMessage: "{channel, select, release {Only stable releases. Changes made since the last release wait until the next one.} off {Keep this version. Armada won't update until you change this.} other {Every update as soon as it's published, including changes not yet in a release.}}",
    },
    { channel: state.channel },
  );

  return (
    <SettingsRow label={label} description={description}>
      <div className="flex items-center gap-2">
        {state.pending && state.channel !== "off" && (
          <Button variant="secondary" size="sm" className="touch:h-11" onClick={restartForDesktopWebUpdate}>
            <FormattedMessage id="webUpdateSettings.restart" defaultMessage="Restart to update" />
          </Button>
        )}
        <Select
          value={state.channel}
          onValueChange={(value) => {
            const channel = value as WebUpdateChannel;
            setState((prev) => (prev ? { ...prev, channel, pending: channel === "off" ? false : prev.pending } : prev));
            void setDesktopWebUpdateChannel(channel).then((s) => s && setState(s));
          }}
        >
          <SelectTrigger className="w-40 shrink-0" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="release"><FormattedMessage id="webUpdateSettings.release" defaultMessage="Releases only" /></SelectItem>
            <SelectItem value="latest"><FormattedMessage id="webUpdateSettings.latest" defaultMessage="Every update" /></SelectItem>
            <SelectItem value="off"><FormattedMessage id="webUpdateSettings.off" defaultMessage="Off" /></SelectItem>
          </SelectContent>
        </Select>
      </div>
    </SettingsRow>
  );
}
