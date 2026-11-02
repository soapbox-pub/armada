import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { defineMessages, FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import { ConcordGrid, ConcordMark, ConcordReveal } from "./ConcordReveal";
import { reducedMotion } from "@/lib/reducedMotion";

/** Landing's closing beat: an encrypted quiz. Picking an answer blows it to dust, uncovering the punchline. */

const MESSAGES = defineMessages({
  title: { id: "encryptionQuiz.title", defaultMessage: "What are you talking about?" },
  punchlineEncrypted: { id: "encryptionQuiz.punchlineEncrypted", defaultMessage: "Messages on Armada are encrypted." },
  punchlineNotEvenWe: { id: "encryptionQuiz.punchlineNotEvenWe", defaultMessage: "Not even we know what you're talking about." },
  pickOne: { id: "encryptionQuiz.pickOne", defaultMessage: "// pick one" },
  firstAnswer: { id: "encryptionQuiz.firstAnswer", defaultMessage: "First answer (encrypted)" },
  secondAnswer: { id: "encryptionQuiz.secondAnswer", defaultMessage: "Second answer (encrypted)" },
  sealed: { id: "encryptionQuiz.sealed", defaultMessage: "sealed" },
});

const BLOCK_ROWS = 5;
const BLOCK_COLS = 18;

const CHURN_MS = 110;

const GARBLE_MS = 1100;
const DECODE_MS = 1300;
const TICK_MS = 45;

const HEX = "0123456789abcdef";

/** Decorative, so `Math.random` is fine. */
function hex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += HEX[(Math.random() * 16) | 0];
  return out;
}

/** Scatter direction for character `i`, hashed from the index so re-renders don't reshuffle it mid-flight. */
function scatter(i: number) {
  const rand = (salt: number) => {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    dx: `${(rand(1) - 0.3) * 130}px`,
    dy: `${-40 - rand(2) * 110}px`,
    rot: `${(rand(3) - 0.5) * 200}deg`,
  };
}

/** Plain string until blown apart; per-character spans only then. */
function DustText({
  text,
  dust,
  seed = 0,
}: {
  text: string;
  dust: boolean;
  seed?: number;
}) {
  if (!dust) return <>{text}</>;
  return (
    <>
      {Array.from(text, (ch, i) => {
        const { dx, dy, rot } = scatter(seed + i);
        return (
          <span
            key={i}
            className="inline-block animate-[armada-dust_900ms_ease-in_forwards] motion-reduce:animate-none"
            style={
              {
                "--dust-dx": dx,
                "--dust-dy": dy,
                "--dust-rot": rot,
              } as React.CSSProperties
            }
          >
            {ch === " " ? "\u00a0" : ch}
          </span>
        );
      })}
    </>
  );
}

/** Decodes the heading by writing to `ref`'s text directly, not state (~50 re-renders otherwise). */
function useDecodingTitle(
  ref: React.RefObject<HTMLElement | null>,
  title: string,
  active: boolean,
) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    if (reducedMotion()) {
      el.textContent = title;
      return;
    }
    const start = performance.now();
    const id = setInterval(() => {
      const elapsed = performance.now() - start;
      const decoded =
        elapsed <= GARBLE_MS
          ? 0
          : Math.round(((elapsed - GARBLE_MS) / DECODE_MS) * title.length);
      if (decoded >= title.length) {
        el.textContent = title;
        clearInterval(id);
        return;
      }
      el.textContent = title.slice(0, decoded) + hex(title.length - decoded);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [ref, title, active]);
}

/** Whether `ref` is on screen in a visible page; gates the ciphertext churn. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [intersecting, setIntersecting] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) =>
      setIntersecting(entry.isIntersecting),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return intersecting && pageVisible;
}

const answerPose = (z: number) => `perspective(1100px) rotateY(var(--r)) translateZ(${-z}px)`;
const ANSWER_FACE = { transform: answerPose(0) } as React.CSSProperties;
const ANSWER_BODY = Array.from({ length: 10 }, (_, j) => {
  const t = j / 9;
  return { transform: answerPose(22 * (1 - t) + 1), background: `hsl(262 10% ${5 + t * 9}%)` } as React.CSSProperties;
});
const ANSWER_SCANLINES = {
  backgroundImage: "repeating-linear-gradient(to bottom, rgba(0,0,0,0.32) 0 1px, transparent 1px 3px)",
} as React.CSSProperties;

/** Churns hex by writing text nodes directly while `live`; React only re-renders to swap in dust spans. */
const AnswerButton = memo(function AnswerButton({
  label,
  letter,
  seed,
  live,
  dust,
  onPick,
}: {
  label: string;
  letter: string;
  seed: number;
  live: boolean;
  dust: boolean;
  onPick: () => void;
}) {
  const [rows] = useState(() =>
    Array.from({ length: BLOCK_ROWS }, () => hex(BLOCK_COLS)),
  );
  const rowEls = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!live || reducedMotion()) return;
    const id = setInterval(() => {
      for (const el of rowEls.current) if (el) el.textContent = hex(BLOCK_COLS);
    }, CHURN_MS);
    return () => clearInterval(id);
  }, [live]);

  // Flat panel under its own perspective (not preserve-3d) keeps text sharp;
  // a real border (not clip-path) keeps the turned edge anti-aliased.
  const outward = letter === "a" ? -1 : 1;
  const pose = {
    "--ry": `${outward * 18}deg`,
    "--ry-hover": `${outward * 6}deg`,
    animationDelay: outward < 0 ? "0s" : "-3.2s",
  } as React.CSSProperties;

  return (
    <div
      className={cn(
        "group/ans relative animate-[armada-ans-float_6.5s_ease-in-out_infinite] [--r:var(--ry)] hover:[--r:var(--ry-hover)] has-[:focus-visible]:[--r:var(--ry-hover)] motion-reduce:animate-none",
        (!live || dust) && "[animation-play-state:paused]",
      )}
      style={pose}
    >
      {ANSWER_BODY.map((shade, j) => (
        <div
          key={j}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[18px] transition-[transform,opacity] duration-700 ease-out",
            dust && "opacity-0 duration-300",
          )}
          style={shade}
        />
      ))}
      <button
        type="button"
        onClick={onPick}
        disabled={dust}
        aria-label={label}
        style={ANSWER_FACE}
        className={cn(
          "relative block w-full rounded-[18px] bg-[#0c0a10] p-2 text-left font-mono text-[0.62rem] leading-relaxed text-muted-foreground/80 ring-1 ring-white/[0.07] transition-[transform,color,box-shadow,background-color] duration-700 ease-out hover:text-foreground/90 hover:ring-[hsl(var(--primary)/0.5)] focus-visible:outline-none focus-visible:ring-ring disabled:cursor-default sm:p-3 sm:text-xs",
          dust && "bg-transparent ring-transparent duration-300 hover:ring-transparent",
        )}
      >
        <span
          className={cn(
            "relative block overflow-hidden rounded-[10px] bg-black px-3 pb-6 pt-11 transition-colors duration-300 sm:px-5",
            dust && "bg-transparent",
          )}
        >
          {!dust && <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60" style={ANSWER_SCANLINES} />}
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-3 top-3 grid size-6 place-items-center rounded-sm border border-[hsl(var(--accent2)/0.5)] text-xs font-bold uppercase text-[hsl(var(--accent2,180_90%_55%))] transition-opacity duration-300 sm:left-5 sm:text-sm",
              dust && "opacity-0",
            )}
          >
            {letter}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "absolute right-3 top-4 text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground/50 transition-opacity duration-300 sm:right-5",
              dust && "opacity-0",
            )}
          >
            <FormattedMessage {...MESSAGES.sealed} />
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 h-10 animate-[armada-read-head_4.5s_ease-in-out_infinite] bg-gradient-to-b from-transparent via-[hsl(var(--accent2)/0.12)] to-transparent motion-reduce:hidden",
              !live && "[animation-play-state:paused]",
              dust && "opacity-0",
            )}
            style={{ animationDelay: `${-seed / 200}s` }}
          />
        {rows.map((row, i) =>
          dust ? (
            <span key={`dust-${i}`} className="block break-all">
              <DustText text={row} dust seed={seed + i * BLOCK_COLS} />
            </span>
          ) : (
            <span
              key={`live-${i}`}
              ref={(el) => {
                rowEls.current[i] = el;
              }}
              className="block break-all"
            >
              {row}
            </span>
          ),
        )}
        </span>
      </button>
    </div>
  );
});

export function EncryptionQuiz() {
  const intl = useIntl();
  const title = intl.formatMessage(MESSAGES.title);
  const sectionRef = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  // Initial noise only; the decode writes the rest straight into the node. Re-rolled per
  // language so the garble is as long as the title it hides.
  const titleNoise = useMemo(() => hex(title.length), [title.length]);
  useDecodingTitle(titleRef, title, revealed && !picked);
  const onScreen = useOnScreen(sectionRef);
  // Stable, so memoized answers don't re-render.
  const pick = useCallback(() => setPicked(true), []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setRevealed(true);
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <section
        ref={sectionRef}
        className="relative grid min-h-[100svh] w-full place-items-center overflow-hidden px-6 py-16"
      >
        {/* Punchline shares the quiz's grid cell, so uncovering it causes no layout shift. */}
        <ConcordGrid shown={picked} />

        {/* `inert` until the pick so the link can't be tabbed to through the quiz. */}
        <div
          inert={!picked}
          className="[grid-area:1/1] relative flex max-w-4xl flex-col items-center gap-8 text-center font-mono"
        >
          <ConcordMark shown={picked} />
          <p
            className={cn(
              "text-balance text-xl font-bold leading-snug tracking-tight transition-opacity duration-1000 sm:text-2xl lg:text-3xl",
              picked ? "opacity-100 delay-500" : "opacity-0",
            )}
          >
            <span className="text-foreground">
              <FormattedMessage {...MESSAGES.punchlineEncrypted} />
            </span>
            <br />
            <span className="text-[hsl(var(--primary))]">
              <FormattedMessage {...MESSAGES.punchlineNotEvenWe} />
            </span>
          </p>

          <ConcordReveal shown={picked} />
        </div>

        <div
          className={`[grid-area:1/1] flex w-full max-w-3xl flex-col items-center gap-8 ${picked ? "pointer-events-none" : ""}`}
        >
          <h2 className="whitespace-nowrap font-mono text-xl font-bold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            {/* Keyed swap: the live span's text is written outside React. */}
            {picked ? (
              <span key="dust">
                <DustText text={title} dust />
              </span>
            ) : (
              <span key="live" ref={titleRef}>
                {titleNoise}
              </span>
            )}
          </h2>

          <p
            className={cn(
              "-mt-4 font-mono text-xs tracking-wide text-muted-foreground/70 transition-opacity duration-300",
              picked && "opacity-0",
            )}
          >
            <FormattedMessage {...MESSAGES.pickOne} />
          </p>

          <div className="grid w-full grid-cols-2 gap-4 sm:gap-10">
            <AnswerButton
              label={intl.formatMessage(MESSAGES.firstAnswer)}
              letter="a"
              seed={100}
              live={!picked && onScreen}
              dust={picked}
              onPick={pick}
            />
            <AnswerButton
              label={intl.formatMessage(MESSAGES.secondAnswer)}
              letter="b"
              seed={500}
              live={!picked && onScreen}
              dust={picked}
              onPick={pick}
            />
          </div>
        </div>
      </section>

      <EncryptionQuizKeyframes />
    </>
  );
}

function EncryptionQuizKeyframes() {
  return (
    <style>{`
      /* A character caught by the gust: carried up and away, spinning out of
         focus as it goes. Transform, filter and opacity only — no layout. */
      @keyframes armada-ans-float {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-10px); }
      }
      @keyframes armada-read-head {
        0%   { transform: translateY(-100%); }
        60%, 100% { transform: translateY(1400%); }
      }
      @keyframes armada-dust {
        from {
          opacity: 1;
          transform: translate3d(0, 0, 0) rotate(0deg);
          filter: blur(0);
        }
        to {
          opacity: 0;
          transform: translate3d(var(--dust-dx), var(--dust-dy), 0) rotate(var(--dust-rot));
          filter: blur(6px);
        }
      }
    `}</style>
  );
}
