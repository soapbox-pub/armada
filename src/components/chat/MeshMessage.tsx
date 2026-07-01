import { MeshContent } from "@/components/chat/MeshContent";
import { MeshPostMessage } from "@/components/chat/MeshPostMessage";
import { MessageRow, type MessageIdentity } from "@/components/chat/MessageRow";
import { isMeAction, meActionText } from "@/lib/slashCommands";
import { meshMentionsMe } from "@/lib/meshIdentity";
import { REBROADCAST_KIND } from "@/lib/rebroadcast";
import { cn } from "@/lib/utils";

import type { ChatMsg } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

interface MeshMessageProps {
  event: ChatMsg;
  /** Resolved author identity (name/color/suffix) for this peer. */
  identity: MessageIdentity;
  /** Nearby peers, for coloring mention chips. */
  peers: MeshPeer[];
  /** Our own peer id, so a mention of us highlights the row. */
  myPeerID: string | null;
  /** Render compactly as a continuation of the previous same-author message. */
  continuation?: boolean;
  /**
   * Open the Noise XX DM with this message's author. Omitted when the author is
   * us or when we're already viewing that DM, which hides the "Message" action.
   */
  onMessage?: (peerID: string) => void;
  /** Insert an @-mention of this message's author into the composer. */
  onMention?: (peerID: string) => void;
}

/**
 * A single Bluetooth-mesh message. Mesh chat has no reactions/replies/threads/
 * polls/edits/moderation, so this is a thin shell over the shared `MessageRow`
 * (rather than the full Nostr `ChatMessage`): it renders the colored author via
 * `identityOverride`, the plain-text body with `@name#suffix` mention chips, the
 * `/me` action form, and emphasizes a message that mentions us. The author
 * avatar/name open a mesh profile popover (Message / Mention) via `meshActions`.
 */
export function MeshMessage({ event, identity, peers, myPeerID, continuation, onMessage, onMention }: MeshMessageProps) {
  // A rebroadcastable post carries a real, signature-verified Nostr event
  // (kind 1 with a non-empty sig), unlike ordinary mesh messages whose `pubkey`
  // is a mesh peer id and whose sig is empty. Render it with the author's real
  // Nostr identity + a Rebroadcast button instead of the mesh-peer chrome.
  if (event.kind === REBROADCAST_KIND && event.sig) {
    return <MeshPostMessage event={event} continuation={continuation} />;
  }

  const mentionsMe = meshMentionsMe(event.content, myPeerID);
  const isSelf = !!myPeerID && event.pubkey === myPeerID;

  const body = isMeAction(event) ? (
    <div className="text-[15px] italic text-muted-foreground">
      <span className="font-semibold not-italic" style={{ color: identity.color }}>
        {identity.name}
      </span>{" "}
      <MeshContent
        content={meActionText(event)}
        peers={peers}
        myPeerID={myPeerID}
        className="inline italic"
      />
    </div>
  ) : (
    <MeshContent content={event.content} peers={peers} myPeerID={myPeerID} className="text-[15px]" />
  );

  return (
    <MessageRow
      pubkey={event.pubkey}
      identityOverride={identity}
      meshActions={{ peerID: event.pubkey, isSelf, onMessage, onMention }}
      createdAt={event.created_at}
      // A mention needs the full header (avatar + name), not a collapsed
      // continuation, so it reads as directed at someone.
      continuation={continuation && !mentionsMe}
      className={cn(mentionsMe && "bg-primary/10 hover:bg-primary/15 border-l-2 border-primary pl-2")}
      containerProps={{ "data-event-id": event.id } as React.HTMLAttributes<HTMLDivElement>}
    >
      {body}
    </MessageRow>
  );
}
