import { defineMessage, type MessageDescriptor } from "@/i18n";
import { MUTE_FOREVER } from "@/lib/notifRecords";
import { nowSecs } from "@/lib/relayClock";

/** The mute lengths offered everywhere a conversation can be muted. */
export const MUTE_DURATIONS: ReadonlyArray<{ label: MessageDescriptor; secs?: number }> = [
  { label: defineMessage({ id: "muteMenu.duration.minutes15", defaultMessage: "For 15 minutes" }), secs: 15 * 60 },
  { label: defineMessage({ id: "muteMenu.duration.hour1", defaultMessage: "For 1 hour" }), secs: 60 * 60 },
  { label: defineMessage({ id: "muteMenu.duration.hours3", defaultMessage: "For 3 hours" }), secs: 3 * 60 * 60 },
  { label: defineMessage({ id: "muteMenu.duration.hours8", defaultMessage: "For 8 hours" }), secs: 8 * 60 * 60 },
  { label: defineMessage({ id: "muteMenu.duration.hours24", defaultMessage: "For 24 hours" }), secs: 24 * 60 * 60 },
  { label: defineMessage({ id: "muteMenu.duration.forever", defaultMessage: "Until I turn it back on" }) },
];

/** The `until` a duration choice stands for. */
export function muteUntilFor(secs: number | undefined): number {
  return secs === undefined ? MUTE_FOREVER : nowSecs() + secs;
}
