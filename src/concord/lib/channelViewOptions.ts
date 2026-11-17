import { Hash, MessageSquareText, Volume2 } from "lucide-react";

import { defineMessage, type MessageDescriptor } from "@/i18n";

import type { ChannelView } from "@/concord/lib/types";

/** What a Channel opens to (CORD-03 §2 `view`); changeable later. */
export const CHANNEL_VIEW_OPTIONS: ReadonlyArray<{ view: ChannelView; label: MessageDescriptor; icon: typeof Hash }> = [
  { view: "chat", label: defineMessage({ id: "newChannelDialog.viewText", defaultMessage: "Text" }), icon: Hash },
  { view: "voice", label: defineMessage({ id: "newChannelDialog.viewVoice", defaultMessage: "Voice" }), icon: Volume2 },
  { view: "forum", label: defineMessage({ id: "newChannelDialog.viewForum", defaultMessage: "Forum" }), icon: MessageSquareText },
];
