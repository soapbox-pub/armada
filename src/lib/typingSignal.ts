import { useEffect, useMemo, type RefObject } from "react";

/**
 * Typing indicators, as Vector sends and shows them: at most one signal per 30s, each
 * live for 30s, and gone as soon as the typer's post lands. Every signal is a signature
 * (and in a DM an encryption) by the user's signer, which on Amber or a bunker is a
 * round trip per send.
 */
export const TYPING_THROTTLE_MS = 30_000;
export const TYPING_WINDOW_MS = 30_000;

/** Whether a composer input is typing worth announcing: text going in, not a deletion or a `/` command. */
export function isTypingInput(value: string, inputType: string | undefined): boolean {
  return value !== "" && !value.startsWith("/") && !inputType?.startsWith("delete");
}

/** A live typer and the date their latest signal carried (their own clock, ms). */
export interface Typer {
  pubkey: string;
  date: number;
}

interface Posted {
  pubkey: string;
  created_at: number;
}

/** Typers whose latest signal no post of theirs has since answered, by their own dates. */
export function useTypersStillTyping(typers: readonly Typer[], messages: readonly Posted[] | undefined): string[] {
  return useMemo(() => {
    const out = typers.map((t) => t.pubkey);
    if (!messages?.length || typers.length === 0) return out;
    const signal = new Map(typers.map((t) => [t.pubkey, Math.floor(t.date / 1000)]));
    const answered = new Set<string>();
    for (const m of messages) {
      const at = signal.get(m.pubkey);
      if (at !== undefined && m.created_at >= at) answered.add(m.pubkey);
    }
    return answered.size === 0 ? out : out.filter((pk) => !answered.has(pk));
  }, [typers, messages]);
}

/** Lets the next keystroke signal again once this member posts, since their post clears them for everyone else. */
export function useTypingResetOnPost(lastSent: RefObject<number>, messages: readonly Posted[] | undefined, self: string | undefined): void {
  useEffect(() => {
    if (!self || !messages?.length) return;
    let newest = 0;
    for (const m of messages) if (m.pubkey === self && m.created_at > newest) newest = m.created_at;
    if (newest * 1000 >= lastSent.current - 1000) lastSent.current = 0;
  }, [lastSent, messages, self]);
}

/** The same entries, or `prev` when nothing changed, so a re-sent signal keeps the list's identity only when its date didn't move. */
export function sameTypers(prev: readonly Typer[], next: Typer[]): readonly Typer[] {
  return prev.length === next.length && prev.every((t, i) => t.pubkey === next[i].pubkey && t.date === next[i].date) ? prev : next;
}
