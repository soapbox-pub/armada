import { ChevronDown } from "lucide-react";
import { useContext, useState } from "react";

import { BlossomServerListEditor } from "@/components/BlossomServerListEditor";
import { DmInboxNotice } from "@/components/DmInboxNotice";
import { RelayBootstrapForm } from "@/components/RelayBootstrapForm";
import { SLOW_MS, StatusLed } from "@/components/RelayLed";
import { RelayListEditor } from "@/components/RelayListEditor";
import { SetupListRow } from "@/components/SetupListRow";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsSearchingContext } from "@/components/settings/settingsNav";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppContext } from "@/hooks/useAppContext";
import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { recommendedDmInbox } from "@/hooks/useDmInboxSetup";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useSearchRelayList } from "@/hooks/useSearchRelayList";
import { FormattedMessage, useIntl } from "@/i18n";
import { APP_BLOSSOM_SERVERS, uploadTargets } from "@/lib/blossom";
import { APP_RELAYS, BROADCAST_RELAYS, COMMUNITY_RELAYS, SEARCH_RELAYS } from "@/lib/platform";
import { defaultPowDifficulty } from "@/lib/pow";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";
import { nowSecs } from "@/lib/relayClock";

/** The lists Settings › Relays shows, in the signup wizard's order and with its names. */
type RelayRow = "home" | "dm" | "search" | "blossom" | "community" | "broadcast";

/** Bits offered besides the deployment default; at 20 a 1 KB message already takes seconds on a desktop. */
const POW_CHOICES = [0, 4, 8, 12, 16, 20];

/** Mono URL list for prose: hosts joined by commas. */
function hostList(urls: string[]): ReactNode {
  return urls.map((url, index) => (
    <span key={url}>
      {index > 0 && ", "}
      <span className="font-mono text-foreground">{url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "")}</span>
    </span>
  ));
}

/** What the lights beside each relay and server mean, since a tooltip never shows on touch. */
function StatusLegend() {
  const intl = useIntl();
  const items = [
    { alive: true, label: intl.formatMessage({ id: "relaysSettings.legendUp", defaultMessage: "Reachable" }) },
    { alive: true, ms: SLOW_MS, label: intl.formatMessage({ id: "relaysSettings.legendSlow", defaultMessage: "Slow (over 1 s)" }) },
    { alive: false, label: intl.formatMessage({ id: "relaysSettings.legendDown", defaultMessage: "Unreachable" }) },
    { alive: undefined, label: intl.formatMessage({ id: "relaysSettings.legendChecking", defaultMessage: "Checking" }) },
  ];
  return (
    <div className="space-y-1.5 text-xs leading-snug text-muted-foreground">
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {items.map(({ alive, ms, label }) => (
          <li key={label} className="flex items-center gap-1.5">
            <StatusLed alive={alive} ms={ms} noun="relay" decorative />
            {label}
          </li>
        ))}
      </ul>
      <p>
        <FormattedMessage
          id="relaysSettings.legendNote"
          defaultMessage="Each light shows whether that relay or server answered a recent check. The number beside it is how long the answer took."
        />
      </p>
    </div>
  );
}

/** Settings › Relays: every relay and media-server list, as at sign-up. */
export function RelaysSettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const searching = useContext(SettingsSearchingContext);
  const dmRelayList = useDmRelayList();
  const blossomServerList = useBlossomServerList();
  const searchRelayList = useSearchRelayList();

  // One list open at a time, as in the signup wizard; searching mounts them all so search can match them.
  const [openRelayRow, setOpenRelayRow] = useState<RelayRow | null>(null);
  const [publishedListOpen, setPublishedListOpen] = useState(false);
  const relayRowOpen = (row: RelayRow) => searching || openRelayRow === row;
  const setRelayRowOpen = (row: RelayRow) => (open: boolean) => setOpenRelayRow(open ? row : null);

  /**
   * App relays travel in encrypted NIP-78; search relays also publish their
   * interoperable NIP-51 kind 10007 list.
   */
  const setAppRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, appRelays: relays }));
  };

  const setBroadcastRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, broadcastRelays: relays }));
  };

  const setCommunityRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, communityRelays: relays }));
  };

  const setSearchRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, searchRelays: relays }));
    if (user) {
      searchRelayList.publish(relays).catch((err) =>
        console.warn("Search relay list (kind 10007) publish failed:", err));
    }
  };

  /**
   * One choice over two flags; "neither" is unreachable from here since it
   * empties the pool. Publishes nothing: `relayMetadata` is a read-only mirror
   * of kind 10002.
   */
  const setRelaySources = (value: string) => {
    updateConfig((current) => ({
      ...current,
      useAppRelays: value !== "published",
      useUserRelays: value !== "home",
    }));
  };
  const relaySources = config.useAppRelays
    ? (config.useUserRelays ? "both" : "home")
    : (config.useUserRelays ? "published" : "");

  /**
   * Publish the user's kind 10050 with exactly the edited list — the one
   * legitimate reason to write it. No refetch, so an in-flight fetch can't
   * clobber the edit.
   */
  const setDmRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, dmRelays: relays }));
    if (user) {
      dmRelayList.publish(relays).catch((err) =>
        console.warn("DM relay list (kind 10050) publish failed:", err));
    }
  };

  /** Persist Blossom servers and republish the canonical BUD-03 kind 10063 list. */
  const setBlossomServers = (servers: string[]) => {
    updateConfig((current) => ({
      ...current,
      blossomServerMetadata: { servers, updatedAt: nowSecs() },
    }));
    if (user) {
      blossomServerList.publish(servers).catch((err) =>
        console.warn("Blossom server list (kind 10063) publish failed:", err));
    }
  };

  // The user's published NIP-65 list (`relayMetadata`), read-only here; ignored when it belongs to another login.
  const ownsRelayList =
    !config.relayMetadata.pubkey || config.relayMetadata.pubkey === user?.pubkey;
  const userRelayUrls = ownsRelayList
    ? config.relayMetadata.relays.map((r) => r.url)
    : [];

  const targets = uploadTargets(config.blossomServerMetadata);
  const ownServers = config.blossomServerMetadata.servers.length > 0;
  const publishedMatchesHome =
    userRelayUrls.length === config.appRelays.length &&
    userRelayUrls.every((url) => config.appRelays.includes(url));
  const publishedOpen = searching || publishedListOpen;
  const connectTo = intl.formatMessage({ id: "relaysSettings.connectTo", defaultMessage: "Connect to" });
  const proofOfWork = intl.formatMessage({ id: "relaysSettings.proofOfWork", defaultMessage: "Proof of work" });

  const setPowChoice = (value: string) => {
    updateConfig((current) => ({ ...current, powDifficulty: value === "default" ? undefined : Number(value) }));
  };

  return (
    <>
      <SettingsGroup
        id="app-relays"
        title={intl.formatMessage({ id: "relaysSettings.yourRelays", defaultMessage: "Your relays" })}
        info={intl.formatMessage({ id: "relaysSettings.yourRelaysInfo", defaultMessage: "Relays are servers that store and pass along your profile, messages and lists. Armada picked these for you; change any of them here, just as at sign-up." })}
      >
        {!config.useAppRelays && !(config.useUserRelays && userRelayUrls.length > 0) && (
          <SettingsRow>
            <p className="text-sm text-destructive leading-snug">
              <FormattedMessage id="relaysSettings.noHomeRelays" defaultMessage="No home relays in use. Your profile and lists won't load or sync until you add one." />
            </p>
          </SettingsRow>
        )}
        <SetupListRow
          label={intl.formatMessage({ id: "relaysSettings.home", defaultMessage: "Home" })}
          hint={intl.formatMessage({ id: "relaysSettings.homeHint", defaultMessage: "Stores your profile, follows and settings." })}
          detail={intl.formatMessage({ id: "relaysSettings.homeDetail", defaultMessage: "Stores your profile, follows and settings. Every other list here may be empty; this one can't." })}
          urls={config.appRelays}
          open={relayRowOpen("home")}
          onOpenChange={setRelayRowOpen("home")}
          padX="px-4"
        >
          <RelayListEditor
            relays={config.appRelays}
            onChange={setAppRelays}
            onReset={() => setAppRelays([...APP_RELAYS])}
            emptyText={intl.formatMessage({ id: "relaysSettings.homeEmpty", defaultMessage: "None. Add a relay, or reset to Armada's defaults." })}
          />
          {user && (
            <Collapsible
              open={publishedOpen}
              onOpenChange={setPublishedListOpen}
              className="clip-corner bg-background/40"
            >
              <CollapsibleTrigger asChild>
                <button type="button" className="flex w-full items-start gap-3 px-3 py-2.5 text-left">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="text-sm font-medium leading-tight">
                      <FormattedMessage id="relaysSettings.publishedList" defaultMessage="Published relay list" />
                    </div>
                    <div className="text-xs text-muted-foreground leading-snug">
                      {userRelayUrls.length === 0
                        ? <FormattedMessage id="relaysSettings.notPublished" defaultMessage="Not published, so other Nostr apps can't find you." />
                        : publishedMatchesHome
                          ? <FormattedMessage id="relaysSettings.publishedMatches" defaultMessage="How other Nostr apps find you. Matches Home." />
                          : <FormattedMessage id="relaysSettings.publishedDiffers" defaultMessage="How other Nostr apps find you. Names {hosts}, unlike Home." values={{ hosts: hostList(userRelayUrls) }} />}
                    </div>
                  </div>
                  <ChevronDown
                    className={cn(
                      "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                      publishedOpen && "rotate-180",
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                <div className="px-3 pb-3">
                  <RelayBootstrapForm />
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </SetupListRow>
        <SetupListRow
          label={intl.formatMessage({ id: "relaysSettings.messages", defaultMessage: "Messages" })}
          hint={intl.formatMessage({ id: "relaysSettings.messagesHint", defaultMessage: "Other apps deliver your direct messages here." })}
          detail={intl.formatMessage({ id: "relaysSettings.messagesDetail", defaultMessage: "Other apps deliver your direct messages here. Armada also checks your home relays." })}
          urls={config.dmRelays}
          open={relayRowOpen("dm")}
          onOpenChange={setRelayRowOpen("dm")}
          padX="px-4"
        >
          <DmInboxNotice />
          <RelayListEditor
            relays={config.dmRelays}
            onChange={setDmRelays}
            onReset={() => setDmRelays(recommendedDmInbox(config))}
            emptyText={intl.formatMessage({ id: "relaysSettings.messagesEmpty", defaultMessage: "None. Armada users can still reach you on your home relays; other apps can't." })}
            placeholder="wss://dm-relay.example.com"
          />
        </SetupListRow>
        <SetupListRow
          label={intl.formatMessage({ id: "relaysSettings.search", defaultMessage: "Search" })}
          hint={intl.formatMessage({ id: "relaysSettings.searchHint", defaultMessage: "Used to find people and communities." })}
          detail={intl.formatMessage({ id: "relaysSettings.searchDetail", defaultMessage: "Used to find people and communities by name (NIP-50)." })}
          urls={config.searchRelays}
          open={relayRowOpen("search")}
          onOpenChange={setRelayRowOpen("search")}
          padX="px-4"
        >
          <RelayListEditor
            relays={config.searchRelays}
            onChange={setSearchRelays}
            onReset={() => setSearchRelays([...SEARCH_RELAYS])}
            emptyText={intl.formatMessage({ id: "relaysSettings.searchEmpty", defaultMessage: "None. Search uses your home relays." })}
          />
        </SetupListRow>
        <SetupListRow
          label={intl.formatMessage({ id: "relaysSettings.media", defaultMessage: "Media" })}
          hint={intl.formatMessage({ id: "relaysSettings.mediaHint", defaultMessage: "Your uploads go here. Links use the first server." })}
          detail={ownServers
            ? intl.formatMessage({ id: "relaysSettings.mediaDetail", defaultMessage: "Your uploads go here. A file is sent to every server in the list; links point at the primary one, first in the list, and the others keep a copy in case it goes away." })
            : intl.formatMessage({ id: "relaysSettings.mediaDetailDefaults", defaultMessage: "Your uploads go here. A file is sent to every server in the list; links point at the primary one, first in the list, and the others keep a copy in case it goes away. These are Armada's servers. Changing the list makes it your own and saves it to your account." })}
          urls={targets.servers}
          kind="blossom"
          open={relayRowOpen("blossom")}
          onOpenChange={setRelayRowOpen("blossom")}
          padX="px-4"
        >
          <BlossomServerListEditor
            servers={targets.servers}
            primary={targets.preferred ?? null}
            defaults={!ownServers}
            onChange={setBlossomServers}
            onReset={() => setBlossomServers([...APP_BLOSSOM_SERVERS])}
          />
        </SetupListRow>
        <SetupListRow
          label={intl.formatMessage({ id: "relaysSettings.communities", defaultMessage: "Communities" })}
          hint={intl.formatMessage({ id: "relaysSettings.communitiesHint", defaultMessage: "Default relays for communities you create." })}
          detail={intl.formatMessage({ id: "relaysSettings.communitiesDetail", defaultMessage: "Default relays for communities you create. Each community can change its own afterwards." })}
          urls={config.communityRelays}
          open={relayRowOpen("community")}
          onOpenChange={setRelayRowOpen("community")}
          padX="px-4"
        >
          <RelayListEditor
            relays={config.communityRelays}
            onChange={setCommunityRelays}
            onReset={() => setCommunityRelays([...COMMUNITY_RELAYS])}
            emptyText={intl.formatMessage({ id: "relaysSettings.communitiesEmpty", defaultMessage: "None. New communities use the shared Concord relays." })}
          />
        </SetupListRow>
        <SetupListRow
          label={intl.formatMessage({ id: "relaysSettings.broadcast", defaultMessage: "Broadcast" })}
          hint={intl.formatMessage({ id: "relaysSettings.broadcastHint", defaultMessage: "Extra relays your public profile is sent to." })}
          detail={intl.formatMessage({ id: "relaysSettings.broadcastDetail", defaultMessage: "Extra relays your public profile is sent to, so people on other Nostr apps see it. Armada never reads from them or sends messages here." })}
          urls={config.broadcastRelays}
          open={relayRowOpen("broadcast")}
          onOpenChange={setRelayRowOpen("broadcast")}
          padX="px-4"
        >
          <RelayListEditor
            relays={config.broadcastRelays}
            onChange={setBroadcastRelays}
            onReset={() => setBroadcastRelays([...BROADCAST_RELAYS])}
            emptyText={intl.formatMessage({ id: "relaysSettings.broadcastEmpty", defaultMessage: "None. Your public profile goes only to your home relays." })}
          />
        </SetupListRow>
        <SettingsRow>
          <StatusLegend />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title={intl.formatMessage({ id: "relaysSettings.advanced", defaultMessage: "Advanced" })}
      >
        <SettingsRow
          label={connectTo}
          info={userRelayUrls.length > 0
            ? intl.formatMessage({ id: "relaysSettings.connectToInfo", defaultMessage: "Which relays Armada reads and writes your account data on: the Home list above, the relay list you published for other apps, or both." })
            : intl.formatMessage({ id: "relaysSettings.connectToInfoUnpublished", defaultMessage: "Which relays Armada reads and writes your account data on. Publish a relay list under Home to choose it here." })}
        >
          <Select value={relaySources} onValueChange={setRelaySources}>
            <SelectTrigger className="w-44 sm:w-52" aria-label={connectTo}>
              <SelectValue placeholder={intl.formatMessage({ id: "relaysSettings.none", defaultMessage: "None" })} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="home"><FormattedMessage id="relaysSettings.homeRelays" defaultMessage="Home relays" /></SelectItem>
              <SelectItem value="published" disabled={userRelayUrls.length === 0}>
                <FormattedMessage id="relaysSettings.publishedList" defaultMessage="Published relay list" />
              </SelectItem>
              <SelectItem value="both" disabled={userRelayUrls.length === 0}>
                <FormattedMessage id="relaysSettings.both" defaultMessage="Both" />
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label={proofOfWork}
          info={intl.formatMessage({ id: "relaysSettings.proofOfWorkInfo", defaultMessage: "Work this device does before sending anything, so relays that ask for it accept your posts and messages (NIP-13). Each extra bit doubles how long that takes." })}
        >
          <Select value={config.powDifficulty === undefined ? "default" : String(config.powDifficulty)} onValueChange={setPowChoice}>
            <SelectTrigger className="w-44 sm:w-52" aria-label={proofOfWork}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                <FormattedMessage
                  id="relaysSettings.proofOfWorkDefault"
                  defaultMessage="Default ({bits, plural, =0 {off} one {# bit} other {# bits}})"
                  values={{ bits: defaultPowDifficulty() }}
                />
              </SelectItem>
              {POW_CHOICES.map((bits) => (
                <SelectItem key={bits} value={String(bits)}>
                  {bits === 0
                    ? <FormattedMessage id="relaysSettings.proofOfWorkOff" defaultMessage="Off" />
                    : <FormattedMessage id="relaysSettings.proofOfWorkBits" defaultMessage="{bits, plural, one {# bit} other {# bits}}" values={{ bits }} />}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
