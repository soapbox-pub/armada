import {
  Archive,
  BellRing,
  Database,
  Globe,
  HardDrive,
  Image,
  MessageSquareLock,
  Mic,
  Server,
  SlidersHorizontal,
  UserRound,
  Users,
} from "lucide-react";
import { Fragment, useCallback, useContext, useEffect, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsSearchingContext } from "@/components/settings/settingsNav";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/useToast";
import { common, defineMessages, FormattedMessage, useIntl, type IntlShape, type MessageDescriptor } from "@/i18n";
import { clearStorage, LOCAL_STORAGE_PART, measureStorage, type StoragePart, type StorageReport, type StorageRow, type StorageRowId } from "@/lib/storageUsage";

import type { LucideIcon } from "lucide-react";

const labels = defineMessages({
  media: { id: "storageSettings.media", defaultMessage: "Media cache" },
  communityImages: { id: "storageSettings.communityImages", defaultMessage: "Community icons and banners" },
  notificationAvatars: { id: "storageSettings.notificationAvatars", defaultMessage: "Notification pictures" },
  webCache: { id: "storageSettings.webCache", defaultMessage: "Web cache" },
  callRecordings: { id: "storageSettings.callRecordings", defaultMessage: "Unsaved call recordings" },
  legacy: { id: "storageSettings.legacy", defaultMessage: "Data from older versions" },
  dms: { id: "storageSettings.dms", defaultMessage: "Direct messages" },
  communities: { id: "storageSettings.communities", defaultMessage: "Communities" },
  servers: { id: "storageSettings.servers", defaultMessage: "Relay servers" },
  profiles: { id: "storageSettings.profiles", defaultMessage: "Profiles and lists" },
  otherData: { id: "storageSettings.otherData", defaultMessage: "Other events" },
  settings: { id: "storageSettings.settings", defaultMessage: "Settings and sync state" },
});

const descriptions = defineMessages({
  media: { id: "storageSettings.mediaDescription", defaultMessage: "Images and files from chats. Encrypted ones stay encrypted." },
  communityImages: { id: "storageSettings.communityImagesDescription", defaultMessage: "Decrypted so communities show up quickly." },
  notificationAvatars: { id: "storageSettings.notificationAvatarsDescription", defaultMessage: "Profile pictures shown on notifications." },
  webCache: { id: "storageSettings.webCacheDescription", defaultMessage: "Pictures and pages the app loaded recently, including profile pictures." },
  callRecordings: { id: "storageSettings.callRecordingsDescription", defaultMessage: "Recordings that were never saved, for example after a crash." },
  legacy: { id: "storageSettings.legacyDescription", defaultMessage: "Storage an earlier version of Armada left behind." },
});

/** Names for the pieces of settings and sync state worth naming; any other shows its key group. */
const partLabels: Record<string, MessageDescriptor> = defineMessages({
  [LOCAL_STORAGE_PART]: { id: "storageSettings.part.localStorage", defaultMessage: "Settings on this device" },
  c2seal: { id: "storageSettings.part.seals", defaultMessage: "Message signatures" },
  "folded:c2-timeline-snap": { id: "storageSettings.part.channelSnapshots", defaultMessage: "Channel snapshots" },
  "folded:dm17-thread-snap": { id: "storageSettings.part.dmSnapshots", defaultMessage: "Direct message snapshots" },
  "folded:concord2-fold": { id: "storageSettings.part.communityState", defaultMessage: "Community roles and channels" },
  decrypt: { id: "storageSettings.part.decrypted", defaultMessage: "Decrypted message cache" },
  "verified-ids": { id: "storageSettings.part.verified", defaultMessage: "Checked signatures" },
  "plane-seen-wraps": { id: "storageSettings.part.communitySync", defaultMessage: "Community sync progress" },
  c2gkmemo: { id: "storageSettings.part.communityKeys", defaultMessage: "Community key cache" },
});

const ICONS: Record<StorageRowId, LucideIcon> = {
  media: Image,
  communityImages: Users,
  notificationAvatars: BellRing,
  webCache: Globe,
  callRecordings: Mic,
  legacy: Archive,
  dms: MessageSquareLock,
  communities: Users,
  servers: Server,
  profiles: UserRound,
  otherData: Database,
  settings: SlidersHorizontal,
};

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** A size in the app's language, decimal units as phones and desktops report them. */
function formatSize(intl: IntlShape, bytes: number): string {
  let n = Math.max(0, bytes);
  let i = 0;
  while (n >= 1000 && i < UNITS.length - 1) {
    n /= 1000;
    i++;
  }
  return intl.formatNumber(n, {
    style: "unit",
    unit: UNITS[i],
    unitDisplay: "short",
    maximumFractionDigits: i > 0 && n < 10 ? 1 : 0,
  });
}

/** Settings › Storage: what Armada keeps on this device, and clearing its caches. */
export function StorageSettings() {
  const intl = useIntl();
  // Search renders every page at once; measuring then would walk every store for nothing.
  const searching = useContext(SettingsSearchingContext);
  const [report, setReport] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState<StorageRowId | null>(null);
  const [confirm, setConfirm] = useState<StorageRowId | null>(null);
  const [openParts, setOpenParts] = useState(false);

  const refresh = useCallback(async () => {
    const next = await measureStorage().catch(() => null);
    setReport(next);
  }, []);

  useEffect(() => {
    if (!searching) void refresh();
  }, [searching, refresh]);

  const clear = useCallback(async (id: StorageRowId) => {
    setBusy(id);
    try {
      await clearStorage(id);
      toast({ title: intl.formatMessage({ id: "storageSettings.cleared", defaultMessage: "Cleared" }) });
    } catch {
      toast({ title: intl.formatMessage({ id: "storageSettings.clearFailed", defaultMessage: "Couldn't clear it" }), variant: "destructive" });
    } finally {
      setBusy(null);
      await refresh();
    }
  }, [intl, refresh]);

  const size = (bytes: number | undefined) =>
    report === null ? "…" : bytes === undefined ? "—" : formatSize(intl, bytes);

  const caches = report?.caches ?? [];
  const data = report?.data ?? [];

  return (
    <>
      <SettingsGroup
        id="storage"
        footer={report?.quotaBytes !== undefined
          ? intl.formatMessage(
            { id: "storageSettings.quota", defaultMessage: "This browser lets Armada use up to {quota}." },
            { quota: formatSize(intl, report.quotaBytes) },
          )
          : undefined}
      >
        <SettingsRow
          icon={HardDrive}
          tone="primary"
          label={intl.formatMessage({ id: "storageSettings.total", defaultMessage: "Used on this device" })}
          value={size(report?.totalBytes)}
        />
      </SettingsGroup>

      <SettingsGroup
        id="storage-caches"
        title={intl.formatMessage({ id: "storageSettings.cachesTitle", defaultMessage: "Caches" })}
        footer={intl.formatMessage({ id: "storageSettings.cachesFooter", defaultMessage: "Clearing a cache only frees space. Armada downloads what it needs again." })}
      >
        {caches.map((row) => (
          <CacheRow
            key={row.id}
            row={row}
            label={labels[row.id]}
            description={descriptions[row.id as keyof typeof descriptions]}
            value={size(row.bytes)}
            busy={busy === row.id}
            onClear={row.id === "callRecordings" ? setConfirm : clear}
          />
        ))}
        {report === null && (
          <SettingsRow label={intl.formatMessage(common.loading)} />
        )}
      </SettingsGroup>

      <SettingsGroup
        id="storage-data"
        title={intl.formatMessage({ id: "storageSettings.dataTitle", defaultMessage: "Messages and data" })}
        footer={intl.formatMessage({ id: "storageSettings.dataFooter", defaultMessage: "Message history may exist only on this device, so it can't be cleared here. Logging out removes everything." })}
      >
        {data.map((row) => (
          <Fragment key={row.id}>
            <SettingsRow
              icon={ICONS[row.id]}
              label={intl.formatMessage(labels[row.id])}
              description={row.count !== undefined ? items(intl, row.count) : undefined}
              value={size(row.bytes)}
              {...(row.parts?.length ? { onClick: () => setOpenParts((open) => !open), chevron: true } : {})}
            />
            {openParts && row.parts?.map((part) => (
              <PartRow key={part.id} part={part} value={size(part.bytes)} />
            ))}
          </Fragment>
        ))}
        {report === null && (
          <SettingsRow label={intl.formatMessage(common.loading)} />
        )}
      </SettingsGroup>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <FormattedMessage id="storageSettings.confirmRecordingsTitle" defaultMessage="Delete unsaved recordings?" />
            </AlertDialogTitle>
            <AlertDialogDescription>
              <FormattedMessage
                id="storageSettings.confirmRecordingsDescription"
                defaultMessage="These recordings were never saved anywhere else. Once deleted, they're gone."
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <FormattedMessage {...common.cancel} />
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const id = confirm;
                setConfirm(null);
                if (id) void clear(id);
              }}
            >
              <FormattedMessage {...common.delete} />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function items(intl: IntlShape, count: number): string {
  return intl.formatMessage(
    { id: "storageSettings.events", defaultMessage: "{count, plural, one {# item} other {# items}}" },
    { count },
  );
}

/** One piece of a data row; an unnamed one shows its key group, which is what a bug report needs. */
function PartRow({ part, value }: { part: StoragePart; value: string }) {
  const intl = useIntl();
  const named = partLabels[part.id];
  return (
    <SettingsRow
      className="pl-14"
      label={named ? intl.formatMessage(named) : <code className="font-mono text-xs">{part.id}</code>}
      description={part.entries !== undefined ? items(intl, part.entries) : undefined}
      value={value}
    />
  );
}

function CacheRow({
  row,
  label,
  description,
  value,
  busy,
  onClear,
}: {
  row: StorageRow;
  label: MessageDescriptor;
  description?: MessageDescriptor;
  value: string;
  busy: boolean;
  onClear: (id: StorageRowId) => void;
}) {
  const intl = useIntl();
  return (
    <SettingsRow
      icon={ICONS[row.id]}
      label={intl.formatMessage(label)}
      description={description ? intl.formatMessage(description) : undefined}
      value={value}
    >
      <Button
        variant="secondary"
        size="sm"
        className="touch:h-11"
        disabled={!row.clearable || busy}
        onClick={() => onClear(row.id)}
      >
        <FormattedMessage id="storageSettings.clear" defaultMessage="Clear" />
      </Button>
    </SettingsRow>
  );
}
