import { getLocale, t } from "@/i18n";

/** Format seconds to m:ss or h:mm:ss. */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Average lengths; short labels round away calendar detail. */
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

/**
 * Format a unix-seconds timestamp into a short relative string
 * ("now"/"5m"/"3h"/"2d"/"4w"/"11mo"/"2y"). Months are "mo" because "m" is minutes.
 */
export function shortTimeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < MINUTE) return t({ id: "formatTime.short.now", defaultMessage: "now" });
  if (diff < HOUR) return t({ id: "formatTime.short.minutes", defaultMessage: "{count}m" }, { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t({ id: "formatTime.short.hours", defaultMessage: "{count}h" }, { count: Math.floor(diff / HOUR) });
  if (diff < WEEK) return t({ id: "formatTime.short.days", defaultMessage: "{count}d" }, { count: Math.floor(diff / DAY) });
  if (diff < MONTH) return t({ id: "formatTime.short.weeks", defaultMessage: "{count}w" }, { count: Math.floor(diff / WEEK) });
  if (diff < YEAR) return t({ id: "formatTime.short.months", defaultMessage: "{count}mo" }, { count: Math.floor(diff / MONTH) });
  return t({ id: "formatTime.short.years", defaultMessage: "{count}y" }, { count: Math.floor(diff / YEAR) });
}

/**
 * {@link shortTimeAgo} as a phrase that can stand inside a sentence ("seen
 * {ago}"): "5m ago", "just now". The bare form has no "ago" to inflect around.
 */
export function shortTimeAgoPhrase(timestamp: number): string {
  if (Math.floor(Date.now() / 1000) - timestamp < MINUTE) {
    return t({ id: "formatTime.justNow", defaultMessage: "just now" });
  }
  return t({ id: "formatTime.shortAgo", defaultMessage: "{time} ago" }, { time: shortTimeAgo(timestamp) });
}

/** Format a unix-seconds timestamp as a long relative string ("2 days ago"). */
export function relativeTime(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    return t(
      { id: "formatTime.monthsAgo", defaultMessage: "{count, plural, one {# month ago} other {# months ago}}" },
      { count: Math.floor(days / 30) },
    );
  }
  if (days > 0) return t({ id: "formatTime.daysAgo", defaultMessage: "{count, plural, one {# day ago} other {# days ago}}" }, { count: days });
  if (hours > 0) return t({ id: "formatTime.hoursAgo", defaultMessage: "{count, plural, one {# hour ago} other {# hours ago}}" }, { count: hours });
  if (minutes > 0) {
    return t({ id: "formatTime.minutesAgo", defaultMessage: "{count, plural, one {# minute ago} other {# minutes ago}}" }, { count: minutes });
  }
  return t({ id: "formatTime.justNow", defaultMessage: "just now" });
}

// toLocaleTimeString builds a new Intl.DateTimeFormat per call; every row calls this.
let clockFormat: { locale: string; format: Intl.DateTimeFormat } | undefined;

/**
 * A unix-seconds timestamp as a Date, or undefined outside JS's date range: a
 * sender sets `created_at`, and formatting an invalid Date throws RangeError.
 */
function validDate(timestamp: number): Date | undefined {
  const date = new Date(timestamp * 1000);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** A `<time dateTime>` value; undefined for a timestamp no Date can hold. */
export function isoDateTime(timestamp: number): string | undefined {
  return validDate(timestamp)?.toISOString();
}

/** Format a unix-seconds timestamp as a short local clock time ("3:07 PM"). */
export function shortClockTime(timestamp: number): string {
  const date = validDate(timestamp);
  if (!date) return "";
  const locale = getLocale();
  if (clockFormat?.locale !== locale) {
    clockFormat = { locale, format: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }) };
  }
  return clockFormat.format.format(date);
}

let fullFormat: { locale: string; format: Intl.DateTimeFormat } | undefined;

/** Full local date and time, for surfaces without day dividers. */
export function fullDateTime(timestamp: number): string {
  const date = validDate(timestamp);
  if (!date) return "";
  const locale = getLocale();
  if (fullFormat?.locale !== locale) {
    fullFormat = { locale, format: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }) };
  }
  return fullFormat.format.format(date);
}
