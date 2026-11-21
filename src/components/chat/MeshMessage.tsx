import { DiceRollBody } from "@/components/chat/DiceRoll";
import { MeshContent } from "@/components/chat/MeshContent";
import { parseRollMessage } from "@/lib/dice";
import { MessageRow, type MessageIdentity } from "@/components/chat/MessageRow";
import { isMeAction, meActionText } from "@/lib/slashCommands";
import { meshMentionsMe } from "@/lib/meshIdentity";
import { cn } from "@/lib/utils";

import type { ChatMsg } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

interface MeshMessageProps {
  event: ChatMsg;
  identity: MessageIdentity;
  peers: MeshPeer[];
  myPeerID: string | null;
  continuation?: boolean;
  /** Open the Noise XX DM; omitted for our own messages or inside that DM. */
  onMessage?: (peerID: string) => void;
  onMention?: (peerID: string) => void;
}

/**
 * A Bluetooth-mesh message: a thin shell over `MessageRow` (mesh has no
 * reactions/threads/edits), with `identityOverride` and a profile popover.
 */
export function MeshMessage({ event, identity, peers, myPeerID, continuation, onMessage, onMention }: MeshMessageProps) {
  const mentionsMe = meshMentionsMe(event.content, myPeerID);
  const isSelf = !!myPeerID && event.pubkey === myPeerID;

  const roll = parseRollMessage(event.content);
  const body = roll ? (
    <DiceRollBody
      roll={roll}
      id={event.id}
      createdAt={event.created_at}
      own={isSelf}
      name={<span style={{ color: identity.color }}>{identity.name}</span>}
    />
  ) : isMeAction(event) ? (
    <div className="text-chat italic text-muted-foreground">
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
    <MeshContent content={event.content} peers={peers} myPeerID={myPeerID} className="text-chat" />
  );

  return (
    <MessageRow
      pubkey={event.pubkey}
      identityOverride={identity}
      meshActions={{ peerID: event.pubkey, isSelf, onMessage, onMention }}
      createdAt={event.created_at}
      // A mention needs the full header to read as directed at someone.
      continuation={continuation && !mentionsMe}
      className={cn(mentionsMe && "bg-primary/10 hover:bg-primary/15 border-l-2 border-primary pl-2")}
      containerProps={{ "data-event-id": event.id } as React.HTMLAttributes<HTMLDivElement>}
    >
      {body}
    </MessageRow>
  );
}
