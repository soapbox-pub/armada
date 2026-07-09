import {
  Anchor,
  ArrowLeft,
  Bell,
  ChevronDown,
  ChevronRight,
  Download,
  Image,
  MessageSquareLock,
  Mic,
  Palette,
  Search,
  Server,
  UserCircle,
  Waypoints,
  Wrench,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { LoginArea } from "@/components/auth/LoginArea";
import { ConcordResyncCard } from "@/concord-v1/components/ConcordResyncCard";
import { BlossomServerListEditor } from "@/components/BlossomServerListEditor";
import { ProfileSettings } from "@/components/ProfileSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { RelayListEditor } from "@/components/RelayListEditor";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { WalletSettings } from "@/components/settings/WalletSettings";
import { ThemeSelector } from "@/components/ThemeSelector";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { CONCORD_ENABLED } from "@/concord-v1/lib/concord";
import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { APP_RELAYS, PINNED_RAIL_RELAYS, SEARCH_RELAYS } from "@/lib/platform";
import {
  getAudioProcessing,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import { rnnoiseSupported } from "@/lib/rnnoiseSupport";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type SectionId =
  | "account"
  | "profile"
  | "notifications"
  | "appearance"
  | "voice"
  | "servers"
  | "app-relays"
  | "search-relays"
  | "dms"
  | "media"
  | "wallet"
  | "advanced"
  | "install"
  | "about";

interface NavItem {
  id: SectionId;
  title: string;
  icon: LucideIcon;
  /**
   * Render this section's row(s) directly in the list (no collapsible
   * header). Used for single-item sections — Account (the login pill), About
   * (one link row), and Advanced (whose one row is already its own
   * collapsible) — where a header would just hide a single tap target.
   */
  inline?: boolean;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * App settings: one scrolling list (same format on every viewport). Sections
 * with multiple controls sit behind a collapsible header (icon + title,
 * expands in place); single-item sections render their row directly.
 */
export function SettingsPage() {
  const navigate = useNavigate();
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const dmRelayList = useDmRelayList();
  const blossomServerList = useBlossomServerList();

  // Voice mic-processing prefs are device-local (stored in localStorage, not
  // synced AppConfig — a setting right for a laptop mic is wrong on a phone).
  // Mirror the in-call gear menu; changes apply to the next captured mic track
  // (and live mid-call, since the gear menu restarts the track on change).
  const [voiceProcessing, setVoiceProcessing] = useState<AudioProcessingPrefs>(() =>
    getAudioProcessing(),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { canInstall, install } = useInstallPrompt();
  const setVoiceToggle = (key: keyof AudioProcessingPrefs) => (value: boolean) => {
    setVoiceProcessing((prev) => {
      const next = { ...prev, [key]: value };
      setAudioProcessing(next);
      return next;
    });
  };

  /**
   * Update a relay field locally. The added-server list (`addedRelays`) is
   * handled separately by `setAddedRelays` (NIP-29 kind 10009), and the DM
   * relays by `setDmRelays` (also republishes the NIP-17 kind 10050 list).
   * The change is pushed to the encrypted NIP-78 settings centrally by
   * NostrSync, which watches every synced AppConfig field.
   */
  const setRelays = (key: "appRelays" | "searchRelays") => (relays: string[]) => {
    updateConfig((current) => ({ ...current, [key]: relays }));
  };

  /**
   * Update the user's server list. The local cache updates immediately; the
   * change is diffed and persisted to the NIP-29 kind 10009 list (`r` tags),
   * the cross-device source of truth.
   */
  const setAddedRelays = (relays: string[]) => {
    const prev = config.addedRelays;
    updateConfig((current) => ({ ...current, addedRelays: relays }));
    if (!user) return;
    for (const url of relays) {
      if (!prev.includes(url)) {
        updateList({ type: "add-server", url }).catch((err) =>
          console.warn("Failed to add server to group list:", err));
      }
    }
    for (const url of prev) {
      if (!relays.includes(url)) {
        updateList({ type: "remove-server", url }).catch((err) =>
          console.warn("Failed to remove server from group list:", err));
      }
    }
  };

  /**
   * Persist the user's DM relays. Updates local config (the encrypted-settings
   * push is handled centrally by NostrSync) and — since kind 10050 is the
   * canonical, discoverable "where to send me DMs" list — republishes it so
   * other clients stay in sync. `publish: false` skips the republish when we
   * just seeded the editor from an already-published 10050 (no edit to write
   * back).
   */
  const setDmRelays = (relays: string[], opts: { publish?: boolean } = {}) => {
    updateConfig((current) => ({ ...current, dmRelays: relays }));
    if (opts.publish !== false && user) {
      dmRelayList.publish(relays).catch((err) =>
        console.warn("DM relay list (kind 10050) publish failed:", err));
    }
  };

  /** Toggle whether DMs use the user's own relays. */
  const setUseOwnDmRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useOwnDmRelays: value }));
    // On opt-in, seed from the user's published NIP-17 DM relay list (kind
    // 10050) if they have one, so the editor — and the relays DMs actually use
    // (effectiveDmRelays) — reflect their canonical, discoverable list rather
    // than the app-relay default.
    if (value) {
      dmRelayList.refetch().then((res) => {
        const fetched = res.data ?? [];
        if (fetched.length > 0) setDmRelays(fetched, { publish: false });
      });
    }
  };

  /**
   * Persist the user's Blossom media servers. Updates local config (the
   * encrypted-settings push is handled centrally by NostrSync) and — since
   * kind 10063 is the canonical, discoverable "where my media lives" list
   * (BUD-03) — republishes it so other clients stay in sync.
   */
  const setBlossomServers = (servers: string[]) => {
    updateConfig((current) => ({
      ...current,
      blossomServerMetadata: { servers, updatedAt: Math.floor(Date.now() / 1000) },
    }));
    if (user) {
      blossomServerList.publish(servers).catch((err) =>
        console.warn("Blossom server list (kind 10063) publish failed:", err));
    }
  };

  /** Toggle whether uploads also use the app default Blossom servers. */
  const setUseAppBlossomServers = (value: boolean) => {
    updateConfig((current) => ({ ...current, useAppBlossomServers: value }));
  };

  // Section list, gated the same way the old flat sections were.
  const navGroups = useMemo<NavGroup[]>(() => {
    const userItems: NavItem[] = [
      { id: "account", title: "Account", icon: UserCircle, inline: true },
    ];
    if (user) {
      userItems.push(
        { id: "profile", title: "Profile", icon: UserCircle },
        { id: "notifications", title: "Notifications", icon: Bell },
      );
    }
    const appItems: NavItem[] = [
      { id: "appearance", title: "Appearance", icon: Palette },
      { id: "voice", title: "Voice", icon: Mic },
      { id: "servers", title: "Servers", icon: Server },
      { id: "app-relays", title: "App relays", icon: Waypoints },
      { id: "search-relays", title: "Search relays", icon: Search },
      { id: "dms", title: "Direct messages", icon: MessageSquareLock },
      { id: "media", title: "Media servers", icon: Image },
    ];
    if (user) {
      appItems.push({ id: "wallet", title: "Wallet", icon: Zap });
    }
    if (user && CONCORD_ENABLED) {
      appItems.push({ id: "advanced", title: "Advanced", icon: Wrench, inline: true });
    }
    if (canInstall) {
      appItems.push({ id: "install", title: "Install app", icon: Download, inline: true });
    }
    appItems.push({ id: "about", title: "About", icon: Anchor, inline: true });
    return [
      { heading: "User settings", items: userItems },
      { heading: "App settings", items: appItems },
    ];
  }, [user, canInstall]);

  /** The row(s) inside one section's chrome card. */
  const sectionBody = (id: SectionId): ReactNode => {
    switch (id) {
      case "account":
        return (
          <SettingsRow>
            <LoginArea className="w-full flex" />
          </SettingsRow>
        );
      case "profile":
        return (
          <SettingsRow>
            <ProfileSettings />
          </SettingsRow>
        );
      case "notifications":
        return (
          <SettingsRow>
            <NotificationSettings />
          </SettingsRow>
        );
      case "appearance":
        return (
          <SettingsRow>
            <ThemeSelector />
          </SettingsRow>
        );
      case "servers":
        return (
          <SettingsRow>
            <RelayListEditor
              pinned={PINNED_RAIL_RELAYS}
              relays={config.addedRelays}
              onChange={setAddedRelays}
              emptyText="No extra servers added. Use the + button in the server rail to add one."
              placeholder="wss://server.example.com"
            />
          </SettingsRow>
        );
      case "app-relays":
        return (
          <SettingsRow>
            <RelayListEditor
              relays={config.appRelays}
              onChange={setRelays("appRelays")}
              onReset={() => setRelays("appRelays")([...APP_RELAYS])}
              emptyText="No app relays — profiles and lists are stored on your internal servers only."
            />
          </SettingsRow>
        );
      case "search-relays":
        return (
          <SettingsRow>
            <RelayListEditor
              relays={config.searchRelays}
              onChange={setRelays("searchRelays")}
              onReset={() => setRelays("searchRelays")([...SEARCH_RELAYS])}
              emptyText="No search relays — search falls back to your app relays."
            />
          </SettingsRow>
        );
      case "dms":
        return (
          <>
            <SettingsRow
              label="Use my own DM relays"
              description="Store and read DMs on your own relays instead of the app relays."
            >
              <Switch checked={config.useOwnDmRelays} onCheckedChange={setUseOwnDmRelays} />
            </SettingsRow>
            {config.useOwnDmRelays && (
              <SettingsRow>
                <RelayListEditor
                  relays={config.dmRelays}
                  onChange={setDmRelays}
                  onReset={() => setDmRelays([...APP_RELAYS])}
                  emptyText="No DM relays — add at least one, or DMs fall back to your app relays."
                  placeholder="wss://dm-relay.example.com"
                />
              </SettingsRow>
            )}
          </>
        );
      case "media":
        return (
          <>
            <SettingsRow
              label="Use app media servers"
              description="Upload files to Armada's default Blossom media servers in addition to your own."
            >
              <Switch
                checked={config.useAppBlossomServers}
                onCheckedChange={setUseAppBlossomServers}
              />
            </SettingsRow>
            <SettingsRow>
              <BlossomServerListEditor
                pinned={config.useAppBlossomServers ? APP_BLOSSOM_SERVERS : []}
                servers={config.blossomServerMetadata.servers}
                onChange={setBlossomServers}
                emptyText="No media servers of your own — uploads use the app defaults."
              />
            </SettingsRow>
          </>
        );
      case "voice":
        return (
          <>
            <SettingsRow>
              <VoiceDeviceSettings />
            </SettingsRow>
            {rnnoiseSupported() && (
              <SettingsRow
                label="Noise cancellation"
                description="ML background-noise removal (RNNoise) — removes keyboards, fans, and chatter. Applied to your next call."
              >
                <Switch
                  checked={voiceProcessing.rnnoise}
                  onCheckedChange={setVoiceToggle("rnnoise")}
                />
              </SettingsRow>
            )}
            <SettingsRow
              label="Noise suppression"
              description="Filter out background hum and keyboard noise."
            >
              <Switch
                checked={voiceProcessing.noiseSuppression}
                onCheckedChange={setVoiceToggle("noiseSuppression")}
              />
            </SettingsRow>
            <SettingsRow
              label="Echo cancellation"
              description="Stop your speakers from echoing back into the mic."
            >
              <Switch
                checked={voiceProcessing.echoCancellation}
                onCheckedChange={setVoiceToggle("echoCancellation")}
              />
            </SettingsRow>
            <SettingsRow
              label="Auto gain control"
              description="Even out your volume automatically."
            >
              <Switch
                checked={voiceProcessing.autoGainControl}
                onCheckedChange={setVoiceToggle("autoGainControl")}
              />
            </SettingsRow>
          </>
        );
      case "wallet":
        return <WalletSettings />;
      case "advanced":
        return (
          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
                aria-expanded={showAdvanced}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-sm font-medium leading-tight">Recover communities</div>
                  <div className="text-xs text-muted-foreground leading-snug">
                    Find and restore encrypted rooms missing from your list.
                  </div>
                </div>
                <ChevronDown
                  className="size-4 text-muted-foreground shrink-0 transition-transform duration-200 [[data-state=open]_&]:rotate-180"
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
              <div className="border-t border-chrome px-4 py-3.5">
                <ConcordResyncCard />
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      case "install":
        return (
          <SettingsRow
            label="Install Armada"
            description="Add to your home screen or desktop for a standalone app experience."
            onClick={() => install()}
          >
            <Download className="size-4 text-muted-foreground" />
          </SettingsRow>
        );
      case "about":
        return (
          <SettingsRow
            label="How Armada works"
            description="The two ways to talk, and what stays private."
            onClick={() => navigate("/about")}
          >
            <ChevronRight className="size-4 text-muted-foreground" />
          </SettingsRow>
        );
    }
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      {/* Header — a detached floating command bar matching the group/Concord/DM
          chrome (cut-corner card, recessed shade), capped to the settings
          content width and centered on desktop. */}
      <header className="relative h-12 touch:h-14 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          aria-label="Back"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Settings</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-12 pt-4 space-y-6">
          {navGroups.map((group) => (
            <section key={group.heading} className="space-y-1.5">
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.heading}
              </h2>
              <div className="space-y-1.5">
                {group.items.map((item) =>
                  item.inline ? (
                    /* Single-item section: its row IS the list entry. */
                    <div
                      key={item.id}
                      className="bg-chrome clip-corner-lg overflow-hidden [&>*]:border-chrome [&>*:not(:first-child)]:border-t"
                    >
                      {sectionBody(item.id)}
                    </div>
                  ) : (
                    /* Multi-control section: collapsible header, expands in place. */
                    <Collapsible
                      key={item.id}
                      className="bg-chrome clip-corner-lg overflow-hidden"
                    >
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/40"
                        >
                          <item.icon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 text-sm font-medium truncate">
                            {item.title}
                          </span>
                          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                        <div className="border-t border-chrome [&>*]:border-chrome [&>*:not(:first-child)]:border-t">
                          {sectionBody(item.id)}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
