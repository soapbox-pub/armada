import { useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop";
import { useIntl } from "@/i18n";

/** A native delivery check: Chromium's permission does not describe macOS authorization. */
export function DesktopNotificationTest() {
  const intl = useIntl();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const bridge = desktop();
  if (!bridge?.showNotification) return null;

  const send = async () => {
    setState("sending");
    try {
      await bridge.showNotification!({
        title: "Armada",
        body: intl.formatMessage({ id: "desktopNotificationTest.body", defaultMessage: "Message previews will appear here." }),
        tag: "armada-notification-test",
        url: "/settings",
      });
      setState("sent");
    } catch {
      setState("failed");
    }
  };

  return (
    <SettingsGroup>
      <SettingsRow
        stack
        label={intl.formatMessage({ id: "desktopNotificationTest.label", defaultMessage: "Test notification" })}
        description={intl.formatMessage({ id: "desktopNotificationTest.description", defaultMessage: "Send a test banner to check permissions and message previews." })}
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={state === "sending"} onClick={() => void send()}>
            {intl.formatMessage({ id: "desktopNotificationTest.send", defaultMessage: "Send test" })}
          </Button>
          {bridge.openNotificationSettings && (
            <Button variant="secondary" onClick={() => void bridge.openNotificationSettings!().catch(() => {})}>
              {intl.formatMessage({ id: "desktopNotificationTest.settings", defaultMessage: "Open macOS settings" })}
            </Button>
          )}
        </div>
        <p role="status" className={state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {state === "sent" && intl.formatMessage({ id: "desktopNotificationTest.sent", defaultMessage: "Test sent. If no banner appears, check macOS notification settings." })}
          {state === "failed" && intl.formatMessage({ id: "desktopNotificationTest.failed", defaultMessage: "macOS couldn't deliver the notification. Check Armada's notification settings." })}
        </p>
      </SettingsRow>
    </SettingsGroup>
  );
}
