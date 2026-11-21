import { useCallback } from "react";

import { useIntl } from "@/i18n";
import { MUTE_FOREVER } from "@/lib/notifRecords";

/** "Muted until 14:30" (with a weekday when it isn't today), or "Muted" for a mute with no end. */
export function useMuteStatus(): (until: number) => string {
  const intl = useIntl();
  return useCallback((until: number) => {
    if (until === MUTE_FOREVER) {
      return intl.formatMessage({ id: "muteMenu.status.forever", defaultMessage: "Muted" });
    }
    const end = new Date(until * 1000);
    const sameDay = end.toDateString() === new Date().toDateString();
    const time = sameDay
      ? intl.formatTime(end, { hour: "numeric", minute: "2-digit" })
      : intl.formatDate(end, { weekday: "short", hour: "numeric", minute: "2-digit" });
    return intl.formatMessage({ id: "muteMenu.status.until", defaultMessage: "Muted until {time}" }, { time });
  }, [intl]);
}
