import type { IntlShape } from "@/i18n";

export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** "Today", "Yesterday", or the date (with the year when it isn't this one). */
export function formatDayLabel(ts: number, intl: IntlShape): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  if (isSameDay(ts, Math.floor(now.getTime() / 1000))) {
    return intl.formatMessage({ id: "messageTimeline.today", defaultMessage: "Today" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(ts, Math.floor(yesterday.getTime() / 1000))) {
    return intl.formatMessage({ id: "messageTimeline.yesterday", defaultMessage: "Yesterday" });
  }
  // intl memoizes its formatters, so this doesn't build an Intl.DateTimeFormat per call.
  return intl.formatDate(date, date.getFullYear() === now.getFullYear() ? DAY_FORMAT : DAY_YEAR_FORMAT);
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
const DAY_YEAR_FORMAT: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" };
