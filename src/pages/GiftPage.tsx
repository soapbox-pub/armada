import { Camera, Gem, Gift, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { AvatarInitial } from "@/components/AvatarInitial";
import { Confetti } from "@/components/Confetti";
import { ImageCropDialog } from "@/components/ImageCropDialog";
import { JoinButton } from "@/components/auth/JoinButton";
import { GiftBox } from "@/components/gift/GiftBox";
import { GiftStage } from "@/components/gift/GiftStage";
import { GiftUltraButton } from "@/components/gift/GiftUltraButton";
import { ServerRail } from "@/components/layout/ServerRail";
import { OptionTile } from "@/components/settings/UltraSettings";
import { UltraName } from "@/components/settings/UltraIllustrations";
import { UltraEffect } from "@/components/UltraEffect";
import { UltraPill } from "@/components/UltraPill";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useMyUltra, usePublishUltra, type UltraPicture } from "@/hooks/useUltra";
import { useUltraGift } from "@/hooks/useUltraGift";
import { useUploadProfileImage } from "@/hooks/useUploadProfileImage";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { playFanfare } from "@/lib/fanfare";
import { getDisplayName } from "@/lib/getDisplayName";
import { isAnimatedImage, METADATA_SCAN_BYTES } from "@/lib/imageMetadata";
import { isGifBytes } from "@/lib/runGifCrop";
import {
  AVATAR_FRAMES,
  frameCss,
  NAME_STYLES,
  nameStyleCss,
  PROFILE_EFFECTS,
  readUltra,
  ULTRA_DEFAULTS,
  ULTRA_NAME_CLASS,
  useFrameCss,
  type AvatarFrameId,
  type NameStyleId,
  type ProfileEffectId,
  type UltraProfile,
} from "@/lib/ultra";
import { parseGiftSegment } from "@/lib/ultraGift";
import { cn } from "@/lib/utils";

import type { NostrMetadata } from "@nostrify/nostrify";

/** How long the box rattles before the lid comes off. */
const SHAKE_MS = 550;
/** The least time claiming pretends to take, so the moment lands. */
const CLAIM_MS = 1200;

type Look = Omit<UltraProfile, "since">;

const GRADIENT_CTA = "relative overflow-hidden bg-gradient-to-r from-primary via-fuchsia-500 to-accent2 font-semibold text-white shadow-xl shadow-primary/40 hover:brightness-110";

/**
 * Landing page for an Armada Ultra gift, `/gift/<npub>`: a wrapped box to open,
 * then a studio to pick a look (and a photo) before claiming. Works signed out,
 * so a gift doubles as an invite: the recipient joins here and claims in place.
 */
export function GiftPage() {
  const { from: segment } = useParams<{ from: string }>();
  const gifter = parseGiftSegment(segment);

  return (
    <>
      <ServerRail />
      <main className="flex-1 min-w-0 overflow-y-auto bg-background">
        <div className="relative min-h-full">
          <GiftStage />
          <div className="relative mx-auto flex w-full max-w-xl flex-col items-center px-5 py-10 text-center md:py-14">
            {gifter ? <GiftBody gifter={gifter} /> : <GiftBroken />}
          </div>
        </div>
      </main>
    </>
  );
}

function GiftBroken() {
  return (
    <div className="flex flex-col items-center gap-5 py-10">
      <GiftBox className="size-40 grayscale" rays={false} />
      <h1 className="text-3xl font-black tracking-tight">
        <FormattedMessage id="giftPage.brokenTitle" defaultMessage="This gift link didn’t work" />
      </h1>
      <Button asChild size="lg">
        <Link to="/">
          <FormattedMessage id="giftPage.home" defaultMessage="Go to Armada" />
        </Link>
      </Button>
    </div>
  );
}

type Stage = "wrapped" | "shaking" | "open";

function GiftBody({ gifter }: { gifter: string }) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const author = useAuthor(gifter);
  const gifterMeta = author.data?.metadata;
  const gifterName = getDisplayName(gifterMeta, gifter);
  const gifterFrame = useFrameCss(readUltra(gifterMeta)?.frame);
  const mine = useMyUltra();
  const { publish } = usePublishUltra();
  const { upload } = useUploadProfileImage();
  const { thank } = useUltraGift();

  const [stage, setStage] = useState<Stage>("wrapped");
  const [burst, setBurst] = useState(0);
  const [look, setLook] = useState<Look>(ULTRA_DEFAULTS);
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  const ownGift = user?.pubkey === gifter;
  const alreadyUltra = !!mine.ultra && !claimed;
  const opened = stage === "open";
  const choosing = opened && !claimed && !alreadyUltra;

  const celebrate = (audio: AudioContext | undefined) => {
    if (audio) playFanfare(audio);
    setBurst((n) => n + 1);
  };

  const openGift = () => {
    if (stage !== "wrapped") return;
    // Made inside the click, or the autoplay policy keeps it suspended.
    let audio: AudioContext | undefined;
    try {
      audio = new AudioContext();
    } catch { /* no Web Audio: confetti only */ }
    setStage("shaking");
    setTimeout(() => {
      if (!mounted.current) return;
      setStage("open");
      celebrate(audio);
    }, SHAKE_MS);
  };

  const claim = async () => {
    setClaiming(true);
    let audio: AudioContext | undefined;
    try {
      audio = new AudioContext();
    } catch { /* no Web Audio: confetti only */ }
    try {
      const work = (async () => {
        let picture: UltraPicture | undefined;
        if (photo) picture = await upload(photo.file);
        await publish({ since: Math.floor(Date.now() / 1000), ...look }, { picture });
      })();
      await Promise.all([work, new Promise((resolve) => setTimeout(resolve, CLAIM_MS))]);
    } catch (error) {
      void audio?.close().catch(() => {});
      if (mounted.current) setClaiming(false);
      toast({
        title: intl.formatMessage(common.error),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
      return;
    }
    if (!mounted.current) return;
    setClaiming(false);
    setClaimed(true);
    celebrate(audio);
  };

  // Drawn as the viewer: their real name and picture once signed in, a photo picked here first.
  const selfName = mine.pubkey ? getDisplayName(mine.metadata, mine.pubkey) : intl.formatMessage({ id: "giftPage.you", defaultMessage: "You" });
  const shown: Look = alreadyUltra && mine.ultra ? mine.ultra : look;

  return (
    <>
      {burst > 0 && <Confetti key={burst} />}

      <div className="flex items-center gap-2.5 rounded-full bg-background/60 py-1.5 pl-1.5 pr-4 shadow-lg backdrop-blur-md">
        <span className="rounded-full" style={gifterFrame}>
          <Avatar shape={getAvatarShape(gifterMeta)} className="size-8">
            <AvatarImage src={gifterMeta?.picture} imeta={author.data?.imeta?.picture} alt={gifterName} />
            <AvatarFallback className="bg-primary/20 text-primary text-xs">
              <AvatarInitial name={gifterName} pubkey={gifter} />
            </AvatarFallback>
          </Avatar>
        </span>
        <span className="text-sm font-medium">
          {ownGift
            ? <FormattedMessage id="giftPage.ownChip" defaultMessage="Your gift" />
            : <FormattedMessage id="giftPage.chip" defaultMessage="{name} sent you a gift" values={{ name: <span className="font-bold">{gifterName}</span> }} />}
        </span>
      </div>

      <button
        type="button"
        disabled={stage !== "wrapped" || ownGift}
        onClick={openGift}
        aria-label={intl.formatMessage({ id: "giftPage.open", defaultMessage: "Open your gift" })}
        className={cn(
          "my-8 rounded-full transition-[margin] duration-700 enabled:cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          opened && "my-4",
        )}
      >
        <GiftBox
          open={opened}
          shaking={stage === "shaking"}
          className={cn("transition-[width,height] duration-700", opened ? "size-28 md:size-32" : "size-56 md:size-72")}
        />
      </button>

      {!opened ? (
        <div className="flex w-full flex-col items-center gap-5">
          <h1 className="text-4xl font-black tracking-tight md:text-5xl">
            {ownGift
              ? <FormattedMessage id="giftPage.ownTitle" defaultMessage="This is what they’ll see" />
              : <FormattedMessage id="giftPage.wrappedTitle" defaultMessage="You’ve got a gift!" />}
          </h1>
          {ownGift ? (
            <GiftUltraButton className="h-14 w-full max-w-xs text-base clip-corner-lg">
              <FormattedMessage id="giftPage.sendIt" defaultMessage="Send it to someone" />
            </GiftUltraButton>
          ) : (
            <Button size="lg" className={cn(GRADIENT_CTA, "h-14 w-full max-w-xs text-base clip-corner-lg")} onClick={openGift} disabled={stage !== "wrapped"}>
              <Gift className="size-5 mr-2" />
              <FormattedMessage id="giftPage.open" defaultMessage="Open your gift" />
            </Button>
          )}
        </div>
      ) : (
        <div className="flex w-full flex-col items-center gap-6 motion-safe:animate-gift-reveal">
          <div className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-foreground/70">
              {claimed
                ? <FormattedMessage id="giftPage.kickerClaimed" defaultMessage="You’re officially" />
                : <FormattedMessage id="giftPage.kicker" defaultMessage="{name} gifted you" values={{ name: gifterName }} />}
            </p>
            <h1
              className={cn("pb-1 text-5xl font-black tracking-tight drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)] md:text-7xl", ULTRA_NAME_CLASS)}
              style={nameStyleCss("aurora")}
            >
              Armada Ultra
            </h1>
            <p className="text-base text-foreground/80">
              {claimed ? (
                <FormattedMessage id="giftPage.subClaimed" defaultMessage="Everyone sees it now. Don’t forget to say thanks." />
              ) : alreadyUltra ? (
                <FormattedMessage id="giftPage.subAlready" defaultMessage="You’re already Ultra, so pass this one on." />
              ) : (
                <FormattedMessage id="giftPage.subChoose" defaultMessage="Pick your look. Everyone on Armada will see it." />
              )}
            </p>
          </div>

          <ProfilePreview
            name={selfName}
            metadata={mine.metadata}
            imeta={mine.imeta}
            photoUrl={photo?.url}
            look={shown}
            onPhoto={choosing ? (file) => setPhoto((prev) => {
              if (prev) URL.revokeObjectURL(prev.url);
              return { file, url: URL.createObjectURL(file) };
            }) : undefined}
          />

          {choosing && <LookPicker look={look} onChange={setLook} />}

          <div className="flex w-full max-w-sm flex-col gap-2">
            {choosing ? (
              user ? (
                <Button size="lg" className={cn(GRADIENT_CTA, "h-14 text-base clip-corner-lg")} onClick={() => void claim()} disabled={claiming || mine.isLoading}>
                  {claiming
                    ? <><Loader2 className="size-5 mr-2 animate-spin" /><FormattedMessage id="giftPage.claiming" defaultMessage="Claiming…" /></>
                    : <><Gem className="size-5 mr-2" /><FormattedMessage id="giftPage.claim" defaultMessage="Claim my Ultra" /></>}
                </Button>
              ) : (
                <JoinButton size="lg" className={cn(GRADIENT_CTA, "h-14 text-base clip-corner-lg")}>
                  <Gem className="size-5 mr-2" />
                  <FormattedMessage id="giftPage.joinToClaim" defaultMessage="Join Armada to claim" />
                </JoinButton>
              )
            ) : (
              <>
                <Button size="lg" className={cn(GRADIENT_CTA, "h-14 text-base clip-corner-lg")} onClick={() => thank(gifter)}>
                  <MessageSquare className="size-5 mr-2" />
                  <FormattedMessage id="giftPage.thank" defaultMessage="Thank {name}" values={{ name: gifterName }} />
                </Button>
                <GiftUltraButton className="h-12 bg-none bg-secondary/80 text-foreground shadow-none clip-corner-lg backdrop-blur hover:bg-secondary">
                  <FormattedMessage id="giftPage.passItOn" defaultMessage="Pass it on" />
                </GiftUltraButton>
                {claimed && (
                  <Button variant="ghost" onClick={() => navigate("/")}>
                    <FormattedMessage id="giftPage.done" defaultMessage="Done" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The recipient as everyone will see them, with the chosen look playing live. */
function ProfilePreview({ name, metadata, imeta, photoUrl, look, onPhoto }: {
  name: string;
  metadata?: NostrMetadata;
  imeta?: ReturnType<typeof useMyUltra>["imeta"];
  photoUrl?: string;
  look: Look;
  onPhoto?: (file: File) => void;
}) {
  const intl = useIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  useEffect(() => () => { if (cropSrc) URL.revokeObjectURL(cropSrc); }, [cropSrc]);
  const hasPicture = !!photoUrl || !!metadata?.picture;
  const frame = frameCss(look.frame);

  const chosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !onPhoto) return;
    // Animated images would be flattened by the crop canvas; keep them as-is.
    const head = new Uint8Array(await file.slice(0, METADATA_SCAN_BYTES).arrayBuffer());
    if (!isGifBytes(head) && isAnimatedImage(file.type, head)) {
      onPhoto(file);
      return;
    }
    setCropSrc(URL.createObjectURL(file));
  };

  const avatar: ReactNode = photoUrl ? (
    <img src={photoUrl} alt={name} className="size-full rounded-full object-cover" />
  ) : hasPicture ? (
    <Avatar shape={getAvatarShape(metadata)} className="size-full">
      <AvatarImage src={metadata?.picture} imeta={imeta?.picture} alt={name} />
      <AvatarFallback><AvatarInitial name={name} /></AvatarFallback>
    </Avatar>
  ) : (
    <span className="flex size-full flex-col items-center justify-center gap-0.5 rounded-full bg-gradient-to-br from-primary/80 to-accent2/80 text-white">
      <Camera className="size-7" />
      <span className="text-[0.65rem] font-semibold uppercase tracking-wide">
        <FormattedMessage id="giftPage.addPhoto" defaultMessage="Add photo" />
      </span>
    </span>
  );

  return (
    <div className="relative w-full max-w-sm overflow-hidden clip-corner-lg bg-background/85 text-left shadow-2xl shadow-primary/20 backdrop-blur-md">
      <div className="h-24 bg-gradient-to-r from-primary via-fuchsia-500 to-accent2">
        <div className="size-full bg-[radial-gradient(circle_at_20%_120%,rgba(255,255,255,0.35),transparent_55%)]" />
      </div>
      <div className="px-5 pb-5">
        <div className="-mt-12 mb-3 flex items-end justify-between">
          <span className="relative block size-24 rounded-full ring-4 ring-background" style={frame}>
            {onPhoto ? (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                aria-label={intl.formatMessage({ id: "giftPage.choosePhoto", defaultMessage: "Choose your photo" })}
                className="group block size-full rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {avatar}
                {hasPicture && (
                  <span className="absolute bottom-0 right-0 flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md ring-2 ring-background transition-transform group-hover:scale-110">
                    <Camera className="size-4" />
                  </span>
                )}
              </button>
            ) : avatar}
          </span>
          <UltraPill force interactive={false} className="mb-1" />
        </div>
        <UltraName name={name} style={look.name} className="block text-2xl font-black" />
        <p className="mt-1 text-sm text-foreground/80">
          <FormattedMessage id="ultraIllustrations.message" defaultMessage="gm everyone, I'm Ultra now ✨" />
        </p>
      </div>
      <UltraEffect key={look.effect} effect={look.effect} loop />
      {onPhoto && <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void chosen(e)} />}
      {cropSrc && (
        <ImageCropDialog
          open
          imageSrc={cropSrc}
          aspect={1}
          onCancel={() => setCropSrc(null)}
          onCrop={(blob) => {
            setCropSrc(null);
            const ext = blob.type === "image/png" ? "png" : "jpg";
            onPhoto?.(new File([blob], `picture.${ext}`, { type: blob.type || "image/jpeg" }));
          }}
        />
      )}
    </div>
  );
}

function presetLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function LookPicker({ look, onChange }: { look: Look; onChange: (look: Look) => void }) {
  const intl = useIntl();
  const set = (patch: Partial<Look>) => onChange({ ...look, ...patch });

  return (
    <div className="w-full max-w-sm space-y-4 clip-corner-lg bg-background/70 p-4 text-left shadow-xl backdrop-blur-md">
      <PickerRow label={intl.formatMessage({ id: "giftPage.pickName", defaultMessage: "Name" })}>
        <div className="grid grid-cols-5 gap-2">
          {(Object.keys(NAME_STYLES) as NameStyleId[]).map((id) => (
            <OptionTile key={id} active={look.name === id} label={presetLabel(id)} onClick={() => set({ name: id })}>
              <span className={cn("text-2xl font-black", ULTRA_NAME_CLASS)} style={nameStyleCss(id)}>Aa</span>
            </OptionTile>
          ))}
        </div>
      </PickerRow>
      <PickerRow label={intl.formatMessage({ id: "giftPage.pickFrame", defaultMessage: "Glow" })}>
        <div className="grid grid-cols-5 gap-2">
          {(Object.keys(AVATAR_FRAMES) as AvatarFrameId[]).map((id) => (
            <OptionTile key={id} active={look.frame === id} label={presetLabel(id)} onClick={() => set({ frame: id })}>
              <span
                className="size-8 rounded-full bg-foreground/15"
                style={{ boxShadow: `0 0 0 2px ${AVATAR_FRAMES[id]}, 0 0 12px 2px ${AVATAR_FRAMES[id]}` }}
              />
            </OptionTile>
          ))}
        </div>
      </PickerRow>
      <PickerRow label={intl.formatMessage({ id: "giftPage.pickEffect", defaultMessage: "Effect" })}>
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(PROFILE_EFFECTS) as ProfileEffectId[]).map((id) => (
            <OptionTile key={id} active={look.effect === id} label={presetLabel(id)} onClick={() => set({ effect: id })}>
              <span className="text-2xl leading-none font-emoji">{PROFILE_EFFECTS[id]}</span>
            </OptionTile>
          ))}
        </div>
      </PickerRow>
    </div>
  );
}

function PickerRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

export default GiftPage;
