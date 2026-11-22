import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Play } from "lucide-react";

import { BravePushServiceNotice } from "@/components/BravePushNotice";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { DesktopNotificationTest } from "@/components/DesktopNotificationTest";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useForegroundNotificationSettings } from "@/hooks/useForegroundNotificationSettings";
import {
  useNativeNotifications,
  type UseNativeNotificationsReturn,
} from "@/hooks/useNativeNotifications";
import { useWebPushNotifications } from "@/contexts/WebPushContext";
import {
  loadNotificationSoundSettings,
  NOTIFICATION_SOUNDS,
  NOTIFICATION_SOUND_SETTINGS_KEY,
  playNotificationSound,
  saveNotificationSoundSettings,
  type NotificationSoundId,
  type NotificationSoundSettings as NotificationSoundSettingsValue,
} from "@/lib/notificationSounds";
import { isBrave } from "@/lib/bravePush";
import { hasIosPush } from "@/lib/nativePush";
import { hasNappPush } from "@/lib/nappPush";
import { type DmRequestLevel, type PushPrefs } from "@/lib/pushPrefs";
import type { WebPushUnavailableReason } from "@/lib/webPushSupport";
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/lib/nativeNotifications";
import { isIOS, isNativeRuntime } from "@/lib/platform";
import { isDesktop } from "@/lib/desktop";
import { FormattedMessage, getLocale, t, useIntl } from "@/i18n";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

/**
 * Notification settings. Native APK: a foreground service with a persistent
 * relay connection (no FCM; see useNativeNotifications). Web/PWA: Web Push via
 * a content-blind nostr-push gateway (see useWebPushNotifications).
 */
export function NotificationSettings() {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const native = useNativeNotifications();

  if (!user) {
    return (
      <NoticeGroup>
        <FormattedMessage id="notificationSettings.logIn" defaultMessage="Log in to enable notifications." />
      </NoticeGroup>
    );
  }

  if (native.supported) {
    return (
      <>
        {native.enabled && <BatteryOptimizationWarning />}
        <NotificationToggles
          title={intl.formatMessage({ id: "notificationSettings.background", defaultMessage: "Background notifications" })}
          description={intl.formatMessage({ id: "notificationSettings.notifiedWhenClosed", defaultMessage: "Get notified even when Armada is closed." })}
          info={intl.formatMessage({ id: "notificationSettings.backgroundInfo", defaultMessage: "Armada stays connected in the background to notify you, without Google services." })}
          enabled={native.enabled}
          busy={native.busy}
          blocked={false}
          prefs={native.prefs}
          onToggle={(v) => (v ? native.enable() : native.disable())}
          onSetPrefs={(p) => native.setPrefs(p).catch(() => {})}
        />
        <NativeNotificationHealthPanel native={native} />
      </>
    );
  }

  return (
    <>
      <WebPushSettings />
      {!isNativeRuntime() && <NotificationSoundSettings />}
    </>
  );
}

/** A group holding only explanatory copy, for states with nothing to toggle. */
function NoticeGroup({ children }: { children: ReactNode }) {
  return (
    <SettingsGroup>
      <SettingsRow>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </SettingsRow>
    </SettingsGroup>
  );
}

function NativeNotificationHealthPanel({
  native,
}: {
  native: UseNativeNotificationsReturn;
}) {
  const intl = useIntl();
  const health = native.health;
  if (!health) return null;

  const appBlocked = !health.postNotificationsGranted || !health.notificationsEnabled;
  const messagesBlocked = health.messageChannelImportance === 0;
  const messagesQuiet = health.messageChannelImportance > 0 &&
    health.messageChannelImportance < 4;
  const callsBlocked = health.callChannelImportance === 0;
  const callsQuiet = health.callChannelImportance > 0 && health.callChannelImportance < 4;
  const serviceBlocked = health.serviceChannelImportance === 0;
  const stopped = native.enabled && (!health.configEnabled || !health.serviceRunning);
  const staleConfig = native.enabled && health.serviceRunning &&
    health.loadedConfigRevision !== health.configRevision;
  const disconnected = native.enabled && health.socketTotalCount > 0 &&
    health.socketOpenCount === 0;
  const signerUnavailable = native.enabled && health.signerStatus === "unavailable";
  const blocked = appBlocked || messagesBlocked;
  const degraded = messagesQuiet || callsQuiet || stopped || staleConfig || disconnected ||
    serviceBlocked || signerUnavailable ||
    health.authStatus === "rejected" || health.authStatus === "failed";

  const open = (channel?: "messages" | "calls" | "service") => {
    void native.openSettings(channel).catch(() => {});
  };

  return (
    <SettingsGroup title={intl.formatMessage({ id: "notificationSettings.status", defaultMessage: "Status" })}>
      {(blocked || degraded || callsBlocked) && (
        <SettingsRow className="bg-warning/10">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs">
                {appBlocked
                  ? <FormattedMessage id="notificationSettings.health.appBlocked" defaultMessage="Android is blocking Armada notifications at the app level." />
                  : messagesBlocked
                    ? <FormattedMessage id="notificationSettings.health.messagesBlocked" defaultMessage="Android's Armada message channel is turned off." />
                    : messagesQuiet
                      ? <FormattedMessage id="notificationSettings.health.messagesQuiet" defaultMessage="Android's Armada message channel is below high priority, so alerts may be silent or have no banner." />
                    : serviceBlocked
                      ? <FormattedMessage id="notificationSettings.health.serviceBlocked" defaultMessage="The background-service notification channel is turned off. Android cannot run the background connection without it." />
                      : stopped
                        ? <FormattedMessage id="notificationSettings.health.stopped" defaultMessage="The background notification service is not running with a complete configuration." />
                        : staleConfig
                          ? <FormattedMessage id="notificationSettings.health.staleConfig" defaultMessage="The background service has not loaded the latest notification configuration." />
                          : disconnected
                            ? <FormattedMessage id="notificationSettings.health.disconnected" defaultMessage="The service is running, but none of its relay connections are open." />
                            : signerUnavailable
                              ? <FormattedMessage id="notificationSettings.health.signerUnavailable" defaultMessage="The background signer is unavailable, so encrypted DMs and relay authentication can fail while Armada is closed." />
                              : callsBlocked
                                ? <FormattedMessage id="notificationSettings.health.callsBlocked" defaultMessage="Android's incoming-call notification channel is turned off." />
                                : <FormattedMessage id="notificationSettings.health.callsQuiet" defaultMessage="Android's incoming-call channel is below high priority, so calls may not ring." />}
              </p>
              <div className="flex flex-wrap gap-2">
                {(appBlocked || messagesBlocked || messagesQuiet) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-xs touch:h-11"
                    onClick={() => open(appBlocked ? undefined : "messages")}
                  >
                    <FormattedMessage id="notificationSettings.openNotificationSettings" defaultMessage="Open notification settings" />
                  </Button>
                )}
                {(callsBlocked || callsQuiet) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-xs touch:h-11"
                    onClick={() => open("calls")}
                  >
                    <FormattedMessage id="notificationSettings.openCallSettings" defaultMessage="Open call settings" />
                  </Button>
                )}
                {serviceBlocked && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-xs touch:h-11"
                    onClick={() => open("service")}
                  >
                    <FormattedMessage id="notificationSettings.openServiceSettings" defaultMessage="Open service settings" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </SettingsRow>
      )}

      <details className="px-4 py-3.5 text-xs">
        <summary className="cursor-pointer text-sm font-medium">
          <FormattedMessage id="notificationSettings.diagnostics" defaultMessage="Notification diagnostics" />
        </summary>
        <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-muted-foreground">
          <dt><FormattedMessage id="notificationSettings.diag.serviceConfig" defaultMessage="Service / config" /></dt>
          <dd className="text-right text-foreground">
            <FormattedMessage id="notificationSettings.diag.serviceConfigValue" defaultMessage="{service, select, running {running} other {stopped}} / {config, select, loaded {loaded} stale {stale} other {off}}" values={{
              service: health.serviceRunning ? "running" : "stopped",
              config: health.configEnabled
                ? health.loadedConfigRevision === health.configRevision ? "loaded" : "stale"
                : "off",
            }} />
          </dd>
          <dt><FormattedMessage id="notificationSettings.diag.watches" defaultMessage="Watches" /></dt>
          <dd className="text-right text-foreground">
            <FormattedMessage id="notificationSettings.diag.watchesValue" defaultMessage="{relays} relays · {groups} groups · {dms} DMs · {streams} streams" values={{ relays: health.relayWatchCount, groups: health.groupWatchCount, dms: health.dmPeerWatchCount, streams: health.concordStreamWatchCount }} />
          </dd>
          <dt><FormattedMessage id="notificationSettings.diag.relaySockets" defaultMessage="Relay sockets" /></dt>
          <dd className="text-right text-foreground">
            <FormattedMessage id="notificationSettings.diag.relaySocketsValue" defaultMessage="{open}/{total} open" values={{ open: health.socketOpenCount, total: health.socketTotalCount }} />
          </dd>
          <dt><FormattedMessage id="notificationSettings.diag.channels" defaultMessage="Message / call / service channels" /></dt>
          <dd className="text-right text-foreground">
            {formatImportance(health.messageChannelImportance)} / {formatImportance(health.callChannelImportance)} / {formatImportance(health.serviceChannelImportance)}
          </dd>
          <dt><FormattedMessage id="notificationSettings.diag.signerAuth" defaultMessage="Signer / relay auth" /></dt>
          <dd className="text-right text-foreground">
            {health.signerStatus} / {health.authStatus}
          </dd>
          <dt><FormattedMessage id="notificationSettings.diag.lastConfig" defaultMessage="Last config / sign / auth" /></dt>
          <dd className="text-right text-foreground">
            {formatHealthTime(health.lastConfigAt)} / {formatHealthTime(health.lastSignAt)} / {formatHealthTime(health.lastAuthAt)}
          </dd>
          <dt><FormattedMessage id="notificationSettings.diag.lastEvent" defaultMessage="Last relay event" /></dt>
          <dd className="text-right text-foreground">{formatHealthTime(health.lastEventAt)}</dd>
          <dt><FormattedMessage id="notificationSettings.diag.lastPost" defaultMessage="Last notification post" /></dt>
          <dd className="text-right text-foreground">{formatHealthTime(health.lastPresentedAt)}</dd>
          <dt><FormattedMessage id="notificationSettings.diag.active" defaultMessage="Active notifications" /></dt>
          <dd className="text-right text-foreground">{health.activeNotificationCount}</dd>
          <dt><FormattedMessage id="notificationSettings.diag.lastError" defaultMessage="Last error" /></dt>
          <dd className="text-right text-foreground">
            {health.lastError
              ? `${health.lastError} · ${formatHealthTime(health.lastErrorAt)}`
              : <FormattedMessage id="notificationSettings.diag.none" defaultMessage="none" />}
          </dd>
        </dl>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 h-8 px-2 text-xs touch:h-11"
          onClick={() => void native.refreshHealth()}
        >
          <FormattedMessage id="notificationSettings.refresh" defaultMessage="Refresh" />
        </Button>
      </details>
    </SettingsGroup>
  );
}

function formatHealthTime(timestamp: number): string {
  if (!timestamp) return t({ id: "notificationSettings.diag.never", defaultMessage: "never" });
  return new Date(timestamp).toLocaleString(getLocale());
}

function formatImportance(importance: number): string {
  return ["blocked", "min", "low", "default", "high", "max"][importance] ?? "n/a";
}

/** Sound for the web/desktop client; native platforms own audio. */
function NotificationSoundSettings() {
  const intl = useIntl();
  const [settings, setSettings] = useState<NotificationSoundSettingsValue>(
    loadNotificationSoundSettings,
  );

  useEffect(() => {
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key === NOTIFICATION_SOUND_SETTINGS_KEY) {
        setSettings(loadNotificationSoundSettings());
      }
    };
    window.addEventListener("storage", syncFromStorage);
    return () => window.removeEventListener("storage", syncFromStorage);
  }, []);

  const update = (patch: Partial<NotificationSoundSettingsValue>) => {
    setSettings((current) => saveNotificationSoundSettings({ ...current, ...patch }));
  };

  return (
    <SettingsGroup title={intl.formatMessage({ id: "notificationSettings.sound", defaultMessage: "Sound" })}>
      <SettingsRow
        label={intl.formatMessage({ id: "notificationSettings.notificationSound", defaultMessage: "Notification sound" })}
        description={intl.formatMessage({ id: "notificationSettings.notificationSoundDescription", defaultMessage: "Plays for new activity while Armada is open." })}
        info={(
          <FormattedMessage
            id="notificationSettings.soundInfo"
            defaultMessage="Background push and Android use the sound selected by your device. Browsers may require one interaction with Armada before allowing in-page audio. Sounds are CC0 or CC BY-SA; see the <link>sound credits</link>."
            values={{
              link: (chunks) => (
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="/sounds/notifications/LICENSES.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  {chunks}
                </a>
              ),
            }}
          />
        )}
      >
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </SettingsRow>

      {settings.enabled && (
        <SettingsRow stack label={intl.formatMessage({ id: "notificationSettings.sound", defaultMessage: "Sound" })}>
          <div className="flex items-center gap-2">
            <Select
              value={settings.sound}
              onValueChange={(sound) => update({ sound: sound as NotificationSoundId })}
            >
              <SelectTrigger aria-label={intl.formatMessage({ id: "notificationSettings.notificationSound", defaultMessage: "Notification sound" })} className="min-w-0 flex-1 sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTIFICATION_SOUNDS.map((sound) => (
                  <SelectItem key={sound.id} value={sound.id}>
                    <FormattedMessage id="notificationSettings.soundBy" defaultMessage="{label} by {creator}" values={{ label: sound.label, creator: sound.creator }} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label={intl.formatMessage({ id: "notificationSettings.previewSound", defaultMessage: "Preview sound" })}
              className="size-10 shrink-0 clip-corner touch:size-11"
              onClick={() => playNotificationSound({ settings, preview: true })}
            >
              <Play className="size-4" />
            </Button>
          </div>
        </SettingsRow>
      )}

      {settings.enabled && (
        <SettingsRow stack label={intl.formatMessage({ id: "notificationSettings.volume", defaultMessage: "Volume" })}>
          <div className="flex items-center gap-3 sm:w-72">
            <Slider
              aria-label={intl.formatMessage({ id: "notificationSettings.volumeLabel", defaultMessage: "Notification sound volume" })}
              className="flex-1 touch:h-11"
              min={0}
              max={1}
              step={0.05}
              value={[settings.volume]}
              onValueChange={([volume]) => update({ volume })}
            />
            <span className="w-11 shrink-0 text-right text-sm tabular-nums">
              {intl.formatNumber(settings.volume, { style: "percent", maximumFractionDigits: 0 })}
            </span>
          </div>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/**
 * Warns while Android battery optimization is active: it kills relay sockets
 * when idle and, on Android 15+, blocks the boot receiver restart.
 */
function BatteryOptimizationWarning() {
  const [optimized, setOptimized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      isIgnoringBatteryOptimizations().then((ignoring) => {
        if (!cancelled) setOptimized(!ignoring);
      });
    };

    check();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  if (!optimized) return null;

  return (
    <SettingsGroup>
      <SettingsRow className="bg-warning/10">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-xs">
              <FormattedMessage id="notificationSettings.batteryWarning" defaultMessage="Battery optimization can stop notifications while your device is idle or after a reboot." />
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2 h-8 text-xs touch:h-11"
              onClick={() => requestIgnoreBatteryOptimizations()}
            >
              <FormattedMessage id="notificationSettings.disableBattery" defaultMessage="Disable battery optimization" />
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}

function WebPushSettings() {
  // Web Push through nostr-push2, or Tenna's `window.napp.push`. Self-gates on
  // `supported` when neither is available to this build.
  const {
    supported,
    unavailableReason,
    ready,
    error,
    pushServiceOff,
    permissionExpired,
    permission,
    enabled,
    busy,
    prefs,
    enable,
    disable,
    setPrefs,
    retry,
  } = useWebPushNotifications();
  const intl = useIntl();

  // Without Web Push (no gateway, no push service), offer foreground notifications.
  if (!supported) {
    // Every iOS browser is WKWebView, so the foreground fallback's advice doesn't apply.
    if (isIOS()) return <IosNotificationHint reason={unavailableReason} />;
    return <ForegroundOnlySettings />;
  }

  if (pushServiceOff) {
    return (
      <>
        <SettingsGroup>
          <SettingsRow>
            <BravePushServiceNotice onRetry={() => void enable()} retrying={busy} />
          </SettingsRow>
        </SettingsGroup>
        <ForegroundOnlySettings />
      </>
    );
  }

  // Brave's permission prompt defaults to "until I close this site".
  const braveHint = permissionExpired
    ? intl.formatMessage({ id: "notificationSettings.braveExpired", defaultMessage: "Brave dropped the permission when you closed Armada. Turn this on and pick “forever” when Brave asks." })
    : isBrave() && !enabled && permission === "default"
      ? intl.formatMessage({ id: "notificationSettings.braveForever", defaultMessage: "When Brave asks, pick “forever”, or it stops when you close Armada." })
      : undefined;

  if (error) {
    return (
      <SettingsGroup>
        <SettingsRow>
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>{error}</p>
            </div>
            <Button size="sm" variant="secondary" className="touch:h-11" onClick={retry}>
              <FormattedMessage id="notificationSettings.retrySetup" defaultMessage="Retry notification setup" />
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>
    );
  }

  return (
    <NotificationToggles
      title={intl.formatMessage({ id: "notificationSettings.enablePush", defaultMessage: "Enable push notifications" })}
      description={!ready
        ? intl.formatMessage({ id: "notificationSettings.preparing", defaultMessage: "Preparing secure background notifications…" })
        : intl.formatMessage({ id: "notificationSettings.notifiedWhenClosed", defaultMessage: "Get notified even when Armada is closed." })}
      info={!ready || hasNappPush()
        ? undefined
        : hasIosPush()
          // No Notification Service Extension yet, so the lock screen shows the gateway's fixed text.
          ? intl.formatMessage({ id: "notificationSettings.iosPushInfo", defaultMessage: "Notifications don't name the sender or quote the message. Armada decrypts it when you open it." })
          : intl.formatMessage({ id: "notificationSettings.webPushInfo", defaultMessage: "Armada repairs expired browser subscriptions whenever you return." })}
      enabled={enabled}
      busy={busy}
      blocked={permission === "denied"}
      blockedMessage={isIOS()
        ? intl.formatMessage({ id: "notificationSettings.blockedIos", defaultMessage: "Notifications are blocked. Allow Armada in iPhone Settings → Notifications." })
        : intl.formatMessage({ id: "notificationSettings.blockedBrowser", defaultMessage: "Notifications are blocked in your browser settings." })}
      hint={ready ? braveHint : undefined}
      prefs={prefs}
      onToggle={(v) => (v ? enable() : disable())}
      onSetPrefs={(p) => setPrefs(p).catch(() => {})}
    />
  );
}

/** iOS notification guidance when background push is unavailable. */
function IosNotificationHint(props: { reason?: WebPushUnavailableReason }) {
  return (
    <NoticeGroup>
      <IosNotificationHintText {...props} />
    </NoticeGroup>
  );
}

function IosNotificationHintText({ reason }: { reason?: WebPushUnavailableReason }) {
  // Only pre-push iOS app builds reach this; current ones register APNs tokens (useIosPush).
  if (reason === "native-runtime") {
    return (
      <p className="text-sm text-muted-foreground">
        <FormattedMessage id="notificationSettings.ios.nativeRuntime" defaultMessage="This version of the Armada app can’t receive background notifications. Update to a newer build to turn them on." />
      </p>
    );
  }

  if (reason === "gateway") {
    return (
      <p className="text-sm text-muted-foreground">
        <FormattedMessage id="notificationSettings.ios.gateway" defaultMessage="This build of Armada has no background push service configured. Your iPhone is not the problem; whoever built or deployed it needs to configure a push gateway." />
      </p>
    );
  }

  // Every iOS browser's Web Push is WebKit's (useNostrPush refuses it).
  return (
    <p className="text-sm text-muted-foreground">
      <FormattedMessage id="notificationSettings.ios.webkit" defaultMessage="Background notifications aren't available in the iPhone and iPad web app: iOS makes every push show a notification, so Armada would announce each sync. They're available in the Android and desktop apps." />
    </p>
  );
}

/**
 * Foreground-only notifications while Armada is open, where Web Push is
 * unavailable (e.g. Brave, or Electron, which has the Push API but no push
 * service). The desktop shell keeps sockets alive in the tray.
 */
function ForegroundOnlySettings() {
  const { apiAvailable, permission, enabled, setEnabled, prefs, setPrefs } =
    useForegroundNotificationSettings();
  const intl = useIntl();

  const desktop = isDesktop();
  const blocked = apiAvailable && permission === "denied";

  if (!apiAvailable) {
    return (
      <NoticeGroup>
        {desktop
          ? <FormattedMessage id="notificationSettings.desktopUnsupported" defaultMessage="This version of Armada can't show notifications." />
          : <FormattedMessage id="notificationSettings.browserUnsupported" defaultMessage="This browser doesn't support notifications. Use Chrome, Firefox, or the Android app." />}
      </NoticeGroup>
    );
  }

  return (
    <>
    <NotificationToggles
      title={intl.formatMessage({ id: "notificationSettings.foreground", defaultMessage: "Notifications while Armada is open" })}
      description={desktop
        ? intl.formatMessage({ id: "notificationSettings.foregroundDesktop", defaultMessage: "Including when minimized to the tray." })
        : intl.formatMessage({ id: "notificationSettings.foregroundBrowser", defaultMessage: "This browser can't notify you while Armada is closed." })}
      info={desktop
        ? intl.formatMessage({ id: "notificationSettings.foregroundDesktopInfo", defaultMessage: "Armada shows a system notification for new messages while it's running, including when it's minimized to the tray." })
        : intl.formatMessage({ id: "notificationSettings.foregroundBrowserInfo", defaultMessage: "This browser doesn't support background push, so you'll get a system notification for new messages only while Armada is open and you're not looking at the conversation. For notifications when Armada is closed, use a browser that supports Web Push (Chrome, Firefox, or Brave with Google push services enabled), or the Android app." })}
      enabled={enabled}
      busy={false}
      blocked={blocked}
      blockedMessage={desktop
        ? intl.formatMessage({ id: "notificationSettings.blockedDesktop", defaultMessage: "Notifications are blocked. Allow Armada in your system notification settings." })
        : intl.formatMessage({ id: "notificationSettings.blockedBrowser", defaultMessage: "Notifications are blocked in your browser settings." })}
      // Permission never asked: the master wish defaults on, so without this it looks enabled but never fires.
      hint={apiAvailable && permission === "default"
        ? desktop
          ? intl.formatMessage({ id: "notificationSettings.askDesktop", defaultMessage: "Armada isn't allowed to notify yet. Turn this on to ask." })
          : intl.formatMessage({ id: "notificationSettings.askBrowser", defaultMessage: "Your browser hasn't allowed notifications yet. Turn this on to ask." })
        : undefined}
      prefs={prefs}
      onToggle={(v) => setEnabled(v).catch(() => {})}
      onSetPrefs={setPrefs}
    />
    <DesktopNotificationTest />
    </>
  );
}

function NotificationToggles(props: {
  title: string;
  description?: string;
  info?: string;
  enabled: boolean;
  busy: boolean;
  blocked: boolean;
  blockedMessage?: string;
  /** An advisory note below the description — unlike `blocked`, actionable. */
  hint?: string;
  prefs: PushPrefs;
  onToggle: (value: boolean) => void;
  onSetPrefs: (next: PushPrefs) => void;
}) {
  const intl = useIntl();
  const { title, description, info, enabled, busy, blocked, blockedMessage, hint, prefs } = props;

  const setPref = (key: keyof PushPrefs) => (value: boolean) => {
    props.onSetPrefs({ ...prefs, [key]: value });
  };

  const messageRequests = intl.formatMessage({ id: "notificationSettings.pref.requests", defaultMessage: "Message requests" });

  const setDmRequests = (value: DmRequestLevel) => {
    props.onSetPrefs({ ...prefs, dmRequests: value });
  };

  return (
    <>
      <SettingsGroup id="notifications">
        <SettingsRow
          label={title}
          info={info}
          description={(
            <>
              {description}
              {blocked && blockedMessage && (
                <span className="block text-destructive">{blockedMessage}</span>
              )}
              {!blocked && hint && (
                <span className="block text-warning">{hint}</span>
              )}
            </>
          )}
        >
          <Switch checked={enabled} disabled={busy || blocked} onCheckedChange={props.onToggle} aria-label={title} />
        </SettingsRow>
      </SettingsGroup>

      {enabled && (
        <SettingsGroup title={intl.formatMessage({ id: "notificationSettings.notifyAbout", defaultMessage: "Notify me about" })}>
          <PrefRow
            label={intl.formatMessage({ id: "notificationSettings.pref.mentions", defaultMessage: "Mentions" })}
            description={intl.formatMessage({ id: "notificationSettings.pref.mentionsDescription", defaultMessage: "When someone @-mentions you in a channel." })}
            checked={prefs.mentions}
            disabled={busy}
            onChange={setPref("mentions")}
          />
          <PrefRow
            label={intl.formatMessage({ id: "notificationSettings.pref.replies", defaultMessage: "Replies" })}
            description={intl.formatMessage({ id: "notificationSettings.pref.repliesDescription", defaultMessage: "When someone replies to your message." })}
            checked={prefs.replies}
            disabled={busy}
            onChange={setPref("replies")}
          />
          <PrefRow
            label={intl.formatMessage({ id: "notificationSettings.pref.reactions", defaultMessage: "Reactions" })}
            description={intl.formatMessage({ id: "notificationSettings.pref.reactionsDescription", defaultMessage: "When someone reacts to your message." })}
            checked={prefs.reactions}
            disabled={busy}
            onChange={setPref("reactions")}
          />
          <PrefRow
            label={intl.formatMessage({ id: "notificationSettings.pref.dms", defaultMessage: "Direct messages" })}
            description={intl.formatMessage({ id: "notificationSettings.pref.dmsDescription", defaultMessage: "When you receive a DM." })}
            checked={prefs.directMessages}
            disabled={busy}
            onChange={setPref("directMessages")}
          />
          {prefs.directMessages && (
            <SettingsRow
              stack
              label={messageRequests}
              description={intl.formatMessage({ id: "notificationSettings.pref.requestsDescription", defaultMessage: "DMs from people you don't follow." })}
              info={intl.formatMessage({ id: "notificationSettings.pref.requestsInfo", defaultMessage: "A stranger controls the text, name and picture a notification shows." })}
              className="pl-8"
            >
              <Select
                value={prefs.dmRequests}
                onValueChange={(v) => setDmRequests(v as DmRequestLevel)}
                disabled={busy}
              >
                <SelectTrigger className="w-full sm:w-36" aria-label={messageRequests}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full"><FormattedMessage id="notificationSettings.pref.showFully" defaultMessage="Show fully" /></SelectItem>
                  <SelectItem value="generic"><FormattedMessage id="notificationSettings.pref.hideContent" defaultMessage="Hide content" /></SelectItem>
                  <SelectItem value="off"><FormattedMessage id="notificationSettings.pref.dontNotify" defaultMessage="Don't notify" /></SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          )}
          <PrefRow
            label={intl.formatMessage({ id: "notificationSettings.pref.allChannel", defaultMessage: "All channel messages" })}
            description={intl.formatMessage({ id: "notificationSettings.pref.allChannelDescription", defaultMessage: "Every message in your channels, not just mentions. Noisy in busy servers." })}
            checked={prefs.allGroupMessages}
            disabled={busy}
            onChange={setPref("allGroupMessages")}
          />
        </SettingsGroup>
      )}
    </>
  );
}

function PrefRow(props: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingsRow label={props.label} description={props.description}>
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        aria-label={props.label}
      />
    </SettingsRow>
  );
}
