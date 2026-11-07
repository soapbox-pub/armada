import { ArrowRightLeft, HeadphoneOff, Headphones, Mic, MicOff, PhoneOff } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useVoiceModeration } from "@/concord/hooks/useVoice";
import { channelsView } from "@/concord/lib/community";
import type { Channel, Community } from "@/concord/lib/types";
import type { VoiceDirectiveVerb, VoicePresent } from "@/concord/lib/voice";
import type { MemberActionItem } from "@/contexts/MemberActionsContext";
import { toast } from "@/hooks/useToast";
import { t, useIntl } from "@/i18n";

/**
 * A moderator's directives against each participant of one Channel's call (CORD-07 §7),
 * for the call's tile menus and the sidebar roster alike: being in the call isn't needed.
 */
export function useVoiceActionsFor(
  community: Community | undefined,
  channel: Channel | undefined,
  present: readonly VoicePresent[],
): (pubkey: string) => MemberActionItem[] {
  const intl = useIntl();
  const { data: folded } = useControlFold(community, false);
  const { may, send } = useVoiceModeration(community, channel);
  const voiceChannels = useMemo(
    () => (community && channel ? channelsView(community, folded).filter((c) => c.view === "voice" && c.idHex !== channel.idHex) : []),
    [community, folded, channel],
  );
  return useCallback(
    (pk: string): MemberActionItem[] => {
      const p = present.find((x) => x.author === pk);
      if (!p) return [];
      const act = (verb: VoiceDirectiveVerb, to?: string) => () => {
        void send(pk, verb, to).then((sent) => {
          if (!sent) toast({ title: t({ id: "persistentVoiceRoom.directive.failed", defaultMessage: "Couldn't reach the relays. Try again." }), variant: "destructive" });
        });
      };
      const out: MemberActionItem[] = [];
      if (may(pk, "mute")) {
        out.push(p.serverMuted
          ? { id: "voice-unmute", label: intl.formatMessage({ id: "persistentVoiceRoom.directive.unmute", defaultMessage: "Remove server mute" }), icon: Mic, onSelect: act("unmute") }
          : { id: "voice-mute", label: intl.formatMessage({ id: "persistentVoiceRoom.directive.mute", defaultMessage: "Server mute" }), icon: MicOff, onSelect: act("mute") });
      }
      if (may(pk, "deafen")) {
        out.push(p.serverDeafened
          ? { id: "voice-undeafen", label: intl.formatMessage({ id: "persistentVoiceRoom.directive.undeafen", defaultMessage: "Remove server deafen" }), icon: Headphones, onSelect: act("undeafen") }
          : { id: "voice-deafen", label: intl.formatMessage({ id: "persistentVoiceRoom.directive.deafen", defaultMessage: "Server deafen" }), icon: HeadphoneOff, onSelect: act("deafen") });
      }
      if (may(pk, "move")) {
        for (const c of voiceChannels) {
          out.push({ id: `voice-move-${c.idHex}`, label: intl.formatMessage({ id: "persistentVoiceRoom.directive.moveTo", defaultMessage: "Move to #{channel}" }, { channel: c.name }), icon: ArrowRightLeft, onSelect: act("move", c.idHex) });
        }
        out.push({ id: "voice-disconnect", label: intl.formatMessage({ id: "persistentVoiceRoom.directive.disconnect", defaultMessage: "Disconnect from call" }), icon: PhoneOff, destructive: true, onSelect: act("disconnect") });
      }
      return out;
    },
    [may, send, present, voiceChannels, intl],
  );
}
