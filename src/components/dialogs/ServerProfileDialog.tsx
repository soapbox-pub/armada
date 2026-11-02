import { Loader2, RotateCcw, UserCog } from "lucide-react";
import { useEffect, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  ChromeDialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUserProfile } from "@/hooks/useCurrentUser";
import { useServerProfile, useUpdateServerProfile } from "@/hooks/useServerProfile";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { isHexColor } from "@/lib/nip29";
import { AvatarInitial } from "@/components/AvatarInitial";

interface ServerProfileDialogProps {
  relayUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_COLOR = "#7c5cff";

const PRESET_COLORS = [
  "#f87171", "#fb923c", "#facc15", "#4ade80",
  "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6",
];

/** Per-server nickname, label and username color: NIP-32 self-labels scoped to this relay only. */
export function ServerProfileDialog({ relayUrl, open, onOpenChange }: ServerProfileDialogProps) {
  const intl = useIntl();
  const { user, metadata, imeta } = useCurrentUserProfile();
  const { data: profile, isLoading } = useServerProfile(relayUrl, user?.pubkey);
  const { mutateAsync: save, isPending } = useUpdateServerProfile(relayUrl);

  const [nickname, setNickname] = useState("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("");
  const [colorEnabled, setColorEnabled] = useState(false);

  useEffect(() => {
    if (open) {
      setNickname(profile?.nickname ?? "");
      setLabel(profile?.label ?? "");
      setColor(profile?.color ?? "");
      setColorEnabled(isHexColor(profile?.color));
    }
  }, [open, profile]);

  const handleSave = async () => {
    try {
      await save({
        nickname,
        label,
        color: colorEnabled ? (color || DEFAULT_COLOR) : "",
      });
      toast({
        title: t({ id: "serverProfileDialog.saved", defaultMessage: "Saved" }),
        description: t({ id: "serverProfileDialog.savedDescription", defaultMessage: "Your server identity has been updated." }),
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: t({ id: "serverProfileDialog.saveFailed", defaultMessage: "Couldn’t save" }),
        description: err instanceof Error ? err.message : t({ id: "serverProfileDialog.pleaseTryAgain", defaultMessage: "Please try again." }),
        variant: "destructive",
      });
    }
  };

  const pickColor = (next: string) => {
    setColor(next);
    setColorEnabled(true);
  };

  const previewName = nickname.trim() || getDisplayName(metadata, user?.pubkey);
  const previewColor = colorEnabled && isHexColor(color || DEFAULT_COLOR)
    ? (color || DEFAULT_COLOR)
    : undefined;
  const swatch = isHexColor(color) ? color : DEFAULT_COLOR;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "serverProfileDialog.title", defaultMessage: "Server identity" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <UserCog className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="serverProfileDialog.heading" defaultMessage="server identity" />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="serverProfileDialog.intro" defaultMessage="A nickname, label and color for this server only. They don't change other servers or your global profile." />
          </p>
        </div>

        <div className="mt-6">
          <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/70 mb-2">
            <FormattedMessage id="serverProfileDialog.preview" defaultMessage="Preview" />
          </div>
          <div className="clip-corner-lg bg-background/40 p-3">
            <div className="flex items-start gap-3">
              <Avatar shape={getAvatarShape(metadata)} className="size-10 shrink-0">
                <AvatarImage src={metadata?.picture} imeta={imeta?.picture} alt={previewName} />
                <AvatarFallback className="bg-primary/20 text-primary text-sm">
                  <AvatarInitial name={previewName} />
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-chat font-semibold text-primary truncate"
                    style={previewColor ? { color: previewColor } : undefined}
                  >
                    {/* Emojify like a real message row, or shortcode nicknames preview wrong. */}
                    <DisplayName pubkey={user?.pubkey} name={previewName} />
                  </span>
                  {label.trim() && (
                    <Badge variant="secondary" className="text-3xs font-medium">
                      {label.trim()}
                    </Badge>
                  )}
                  <span className="text-2xs text-muted-foreground/70">
                    <FormattedMessage id="serverProfileDialog.justNow" defaultMessage="just now" />
                  </span>
                </div>
                <p className="text-sm text-foreground/90 mt-0.5">
                  <FormattedMessage id="serverProfileDialog.sampleMessage" defaultMessage="Hey everyone, glad to be here." />
                </p>
              </div>
            </div>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="mt-6 space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="server-nickname">
              <FormattedMessage id="serverProfileDialog.nickname" defaultMessage="Nickname" />
            </Label>
            <Input
              id="server-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={intl.formatMessage({ id: "serverProfileDialog.nicknamePlaceholder", defaultMessage: "How others see you here" })}
              autoComplete="off"
              maxLength={64}
              disabled={isLoading}
              className="bg-background/40 border-transparent"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="server-label">
              <FormattedMessage id="serverProfileDialog.label" defaultMessage="Label" />
            </Label>
            <Input
              id="server-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={intl.formatMessage({ id: "serverProfileDialog.labelPlaceholder", defaultMessage: "A short tag, e.g. “Founder”" })}
              autoComplete="off"
              maxLength={32}
              disabled={isLoading}
              className="bg-background/40 border-transparent"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>
                <FormattedMessage id="serverProfileDialog.usernameColor" defaultMessage="Username color" />
              </Label>
              {colorEnabled && (
                <button
                  type="button"
                  onClick={() => {
                    setColorEnabled(false);
                    setColor("");
                  }}
                  disabled={isLoading}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw className="size-3" />
                  <FormattedMessage id="serverProfileDialog.reset" defaultMessage="Reset" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label
                className="relative size-9 shrink-0 cursor-pointer clip-corner-lg overflow-hidden"
                style={{ backgroundColor: colorEnabled ? swatch : "hsl(var(--background) / 0.4)" }}
                title={intl.formatMessage({ id: "serverProfileDialog.customColor", defaultMessage: "Custom color" })}
              >
                <input
                  type="color"
                  aria-label={intl.formatMessage({ id: "serverProfileDialog.customUsernameColor", defaultMessage: "Custom username color" })}
                  value={swatch}
                  onChange={(e) => pickColor(e.target.value)}
                  disabled={isLoading}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {PRESET_COLORS.map((c) => {
                  const active = colorEnabled && color.toLowerCase() === c.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-label={intl.formatMessage({ id: "serverProfileDialog.useColor", defaultMessage: "Use color {color}" }, { color: c })}
                      onClick={() => pickColor(c)}
                      disabled={isLoading}
                      className="size-6 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110"
                      style={{
                        backgroundColor: c,
                        boxShadow: active ? `0 0 0 2px var(--background, #000), 0 0 0 4px ${c}` : undefined,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={isPending || isLoading}>
              {isPending ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" /> <FormattedMessage {...common.saving} />
                </>
              ) : (
                <FormattedMessage {...common.save} />
              )}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
