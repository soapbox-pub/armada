import { useEffect, useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FormattedMessage, useIntl } from "@/i18n";
import {
  getDesktopLowMemoryState,
  relaunchDesktop,
  setDesktopLowMemoryMode,
  type DesktopLowMemoryState,
} from "@/lib/desktop";

/** Desktop low memory mode (electron/lowMemory.js). Hides on shells without it. */
export function LowMemorySettings() {
  const intl = useIntl();
  const [state, setState] = useState<DesktopLowMemoryState | null>(null);

  useEffect(() => {
    let active = true;
    void getDesktopLowMemoryState().then((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!state) return null;

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "lowMemorySettings.label", defaultMessage: "Low memory mode" })}
      description={
        state.restartRequired
          ? intl.formatMessage({ id: "lowMemorySettings.restart", defaultMessage: "Takes effect when Armada restarts." })
          : intl.formatMessage({ id: "lowMemorySettings.description", defaultMessage: "Uses less memory, but the app runs a little slower." })
      }
    >
      <div className="flex items-center gap-2">
        {state.restartRequired && (
          <Button variant="secondary" size="sm" className="touch:h-11" onClick={relaunchDesktop}>
            <FormattedMessage id="lowMemorySettings.restartNow" defaultMessage="Restart" />
          </Button>
        )}
        <Switch
          checked={state.configured}
          onCheckedChange={(on) => {
            setState((prev) => (prev ? { ...prev, configured: on, restartRequired: on !== prev.active } : prev));
            void setDesktopLowMemoryMode(on).then((s) => s && setState(s));
          }}
        />
      </div>
    </SettingsRow>
  );
}
