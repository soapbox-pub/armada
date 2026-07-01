import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNativeNotifications } from "@/hooks/useNativeNotifications";
import { useFcmNotifications } from "@/hooks/useFcmNotifications";
import { usePushNotifications, type PushPrefs } from "@/hooks/usePushNotifications";
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/lib/nativeNotifications";
import type { NotificationStyle } from "@/lib/notificationStyle";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

/**
 * Notification settings.
 *
 * Two delivery paths, picked by runtime:
 *  - Native APK: the user chooses between two styles —
 *      • "Persistent": a foreground service holds a persistent relay connection
 *        and fires notifications instantly (no Google). Covers groups, Concord
 *        and DMs, at a small battery cost. (useNativeNotifications)
 *      • "Push": FCM via the shared nostr-push server — battery-free and
 *        OS-delivered, but only covers DMs + Concord (generic "New message");
 *        requires Firebase configured in the build. (useFcmNotifications)
 *  - Web / PWA: Web Push via the Armada relay's VAPID gateway.
 *    (usePushNotifications)
 *
 * All paths share the same Discord-style per-type toggles.
 */
export function NotificationSettings() {
  const { user } = useCurrentUser();
  const native = useNativeNotifications();

  if (!user) {
    return <p className="text-sm text-muted-foreground">Log in to enable notifications.</p>;
  }

  // Native APK: background notifications, with a delivery-style choice.
  if (native.supported) {
    return <NativeNotificationSettings native={native} userPubkey={user.pubkey} />;
  }

  return <WebPushSettings />;
}

/**
 * Warns when Android battery optimization is still active for Armada.
 *
 * Battery optimization tears down the persistent relay websockets while the
 * device is idle, and on Android 15+ it also prevents the boot receiver from
 * restarting the service after a reboot. Offers the one-tap system exemption
 * dialog and re-checks when the user returns from it.
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

    // Re-check when the user returns from the system exemption dialog.
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
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs">
            Battery optimization is enabled for Armada. Android may close the background
            connection while your device is idle and prevent notifications from resuming
            after a reboot.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-8 text-xs"
            onClick={() => requestIgnoreBatteryOptimizations()}
          >
            Disable battery optimization
          </Button>
        </div>
      </div>
    </div>
  );
}

function NativeNotificationSettings(props: {
  native: ReturnType<typeof useNativeNotifications>;
  userPubkey: string;
}) {
  const { native } = props;
  const fcm = useFcmNotifications();

  // Switching to "push" registers FCM; switching to "persistent" unregisters it.
  // The persistent foreground service is driven by useNativeNotifications, which
  // already tears itself down whenever the style is "push".
  const onStyleChange = async (style: NotificationStyle) => {
    native.setStyle(style);
    if (!fcm.supported) return;
    try {
      if (style === "push") {
        if (!native.enabled) await native.enable(); // ensure OS permission
        await fcm.enable();
      } else {
        await fcm.disable();
      }
    } catch (err) {
      console.error("[notif] failed to apply style change:", err);
    }
  };

  const onToggle = async (v: boolean) => {
    if (native.style === "push" && fcm.supported) {
      if (v) {
        await native.enable(); // OS permission
        await fcm.enable().catch((err) => console.error("[fcm] enable failed:", err));
      } else {
        await fcm.disable().catch((err) => console.error("[fcm] disable failed:", err));
        await native.disable();
      }
      return;
    }
    // Persistent style: the foreground service handles everything.
    return v ? native.enable() : native.disable();
  };

  const busy = native.busy || fcm.busy;

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Delivery method</h3>
        <RadioGroup
          value={native.style}
          onValueChange={(v) => onStyleChange(v as NotificationStyle)}
          className="space-y-2"
        >
          <StyleOption
            id="style-persistent"
            value="persistent"
            title="Persistent (no Google)"
            description="Armada stays connected in the background and notifies you instantly. Covers channels, communities and DMs. Uses a little more battery."
          />
          <StyleOption
            id="style-push"
            value="push"
            title="Push (battery-saving)"
            description={
              fcm.supported
                ? "Delivered by the OS via the push server. Best battery life. Covers DMs and community messages; NIP-29 channels stay on Persistent."
                : "Unavailable on this build (Firebase not configured)."
            }
            disabled={!fcm.supported}
          />
        </RadioGroup>
      </div>

      <div className="border-t border-border pt-4">
        <NotificationToggles
          title="Enable notifications"
          description={
            native.style === "push"
              ? "Battery-free push for DMs and community messages."
              : "Instant background notifications — no Google services."
          }
          enabled={native.enabled}
          busy={busy}
          blocked={false}
          prefs={native.prefs}
          onToggle={onToggle}
          onSetPrefs={(p) => native.setPrefs(p).catch(() => {})}
        />
      </div>

      {native.enabled && native.style !== "push" && <BatteryOptimizationWarning />}
    </div>
  );
}

function StyleOption(props: {
  id: string;
  value: string;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={props.id}
      className={`flex items-start gap-3 rounded-md border border-border p-3 ${
        props.disabled ? "opacity-50" : "cursor-pointer"
      }`}
    >
      <RadioGroupItem id={props.id} value={props.value} disabled={props.disabled} className="mt-0.5" />
      <span className="min-w-0">
        <Label htmlFor={props.id} className="block text-sm font-medium">
          {props.title}
        </Label>
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
    </label>
  );
}

function WebPushSettings() {
  const { supported, permission, enabled, busy, prefs, enable, disable, setPrefs } =
    usePushNotifications();

  if (!supported) {
    return (
      <p className="text-sm text-muted-foreground">
        Web Push isn't available in this browser. On iOS, add Armada to your Home Screen first.
      </p>
    );
  }

  return (
    <NotificationToggles
      title="Enable push notifications"
      enabled={enabled}
      busy={busy}
      blocked={permission === "denied"}
      blockedMessage="Notifications are blocked in your browser settings."
      prefs={prefs}
      onToggle={(v) => (v ? enable() : disable())}
      onSetPrefs={(p) => setPrefs(p).catch(() => {})}
    />
  );
}

function NotificationToggles(props: {
  title: string;
  description?: string;
  enabled: boolean;
  busy: boolean;
  blocked: boolean;
  blockedMessage?: string;
  prefs: PushPrefs;
  onToggle: (value: boolean) => void;
  onSetPrefs: (next: PushPrefs) => void;
}) {
  const { title, description, enabled, busy, blocked, blockedMessage, prefs } = props;

  const setPref = (key: keyof PushPrefs) => (value: boolean) => {
    props.onSetPrefs({ ...prefs, [key]: value });
  };

  return (
    <div className="space-y-5">
      <label className="flex items-center justify-between gap-4 cursor-pointer">
        <span className="text-sm font-medium">
          {title}
          {description && (
            <span className="block text-xs font-normal text-muted-foreground">{description}</span>
          )}
          {blocked && blockedMessage && (
            <span className="block text-xs font-normal text-destructive">{blockedMessage}</span>
          )}
        </span>
        <Switch checked={enabled} disabled={busy || blocked} onCheckedChange={props.onToggle} />
      </label>

      {enabled && (
        <div className="space-y-4 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-muted-foreground">Notify me about</h3>

          <PrefRow
            label="Mentions"
            description="When someone @-mentions you in a channel."
            checked={prefs.mentions}
            disabled={busy}
            onChange={setPref("mentions")}
          />
          <PrefRow
            label="Replies"
            description="When someone replies to your message."
            checked={prefs.replies}
            disabled={busy}
            onChange={setPref("replies")}
          />
          <PrefRow
            label="Reactions"
            description="When someone reacts to your message."
            checked={prefs.reactions}
            disabled={busy}
            onChange={setPref("reactions")}
          />
          <PrefRow
            label="Direct messages"
            description="When you receive a DM."
            checked={prefs.directMessages}
            disabled={busy}
            onChange={setPref("directMessages")}
          />
          <PrefRow
            label="All channel messages"
            description="Every message in your channels, not just mentions. Noisy in busy servers."
            checked={prefs.allGroupMessages}
            disabled={busy}
            onChange={setPref("allGroupMessages")}
          />
        </div>
      )}
    </div>
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
    <label className="flex items-center justify-between gap-4 cursor-pointer">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
      <Switch checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />
    </label>
  );
}
