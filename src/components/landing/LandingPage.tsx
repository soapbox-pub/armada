import { HardDriveDownload } from "lucide-react";
import { memo, useRef } from "react";
import { Link } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { RelayLed } from "@/components/RelayLed";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RELAY_DICTIONARY } from "@/concord/lib/stockRelays";
import { defineMessage, defineMessages, FormattedMessage, useIntl } from "@/i18n";
import { isDesktop } from "@/lib/desktop";
import { ANDROID_STORES } from "@/lib/downloads";
import { DEPLOYMENT_RELAYS, isNativeRuntime, relayToHttpUrl } from "@/lib/platform";

import { AsciiSea } from "./AsciiSea";
import { EncryptionQuiz } from "./EncryptionQuiz";
import { usePauseOffscreenAnimations } from "./pauseOffscreenAnimations";
import { PitchToy } from "./PitchToy";
import { ProductShots } from "./ProductShots";
import { SailingSea } from "./SailingSea";
import { scrollBehavior } from "@/lib/reducedMotion";

/** Signed-out landing page: hero over the {@link AsciiSea}, then pitch, quiz and closer. */

/**
 * The deployment's own relays, else the stock set in display order only;
 * dictionary ids (and STOCK_RELAYS' order) are CORD-05 wire format.
 */
const LANDING_RELAYS: string[] = DEPLOYMENT_RELAYS.length > 0
  ? DEPLOYMENT_RELAYS
  : [3, 1, 4, 2].map((i) => RELAY_DICTIONARY[i]);

const CLOSER_SHOT = ["raid-crew"];
const CLOSER_LABEL = defineMessage({
  id: "pitchToy.raidCrew.label",
  defaultMessage: "a gaming community's #general, with reactions, an inline reply and a thread",
});

/** Native and desktop users already have the app, so "get armada" is hidden. */
const INSTALLED_APP = isNativeRuntime() || isDesktop();

/** Memoized: the parent re-renders on login dialog open/close, which would re-render the whole deck. */
export const LandingPage = memo(function LandingPage({
  onJoin,
  scrollRef,
}: {
  onJoin: () => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const intl = useIntl();
  const statementRef = useRef<HTMLElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  usePauseOffscreenAnimations(deckRef, scrollRef);

  const scrollToStatement = () => {
    statementRef.current?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "start",
    });
  };

  return (
    <>
      {/* `sticky` pins the sea while `-mb-[100svh]` cancels its scroll height. */}
      <div className="pointer-events-none sticky top-0 z-0 -mb-[100svh] h-[100svh]">
        <AsciiSea scrollRef={scrollRef} />
      </div>

      <div ref={deckRef} className="relative z-10">
        {!INSTALLED_APP && (
          <div className="absolute right-3 top-3 z-20 safe-area-top">
            <Link
              to="/downloads"
              className="inline-flex h-10 items-center gap-2 px-3 font-mono text-sm lowercase tracking-tight text-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <HardDriveDownload className="size-4 shrink-0 text-[hsl(var(--accent2,180_90%_55%))]" />
              <FormattedMessage id="landingPage.getArmada" defaultMessage="get armada" />
            </Link>
          </div>
        )}

        <section className="mx-auto flex min-h-[100svh] max-w-xl flex-col items-center justify-center gap-10 px-6 py-16 safe-area-top">
          <div className="flex flex-col items-center gap-8">
            <ArmadaCrest size={150} />
            <BrandMark />
          </div>

          <div className="w-full max-w-sm">
            <Button
              size="lg"
              onClick={onJoin}
              className="h-12 w-full clip-corner-lg text-base font-medium"
            >
              <FormattedMessage id="landingPage.join" defaultMessage="Join" />
            </Button>
            <button
              type="button"
              onClick={scrollToStatement}
              className="group mt-5 flex w-full flex-col items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <FormattedMessage id="landingPage.howItWorks" defaultMessage="How does Armada work?" />
              {/* U+2193 is in WGL4, so every system font has a glyph (and not `font-mono`). */}
              <span
                aria-hidden="true"
                className="animate-[armada-bob_2.4s_ease-in-out_infinite] text-base leading-none text-[hsl(var(--accent2)/0.75)] group-hover:text-[hsl(var(--accent2))]"
              >
                &#8595;
              </span>
            </button>
          </div>
        </section>

        <section
          ref={statementRef}
          className="mx-auto flex min-h-[100svh] max-w-5xl flex-col items-center justify-center gap-4 px-6 py-16 text-center sm:gap-5"
        >
          <p className="text-balance font-mono text-2xl font-bold tracking-tight text-muted-foreground sm:text-3xl lg:text-4xl">
            <FormattedMessage id="landingPage.statementOwners" defaultMessage="Chat apps belong to whoever runs the servers." />
          </p>
          <p className="text-balance font-mono text-2xl font-bold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
            <FormattedMessage id="landingPage.statementSpread" defaultMessage="Armada is spread across free public servers." />
          </p>

          <ul className="mt-14 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5 font-mono text-xs text-muted-foreground/70">
            {LANDING_RELAYS.map((url, i) => <RelayLight key={url} url={url} index={i} />)}
            <li className="tracking-wide">
              <a
                href="https://nostr.watch/"
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-foreground"
              >
                <FormattedMessage id="landingPage.moreRelays" defaultMessage="1000+ more" />
              </a>
            </li>
          </ul>
          <Collapsible className="mt-5 w-full max-w-lg">
            <div className="flex items-center justify-center gap-6 font-mono text-xs tracking-wide text-muted-foreground/70">
              <CollapsibleTrigger className="transition-colors hover:text-foreground data-[state=open]:text-foreground">
                <FormattedMessage id="landingPage.why" defaultMessage="Why?" />
              </CollapsibleTrigger>
              <a
                href="https://soapbox.pub/blog/how-to-self-host-armada"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
              >
                <FormattedMessage id="landingPage.hostYourOwn" defaultMessage="Host your own" />
              </a>
            </div>
            {/* Landing-local keyframes: `animate-accordion-*` reads the Accordion height var, which Collapsible never sets. */}
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-[armada-reveal-up_200ms_ease-out] data-[state=open]:animate-[armada-reveal-down_200ms_ease-out]">
              <p className="text-pretty px-2 pt-6 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                <FormattedMessage
                  id="landingPage.whyBody"
                  defaultMessage="Armada is built on <link>Nostr</link>, a social protocol which redefines the Internet. On Nostr, apps are separate from infra. Users sign events with private keys and distribute them across multiple public relays. Messages can be encrypted so even Nostr relays don't know what they say."
                  values={{ link: nostrLink }}
                />
              </p>
            </CollapsibleContent>
          </Collapsible>
        </section>

        <section
          className="flex min-h-[100svh] w-full flex-col items-center justify-center overflow-x-clip px-6 py-16"
        >
          <PitchToy />
        </section>

        <EncryptionQuiz />

        <section className="mx-auto flex min-h-[100svh] max-w-6xl flex-col items-center justify-center px-6 pb-56 pt-16 text-center">
          <h2 className="text-balance font-mono text-2xl font-bold tracking-tight text-foreground sm:text-4xl">
            <FormattedMessage id="landingPage.closerTitle" defaultMessage="Everything, on every deck" />
          </h2>
          <p className="mt-3 text-pretty text-sm text-muted-foreground sm:text-base">
            <FormattedMessage
              id="landingPage.closerBody"
              defaultMessage="Desktop, phone or browser. Your key is your account on all of them."
            />
          </p>

          <div className="mt-10 w-full">
            <ProductShots slugs={CLOSER_SHOT} index={0} label={intl.formatMessage(CLOSER_LABEL)} />
          </div>

          <FeaturePoints />

          <div className="mt-16 flex w-full max-w-sm flex-col items-center gap-5">
            <p className="font-mono text-xl text-[hsl(var(--primary))] sm:text-2xl">
              <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
              <FormattedMessage id="landingPage.sailTheSeas" defaultMessage="sail the seas" />
              <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
            </p>
            <Button
              size="lg"
              onClick={onJoin}
              className="h-12 w-full clip-corner-lg text-base font-medium"
            >
              <FormattedMessage id="landingPage.join" defaultMessage="Join" />
            </Button>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
            {ANDROID_STORES.map((store) => (
              <a
                key={store.url}
                href={store.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring touch:h-11"
              >
                <img src={store.icon} alt="" className="size-4 shrink-0" />
                {store.label}
              </a>
            ))}
          </div>

          <p className="mt-2 text-balance font-mono text-xs tracking-wide text-muted-foreground sm:text-sm">
            <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
            <FormattedMessage id="landingPage.alsoOn" defaultMessage="also on macOS, Linux & Windows" />{" "}
            <span className="whitespace-nowrap">
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>{" "}
            <Link
              to="/downloads"
              className="text-foreground/90 underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
            >
              <FormattedMessage id="landingPage.allDownloads" defaultMessage="all downloads" />
            </Link>
            </span>
          </p>

          <div className="mt-6 flex items-center justify-center gap-6 font-mono text-xs tracking-wide text-muted-foreground/60">
            <a
              href="https://soapbox.pub/armada"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              <FormattedMessage id="landingPage.moreAbout" defaultMessage="more about armada" />
            </a>
            <a
              href="https://gitworkshop.dev/soapbox.pub/relay.ngit.dev/armada"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              <FormattedMessage id="landingPage.sourceCode" defaultMessage="source code" />
            </a>
          </div>
        </section>

        <SailingSea />
      </div>

      <ArmadaCrestKeyframes />
      <LandingKeyframes />
    </>
  );
});

function RelayLight({ url, index }: { url: string; index: number }) {
  return (
    <li className="flex items-center gap-2 tracking-wide">
      <RelayLed url={url} phase={index} />
      <a
        href={relayToHttpUrl(url)}
        target="_blank"
        rel="noreferrer"
        className="transition-colors hover:text-foreground"
      >
        {url.replace(/^wss:\/\//, "")}
      </a>
    </li>
  );
}

const FEATURE_MESSAGES = defineMessages({
  games: { id: "landingPage.feature.games", defaultMessage: "Multiplayer games & mini apps" },
  calls: { id: "landingPage.feature.calls", defaultMessage: "Voice & video calls" },
  discord: { id: "landingPage.feature.discord", defaultMessage: "Discord import" },
  noPhone: { id: "landingPage.feature.noPhone", defaultMessage: "No phone or email" },
});
const FEATURES = Object.entries(FEATURE_MESSAGES);

function nostrLink(chunks: React.ReactNode[]) {
  return (
    <a
      href="https://github.com/nostr-protocol/nostr"
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current"
    >
      {chunks}
    </a>
  );
}

/** Diamonds are rotated squares, not glyphs, to avoid tofu. */
function FeaturePoints() {
  return (
    <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 font-mono text-xs tracking-wide text-muted-foreground sm:text-sm">
      {FEATURES.map(([key, feature]) => (
        <li key={key} className="flex items-center gap-2.5">
          <span aria-hidden="true" className="size-1.5 shrink-0 rotate-45 bg-amber-300/90" />
          <FormattedMessage {...feature} />
        </li>
      ))}
    </ul>
  );
}

function LandingKeyframes() {
  return (
    <style>{`
      /* The "Why?" reveal. Radix measures the panel and publishes its height
         on the content element, so the open/close is a real height animation
         rather than a guessed max-height. */
      @keyframes armada-reveal-down {
        from { height: 0; opacity: 0; }
        to   { height: var(--radix-collapsible-content-height); opacity: 1; }
      }
      @keyframes armada-reveal-up {
        from { height: var(--radix-collapsible-content-height); opacity: 1; }
        to   { height: 0; opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[armada-reveal"] { animation-duration: 1ms !important; }
      }
      html[data-reduce-motion] [class*="animate-[armada-reveal"] { animation-duration: 1ms !important; }

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
