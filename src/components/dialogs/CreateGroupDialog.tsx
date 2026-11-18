import { Globe, Hash, Loader2, Lock, Mail, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useIsBuzzRelay } from "@/buzz/detect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  ChromeDialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCreateGroup, useGroupModeration } from "@/hooks/useGroupModeration";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { relayDeniesNip29 } from "@/lib/nip29";
import { relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface CreateGroupDialogProps {
  relayUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function randomGroupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Buzz channel ids MUST be lowercase UUIDs. */
function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toChannelSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

/**
 * Create a NIP-29 group: kind 9007 then 9002 metadata, then add to kind 10009.
 * Buzz relays take everything in ONE 9007 (requires a `name` tag) and need a UUID id.
 */
export function CreateGroupDialog({ relayUrl, open, onOpenChange }: CreateGroupDialogProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const { isBuzz } = useIsBuzzRelay(relayUrl);
  const { data: relayInfo } = useRelayInfo(relayUrl);
  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const noNip29 = !isBuzz && relayDeniesNip29(relayInfo);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [isForum, setIsForum] = useState(false);
  const [groupId] = useState(randomGroupId);
  const [buzzId] = useState(randomUuid);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveId = isBuzz ? buzzId : groupId;
  const { mutateAsync: createGroup } = useCreateGroup(relayUrl);
  const { editMetadata } = useGroupModeration(relayUrl, effectiveId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();

  const slug = toChannelSlug(name);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setPending(true);
    setError(null);
    try {
      if (isBuzz) {
        const extraTags: string[][] = [["name", name.trim()]];
        extraTags.push(["visibility", isPrivate ? "private" : "open"]);
        if (isForum) extraTags.push(["channel_type", "forum"]);
        if (about.trim()) extraTags.push(["about", about.trim()]);
        await createGroup({ groupId: effectiveId, extraTags });
      } else {
        // Stops here, before the 9002 and the list entry, if the relay never makes the group.
        await createGroup({ groupId: effectiveId, verify: { relaySelf } });
        await editMetadata.mutateAsync({
          patch: {
            name: name.trim(),
            about: about.trim() || undefined,
            isPrivate,
            isClosed,
          },
        });
      }
      // Best-effort; the list entry is what gives the new channel a rail icon.
      updateList({ type: "add-group", ref: { id: effectiveId, relay: relayUrl } }).catch(() => undefined);

      toast({ title: t({ id: "createGroupDialog.channelCreated", defaultMessage: "Channel created" }), description: name.trim() });
      onOpenChange(false);
      navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(effectiveId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "createGroupDialog.createFailed", defaultMessage: "Failed to create the channel." }));
    } finally {
      setPending(false);
    }
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "createGroupDialog.title", defaultMessage: "Create a channel" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Hash className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="createGroupDialog.heading" defaultMessage="create a channel" />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="createGroupDialog.intro" defaultMessage="Channels are where your community talks. You'll be its first admin." />
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="mt-6 space-y-5"
        >
          <div className="space-y-1.5">
            <Label htmlFor="group-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FormattedMessage id="createGroupDialog.channelName" defaultMessage="Channel name" />
            </Label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={intl.formatMessage({ id: "createGroupDialog.namePlaceholder", defaultMessage: "general" })}
                maxLength={64}
                autoComplete="off"
                autoFocus
                className="pl-9"
              />
            </div>
            {slug && (
              <p className="text-xs text-muted-foreground">
                <FormattedMessage
                  id="createGroupDialog.membersWillSee"
                  defaultMessage="Members will see <name>#{slug}</name>"
                  values={{
                    slug,
                    name: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
                  }}
                />
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="group-about" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FormattedMessage
                id="createGroupDialog.topicOptional"
                defaultMessage="Topic <optional>(optional)</optional>"
                values={{ optional: (chunks) => <span className="normal-case font-normal">{chunks}</span> }}
              />
            </Label>
            <Textarea
              id="group-about"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder={intl.formatMessage({ id: "createGroupDialog.topicPlaceholder", defaultMessage: "What's this channel about?" })}
              maxLength={300}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <PrivacyToggle
              id="group-private"
              icon={isPrivate ? <Lock className="size-4" /> : <Globe className="size-4" />}
              title={intl.formatMessage({ id: "createGroupDialog.private", defaultMessage: "Private" })}
              description={intl.formatMessage({ id: "createGroupDialog.privateDescription", defaultMessage: "Only members can read messages." })}
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
            />
            {isBuzz ? (
              <PrivacyToggle
                id="group-forum"
                icon={<MessagesSquare className="size-4" />}
                title={intl.formatMessage({ id: "createGroupDialog.forum", defaultMessage: "Forum" })}
                description={intl.formatMessage({ id: "createGroupDialog.forumDescription", defaultMessage: "Threaded posts with votes instead of a chat stream." })}
                checked={isForum}
                onCheckedChange={setIsForum}
              />
            ) : (
              <PrivacyToggle
                id="group-closed"
                icon={<Mail className="size-4" />}
                title={intl.formatMessage({ id: "createGroupDialog.inviteOnly", defaultMessage: "Invite only" })}
                description={intl.formatMessage({ id: "createGroupDialog.inviteOnlyDescription", defaultMessage: "People need an invite code to join." })}
                checked={isClosed}
                onCheckedChange={setIsClosed}
              />
            )}
          </div>

          {noNip29 && !error && (
            <Alert>
              <AlertDescription>
                <FormattedMessage id="createGroupDialog.noNip29" defaultMessage="This server doesn't list support for NIP-29 groups, so it probably can't host channels." />
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={pending || !name.trim()}>
              {pending ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" /> <FormattedMessage id="createGroupDialog.creating" defaultMessage="Creating…" />
                </>
              ) : (
                <FormattedMessage id="createGroupDialog.createChannel" defaultMessage="Create channel" />
              )}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}

interface PrivacyToggleProps {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function PrivacyToggle({ id, icon, title, description, checked, onCheckedChange }: PrivacyToggleProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-center gap-3 clip-corner-lg p-3 cursor-pointer transition-colors",
        checked ? "bg-primary/10" : "bg-background/40 hover:bg-background/70",
      )}
    >
      <span className={cn(
        "flex size-9 shrink-0 items-center justify-center clip-corner-lg transition-colors",
        checked ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
      )}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
