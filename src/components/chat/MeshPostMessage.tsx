import { useMemo, useState } from "react";
import { Radio } from "lucide-react";

import { useNostr } from "@nostrify/react";

import { ChatContent } from "@/components/chat/ChatContent";
import { MessageRow } from "@/components/chat/MessageRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/hooks/useAppContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { toast } from "@/hooks/useToast";
import { PLATFORM_RELAYS, normalizeRelayUrl } from "@/lib/platform";

import type { ChatMsg } from "@/components/chat/transport";

interface MeshPostMessageProps {
  /** The verified, signed kind-1 Nostr event carried over the mesh. */
  event: ChatMsg;
  /** Render compactly as a continuation of the previous same-author message. */
  continuation?: boolean;
}

/**
 * A rebroadcastable Nostr post (`/post`) received over the Bluetooth mesh.
 *
 * Unlike ordinary mesh messages — whose `pubkey` is a mesh peer id and whose
 * signature is empty and never checked — this carries a *full, signature-valid*
 * Nostr event (verified in `parseRebroadcast`). So it renders through the
 * normal Nostr author path (`MessageRow` with the real `pubkey`, no
 * `identityOverride`): real npub profile name/avatar, full `ChatContent`.
 *
 * The point of the feature: anyone holding the event can push it to a relay
 * without signing anything. The "Rebroadcast" button relays the event verbatim
 * to the user's **general-purpose** relays.
 *
 * Relay targeting matters here: a `/post` is a plain **kind 1**, but Armada's
 * own relays are NIP-29 (relay29) servers whose `RestrictToSpecifiedKinds`
 * allowlist does NOT include kind 1 — they reject it outright. So we must NOT
 * use the generic event router (which fans out to every pool relay, NIP-29
 * servers included); routing a kind 1 there means every NIP-29 relay rejects
 * it, and if those are the only reachable relays the publish fails entirely
 * ("all promises were rejected"). Instead we publish only to the
 * general-purpose relays (`appRelays` + pinned `PLATFORM_RELAYS`), per relay,
 * and report how many accepted.
 *
 * Gated on connectivity — offline, it's disabled with a hint, and a stray click
 * toasts an error.
 */
export function MeshPostMessage({ event, continuation }: MeshPostMessageProps) {
  const online = useOnlineStatus();
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  // General-purpose relays only — never the NIP-29 `addedRelays`, which reject
  // kind 1. Pinned platform relays are included because a hosted deployment's
  // own relay may be a general relay; harmless if it isn't (it just rejects and
  // we count it as a failure for that one relay, not the whole publish).
  const targetRelays = useMemo(() => {
    const urls = new Set<string>();
    for (const url of config.appRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    for (const url of PLATFORM_RELAYS) urls.add(url);
    return [...urls];
  }, [config.appRelays]);

  const rebroadcast = async () => {
    if (!online) {
      toast({
        title: "You're offline",
        description: "Connect to the internet to rebroadcast this post to your relays.",
        variant: "destructive",
      });
      return;
    }
    if (targetRelays.length === 0) {
      toast({
        title: "No relays to rebroadcast to",
        description:
          "Add a general-purpose relay in Settings → Relays. Armada (NIP-29) servers don't accept plain posts.",
        variant: "destructive",
      });
      return;
    }

    setPending(true);
    // Publish to each general relay independently so one rejection (or a NIP-29
    // relay that slipped into appRelays) doesn't sink the whole rebroadcast.
    // Success = at least one relay accepted the event.
    const results = await Promise.allSettled(
      targetRelays.map((url) =>
        nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) }),
      ),
    );
    setPending(false);

    const accepted = results.filter((r) => r.status === "fulfilled").length;
    if (accepted > 0) {
      setDone(true);
      toast({
        title: "Rebroadcast",
        description: `Sent to ${accepted} relay${accepted === 1 ? "" : "s"}.`,
      });
      return;
    }

    const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    const reason =
      firstError?.reason instanceof Error ? firstError.reason.message : String(firstError?.reason ?? "");
    toast({
      title: "Rebroadcast failed",
      description: reason
        ? `No relay accepted the post: ${reason}`
        : "No relay accepted the post.",
      variant: "destructive",
    });
  };

  return (
    <MessageRow
      pubkey={event.pubkey}
      createdAt={event.created_at}
      continuation={continuation}
      containerProps={{ "data-event-id": event.id } as React.HTMLAttributes<HTMLDivElement>}
    >
      <div className="flex flex-col gap-1.5">
        {!continuation && (
          <Badge variant="secondary" className="w-fit gap-1 text-[10px] font-medium">
            <Radio className="size-3" />
            Rebroadcastable post
          </Badge>
        )}
        <ChatContent event={event} className="text-[15px]" />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            disabled={!online || pending || done}
            onClick={() => void rebroadcast()}
          >
            <Radio className="size-3.5" />
            {done ? "Rebroadcasted" : pending ? "Rebroadcasting…" : "Rebroadcast"}
          </Button>
          {!online && (
            <span className="text-[11px] text-muted-foreground/70">Connect to the internet to relay</span>
          )}
        </div>
      </div>
    </MessageRow>
  );
}
