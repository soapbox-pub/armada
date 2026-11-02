import { Capacitor } from "@capacitor/core";

import { QuickReactionsSettings } from "@/components/settings/QuickReactionsSettings";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useIntl } from "@/i18n";
import { sendsOnEnter } from "@/lib/sendOnEnter";

/** Settings › Chats: composing, typing status and reactions, everywhere you chat. */
export function ChatSettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();

  /** Toggle send-on-Enter, stored per device class — see AppConfig.sendOnEnter. */
  const setSendOnEnter = (value: boolean) => {
    const key = isTouch ? "touch" : "desktop";
    updateConfig((current) => ({
      ...current,
      sendOnEnter: { ...current.sendOnEnter, [key]: value },
    }));
  };

  return (
    <>
      <SettingsGroup id="chat">
        <SettingsRow
          label={intl.formatMessage({ id: "chatSettings.sendWithEnter", defaultMessage: "Send with Enter" })}
          description={
            isTouch
              ? intl.formatMessage({ id: "chatSettings.sendWithEnterTouch", defaultMessage: "Enter sends the message. Off, Enter is a new line and you send with the button." })
              : intl.formatMessage({ id: "chatSettings.sendWithEnterDesktop", defaultMessage: "Enter sends; Shift+Enter for a new line. Off, Ctrl/Cmd+Enter sends." })
          }
        >
          <Switch
            checked={sendsOnEnter(config.sendOnEnter, isTouch)}
            onCheckedChange={setSendOnEnter}
          />
        </SettingsRow>
        <SettingsRow
          label={intl.formatMessage({ id: "chatSettings.typingIndicators", defaultMessage: "Typing indicators" })}
          description={intl.formatMessage({ id: "chatSettings.typingIndicatorsDescription", defaultMessage: "Share and see typing status in DMs and channels." })}
        >
          <Switch
            checked={config.dmTypingIndicators}
            onCheckedChange={(dmTypingIndicators) =>
              updateConfig((current) => ({ ...current, dmTypingIndicators }))}
          />
        </SettingsRow>
        {!isTouch && (
          <SettingsRow
            label={intl.formatMessage({ id: "chatSettings.hoverActions", defaultMessage: "Message actions on hover" })}
            description={intl.formatMessage({ id: "chatSettings.hoverActionsDescription", defaultMessage: "Show reactions and actions when hovering a message. Off, right-click a message for them." })}
          >
            <Switch
              checked={config.messageHoverActions}
              onCheckedChange={(messageHoverActions) =>
                updateConfig((current) => ({ ...current, messageHoverActions }))}
            />
          </SettingsRow>
        )}
        <SettingsRow
          label={intl.formatMessage({ id: "chatSettings.replyGestures", defaultMessage: "Reply gestures" })}
          description={
            isTouch
              ? intl.formatMessage({ id: "chatSettings.replyGesturesTouch", defaultMessage: "Swipe a message to reply to it. Off, reply from the message's menu." })
              : intl.formatMessage({ id: "chatSettings.replyGesturesDesktop", defaultMessage: "Double-click a message to reply to it. Off, double-click selects a word as usual." })
          }
        >
          <Switch
            checked={config.replyGestures}
            onCheckedChange={(replyGestures) =>
              updateConfig((current) => ({ ...current, replyGestures }))}
          />
        </SettingsRow>
        <SettingsRow
          label={intl.formatMessage({ id: "chatSettings.absoluteTimestamps", defaultMessage: "Show message times" })}
          description={intl.formatMessage({ id: "chatSettings.absoluteTimestampsDescription", defaultMessage: "Show the time each message was sent, like 3:07 PM, instead of how long ago." })}
        >
          <Switch
            checked={config.absoluteTimestamps}
            onCheckedChange={(absoluteTimestamps) =>
              updateConfig((current) => ({ ...current, absoluteTimestamps }))}
          />
        </SettingsRow>
        <SettingsRow
          label={intl.formatMessage({ id: "chatSettings.foldSimilar", defaultMessage: "Fold similar messages" })}
          description={intl.formatMessage({ id: "chatSettings.foldSimilarDescription", defaultMessage: "Collapse bursts of near-identical messages in communities into one row. Off, every message is shown." })}
        >
          <Switch
            checked={config.foldSimilarMessages}
            onCheckedChange={(foldSimilarMessages) =>
              updateConfig((current) => ({ ...current, foldSimilarMessages }))}
          />
        </SettingsRow>
        {Capacitor.getPlatform() === "android" && (
          // Per-device: leave the app vs. walk history from the revealed list pane.
          <SettingsRow
            label={intl.formatMessage({ id: "chatSettings.backLeavesApp", defaultMessage: "Back leaves the app" })}
            description={intl.formatMessage({ id: "chatSettings.backLeavesAppDescription", defaultMessage: "Off, back switches between the channel list and the chat." })}
          >
            <Switch
              checked={config.androidBackLeavesApp}
              onCheckedChange={(androidBackLeavesApp) =>
                updateConfig((current) => ({ ...current, androidBackLeavesApp }))}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      {user && (
        <SettingsGroup id="quick-reactions">
          <QuickReactionsSettings />
        </SettingsGroup>
      )}
    </>
  );
}
