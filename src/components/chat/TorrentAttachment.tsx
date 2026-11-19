import { ChevronDown, Download, Loader2, Magnet } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { useRoutedCandidates } from "@/hooks/useBlossomCandidates";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, common, t, useIntl } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";
import { decryptBuffer, fetchCapped, verifyPlaintextHash } from "@/lib/encryptedMedia";
import type { ImetaEncryption } from "@/lib/imeta";
import { parseTorrent, type TorrentMetainfo } from "@/lib/torrent";
import { cn } from "@/lib/utils";

const MAX_METAINFO_BYTES = 4 * 1024 * 1024;
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const actionClass = "flex min-h-9 touch:min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-background/50 px-3 py-2 text-sm font-semibold hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50";
const sectionClass = "mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

interface Props {
  url: string;
  name: string;
  encryption?: ImetaEncryption;
  fallbacks?: string[];
  held?: boolean;
  downloadRow: ReactNode;
  downloadStatus: "idle" | "loading" | "error";
  onDownload: () => Promise<void>;
  className?: string;
}

export function TorrentAttachment({ url, name, encryption, fallbacks, held, downloadRow, downloadStatus, onDownload, className }: Props) {
  const intl = useIntl();
  const detailsId = useId();
  const { sources } = useRoutedCandidates(url, fallbacks);
  const [allowed, setAllowed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState<{ sources: string[]; value: TorrentMetainfo | null }>();
  const shouldLoad = !held || allowed;
  const result = shouldLoad && loaded?.sources === sources ? loaded.value : undefined;

  useEffect(() => {
    if (!shouldLoad || !sources.length) { return; }
    const controller = new AbortController();
    async function load() {
      try {
        const raw = await fetchCapped(sources, { maxBytes: MAX_METAINFO_BYTES, signal: controller.signal });
        const bytes = new Uint8Array(encryption ? await decryptBuffer(raw, encryption.key, encryption.nonce) : raw);
        await verifyPlaintextHash(bytes, encryption?.ox);
        if (!controller.signal.aborted) {
          setLoaded({ sources, value: parseTorrent(bytes) });
        }
      } catch {
        if (!controller.signal.aborted) { setLoaded({ sources, value: null }); }
      }
    }
    void load();
    return () => controller.abort();
  }, [shouldLoad, sources, encryption]);

  if (!sources.length || result === null) { return downloadRow; }

  function formatSize(bytes: number): string {
    let unit = 0;
    while (bytes >= 1024 && unit < UNITS.length - 1) {
      bytes /= 1024;
      unit++;
    }
    return `${intl.formatNumber(bytes, { maximumFractionDigits: unit ? 1 : 0 })} ${UNITS[unit]}`;
  }

  async function copy(text: string) {
    try {
      await writeClipboardText(text);
      toast({ title: t(common.copied) });
    } catch {
      toast({ title: t({ id: "torrentAttachment.copyFailed", defaultMessage: "Could not copy to clipboard" }), variant: "destructive" });
    }
  }

  const open = expanded && !!result;
  return (
    <div className={cn("my-1.5 w-full max-w-xl rounded-xl bg-secondary/55 p-2", className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={shouldLoad && !result}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => {
          if (!shouldLoad) {
            setAllowed(true);
            setExpanded(true);
          } else {
            setExpanded(!expanded);
          }
        }}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-start hover:bg-background/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:hover:bg-transparent"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-background/50 text-primary">
          <Magnet className="size-5 rotate-[135deg]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <MiddleName value={result?.name ?? name} className="text-sm font-semibold" />
          <span className="block text-xs text-muted-foreground">
            <FormattedMessage id="torrentAttachment.type" defaultMessage="Torrent" />
            {result ? (
              <>
                {result.fileCount > 1 && <> · <FormattedMessage id="torrentAttachment.fileCount" defaultMessage="{count, plural, one {# file} other {# files}}" values={{ count: result.fileCount }} /></>}
                {` · ${formatSize(result.size)}`}
              </>
            ) : (
              <> · {shouldLoad ? <FormattedMessage {...common.loading} /> : <FormattedMessage id="torrentAttachment.load" defaultMessage="Load torrent details" />}</>
            )}
          </span>
        </span>
        {shouldLoad && !result ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden /> : (
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-180")} aria-hidden />
        )}
      </button>

      <div id={detailsId} hidden={!open}>
        {open && result && (
          <div className="space-y-4 px-2 py-3 text-sm">
            <section>
              <h4 className={sectionClass}><FormattedMessage id="torrentAttachment.files" defaultMessage="Files" /></h4>
              <ul className="max-h-64 overflow-y-auto rounded-lg bg-background/50 py-1">
                {result.files.map(({ path, size }, index) => (
                  <li key={index} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <MiddleName value={path} className="min-w-0" />
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatSize(size)}</span>
                  </li>
                ))}
                {result.fileCount > result.files.length && (
                  <li className="px-3 py-1.5 text-xs text-muted-foreground">
                    <FormattedMessage id="torrentAttachment.moreFiles" defaultMessage="{count, plural, one {# more file} other {# more files}}" values={{ count: result.fileCount - result.files.length }} />
                  </li>
                )}
              </ul>
            </section>

            <section>
              <h4 className={sectionClass}><FormattedMessage id="torrentAttachment.details" defaultMessage="Details" /></h4>
              <dl className="grid grid-cols-[minmax(5rem,24%)_minmax(0,1fr)] gap-x-3 gap-y-1.5 [overflow-wrap:anywhere]">
                <Detail label={<FormattedMessage id="torrentAttachment.hash" defaultMessage="Info hash" />}>
                  <button className="rounded text-start font-mono text-xs hover:underline focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]" type="button" title={intl.formatMessage({ id: "torrentAttachment.copyHash", defaultMessage: "Copy info hash" })} onClick={() => void copy(result.hash)}>{result.hash}</button>
                </Detail>
                <Detail label={<FormattedMessage id="torrentAttachment.pieces" defaultMessage="Pieces" />}>
                  {formatSize(result.pieceSize)} × {intl.formatNumber(result.pieceCount)}
                </Detail>
                {result.created && <Detail label={<FormattedMessage id="torrentAttachment.created" defaultMessage="Created" />}>{intl.formatDate(result.created * 1000, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" })}</Detail>}
                {result.createdBy && <Detail label={<FormattedMessage id="torrentAttachment.createdBy" defaultMessage="Created by" />}>{result.createdBy}</Detail>}
                {result.private && <Detail label={<FormattedMessage id="torrentAttachment.private" defaultMessage="Private" />}><FormattedMessage id="torrentAttachment.trackersOnly" defaultMessage="Trackers only" /></Detail>}
                {result.trackers.length > 0 && (
                  <Detail label={<FormattedMessage id="torrentAttachment.trackers" defaultMessage="Trackers" />}>
                    <ul className="space-y-1.5">{result.trackers.map((host, i) => <li key={i}>{host}</li>)}</ul>
                  </Detail>
                )}
                {result.comment && <Detail label={<FormattedMessage id="torrentAttachment.comment" defaultMessage="Comment" />}>{result.comment}</Detail>}
              </dl>
            </section>
          </div>
        )}
      </div>

      {result && (
        <div className="mt-1 space-y-1">
          {open && (
            <button type="button" className={actionClass} onClick={() => void onDownload()} disabled={downloadStatus === "loading"}>
              {downloadStatus === "loading" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
              <FormattedMessage id="torrentAttachment.download" defaultMessage="Download .torrent file" />
            </button>
          )}
          <button type="button" className={actionClass} onClick={() => void copy(result.magnet)}>
            <Magnet className="size-4 rotate-[135deg] text-primary" aria-hidden />
            <FormattedMessage id="torrentAttachment.copyMagnet" defaultMessage="Copy magnet link" />
          </button>
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd dir="auto">{children}</dd>
    </>
  );
}

function MiddleName({ value, className }: { value: string; className?: string }) {
  let middle = Math.ceil(value.length / 2);
  if ((value.charCodeAt(middle) & 0xfc00) === 0xdc00) { middle++; }
  return (
    <span className={cn("grid max-w-full grid-cols-[minmax(0,max-content)_minmax(0,max-content)]", className)} title={value}>
      <span className="sr-only">{value}</span>
      <span className="overflow-hidden text-ellipsis whitespace-pre" aria-hidden>{value.slice(0, middle)}</span>
      <span className="flex justify-end overflow-hidden whitespace-pre" aria-hidden>{value.slice(middle)}</span>
    </span>
  );
}
