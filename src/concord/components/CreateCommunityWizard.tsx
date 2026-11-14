import { ImagePlus, Loader2, Pencil, Plus, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ArmadaCrest } from "@/components/brand/ArmadaCrest";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ImageCropDialog } from "@/components/ImageCropDialog";
import { RelayListEditor } from "@/components/RelayListEditor";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCommunityActions, useCreateRelayCandidates } from "@/concord/hooks/useCommunityActions";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { canonicalOrigin } from "@/concord/lib/voice";
import { faviconUrl } from "@/lib/faviconUrl";
import { COMMUNITY_TIMER_PRESETS, DEFAULT_MESSAGE_EXPIRATION_SECS } from "@/concord/lib/disappearing";
import { COMMUNITY_BANNER_EDGE, COMMUNITY_ICON_EDGE, encryptImageBlob } from "@/concord/lib/image";
import {
  DESCRIPTION_MAX_BYTES,
  MAX_COMMUNITY_AV_BROKERS,
  NAME_MAX_BYTES,
  utf8Len,
  type ImagePointer,
} from "@/concord/lib/types";
import { useUploadFile } from "@/hooks/useUploadFile";
import { encryptedUploadFailureReason } from "@/lib/blossomPreflight";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";
import { common, FormattedMessage, t, useIntl } from "@/i18n";

/**
 * One concern per step. Relays and voice servers share a step; the timer is
 * last so the create button never needs scrolling on a phone.
 */
const CREATE_STEPS = ["name", "look", "relays", "rules"] as const;
type CreateStep = (typeof CREATE_STEPS)[number];

interface StagedImage {
  pointer: ImagePointer;
  /** Object URL of the cropped plaintext; only ciphertext is uploaded. */
  preview: string;
}

/**
 * Full-screen community founding wizard. Everything goes into ONE genesis
 * metadata edition at the end, so abandoning leaves nothing (at worst an
 * unreadable orphaned blob).
 */
export function CreateCommunityWizard({ onClose }: { onClose: () => void }) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { create, isCreating } = useCommunityActions();
  const { mutateAsync: uploadFile } = useUploadFile();

  const [step, setStep] = useState<CreateStep>("name");
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<StagedImage | null>(null);
  const [banner, setBanner] = useState<StagedImage | null>(null);
  const [uploading, setUploading] = useState<"icon" | "banner" | null>(null);

  // CORD-08 retention, decided before the first message. Defaults to 30 days.
  const [expiration, setExpiration] = useState(DEFAULT_MESSAGE_EXPIRATION_SECS);

  // `null` = use configured defaults; otherwise an explicit set for this mint only.
  const [relays, setRelays] = useState<string[] | null>(null);
  const candidates = useCreateRelayCandidates();
  const effectiveRelays = relays ?? candidates;

  // Prefilled with the creator's own: once minted, members' calls resolve from
  // this list (CORD-07 §5). Empty leaves members on their own servers.
  const [avBrokers, setAvBrokers] = useState<string[]>(() =>
    ownAvServers()
      .map(canonicalOrigin)
      .filter((origin): origin is string => Boolean(origin))
      .slice(0, MAX_COMMUNITY_AV_BROKERS),
  );

  const nameTooLong = utf8Len(name.trim()) > NAME_MAX_BYTES;
  const descriptionTooLong = utf8Len(description.trim()) > DESCRIPTION_MAX_BYTES;

  // Previews outlive their step, so revoke all on unmount.
  const objectUrls = useRef<string[]>([]);
  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const pickInputRef = useRef<HTMLInputElement>(null);
  const pendingField = useRef<"icon" | "banner">("icon");
  const [cropState, setCropState] = useState<{
    imageSrc: string;
    aspect: number;
    field: "icon" | "banner";
    title: string;
  } | null>(null);

  const handlePickImage = (field: "icon" | "banner") => {
    pendingField.current = field;
    pickInputRef.current?.click();
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const field = pendingField.current;
    setCropState({
      imageSrc: URL.createObjectURL(file),
      aspect: field === "icon" ? 1 : 3,
      field,
      title: field === "icon"
        ? t({ id: "createCommunityWizard.cropIcon", defaultMessage: "Crop icon" })
        : t({ id: "createCommunityWizard.cropBanner", defaultMessage: "Crop banner" }),
    });
  };

  const handleCropCancel = () => {
    if (cropState) URL.revokeObjectURL(cropState.imageSrc);
    setCropState(null);
  };

  const handleCropConfirm = async (blob: Blob) => {
    if (!cropState) return;
    const { field, imageSrc } = cropState;
    URL.revokeObjectURL(imageSrc);
    setCropState(null);
    setError(null);
    setUploading(field);
    try {
      // CORD-02 §6: the media host only sees ciphertext; the key rides in the sealed metadata.
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(blob);
      const tags = await uploadFile(
        new File([ciphertext], `${field}.enc`, { type: "application/octet-stream" }),
      );
      const url = tags[0]?.[1];
      if (!url) throw new Error(t({ id: "createCommunityWizard.noUrl", defaultMessage: "Upload returned no URL." }));
      const preview = URL.createObjectURL(blob);
      objectUrls.current.push(preview);
      const staged: StagedImage = { pointer: { url, key, nonce, hash }, preview };
      if (field === "icon") setIcon(staged);
      else setBanner(staged);
    } catch (e) {
      setError(encryptedUploadFailureReason(e) ?? (e instanceof Error ? e.message : t({ id: "createCommunityWizard.uploadFailed", defaultMessage: "Upload failed." })));
    } finally {
      setUploading(null);
    }
  };

  const handleCreate = async () => {
    setError(null);
    try {
      const { communityId, name: created } = await create({
        name: name.trim(),
        // Mint on exactly the relays shown.
        relays: effectiveRelays,
        avBrokers,
        messageExpirationSecs: expiration,
        description: description.trim() || undefined,
        icon: icon?.pointer,
        banner: banner?.pointer,
      });
      toast({ title: t({ id: "createCommunityWizard.ready", defaultMessage: "Encrypted community ready" }), description: created });
      // Replace so going back can't mint a second community.
      navigate(`/c/${encodeURIComponent(communityId)}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "createCommunityWizard.createFailed", defaultMessage: "Couldn't create the community." }));
    }
  };

  const back: Record<CreateStep, (() => void) | undefined> = {
    name: undefined,
    look: () => setStep("name"),
    relays: () => setStep("look"),
    rules: () => setStep("relays"),
  };

  return (
    <WizardShell
      index={CREATE_STEPS.indexOf(step)}
      total={CREATE_STEPS.length}
      stepKey={step}
      maxWidth={step === "name" ? "max-w-sm" : "max-w-md"}
      onBack={back[step]}
      onClose={isCreating ? undefined : onClose}
    >
      {step === "name" && (
        <div className="flex flex-col items-center gap-8 text-center">
          <ArmadaCrest size={84} />

          <StepHeading
            title={intl.formatMessage({ id: "createCommunityWizard.name.title", defaultMessage: "name your community" })}
            description={intl.formatMessage({
              id: "createCommunityWizard.name.description",
              defaultMessage: "Serverless and end-to-end-encrypted. No host can read it, and you become the owner.",
            })}
          />

          <div className="w-full space-y-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !nameTooLong) {
                  e.preventDefault();
                  setStep("look");
                }
              }}
              placeholder={intl.formatMessage({ id: "createCommunityWizard.name.placeholder", defaultMessage: "e.g. Midnight Fleet" })}
              aria-label={intl.formatMessage({ id: "createCommunityWizard.name.label", defaultMessage: "Community name" })}
              autoComplete="off"
              autoFocus
              className="h-12 text-base"
            />
            {nameTooLong && (
              <p className="text-left text-xs text-destructive">
                <FormattedMessage
                  id="createCommunityWizard.name.tooLong"
                  defaultMessage="Names are capped at {max} bytes. Shorten it to continue."
                  values={{ max: NAME_MAX_BYTES }}
                />
              </p>
            )}
            <Button
              type="button"
              size="lg"
              onClick={() => setStep("look")}
              disabled={!name.trim() || nameTooLong}
              className="h-12 w-full clip-corner-lg text-base font-medium"
            >
              <FormattedMessage {...common.continue} />
            </Button>
          </div>
        </div>
      )}

      {step === "look" && (
        <div className="flex flex-col gap-6">
          <StepHeading
            title={intl.formatMessage({ id: "createCommunityWizard.look.title", defaultMessage: "give it a face" })}
            description={intl.formatMessage({
              id: "createCommunityWizard.look.description",
              defaultMessage: "All optional. Images are encrypted before upload.",
            })}
          />

          {/* Live stand-in for the community header: icon overlapping the banner edge. */}
          <div>
            <div className="relative">
              <ImageSlot
                variant="banner"
                image={banner}
                busy={uploading === "banner"}
                onPick={() => handlePickImage("banner")}
              />
              <div className="absolute -bottom-10 left-1/2 -translate-x-1/2">
                <ImageSlot
                  variant="icon"
                  image={icon}
                  busy={uploading === "icon"}
                  onPick={() => handlePickImage("icon")}
                />
              </div>
            </div>
            <h2 className="mt-12 text-center text-lg font-semibold leading-tight break-words">
              {name.trim()}
            </h2>
          </div>

          <div className="space-y-1.5">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={intl.formatMessage({ id: "createCommunityWizard.look.descriptionPlaceholder", defaultMessage: "What's this community about?" })}
              aria-label={intl.formatMessage({ id: "createCommunityWizard.look.descriptionLabel", defaultMessage: "Community description" })}
              rows={3}
              className="resize-none"
            />
            {descriptionTooLong && (
              <p className="text-xs text-destructive">
                <FormattedMessage
                  id="createCommunityWizard.look.descriptionTooLong"
                  defaultMessage="Descriptions are capped at {max} bytes."
                  values={{ max: DESCRIPTION_MAX_BYTES.toLocaleString(intl.locale) }}
                />
              </p>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="button"
            size="lg"
            onClick={() => setStep("relays")}
            disabled={uploading !== null || descriptionTooLong}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            {uploading ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                <FormattedMessage id="createCommunityWizard.uploading" defaultMessage="Uploading..." />
              </>
            ) : (
              <FormattedMessage {...common.continue} />
            )}
          </Button>
        </div>
      )}

      {step === "relays" && (
        <div className="flex flex-col gap-6">
          <StepHeading
            title={intl.formatMessage({ id: "createCommunityWizard.relays.title", defaultMessage: "where it lives" })}
            description={intl.formatMessage({
              id: "createCommunityWizard.relays.description",
              defaultMessage: "Messages live on the relays; calls run through the voice servers. Pick relays that will let you post.",
            })}
          />

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FormattedMessage id="createCommunityWizard.relays.relays" defaultMessage="Relays" />
            </p>
            <RelayListEditor
              relays={effectiveRelays}
              onChange={setRelays}
              onReset={() => setRelays(candidates)}
              emptyText={intl.formatMessage({ id: "createCommunityWizard.relays.empty", defaultMessage: "Add at least one relay to host this community." })}
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FormattedMessage id="createCommunityWizard.relays.voiceServers" defaultMessage="Voice servers" />
            </p>
            <VoiceServerListEditor servers={avBrokers} onChange={setAvBrokers} />
            <p className="text-xs text-muted-foreground">
              {avBrokers.length > 0
                ? <FormattedMessage
                  id="createCommunityWizard.relays.voiceHint"
                  defaultMessage="Every call in this community runs through these. They never see the calls themselves, which are encrypted end to end, but they do see who connects and when."
                />
                : <FormattedMessage
                  id="createCommunityWizard.relays.voiceNone"
                  defaultMessage="With none set, every member calls through whatever voice server they've set themselves."
                />}
            </p>
          </div>

          <Button
            type="button"
            size="lg"
            onClick={() => setStep("rules")}
            disabled={effectiveRelays.length === 0}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            <FormattedMessage {...common.continue} />
          </Button>
        </div>
      )}

      {step === "rules" && (
        <div className="flex flex-col gap-6">
          <StepHeading
            title={intl.formatMessage({ id: "createCommunityWizard.rules.title", defaultMessage: "disappearing messages" })}
            description={intl.formatMessage({
              id: "createCommunityWizard.rules.description",
              defaultMessage: "Messages delete for everyone this long after they're sent. Changeable later.",
            })}
          />

          <Select value={String(expiration)} onValueChange={(v) => setExpiration(Number(v))}>
            <SelectTrigger className="h-12 w-full text-base" aria-label={intl.formatMessage({ id: "createCommunityWizard.rules.timer", defaultMessage: "Disappearing messages timer" })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[260]">
              {COMMUNITY_TIMER_PRESETS.map((p) => (
                <SelectItem key={p.seconds} value={String(p.seconds)}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="button"
            size="lg"
            onClick={handleCreate}
            disabled={isCreating || effectiveRelays.length === 0}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            {isCreating ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                <FormattedMessage id="createCommunityWizard.creating" defaultMessage="Creating..." />
              </>
            ) : (
              <>
                <ShieldCheck className="size-4 mr-2" />{" "}
                <FormattedMessage id="createCommunityWizard.create" defaultMessage="Create encrypted community" />
              </>
            )}
          </Button>
        </div>
      )}

      {/* Shared input outside the steps so a re-render can't unmount it under the file dialog. */}
      <input
        ref={pickInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChosen}
      />
      {cropState && (
        <ImageCropDialog
          open
          imageSrc={cropState.imageSrc}
          aspect={cropState.aspect}
          title={cropState.title}
          maxEdge={cropState.field === "icon" ? COMMUNITY_ICON_EDGE : COMMUNITY_BANNER_EDGE}
          onCancel={handleCropCancel}
          onCrop={handleCropConfirm}
        />
      )}
    </WizardShell>
  );
}

/**
 * Voice-server list in the relay editor's shape. Brokers publish no NIP-11
 * document, so rows use the host's favicon (`faviconUrl`) with an initial fallback.
 */
function VoiceServerListEditor({
  servers,
  onChange,
}: {
  servers: string[];
  onChange: (servers: string[]) => void;
}) {
  const intl = useIntl();
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    const raw = draft.trim();
    // Non-https refused: the token grant is a bearer credential (CORD-07 §2).
    const origin = canonicalOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!origin) {
      toast({
        title: t({ id: "createCommunityWizard.voice.invalid", defaultMessage: "Invalid voice server" }),
        description: t({ id: "createCommunityWizard.voice.invalidHint", defaultMessage: "Enter an https address, like voice.example.com." }),
        variant: "destructive",
      });
      return;
    }
    if (servers.includes(origin)) {
      toast({ title: t({ id: "createCommunityWizard.voice.duplicate", defaultMessage: "Already in the list" }), description: origin });
      setDraft("");
      return;
    }
    onChange([...servers, origin]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      {servers.map((origin) => {
        const host = origin.replace(/^https:\/\//, "");
        return (
          <div key={origin} className="flex items-center gap-2 rounded-md bg-background/40 px-3 py-2.5">
            <Avatar className="size-7 shrink-0 rounded-md">
              <AvatarImage src={faviconUrl(origin)} alt="" />
              <AvatarFallback className="rounded-md bg-secondary text-xs text-secondary-foreground">
                {host.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{host}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "createCommunityWizard.voice.remove", defaultMessage: "Remove {origin}" }, { origin })}
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => onChange(servers.filter((s) => s !== origin))}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}

      {servers.length === 0 && (
        <p className="py-1 text-sm text-muted-foreground">
          <FormattedMessage id="createCommunityWizard.voice.none" defaultMessage="No voice servers. Members will use their own." />
        </p>
      )}

      {servers.length < MAX_COMMUNITY_AV_BROKERS && (
        <form
          className="flex gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="voice.example.com"
            aria-label={intl.formatMessage({ id: "createCommunityWizard.voice.add", defaultMessage: "Add voice server" })}
            autoComplete="off"
            className="bg-background/40 border-transparent text-base md:text-sm"
          />
          <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
            <Plus className="size-4 mr-1.5" /> <FormattedMessage {...common.add} />
          </Button>
        </form>
      )}
    </div>
  );
}

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-2.5 text-center">
      <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
        {title}
      </h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

/** Icon or banner slot; the pencil shows only once there's something to replace. */
function ImageSlot({
  variant,
  image,
  busy,
  onPick,
}: {
  variant: "icon" | "banner";
  image: StagedImage | null;
  busy: boolean;
  onPick: () => void;
}) {
  const intl = useIntl();
  const isIcon = variant === "icon";
  return (
    <div className={cn("relative", isIcon ? "w-fit" : "w-full")}>
      <button
        type="button"
        className={cn(
          "grid place-items-center overflow-hidden transition-colors",
          isIcon ? "size-20 rounded-2xl ring-4 ring-background" : "h-32 w-full rounded-lg",
          image
            ? "hover:opacity-90"
            : "bg-secondary/40 text-muted-foreground hover:bg-secondary/60",
        )}
        onClick={onPick}
        disabled={busy}
        aria-label={isIcon
          ? image
            ? intl.formatMessage({ id: "createCommunityWizard.changeIcon", defaultMessage: "Change icon" })
            : intl.formatMessage({ id: "createCommunityWizard.addIcon", defaultMessage: "Add icon" })
          : image
            ? intl.formatMessage({ id: "createCommunityWizard.changeBanner", defaultMessage: "Change banner" })
            : intl.formatMessage({ id: "createCommunityWizard.addBanner", defaultMessage: "Add banner" })}
      >
        {image ? (
          <img src={image.preview} alt="" className="size-full object-cover" />
        ) : (
          <ImagePlus className={isIcon ? "size-4" : "size-5"} />
        )}
      </button>
      {(image || busy) && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute grid place-items-center rounded-full bg-background/85 text-foreground ring-1 ring-border backdrop-blur",
            isIcon ? "-bottom-1 -right-1 size-6" : "bottom-2 right-2 size-8",
          )}
        >
          {busy ? (
            <Loader2 className={cn("animate-spin", isIcon ? "size-3" : "size-4")} />
          ) : (
            <Pencil className={isIcon ? "size-3" : "size-3.5"} />
          )}
        </div>
      )}
    </div>
  );
}
