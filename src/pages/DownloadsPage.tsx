import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, Download, Globe, Info, RefreshCw } from "lucide-react";
import { type ComponentType, type MouseEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import {
  AndroidMark,
  AppImageMark,
  AppleMark,
  DebianMark,
  FlatpakMark,
  LinuxMark,
  WindowsMark,
} from "@/components/brand/PlatformMarks";
import { AsciiSea } from "@/components/landing/AsciiSea";
import { Button } from "@/components/ui/button";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { useReleaseArtifacts, useReleases } from "@/hooks/useReleases";
import { toast } from "@/hooks/useToast";
import { common, defineMessages, FormattedMessage, t, useIntl, type IntlShape, type MessageDescriptor } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";
import {
  ANDROID_STORES,
  DOWNLOAD_PLATFORMS,
  type DownloadOs,
  IOS_TESTFLIGHT_URL,
  NPKG_HOST,
  PACKAGE_MANAGERS,
  detectCurrentOs,
  installCommand,
  isRepublishedPackage,
} from "@/lib/downloads";
import { formatBytes } from "@/lib/fileBytes";
import { APP_NAME } from "@/lib/platform";
import { HashMismatchError, downloadArtifact } from "@/lib/releaseDownload";
import { featuredRelease, isStable, type Release, type ReleaseArtifact } from "@/lib/releases";
import { cn } from "@/lib/utils";
import { scrollBehavior } from "@/lib/reducedMotion";

/**
 * The downloads deck, in the landing's visual language over the
 * {@link AsciiSea}. Every file comes from a NIP-82 release and its asset events
 * (`docs/releases.md`): verifiable links, at the cost of a spinner on a cold pool.
 */

type Icon = ComponentType<{ className?: string }>;

const OS_ICON: Record<DownloadOs, Icon> = {
  linux: LinuxMark,
  windows: WindowsMark,
  macos: AppleMark,
  android: AndroidMark,
  ios: AppleMark,
};

/** Picker labels: every one stays visible, so they must fit a fifth of a phone. */
const SHORT_NAME: Record<DownloadOs, string> = {
  linux: "Linux",
  windows: "Windows",
  macos: "macOS",
  android: "Android",
  ios: "iPhone",
};

/** Package-manager marks, keyed by `PackageManager.label`. */
const METHOD_ICON: Record<string, Icon> = {
  "Debian / Ubuntu (APT)": DebianMark,
  Flatpak: FlatpakMark,
};

/**
 * An artifact's name within its platform's tab: "Windows installer (x64)"
 * becomes "Installer" over "x64", "macOS (Intel)" becomes "Intel".
 */
function artifactName(artifact: ReleaseArtifact): { title: string; detail?: string } {
  const match = /^(.*?)\s*\(([^)]+)\)$/.exec(artifact.label);
  const base = (match ? match[1] : artifact.label).replace(/^(Windows|Linux|macOS|Android)\s*/, "");
  const paren = match?.[2];
  if (!base) return { title: paren ?? artifact.label };
  return { title: base.charAt(0).toUpperCase() + base.slice(1), detail: paren };
}

/** A note the user needs BEFORE the download, not after it fails to open. */
const OS_CAVEAT: Partial<Record<DownloadOs, MessageDescriptor>> = defineMessages({
  macos: {
    id: "downloadsPage.caveat.macos",
    defaultMessage: "First launch: Control-click the app, choose Open, then Open Anyway.",
  },
  android: {
    id: "downloadsPage.caveat.android",
    defaultMessage: "Installing the APK asks Android to allow installs from your browser.",
  },
});

const m = defineMessages({
  addToHomeScreen: { id: "downloadsPage.ios.addToHomeScreen", defaultMessage: "Then add it to your Home Screen" },
  testflightTitle: { id: "downloadsPage.ios.testflightTitle", defaultMessage: "Join the beta on TestFlight" },
  testflightDetail: { id: "downloadsPage.ios.testflightDetail", defaultMessage: "Requires Apple's TestFlight app" },
});

/** Earlier releases shown before "show all". */
const OLDER_PREVIEW = 5;

/** Opaque enough to read over the sea; the blur keeps the swell as texture. */
const PANEL = "vessel backdrop-blur-md [--vessel-fill:hsl(var(--background)/0.86)]";

/** NIP-82 versions drop the tag's `v`; the page shows the tag. */
function displayVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

function displayDate(createdAt: number, locale: string): string {
  return new Date(createdAt * 1000).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** Tab order; unplaceable artifacts sort last. */
function osOrder(os: DownloadOs | undefined): number {
  const index = DOWNLOAD_PLATFORMS.findIndex((platform) => platform.os === os);
  return index === -1 ? DOWNLOAD_PLATFORMS.length : index;
}

/** The badge a prerelease wears; undefined for a stable release. */
function prereleaseBadge(release: Release, intl: IntlShape): string | undefined {
  if (isStable(release)) return undefined;
  return release.channel === "main"
    ? intl.formatMessage({ id: "downloadsPage.prerelease", defaultMessage: "prerelease" })
    : release.channel;
}

/**
 * The release's artifacts by platform. `.deb`/`.flatpak` are omitted:
 * they're served via pkg.soapbox.pub ({@link PACKAGE_MANAGERS}) but stay in
 * the release event for npkg.
 */
function groupByOs(artifacts: readonly ReleaseArtifact[] | undefined): Map<DownloadOs, ReleaseArtifact[]> {
  const grouped = new Map<DownloadOs, ReleaseArtifact[]>();
  for (const artifact of artifacts ?? []) {
    if (!artifact.os) continue;
    if (isRepublishedPackage(artifact.filename)) continue;
    const existing = grouped.get(artifact.os);
    if (existing) existing.push(artifact);
    else grouped.set(artifact.os, [artifact]);
  }
  return grouped;
}

/** A terminal block holding every line of one install; a single copy takes the lot. */
function CommandBlock({ commands }: { commands: string[] }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = async () => {
    try {
      await writeClipboardText(commands.join("\n"));
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: t({ id: "downloadsPage.copyFailed.title", defaultMessage: "Copy failed" }),
        description: t({
          id: "downloadsPage.copyFailed.description",
          defaultMessage: "Select the commands and copy them manually.",
        }),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="relative clip-corner-lg bg-black/45">
      <pre className="whitespace-pre-wrap break-all py-3 pl-3.5 pr-12 font-mono text-xs leading-relaxed text-foreground/85">
        {commands.map((command) => (
          <code key={command} className="block">
            <span aria-hidden="true" className="select-none text-[hsl(var(--accent2))]">$ </span>
            {command}
          </code>
        ))}
      </pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={copy}
        aria-label={copied
          ? intl.formatMessage(common.copied)
          : intl.formatMessage({ id: "downloadsPage.copyCommands", defaultMessage: "Copy commands" })}
        className="absolute right-1.5 top-1.5 size-8 touch:size-11 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

/** Install-method chooser: each option is a filled chip with its mark. */
function Segments<T extends string>({ options, value, onChange }: {
  options: readonly { id: T; label: string; icon: Icon }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const OptionIcon = option.icon;
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex h-10 items-center gap-2 clip-corner-lg px-3.5 text-sm font-medium transition-colors touch:h-11",
              active
                ? "bg-primary/20 text-foreground"
                : "bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
            )}
          >
            <OptionIcon className={cn("size-4 shrink-0", active && "text-primary")} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Saves an artifact under its release filename, verified against its hash.
 * The link's own href stays the fallback: for modified clicks (new tab, save
 * as) and for a host that refuses the fetch.
 */
function useArtifactDownload(artifact: ReleaseArtifact | undefined) {
  // Whole percent, so a 140 MB stream re-renders ~100 times rather than per chunk.
  const [percent, setPercent] = useState<number>();
  const busy = useRef(false);

  const onClick = async (event: MouseEvent) => {
    if (!artifact) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPercent(0);
    try {
      await downloadArtifact(artifact, (fraction) => setPercent(Math.floor(fraction * 100)));
    } catch (error) {
      if (error instanceof HashMismatchError) {
        toast({
          title: t({ id: "downloadsPage.downloadBlocked.title", defaultMessage: "Download blocked" }),
          description: t({
            id: "downloadsPage.downloadBlocked.description",
            defaultMessage: "The file didn't match the hash its release names, so it wasn't saved.",
          }),
          variant: "destructive",
        });
      } else {
        window.location.assign(artifact.url);
      }
    } finally {
      busy.current = false;
      setPercent(undefined);
    }
  };

  return { onClick, percent };
}

/** A thin fill along the bottom edge while a download streams. */
function ProgressBar({ percent }: { percent: number }) {
  return (
    <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
      <span className="block h-full bg-[hsl(var(--accent2))] transition-[width] duration-150" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** A filled link tile: an icon well, a name over a detail line, and a trailing cue. */
function Tile({ href, to, icon, title, detail, external, download, primary, onClick, percent }: {
  href?: string;
  onClick?: (event: MouseEvent) => void;
  /** Set while a download streams; replaces the detail line. */
  percent?: number;
  /** An in-app route, followed by the router rather than a page load. */
  to?: string;
  icon: ReactNode;
  title: string;
  detail?: string;
  external?: boolean;
  download?: string;
  primary?: boolean;
}) {
  const Cue = external || to ? ArrowUpRight : Download;
  const className = cn(
    "group relative flex min-h-[4.5rem] items-center gap-3.5 clip-corner-lg px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    primary
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]",
  );
  const body = (
    <>
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center clip-corner",
          primary ? "bg-black/15" : "bg-foreground/[0.07]",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[0.9375rem] font-semibold leading-tight">{title}</span>
        {(detail || percent !== undefined) && (
          <span className={cn("truncate text-xs leading-tight", primary ? "opacity-80" : "text-muted-foreground")}>
{percent !== undefined ? (
              <FormattedMessage
                id="downloadsPage.downloading"
                defaultMessage="Downloading… {percent}%"
                values={{ percent }}
              />
            ) : detail}
          </span>
        )}
      </span>
      {percent !== undefined && <ProgressBar percent={percent} />}
      <Cue
        className={cn(
          "size-4 shrink-0 transition-transform motion-reduce:transition-none",
          external || to ? "group-hover:-translate-y-0.5 group-hover:translate-x-0.5" : "group-hover:translate-y-0.5",
          primary ? "opacity-90" : "text-muted-foreground group-hover:text-foreground",
        )}
      />
    </>
  );
  if (to) return <Link to={to} className={className}>{body}</Link>;
  return (
    <a
      href={href}
      download={download}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      onClick={onClick}
      aria-busy={percent !== undefined || undefined}
      className={className}
    >
      {body}
    </a>
  );
}

function ArtifactTile({ artifact, icon: TileIcon, primary, full }: {
  artifact: ReleaseArtifact;
  icon: Icon;
  primary?: boolean;
  /** Keep the platform in the name, for lists that mix platforms. */
  full?: boolean;
}) {
  const name = artifactName(artifact);
  const size = artifact.size ? formatBytes(artifact.size) : undefined;
  // Mixed lists keep "(Intel)"/"(Apple silicon)": they're the only difference between two macOS rows.
  const title = full ? artifact.label.replace(/\s*\((x86_64|x64)\)$/, "") : name.title;
  const detail = [full ? undefined : name.detail, size].filter(Boolean).join(" · ") || undefined;
  const { onClick, percent } = useArtifactDownload(artifact);
  return (
    <Tile
      href={artifact.url}
      download={artifact.filename}
      onClick={onClick}
      percent={percent}
      icon={<TileIcon className="size-5" />}
      title={title}
      detail={detail}
      primary={primary}
    />
  );
}

function Caveat({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** Linux: the auto-updating repositories first, the AppImage as the last option. */
function LinuxPanel({ artifacts }: { artifacts: ReleaseArtifact[] }) {
  const appImage = artifacts.find((artifact) => installCommand(artifact.filename));
  const options = [
    ...PACKAGE_MANAGERS.filter((manager) => manager.os === "linux").map((manager) => ({
      id: manager.label,
      label: manager.label.replace(/\s*\(.*\)$/, ""),
      icon: METHOD_ICON[manager.label] ?? LinuxMark,
    })),
    ...(appImage ? [{ id: "appimage", label: "AppImage", icon: AppImageMark }] : []),
  ];
  const [method, setMethod] = useState(options[0]?.id ?? "appimage");
  const manager = PACKAGE_MANAGERS.find((m) => m.label === method);
  const others = artifacts.filter((artifact) => artifact !== appImage);

  return (
    <div className="space-y-4">
      <Segments options={options} value={method} onChange={setMethod} />
      {manager ? (
        <>
          <CommandBlock commands={[...manager.setup, manager.install]} />
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="downloadsPage.linux.repoHint"
              defaultMessage="Paste into a terminal. Updates then arrive with the rest of your system, from {host}."
              values={{
                host: (
                  <a
                    href={`https://${NPKG_HOST}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground/90 underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current"
                  >
                    {NPKG_HOST}
                  </a>
                ),
              }}
            />
          </p>
        </>
      ) : appImage ? (
        <>
          <ArtifactTile artifact={appImage} icon={AppImageMark} primary />
          <CommandBlock commands={[installCommand(appImage.filename)!]} />
        </>
      ) : null}
      {others.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {others.map((artifact) => <ArtifactTile key={artifact.id} artifact={artifact} icon={LinuxMark} />)}
        </div>
      )}
    </div>
  );
}

function AndroidPanel({ artifacts }: { artifacts: ReleaseArtifact[] }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {ANDROID_STORES.map((store) => (
          <Tile
            key={store.url}
            href={store.url}
            external
            icon={<img src={store.icon} alt="" className="size-6" />}
            title={store.label}
          />
        ))}
        {artifacts.map((artifact) => <ArtifactTile key={artifact.id} artifact={artifact} icon={AndroidMark} />)}
      </div>
      {artifacts.length > 0 && OS_CAVEAT.android && (
        <Caveat>
          <FormattedMessage {...OS_CAVEAT.android} />
        </Caveat>
      )}
    </div>
  );
}

/** iOS: the TestFlight beta first, then the web app (Add to Home Screen) as a real install. */
const strong = (chunks: ReactNode[]) => <strong className="font-medium text-foreground">{chunks}</strong>;

function IosPanel() {
  const intl = useIntl();
  const steps = [
    <FormattedMessage
      key="open"
      id="downloadsPage.ios.stepOpen"
      defaultMessage="Open {app} in <b>Safari</b>"
      values={{ app: APP_NAME, b: strong }}
    />,
    <FormattedMessage key="share" id="downloadsPage.ios.stepShare" defaultMessage="Tap <b>Share</b>" values={{ b: strong }} />,
    <FormattedMessage
      key="add"
      id="downloadsPage.ios.stepAdd"
      defaultMessage="Choose <b>Add to Home Screen</b>"
      values={{ b: strong }}
    />,
  ];

  return (
    <div className="space-y-5">
      <Tile
        href={IOS_TESTFLIGHT_URL}
        external
        primary
        icon={<AppleMark className="size-5" />}
        title={intl.formatMessage(m.testflightTitle)}
        detail={intl.formatMessage(m.testflightDetail)}
      />
      <p className="text-xs text-muted-foreground">
        <FormattedMessage id="downloadsPage.ios.orWebApp" defaultMessage="Or install the web app:" />
      </p>
      <ol className="space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="flex size-7 shrink-0 items-center justify-center clip-corner bg-primary/15 font-mono text-xs font-bold text-primary">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <Tile
        to="/"
        icon={<Globe className="size-5" />}
        title={intl.formatMessage(
          { id: "downloadsPage.ios.openInBrowser", defaultMessage: "Open {app} in this browser" },
          { app: APP_NAME },
        )}
        detail={intl.formatMessage(m.addToHomeScreen)}
      />
    </div>
  );
}

function PlatformPanel({ os, artifacts }: { os: DownloadOs; artifacts: ReleaseArtifact[] }) {
  if (os === "ios") return <IosPanel />;
  if (os === "linux") return <LinuxPanel artifacts={artifacts} />;
  if (os === "android") return <AndroidPanel artifacts={artifacts} />;

  const caveat = OS_CAVEAT[os];
  if (artifacts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <FormattedMessage id="downloadsPage.noBuild" defaultMessage="This release has no build for this platform." />
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {artifacts.map((artifact, i) => (
          <ArtifactTile key={artifact.id} artifact={artifact} icon={OS_ICON[os]} primary={i === 0} />
        ))}
      </div>
      {caveat && (
        <Caveat>
          <FormattedMessage {...caveat} />
        </Caveat>
      )}
    </div>
  );
}

/** The platform chooser: a row of large, always-labelled logo tiles. */
function PlatformPicker({ value, onChange }: { value: DownloadOs; onChange: (os: DownloadOs) => void }) {
  const intl = useIntl();
  return (
    <div
      role="radiogroup"
      aria-label={intl.formatMessage({ id: "downloadsPage.platform", defaultMessage: "Platform" })} className="grid grid-cols-5 gap-1.5 sm:gap-2">
      {DOWNLOAD_PLATFORMS.map((platform) => {
        const Mark = OS_ICON[platform.os];
        const active = platform.os === value;
        return (
          <button
            key={platform.os}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={platform.name}
            onClick={() => onChange(platform.os)}
            className={cn(
              "flex flex-col items-center gap-2 clip-corner-lg px-1 pb-2.5 pt-3.5 transition-colors sm:pb-3 sm:pt-4",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
            )}
          >
            <Mark className="size-6 sm:size-7" />
            <span className="text-xs font-medium sm:text-sm">{SHORT_NAME[platform.os]}</span>
          </button>
        );
      })}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-8 w-48 animate-pulse clip-corner bg-muted-foreground/10" />
      <div className="h-24 animate-pulse clip-corner-lg bg-muted-foreground/10" />
    </div>
  );
}

/** One past version, collapsed. Its artifacts are fetched on first expand. */
function OlderRelease({ release }: { release: Release }) {
  const intl = useIntl();
  const [opened, setOpened] = useState(false);
  const artifacts = useReleaseArtifacts(opened ? release : undefined);
  const badge = prereleaseBadge(release, intl);

  return (
    <details
      className="group/release"
      onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-3 clip-corner px-2 font-mono text-sm text-muted-foreground transition-colors marker:content-none hover:bg-foreground/[0.05] hover:text-foreground touch:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 shrink-0 -rotate-90 transition-transform group-open/release:rotate-0 motion-reduce:transition-none" />
        <span className="text-foreground/90">{displayVersion(release.version)}</span>
        {badge && <span className="text-3xs lowercase tracking-wide text-primary/80">{badge}</span>}
        <span className="ml-auto text-xs opacity-70">{displayDate(release.createdAt, intl.locale)}</span>
      </summary>
      <div className="grid gap-2 pb-3 pt-1 sm:grid-cols-2">
        {artifacts.isPending ? (
          <>
            <div className="h-12 animate-pulse clip-corner-lg bg-muted-foreground/10" />
            <div className="h-12 animate-pulse clip-corner-lg bg-muted-foreground/10" />
          </>
        ) : (artifacts.data ?? [])
          .filter((artifact) => !isRepublishedPackage(artifact.filename))
          .sort((a, b) => osOrder(a.os) - osOrder(b.os))
          .map((artifact) => (
            <ArtifactTile key={artifact.id} artifact={artifact} icon={artifact.os ? OS_ICON[artifact.os] : Download} full />
          ))}
      </div>
    </details>
  );
}

/** Collapsed to one line until asked for: most visitors want the current build. */
function OlderReleases({ releases }: { releases: Release[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? releases : releases.slice(0, OLDER_PREVIEW);

  return (
    <details className="group/older">
      <summary className="mx-auto flex w-fit cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-mono text-xs lowercase tracking-wide text-muted-foreground transition-colors marker:content-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <FormattedMessage id="downloadsPage.earlierReleases" defaultMessage="earlier releases" />
        <ChevronDown className="size-3.5 transition-transform group-open/older:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="vessel-lift mt-3">
        <section className={cn(PANEL, "p-3 sm:p-4")}>
          {shown.map((release) => (
            <OlderRelease key={release.id} release={release} />
          ))}
          <div className="mt-2 flex items-center justify-between px-2 font-mono text-xs lowercase tracking-wide text-muted-foreground">
            {releases.length > OLDER_PREVIEW ? (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="py-2 transition-colors hover:text-foreground"
              >
                {showAll ? (
                  <FormattedMessage id="downloadsPage.showFewer" defaultMessage="show fewer" />
                ) : (
                  <FormattedMessage
                    id="downloadsPage.showAll"
                    defaultMessage="show all {count}"
                    values={{ count: releases.length }}
                  />
                )}
              </button>
            ) : <span />}
            <Link to="/changelog" className="py-2 transition-colors hover:text-foreground">
              <FormattedMessage id="downloadsPage.changelogLink" defaultMessage="changelog →" />
            </Link>
          </div>
        </section>
      </div>
    </details>
  );
}

/** The page's one call to action: the detected platform's mark, big, over its build details. */
function HeroButton({ href, to, external, download, icon: Mark, title, detail, onClick, percent }: {
  href?: string;
  onClick?: (event: MouseEvent) => void;
  percent?: number;
  to?: string;
  /** An off-site page (opened in a new tab) rather than a file. */
  external?: boolean;
  download?: string;
  icon: Icon;
  title: string;
  detail: string;
}) {
  const body = (
    <>
      <span className="flex size-12 shrink-0 items-center justify-center clip-corner bg-black/15">
        <Mark className="size-7" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
        <span className="text-lg font-semibold leading-tight">{title}</span>
        <span className="truncate text-xs leading-tight opacity-80">
          {percent !== undefined ? (
            <FormattedMessage
              id="downloadsPage.downloading"
              defaultMessage="Downloading… {percent}%"
              values={{ percent }}
            />
          ) : detail}
        </span>
      </span>
      {to || external ? (
        <ArrowUpRight className="mr-1 size-5 shrink-0 opacity-90 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transition-none" />
      ) : (
        <Download className="mr-1 size-5 shrink-0 opacity-90 transition-transform group-hover:translate-y-0.5 motion-reduce:transition-none" />
      )}
    </>
  );
  const className = "group relative flex h-[4.5rem] w-full items-center gap-4 clip-corner-lg bg-primary px-3 text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    // clip-path cuts a box-shadow, so the glow is a filter on a wrapper.
    <div className="w-full [filter:drop-shadow(0_10px_30px_hsl(var(--primary)/0.35))]">
      {to ? (
        <Link to={to} className={className}>{body}</Link>
      ) : (
        <a
          href={href}
          download={download}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
          onClick={onClick}
          aria-busy={percent !== undefined || undefined} className={className}>
          {body}
          {percent !== undefined && <ProgressBar percent={percent} />}
        </a>
      )}
    </div>
  );
}

export function DownloadsPage() {
  const intl = useIntl();
  const back = useBackOrHome();
  // The sea reads scrollTop imperatively, so a ref, never state.
  const scrollRef = useRef<HTMLElement>(null);
  const targetsRef = useRef<HTMLElement>(null);
  // Detected once: a featured card moving between renders is worse than a wrong guess.
  const detected = useMemo(() => detectCurrentOs(), []);
  const [selectedOs, setSelectedOs] = useState<DownloadOs>(detected ?? DOWNLOAD_PLATFORMS[0].os);

  const releases = useReleases();
  // Newest STABLE leads, so a release candidate doesn't become everyone's download.
  const latest = useMemo(() => featuredRelease(releases.data ?? []), [releases.data]);
  const older = (releases.data ?? []).filter((release) => release !== latest);
  const artifacts = useReleaseArtifacts(latest);
  const byOs = useMemo(() => groupByOs(artifacts.data), [artifacts.data]);
  const pending = releases.isPending || (!!latest && artifacts.isPending);


  // On iOS the primary action is the TestFlight beta; with no detection, the hero cues the list.
  const featured = DOWNLOAD_PLATFORMS.find((platform) => platform.os === detected);
  const heroArtifact = featured ? byOs.get(featured.os)?.[0] : undefined;
  const heroDownload = useArtifactDownload(heroArtifact);
  // Only shown when nothing stable was ever tagged (`featuredRelease` prefers stable).
  const channel = latest ? prereleaseBadge(latest, intl) : undefined;

  const scrollToTargets = () => {
    targetsRef.current?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "start",
    });
  };

  return (
    <main ref={scrollRef} className="relative flex-1 min-w-0 overflow-y-auto">
      {/* Viewport-locked sea: `sticky` pins it, `-mb-[100svh]` cancels its scroll height. */}
      <div className="pointer-events-none sticky top-0 z-0 -mb-[100svh] h-[100svh]">
        <AsciiSea scrollRef={scrollRef} />
      </div>

      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage(common.back)}
        onClick={back}
        className="absolute left-2 top-2 z-20 size-9 touch:size-11 text-muted-foreground hover:text-foreground safe-area-top"
      >
        <ArrowLeft className="size-5" />
      </Button>

      <div className="relative z-10">
        <section className="mx-auto flex min-h-[88svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-top">
          <ArmadaCrest size={130} />
          <div className="space-y-3">
            <h1 className="font-mono text-3xl font-bold lowercase tracking-tight text-foreground sm:text-4xl">
              <FormattedMessage
                id="downloadsPage.title"
                defaultMessage="get {app}"
                values={{ app: APP_NAME.toLowerCase() }}
              />
            </h1>
            <p className="text-pretty text-sm text-muted-foreground sm:text-base">
              <FormattedMessage id="downloadsPage.tagline" defaultMessage="Desktop, phone or browser." />
            </p>
          </div>

          <div className="flex w-full max-w-sm flex-col items-center">
            {heroArtifact && featured ? (
              <HeroButton
                href={heroArtifact.url}
                onClick={heroDownload.onClick}
                percent={heroDownload.percent}
                download={heroArtifact.filename}
                icon={OS_ICON[featured.os]}
                title={intl.formatMessage(
                  { id: "downloadsPage.downloadFor", defaultMessage: "Download for {platform}" },
                  { platform: featured.name },
                )}
                detail={[
                  artifactName(heroArtifact).title,
                  latest && `${displayVersion(latest.version)}${channel ? ` ${channel}` : ""}`,
                  heroArtifact.size > 0 && formatBytes(heroArtifact.size),
                ].filter(Boolean).join(" · ")}
              />
            ) : featured?.os === "ios" ? (
              <HeroButton
                href={IOS_TESTFLIGHT_URL}
                external
                icon={AppleMark}
                title={intl.formatMessage(m.testflightTitle)}
                detail={intl.formatMessage(m.testflightDetail)}
              />
            ) : pending ? (
              <div className="h-[4.5rem] w-full animate-pulse clip-corner-lg bg-muted-foreground/15" />
            ) : null}
            <button
              type="button"
              onClick={scrollToTargets}
              className="group mt-6 flex w-full flex-col items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {heroArtifact || featured?.os === "ios" ? (
                <FormattedMessage id="downloadsPage.otherPlatforms" defaultMessage="Other platforms" />
              ) : (
                <FormattedMessage id="downloadsPage.allPlatforms" defaultMessage="All platforms" />
              )}
              {/* U+2193: WGL4 core, so every system font has a glyph. */}
              <span
                aria-hidden="true"
                className="animate-[armada-bob_2.4s_ease-in-out_infinite] text-base leading-none text-[hsl(var(--accent2)/0.75)] group-hover:text-[hsl(var(--accent2))]"
              >
                &#8595;
              </span>
            </button>
          </div>
        </section>

        <section ref={targetsRef} className="mx-auto max-w-2xl scroll-mt-6 space-y-4 px-4 pb-12 pt-4 sm:px-6">
          <div className="vessel-lift">
            <div className={cn(PANEL, "space-y-6 p-4 sm:p-6")}>
              <PlatformPicker value={selectedOs} onChange={setSelectedOs} />

              {pending ? (
                <PanelSkeleton />
              ) : latest ? (
                <PlatformPanel key={selectedOs} os={selectedOs} artifacts={byOs.get(selectedOs) ?? []} />
              ) : (
                // No compiled-in fallback list; explain rather than render an empty page.
                <div className="space-y-3 py-4 text-center">
                  <p className="font-mono text-sm lowercase tracking-tight text-foreground">
                    <FormattedMessage id="downloadsPage.noReleases" defaultMessage="no releases found" />
                  </p>
                  <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
                    <FormattedMessage
                      id="downloadsPage.noReleasesDescription"
                      defaultMessage="The relays that carry {app}'s releases didn't answer. This is almost always a connection problem."
                      values={{ app: APP_NAME }}
                    />
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => releases.refetch()}
                    disabled={releases.isFetching}
                    className="clip-corner-lg"
                  >
                    <RefreshCw className={cn("size-4", releases.isFetching && "animate-spin")} />
                    <FormattedMessage {...common.tryAgain} />
                  </Button>
                </div>
              )}
            </div>
          </div>

          {!pending && older.length > 0 && <OlderReleases releases={older} />}
        </section>

        {/* Sign-off: the landing's terminal prompt (`armada-caret` from the crest's keyframes). */}
        <section className="mx-auto flex min-h-[40svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-bottom">
          <p className="font-mono text-xl text-[hsl(var(--primary))] sm:text-2xl">
            <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
            <FormattedMessage id="downloadsPage.signOff" defaultMessage="anchors aweigh" />
            <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
          </p>

          <div className="w-full max-w-sm">
            <Button size="lg" asChild className="h-12 w-full clip-corner-lg text-base font-medium">
              <Link to="/">
                <FormattedMessage id="downloadsPage.returnHome" defaultMessage="Return home" />
              </Link>
            </Button>
          </div>
        </section>

        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent via-black/45 to-black/90"
        />
      </div>

      <ArmadaCrestKeyframes />
      <DownloadsKeyframes />
    </main>
  );
}

/** Page-local keyframes, scoped the way the landing page's are. */
function DownloadsKeyframes() {
  return (
    <style>{`
      /* The scroll cue riding the swell. Transform only. */
      @keyframes armada-bob {
        0%, 100% { transform: translateY(0); opacity: 0.55; }
        50%      { transform: translateY(0.4rem); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[armada-bob"] { animation: none !important; }
      }
      html[data-reduce-motion] [class*="animate-[armada-bob"] { animation: none !important; }
    `}</style>
  );
}
