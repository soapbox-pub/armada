import { Hash, Lock, Megaphone, type LucideIcon } from "lucide-react";

/**
 * The glyph that stands for a channel's KIND, in one place because it is shown
 * in seven (sidebar row, drag ghost, header, breadcrumb, mention and thread
 * lists, the community info dialog) and a channel that reads as `#general` in
 * one of them and as an announcement channel in another is worse than either.
 *
 * Private wins over announcement: the two are mutually exclusive today
 * (`channelsView` never marks a private channel as one), so the order only
 * decides what a hand-written or future combination degrades to — and "locked"
 * is the safer thing to overstate.
 */
export function channelIconFor(channel: { isPrivate?: boolean; isAnnouncement?: boolean }): LucideIcon {
  if (channel.isPrivate) return Lock;
  if (channel.isAnnouncement) return Megaphone;
  return Hash;
}
