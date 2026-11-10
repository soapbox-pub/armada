/**
 * NIP-17 disappearing-message timers: a shared per-conversation duration in
 * seconds (0 = off), carried as a kind-1740 rumor (newest wins). Outgoing
 * messages carry NIP-40 `["expiration", sent_at + timer]`. Unlike Signal the
 * clock starts at SEND time, since NIP-40 only carries an absolute deadline.
 */

import { defineMessage, defineMessages, t, type MessageDescriptor } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export interface DisappearingPreset {
  /** Duration in seconds; 0 turns disappearing messages off. */
  seconds: number;
  label: string;
}

const presetOf = (seconds: number, message: MessageDescriptor): DisappearingPreset => ({
  seconds,
  get label() {
    return t(message);
  },
});

/** Signal's set, longest first; "Off" leads. */
export const DISAPPEARING_PRESETS: readonly DisappearingPreset[] = [
  presetOf(0, defineMessage({ id: "nip17Disappearing.preset.off", defaultMessage: "Off" })),
  presetOf(4 * WEEK, defineMessage({ id: "nip17Disappearing.preset.fourWeeks", defaultMessage: "4 weeks" })),
  presetOf(WEEK, defineMessage({ id: "nip17Disappearing.preset.oneWeek", defaultMessage: "1 week" })),
  presetOf(DAY, defineMessage({ id: "nip17Disappearing.preset.oneDay", defaultMessage: "1 day" })),
  presetOf(8 * HOUR, defineMessage({ id: "nip17Disappearing.preset.eightHours", defaultMessage: "8 hours" })),
  presetOf(HOUR, defineMessage({ id: "nip17Disappearing.preset.oneHour", defaultMessage: "1 hour" })),
  presetOf(5 * MINUTE, defineMessage({ id: "nip17Disappearing.preset.fiveMinutes", defaultMessage: "5 minutes" })),
  presetOf(30, defineMessage({ id: "nip17Disappearing.preset.thirtySeconds", defaultMessage: "30 seconds" })),
];

const UNIT_MESSAGES = defineMessages({
  week: { id: "nip17Disappearing.unit.week", defaultMessage: "{count, plural, one {# week} other {# weeks}}" },
  day: { id: "nip17Disappearing.unit.day", defaultMessage: "{count, plural, one {# day} other {# days}}" },
  hour: { id: "nip17Disappearing.unit.hour", defaultMessage: "{count, plural, one {# hour} other {# hours}}" },
  minute: { id: "nip17Disappearing.unit.minute", defaultMessage: "{count, plural, one {# minute} other {# minutes}}" },
  second: { id: "nip17Disappearing.unit.second", defaultMessage: "{count, plural, one {# second} other {# seconds}}" },
});

/** Duration in words; composes units for non-preset values set by other clients. */
export function formatDisappearingDuration(seconds: number): string {
  if (seconds <= 0) return t({ id: "nip17Disappearing.off", defaultMessage: "off" });
  const preset = DISAPPEARING_PRESETS.find((p) => p.seconds === seconds);
  if (preset && preset.seconds > 0) return preset.label;

  const parts: string[] = [];
  let left = Math.floor(seconds);
  for (const [unit, size] of [["week", WEEK], ["day", DAY], ["hour", HOUR], ["minute", MINUTE], ["second", 1]] as const) {
    const n = Math.floor(left / size);
    if (n > 0) parts.push(t(UNIT_MESSAGES[unit], { count: n }));
    left -= n * size;
  }
  if (parts.length < 2) return parts[0] ?? "";
  return t({ id: "nip17Disappearing.twoUnits", defaultMessage: "{first} {second}" }, { first: parts[0], second: parts[1] });
}

/**
 * Compact time left ("2d", "4h", "45s"), rounded UP so a visible message never
 * reads "0s". Days are the largest unit to match how timers are set.
 */
export function formatTimeLeft(expiresAt: number, now = nowSecs()): string {
  const left = expiresAt - now;
  if (left >= DAY) return t({ id: "nip17Disappearing.left.days", defaultMessage: "{count}d" }, { count: Math.ceil(left / DAY) });
  if (left >= HOUR) return t({ id: "nip17Disappearing.left.hours", defaultMessage: "{count}h" }, { count: Math.ceil(left / HOUR) });
  if (left >= MINUTE) return t({ id: "nip17Disappearing.left.minutes", defaultMessage: "{count}m" }, { count: Math.ceil(left / MINUTE) });
  return t({ id: "nip17Disappearing.left.seconds", defaultMessage: "{count}s" }, { count: Math.max(0, left) });
}

/** Timer-change notice phrased Signal-style ("You set…" / "Alice set…"). */
export function disappearingNotice(seconds: number, byMe: boolean, name: string): string {
  if (seconds <= 0) {
    return byMe
      ? t({ id: "nip17Disappearing.notice.youOff", defaultMessage: "You turned off disappearing messages." })
      : t({ id: "nip17Disappearing.notice.otherOff", defaultMessage: "{name} turned off disappearing messages." }, { name });
  }
  const duration = formatDisappearingDuration(seconds);
  return byMe
    ? t({ id: "nip17Disappearing.notice.youSet", defaultMessage: "You set disappearing messages to {duration}." }, { duration })
    : t({ id: "nip17Disappearing.notice.otherSet", defaultMessage: "{name} set disappearing messages to {duration}." }, { name, duration });
}
