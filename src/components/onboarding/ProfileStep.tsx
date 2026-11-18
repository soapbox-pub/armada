import { useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2, UserRound } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { toast } from "@/hooks/useToast";
import { useUploadProfileImage } from "@/hooks/useUploadProfileImage";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { profileImetaTags } from "@/lib/profileImeta";
import { DEFAULT_AVATARS, defaultAvatarImeta, type DefaultAvatar } from "@/lib/defaultAvatars";
import { impact } from "@/lib/haptics";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

/** Signup step 3: optional name and picture (twelve presets, one tap). Everything else stays in Settings. */

type Picture =
  | { kind: "none" }
  /** A preset is already a Blossom URL, so publishing one uploads nothing. */
  | { kind: "default"; avatar: DefaultAvatar }
  | { kind: "uploaded"; url: string; imeta: string[] };

export interface ProfileStepBodyProps {
  /**
   * The just-created account and nobody else: a kind 0 signed by the wrong key
   * silently replaces someone's profile, so publishing refuses on mismatch.
   */
  expectedPubkey: string | undefined;
  /** The signed kind 0, so a later step can send it to more relays. */
  onPublished?: (event: NostrEvent) => void;
  onFinish: () => void;
}

export function ProfileStepBody({ expectedPubkey, onPublished, onFinish }: ProfileStepBodyProps) {
  const intl = useIntl();
  const [name, setName] = useState("");
  const [picture, setPicture] = useState<Picture>({ kind: "none" });
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { upload: uploadProfileImage, isPending: uploading } = useUploadProfileImage();

  const busy = saving || uploading;

  const preview =
    picture.kind === "default"
      ? picture.avatar.url
      : picture.kind === "uploaded"
        ? picture.url
        : undefined;

  const handlePhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file twice still fires.
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: t({ id: "profileStep.pickImage", defaultMessage: "Pick an image" }), variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t({ id: "profileStep.tooBig.title", defaultMessage: "That image is too big" }),
        description: t({ id: "profileStep.tooBig.description", defaultMessage: "5MB at most." }),
        variant: "destructive",
      });
      return;
    }

    try {
      const { url, imeta } = await uploadProfileImage(file);
      if (url) setPicture({ kind: "uploaded", url, imeta });
    } catch {
      toast({
        title: t({ id: "profileStep.uploadFailed.title", defaultMessage: "Couldn't upload that" }),
        description: t({
          id: "profileStep.uploadFailed.description",
          defaultMessage: "Try again, or pick one of the pictures below.",
        }),
        variant: "destructive",
      });
    }
  };

  /** Publish and move on. Every failure still calls `onFinish`: both fields are editable in Settings. */
  const handleFinish = async () => {
    const trimmed = name.trim();
    if (!trimmed && picture.kind === "none") {
      onFinish();
      return;
    }

    // Refuse if the new login isn't the active signer, or we'd overwrite another account.
    if (!user || !expectedPubkey || user.pubkey !== expectedPubkey) {
      toast({
        title: t({ id: "profileStep.notActive.title", defaultMessage: "Profile not saved" }),
        description: t({
          id: "profileStep.notActive.description",
          defaultMessage: "This account isn't active yet. You can set it up from Settings.",
        }),
        variant: "destructive",
      });
      onFinish();
      return;
    }

    setSaving(true);

    try {
      let pictureUrl: string | undefined;

      if (picture.kind === "uploaded") {
        pictureUrl = picture.url;
      } else if (picture.kind === "default") {
        // Published as-is; re-uploading a preset would create a second URL for it.
        pictureUrl = picture.avatar.url;
      }

      const metadata: Record<string, string> = {};
      if (trimmed) metadata.name = trimmed;
      if (pictureUrl) metadata.picture = pictureUrl;

      const event = await publishEvent({
        kind: 0,
        content: JSON.stringify(metadata),
        tags: profileImetaTags(metadata, [
          picture.kind === "uploaded" ? picture.imeta : picture.kind === "default" ? defaultAvatarImeta(picture.avatar) : [],
        ]),
      });
      if (event) onPublished?.(event);
      queryClient.invalidateQueries({ queryKey: ["logins"] });
      queryClient.invalidateQueries({ queryKey: ["author", user.pubkey] });
    } catch {
      toast({
        title: t({ id: "profileStep.saveFailed.title", defaultMessage: "Couldn't save your profile" }),
        description: t({
          id: "profileStep.saveFailed.description",
          defaultMessage: "Your account is fine. Set a name and picture from Settings.",
        }),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
      onFinish();
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
        <FormattedMessage id="profileStep.title" defaultMessage="set up your profile" />
      </h1>

      <div className="relative">
        <div className="size-24 overflow-hidden rounded-full bg-muted">
          {preview ? (
            <img src={preview} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <UserRound aria-hidden="true" className="size-10" />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label={intl.formatMessage({ id: "profileStep.choosePhoto", defaultMessage: "Choose a photo" })}
          className="absolute -bottom-1 -right-1 flex size-9 touch:size-11 items-center justify-center rounded-full border-4 border-background bg-primary text-primary-foreground outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {uploading ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Camera aria-hidden="true" className="size-4" />
          )}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handlePhoto}
          className="hidden"
        />
      </div>

      {/* Frame is a wrapper, not an input `border`: clip-path slices borders at the
          cut corners (see `.clip-hairline-lg`), and inputs have no ::before. */}
      <div className="w-full">
        <label htmlFor="onboarding-name" className="sr-only">
          <FormattedMessage id="profileStep.yourName" defaultMessage="Your name" />
        </label>
        <Input
          id="onboarding-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={intl.formatMessage({ id: "profileStep.yourName", defaultMessage: "Your name" })}
          autoComplete="name"
          autoCapitalize="words"
          enterKeyHint="done"
          maxLength={64}
          className="h-12 touch:h-12 text-center text-base"
        />
      </div>

      {/* Own provider: tests render this alone, and a Radix Tooltip without one throws. */}
      <TooltipProvider delayDuration={600}>
        <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-2">
          {DEFAULT_AVATARS.map((avatar) => {
            const chosen = picture.kind === "default" && picture.avatar.id === avatar.id;
            return (
              /* Hover-only credit (a tap must choose, not explain). */
              <Tooltip key={avatar.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={avatar.label}
                    aria-pressed={chosen}
                    onClick={() => {
                      impact("light");
                      setPicture({ kind: "default", avatar });
                    }}
                    disabled={busy}
                    className={cn(
                      "aspect-square overflow-hidden rounded-full outline-none transition-transform",
                      "hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      chosen && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                    )}
                  >
                    {/* Eager: lazy images below the fold in this scroll container never load. */}
                    <img
                      src={avatar.url}
                      alt=""
                      decoding="async"
                      className="size-full object-cover"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{avatar.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>

      <div className="w-full space-y-2">
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={handleFinish}
          disabled={busy}
        >
          {saving ? (
            <>
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              <FormattedMessage {...common.saving} />
            </>
          ) : (
            <FormattedMessage {...common.continue} />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={onFinish}
          disabled={busy}
        >
          <FormattedMessage id="profileStep.skipForNow" defaultMessage="Skip for now" />
        </Button>
      </div>
    </div>
  );
}
