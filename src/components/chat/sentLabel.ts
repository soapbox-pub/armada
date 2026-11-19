import { fullDateTime } from "@/lib/formatTime";

import type { IntlShape } from "@/i18n";

/** The full send time, and the NIP-89 client when the message names one. */
export function sentLabel(intl: IntlShape, createdAt: number, client: string | undefined): string {
  const time = fullDateTime(createdAt);
  return client
    ? intl.formatMessage({ id: "messageRow.sentVia", defaultMessage: "{time} · via {client}" }, { time, client })
    : time;
}
