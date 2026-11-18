import { Check, ChevronDown, Copy, Globe, Hash, Loader2, Lock, Mail, TicketPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { PrivacyToggle } from "@/components/dialogs/CreateGroupDialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  ChromeDialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";

import type { Nip29Group } from "@/lib/nip29";

interface GroupSettingsDialogProps {
  relayUrl: string;
  group: Nip29Group;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function randomInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Channel admin: edit NIP-29 metadata (kind 9002) and mint invite codes (kind 9009). */
export function GroupSettingsDialog({ relayUrl, group, open, onOpenChange }: GroupSettingsDialogProps) {
  const intl = useIntl();
  const { editMetadata, createInvite } = useGroupModeration(relayUrl, group.id);
  const [name, setName] = useState(group.name);
  const [about, setAbout] = useState(group.about ?? "");
  const [banner, setBanner] = useState(group.banner ?? "");
  const [isPrivate, setIsPrivate] = useState(group.isPrivate);
  const [isClosed, setIsClosed] = useState(group.isClosed);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setName(group.name);
      setAbout(group.about ?? "");
      setBanner(group.banner ?? "");
      setIsPrivate(group.isPrivate);
      setIsClosed(group.isClosed);
      setInviteCode(null);
      setCopied(false);
      setAdvancedOpen(false);
    }
  }, [open, group]);

  const handleSave = async () => {
    try {
      await editMetadata.mutateAsync({
        patch: {
          name: name.trim() || group.id,
          about: about.trim(),
          banner: banner.trim(),
          isPrivate,
          isClosed,
        },
        current: group.event,
      });
      toast({ title: t({ id: "groupSettingsDialog.channelUpdated", defaultMessage: "Channel updated" }) });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: t({ id: "groupSettingsDialog.updateFailed", defaultMessage: "Update failed" }),
        description: e instanceof Error ? e.message : t({ id: "groupSettingsDialog.editRejected", defaultMessage: "The relay rejected the edit." }),
        variant: "destructive",
      });
    }
  };

  const handleInvite = async () => {
    const code = randomInviteCode();
    try {
      await createInvite.mutateAsync({ code });
      setInviteCode(code);
    } catch (e) {
      toast({
        title: t({ id: "groupSettingsDialog.inviteFailed", defaultMessage: "Invite failed" }),
        description: e instanceof Error ? e.message : t({ id: "groupSettingsDialog.inviteRejected", defaultMessage: "The relay rejected the invite." }),
        variant: "destructive",
      });
    }
  };

  const copyInvite = () => {
    if (!inviteCode) return;
    writeClipboardText(inviteCode).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast({ title: t({ id: "groupSettingsDialog.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" }),
    );
  };

  const displayName = name.trim() || group.name || group.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage(
          { id: "groupSettingsDialog.title", defaultMessage: "#{name} settings" },
          { name: displayName },
        )}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Hash className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground truncate max-w-full">
            {displayName}
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="groupSettingsDialog.channelSettings" defaultMessage="Channel settings" />
          </p>
        </div>

        <div className="mt-6 space-y-5 max-h-[55vh] overflow-y-auto">
          <div className="space-y-1.5">
            <Label htmlFor="settings-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FormattedMessage id="groupSettingsDialog.channelName" defaultMessage="Channel name" />
            </Label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input id="settings-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} className="pl-9" />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FormattedMessage id="groupSettingsDialog.invites" defaultMessage="Invites" />
            </Label>
            {inviteCode ? (
              <div className="flex gap-2">
                <Input readOnly value={inviteCode} className="font-mono" />
                <Button variant="outline" size="icon" className="clip-corner-lg shrink-0" aria-label={intl.formatMessage({ id: "groupSettingsDialog.copyInviteCode", defaultMessage: "Copy invite code" })} onClick={copyInvite}>
                  {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
                </Button>
              </div>
            ) : (
              <Button className="w-full clip-corner-lg" onClick={handleInvite} disabled={createInvite.isPending}>
                {createInvite.isPending
                  ? <><Loader2 className="size-4 mr-2 animate-spin" /> <FormattedMessage id="groupSettingsDialog.creating" defaultMessage="Creating…" /></>
                  : <><TicketPlus className="size-4 mr-2" /> <FormattedMessage id="groupSettingsDialog.createInviteCode" defaultMessage="Create invite code" /></>}
              </Button>
            )}
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <FormattedMessage id="groupSettingsDialog.advanced" defaultMessage="Advanced" />
                <ChevronDown className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
              <div className="space-y-5 pt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="settings-about" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <FormattedMessage id="groupSettingsDialog.topic" defaultMessage="Topic" />
                  </Label>
                  <Textarea id="settings-about" value={about} onChange={(e) => setAbout(e.target.value)} maxLength={300} rows={2} />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="settings-banner" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <FormattedMessage id="groupSettingsDialog.bannerUrl" defaultMessage="Banner image URL" />
                  </Label>
                  <Input
                    id="settings-banner"
                    value={banner}
                    onChange={(e) => setBanner(e.target.value)}
                    placeholder="https://…"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-2">
                  <PrivacyToggle
                    id="settings-private"
                    icon={isPrivate ? <Lock className="size-4" /> : <Globe className="size-4" />}
                    title={intl.formatMessage({ id: "groupSettingsDialog.private", defaultMessage: "Private" })}
                    description={intl.formatMessage({ id: "groupSettingsDialog.privateDescription", defaultMessage: "Only members can read messages." })}
                    checked={isPrivate}
                    onCheckedChange={setIsPrivate}
                  />
                  <PrivacyToggle
                    id="settings-closed"
                    icon={<Mail className="size-4" />}
                    title={intl.formatMessage({ id: "groupSettingsDialog.inviteOnly", defaultMessage: "Invite only" })}
                    description={intl.formatMessage({ id: "groupSettingsDialog.inviteOnlyDescription", defaultMessage: "People need an invite code to join." })}
                    checked={isClosed}
                    onCheckedChange={setIsClosed}
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <div className="flex gap-2 pt-6">
          <Button variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
            <FormattedMessage {...common.cancel} />
          </Button>
          <Button className="flex-1 clip-corner-lg" onClick={handleSave} disabled={editMetadata.isPending}>
            {editMetadata.isPending ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" /> <FormattedMessage {...common.saving} />
              </>
            ) : (
              <FormattedMessage id="groupSettingsDialog.saveChanges" defaultMessage="Save changes" />
            )}
          </Button>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
