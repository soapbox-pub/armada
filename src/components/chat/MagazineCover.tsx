import { useMemo } from "react";

import { FallbackImage } from "@/components/ui/FallbackImage";
import { useMagazineIssues } from "@/hooks/useMagazineIssues";
import { FormattedMessage } from "@/i18n";
import { loadThemeFont } from "@/lib/fontLoader";
import { MAGAZINE_KIND, parsePublication, type Publication } from "@/lib/publications";
import { cn } from "@/lib/utils";

import type { NostrRumor } from "@/lib/nostrRumor";

/** Grain noise overlay. */
const NOISE = `url("data:image/svg+xml,%3Csvg width='120' height='120' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")`;

/** Pulp palettes for generated covers, picked per magazine (same as Ditto's). */
const COVER_PALETTES = [
  { bg: "#E9B949", ink: "#1F2A44", shadow: "#C8412F", paper: "#F6ECD2" },
  { bg: "#2F7F86", ink: "#FFF3D6", shadow: "#1B3F45", paper: "#F6ECD2" },
  { bg: "#B8382B", ink: "#FFF3D6", shadow: "#5E1A12", paper: "#F6ECD2" },
  { bg: "#25395E", ink: "#F6E7C1", shadow: "#E5533D", paper: "#F6ECD2" },
];

type Palette = (typeof COVER_PALETTES)[number];

const STICKER_COLOR = "#F2C14E";
const STICKER_INK = "#7A1F12";

/** 16-point starburst polygon in a 100×100 viewBox. */
const STARBURST_POINTS = Array.from({ length: 32 }, (_, i) => {
  const r = i % 2 === 0 ? 50 : 40;
  const a = (i / 32) * Math.PI * 2 - Math.PI / 2;
  return `${(50 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`;
}).join(" ");

function paletteFor(seed: string): Palette {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return COVER_PALETTES[hash % COVER_PALETTES.length];
}

interface Fonts {
  masthead: string;
  print: string;
}

/**
 * A quoted magazine (34609) or magazine issue (39731) as Ditto's pulp cover,
 * drawn still: reading and the animated magazine are Ditto's, reached through
 * the card's "View on Ditto". A magazine fans its latest issues out underneath.
 */
export function MagazineCover({ event }: { event: NostrRumor }) {
  const pub = useMemo(() => parsePublication(event), [event]);
  const isMagazine = event.kind === MAGAZINE_KIND;
  const { data } = useMagazineIssues(event.pubkey, pub.identifier, isMagazine);
  const issues = useMemo(() => (isMagazine ? data ?? [] : []), [isMagazine, data]);
  const issuePubs = useMemo(() => issues.map(parsePublication), [issues]);
  const stacked = issuePubs.filter((p) => p.image && !p.warned).slice(0, 2);

  const fonts = useMemo<Fonts>(() => ({
    masthead: `${loadThemeFont({ family: "Luckiest Guy" }) ?? "system-ui"}, Impact, sans-serif`,
    print: `${loadThemeFont({ family: "Special Elite" }) ?? "system-ui"}, "Courier New", monospace`,
  }), []);

  return (
    // The sticker pokes 16px above the cover and the fanned issues ~30px, so
    // the top padding keeps both clear of the card's header row.
    <div className={cn("isolate flex flex-col items-center gap-2 px-6 pb-1", stacked.length > 0 ? "pt-10" : "pt-6")}>
      <div
        className="relative w-36 sm:w-44 -rotate-2 shadow-[2px_3px_2px_rgba(0,0,0,0.3),8px_12px_18px_rgba(0,0,0,0.25)]"
        role="img"
        aria-label={pub.title}
      >
        {stacked.map((issue, i) => (
          <FallbackImage
            key={issue.event.id}
            src={issue.image}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full rounded-[3px] object-cover brightness-[0.8]"
            style={{
              transform: `translate(${(i + 1) * 12}px, ${(i + 1) * -5}px) rotate(${(i + 1) * 8}deg)`,
              zIndex: -1 - i,
              boxShadow: "4px 6px 10px rgba(0,0,0,0.3)",
            }}
          />
        ))}
        <Cover pub={pub} fonts={fonts} issueCount={isMagazine ? issues.length : undefined} />
      </div>
      {!isMagazine && (
        <p className="max-w-full text-sm font-semibold leading-snug line-clamp-2 text-center">{pub.title}</p>
      )}
    </div>
  );
}

function Cover({ pub, fonts, issueCount }: { pub: Publication; fonts: Fonts; issueCount?: number }) {
  const palette = paletteFor(pub.identifier || pub.title);
  // Issues carry real cover art; a magazine's `image` is usually a logo, framed on a generated cover.
  const artCover = pub.kind !== MAGAZINE_KIND && pub.image && !pub.warned;

  return (
    <div className="relative">
      {/* Page block peeking out under the cover */}
      <div
        aria-hidden
        className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-[3px]"
        style={{ background: "repeating-linear-gradient(135deg, #efe5cc 0 1px, #d9ccad 1px 2px)" }}
      />
      <div
        className="relative aspect-[3/4] overflow-hidden rounded-[3px]"
        style={{ backgroundColor: palette.bg, containerType: "inline-size" }}
      >
        {artCover ? (
          <FallbackImage
            src={pub.image}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
            fallback={<PulpCover pub={pub} palette={palette} fonts={fonts} hideArt />}
          />
        ) : (
          <PulpCover pub={pub} palette={palette} fonts={fonts} hideArt={pub.warned} />
        )}

        {/* Barcode */}
        <div className="absolute bottom-2 left-2 flex h-5 w-9 items-end rounded-[1px] bg-[#f6ecd2] p-[2px]">
          <div
            className="size-full"
            style={{
              background:
                "repeating-linear-gradient(90deg, #1a1a1a 0 1px, transparent 1px 2px, #1a1a1a 2px 4px, transparent 4px 5px, #1a1a1a 5px 6px, transparent 6px 8px)",
            }}
          />
        </div>

        {/* Gloss and wear */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(115deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 28%, rgba(255,255,255,0) 62%, rgba(255,255,255,0.1) 100%)",
            boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25), inset 0 0 14px rgba(60, 35, 10, 0.35)",
          }}
        />
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.12] mix-blend-multiply" style={{ backgroundImage: NOISE }} />
        {/* Spine crease */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-2"
          style={{ background: "linear-gradient(90deg, rgba(0,0,0,0.3), rgba(255,255,255,0.12) 60%, transparent)" }}
        />
      </div>
      <Sticker pub={pub} fonts={fonts} issueCount={issueCount} />
    </div>
  );
}

function PulpCover({ pub, palette, fonts, hideArt }: { pub: Publication; palette: Palette; fonts: Fonts; hideArt?: boolean }) {
  const title = pub.title.toUpperCase();
  const titleSize = title.length <= 12 ? "16.5cqw" : title.length <= 24 ? "12cqw" : "9.5cqw";

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Sunburst */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: "repeating-conic-gradient(from 0deg at 50% 64%, rgba(255,255,255,0.16) 0 7deg, transparent 7deg 14deg)" }}
      />

      {/* Masthead */}
      <div className="relative px-2.5 pt-3">
        <p
          className="line-clamp-3 break-words"
          style={{
            fontFamily: fonts.masthead,
            fontSize: titleSize,
            lineHeight: 0.92,
            color: palette.ink,
            textShadow: `2px 2px 0 ${palette.shadow}`,
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </p>
        <div className="mt-1.5 h-[2px] w-full" style={{ background: palette.ink, opacity: 0.7 }} />
      </div>

      {/* Cover illustration */}
      <div className="relative flex flex-1 items-center justify-center px-4 py-2">
        {pub.image && !hideArt && (
          <div className="relative w-[70%] rotate-[-3deg] p-[3px] shadow-[2px_3px_6px_rgba(0,0,0,0.35)]" style={{ background: palette.paper }}>
            <FallbackImage src={pub.image} alt="" loading="lazy" decoding="async" className="aspect-square w-full object-cover" />
            {/* Halftone print dots */}
            <div
              aria-hidden
              className="absolute inset-[3px] mix-blend-multiply"
              style={{ background: "radial-gradient(rgba(0,0,0,0.22) 0.8px, transparent 1.1px) 0 0 / 4px 4px" }}
            />
          </div>
        )}
      </div>

      {/* Tagline */}
      {pub.summary && !pub.warned && (
        <p
          className="relative mx-2 mb-2 ml-12 line-clamp-2 px-1.5 py-1 leading-tight"
          style={{ fontFamily: fonts.print, fontSize: "5.6cqw", background: palette.paper, color: "#2b2118" }}
        >
          {pub.summary}
        </p>
      )}
    </div>
  );
}

function Sticker({ pub, fonts, issueCount }: { pub: Publication; fonts: Fonts; issueCount?: number }) {
  const label = pub.warned ? (
    <FormattedMessage id="magazineCover.sticker.sensitive" defaultMessage="Sensitive" />
  ) : pub.issue ? (
    <FormattedMessage id="magazineCover.sticker.issue" defaultMessage="No. {issue}" values={{ issue: pub.issue.slice(0, 9) }} />
  ) : issueCount ? (
    <FormattedMessage id="magazineCover.sticker.issueCount" defaultMessage="{count, plural, one {# issue} other {# issues}}" values={{ count: issueCount }} />
  ) : (
    <FormattedMessage id="magazineCover.sticker.new" defaultMessage="New!" />
  );

  return (
    <div
      className="absolute -right-4 -top-4 flex size-14 rotate-12 items-center justify-center"
      style={{ filter: "drop-shadow(1px 2px 1px rgba(0,0,0,0.4))" }}
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden>
        <polygon points={STARBURST_POINTS} fill={STICKER_COLOR} stroke={STICKER_INK} strokeWidth="2" />
      </svg>
      <span
        className="relative max-w-[2.75rem] text-center text-[10px] uppercase leading-[0.95]"
        style={{ fontFamily: fonts.masthead, color: STICKER_INK }}
      >
        {label}
      </span>
    </div>
  );
}
