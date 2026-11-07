import { Bitcoin, Check, Gem, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Confetti } from "@/components/Confetti";
import { GenericPaymentContent } from "@/components/GenericPaymentContent";
import { GiftStage } from "@/components/gift/GiftStage";
import { GiftUltraButton } from "@/components/gift/GiftUltraButton";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import {
  EffectIllustration,
  FramesIllustration,
  NameStylesIllustration,
  ThemesIllustration,
  ThemeWindow,
  UltraAvatar,
  UltraMessage,
  UltraName,
  type UltraSelf,
} from "@/components/settings/UltraIllustrations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useTheme } from "@/hooks/useTheme";
import { toast } from "@/hooks/useToast";
import { useMyUltra, usePublishUltra } from "@/hooks/useUltra";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { playFanfare } from "@/lib/fanfare";
import { getDisplayName } from "@/lib/getDisplayName";
import { PAYMENT_METHODS, type PaymentMethodDef, type PaymentTarget } from "@/lib/paymentTargets";
import {
  AVATAR_FRAMES,
  DONATION_BITCOIN,
  DONATION_MONERO,
  NAME_STYLES,
  nameStyleCss,
  PROFILE_EFFECTS,
  ULTRA_DEFAULTS,
  ULTRA_NAME_CLASS,
  ULTRA_THEMES,
  type AvatarFrameId,
  type NameStyleId,
  type ProfileEffectId,
  type UltraProfile,
} from "@/lib/ultra";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

const HERO_TITLE_STYLE = nameStyleCss("aurora");

/** The least time the $0.00 "payment" pretends to take. */
const PROCESSING_MS = 1600;

type Step = "pitch" | "checkout" | "processing";

/** Settings › Armada Ultra: a free "subscription" whose perks everyone can see. */
export function UltraSettings() {
  const intl = useIntl();
  const { pubkey, metadata, imeta, ultra } = useMyUltra();
  const { publish } = usePublishUltra();
  const [step, setStep] = useState<Step>("pitch");
  const [celebration, setCelebration] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const self: UltraSelf = {
    name: pubkey ? getDisplayName(metadata, pubkey) : intl.formatMessage({ id: "ultraSettings.you", defaultMessage: "You" }),
    metadata,
    imeta,
  };

  const failed = (error: unknown) => toast({
    title: intl.formatMessage(common.error),
    description: error instanceof Error ? error.message : String(error),
    variant: "destructive",
  });

  const pay = async () => {
    setStep("processing");
    // Made inside the click, or the autoplay policy keeps it suspended.
    let audio: AudioContext | undefined;
    try {
      audio = new AudioContext();
    } catch { /* no Web Audio: confetti only */ }
    try {
      await Promise.all([
        publish({ since: Math.floor(Date.now() / 1000), ...ULTRA_DEFAULTS }),
        new Promise((resolve) => setTimeout(resolve, PROCESSING_MS)),
      ]);
    } catch (error) {
      void audio?.close().catch(() => {});
      if (mounted.current) setStep("checkout");
      failed(error);
      return;
    }
    if (audio) playFanfare(audio);
    if (!mounted.current) return;
    setCelebration((n) => n + 1);
    setStep("pitch");
  };

  const cancel = async () => {
    try {
      await publish(undefined);
    } catch (error) {
      failed(error);
      return;
    }
    toast({
      title: intl.formatMessage({ id: "ultraSettings.cancelledTitle", defaultMessage: "Ultra cancelled" }),
      description: intl.formatMessage(
        { id: "ultraSettings.cancelledDescription", defaultMessage: "A refund of {amount} is on its way." },
        { amount: intl.formatNumber(0, { style: "currency", currency: "USD" }) },
      ),
    });
  };

  return (
    <>
      {celebration > 0 && <Confetti key={celebration} />}
      {ultra && step !== "processing" ? (
        <UltraActive self={self} ultra={ultra} celebrating={celebration > 0} onSave={publish} onCancel={cancel} onError={failed} />
      ) : step === "pitch" ? (
        <UltraPitch self={self} onContinue={() => setStep("checkout")} />
      ) : (
        <UltraCheckout processing={step === "processing"} onPay={() => void pay()} onBack={() => setStep("pitch")} />
      )}
      <DonationFooter />
    </>
  );
}

export function UltraHero({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-hidden clip-corner-lg px-6 py-8 text-center">
      <GiftStage />
      <div className="relative space-y-3">{children}</div>
    </div>
  );
}

function HeroGem() {
  return (
    <span className="mx-auto flex size-16 items-center justify-center clip-corner-lg bg-gradient-to-br from-primary to-accent2 text-primary-foreground shadow-lg">
      <Gem className="size-8" />
    </span>
  );
}

/** One perk: a live mock-up on top, what it is underneath. */
function FeatureCard({ art, title, body, wide }: { art: ReactNode; title: string; body: string; wide?: boolean }) {
  return (
    <div className={cn("overflow-hidden clip-corner-lg bg-chrome", wide && "sm:col-span-2")}>
      <div className="relative flex h-36 items-center justify-center overflow-hidden bg-gradient-to-br from-primary/15 via-transparent to-accent2/15 px-4">
        {art}
      </div>
      <div className="space-y-0.5 px-4 py-3">
        <h4 className="text-sm font-semibold">{title}</h4>
        <p className="text-xs leading-snug text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function UltraPitch({ self, onContinue }: { self: UltraSelf; onContinue: () => void }) {
  const intl = useIntl();
  const extras = [
    intl.formatMessage({ id: "ultraSettings.perk.encryption", defaultMessage: "End-to-end encryption (you already had it)" }),
    intl.formatMessage({ id: "ultraSettings.perk.ads", defaultMessage: "Zero ads (there never were any)" }),
    intl.formatMessage({ id: "ultraSettings.perk.data", defaultMessage: "We still don't sell your data. We don't even have it." }),
    intl.formatMessage({ id: "ultraSettings.perk.uploads", defaultMessage: "Bigger uploads, as big as your Blossom server allows" }),
    intl.formatMessage({ id: "ultraSettings.perk.feeling", defaultMessage: "A warm, premium feeling" }),
  ];

  return (
    <>
      <UltraHero>
        <HeroGem />
        <h3 className={cn("text-4xl font-black tracking-tight drop-shadow-[0_0_20px_hsl(var(--primary)/0.45)]", ULTRA_NAME_CLASS)} style={HERO_TITLE_STYLE}>Armada Ultra</h3>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="ultraSettings.tagline" defaultMessage="Everything Armada already does, plus some shiny extras, for the low price of nothing." />
        </p>
        <GiftUltraButton size="default" className="mt-1" />
      </UltraHero>

      <section className="space-y-1.5">
        <h3 className="px-4 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="ultraSettings.perksTitle" defaultMessage="What you get" />
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <FeatureCard
            wide
            art={<UltraMessage self={self} name="aurora" frame="glow" />}
            title={intl.formatMessage({ id: "ultraSettings.feature.badge", defaultMessage: "The Ultra badge" })}
            body={intl.formatMessage({ id: "ultraSettings.feature.badgeBody", defaultMessage: "Shown next to your name to everyone on Armada, so they know you paid $0.00 for it." })}
          />
          <FeatureCard
            art={<NameStylesIllustration self={self} />}
            title={intl.formatMessage({ id: "ultraSettings.feature.names", defaultMessage: "Name styles" })}
            body={intl.formatMessage({ id: "ultraSettings.feature.namesBody", defaultMessage: "A shimmering gradient on your name in chats and member lists." })}
          />
          <FeatureCard
            art={<FramesIllustration self={self} />}
            title={intl.formatMessage({ id: "ultraSettings.feature.frames", defaultMessage: "Avatar frames" })}
            body={intl.formatMessage({ id: "ultraSettings.feature.framesBody", defaultMessage: "A glow around your picture, wherever it shows up." })}
          />
          <FeatureCard
            art={<EffectIllustration self={self} effect="sparkles" frame="gold" name="gold" />}
            title={intl.formatMessage({ id: "ultraSettings.feature.effects", defaultMessage: "Profile effects" })}
            body={intl.formatMessage({ id: "ultraSettings.feature.effectsBody", defaultMessage: "Sparkles, hearts or stars burst out when someone opens your profile." })}
          />
          <FeatureCard
            art={<ThemesIllustration />}
            title={intl.formatMessage({ id: "ultraSettings.feature.themes", defaultMessage: "Ultra themes" })}
            body={intl.formatMessage({ id: "ultraSettings.feature.themesBody", defaultMessage: "Exclusive color themes for the whole app." })}
          />
        </div>
      </section>

      <SettingsGroup title={intl.formatMessage({ id: "ultraSettings.extrasTitle", defaultMessage: "Also included" })}>
        {extras.map((extra) => (
          <SettingsRow key={extra}>
            <span className="flex items-center gap-3 text-sm text-muted-foreground">
              <Check className="size-4 shrink-0 text-success" />
              {extra}
            </span>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <div className="space-y-2">
        <Button className="w-full" size="lg" onClick={onContinue}>
          <Gem className="size-4 mr-2" />
          <FormattedMessage id="ultraSettings.getUltra" defaultMessage="Get Ultra for $0.00/month" />
        </Button>
        <p className="px-4 text-center text-xs text-muted-foreground">
          <FormattedMessage id="ultraSettings.noTrial" defaultMessage="No free trial, because it's free forever." />
        </p>
      </div>
    </>
  );
}

function UltraCheckout({ processing, onPay, onBack }: { processing: boolean; onPay: () => void; onBack: () => void }) {
  const intl = useIntl();
  const zero = intl.formatNumber(0, { style: "currency", currency: "USD" });
  const line = (label: string, value: string, strong?: boolean) => (
    <SettingsRow label={<span className={strong ? "font-semibold" : undefined}>{label}</span>} value={<span className={strong ? "font-semibold text-foreground" : undefined}>{value}</span>} />
  );

  return (
    <>
      <SettingsGroup
        title={intl.formatMessage({ id: "ultraSettings.orderTitle", defaultMessage: "Your order" })}
        footer={intl.formatMessage({ id: "ultraSettings.orderFooter", defaultMessage: "Cancel anytime. You'll get every cent back." })}
      >
        {line(intl.formatMessage({ id: "ultraSettings.orderItem", defaultMessage: "Armada Ultra, forever" }), zero)}
        {line(intl.formatMessage({ id: "ultraSettings.orderFees", defaultMessage: "Hidden fees" }), intl.formatMessage({ id: "ultraSettings.orderFeesValue", defaultMessage: "None, we checked" }))}
        {line(intl.formatMessage({ id: "ultraSettings.orderPayment", defaultMessage: "Payment method" }), intl.formatMessage({ id: "ultraSettings.orderPaymentValue", defaultMessage: "Not needed" }))}
        {line(intl.formatMessage({ id: "ultraSettings.orderTotal", defaultMessage: "Total" }), zero, true)}
      </SettingsGroup>
      <div className="space-y-2">
        <Button className="w-full" size="lg" onClick={onPay} disabled={processing}>
          {processing ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              <FormattedMessage id="ultraSettings.processing" defaultMessage="Processing your payment of {amount}…" values={{ amount: zero }} />
            </>
          ) : (
            <FormattedMessage id="ultraSettings.pay" defaultMessage="Pay {amount}" values={{ amount: zero }} />
          )}
        </Button>
        {!processing && (
          <Button variant="ghost" className="w-full" onClick={onBack}>
            <FormattedMessage id="ultraSettings.reconsider" defaultMessage="Let me think about it" />
          </Button>
        )}
        <p className="px-4 text-center text-xs text-muted-foreground">
          <FormattedMessage id="ultraSettings.publicNote" defaultMessage="Ultra is saved to your public profile, so others can see your badge and styles." />
        </p>
      </div>
    </>
  );
}

/** A picker tile; the art is the option drawn as it will look. */
export function OptionTile({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 clip-corner-lg px-2 py-2.5 text-xs transition-colors",
        active ? "bg-primary/20 text-foreground" : "bg-secondary/60 text-muted-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}

/** Preset ids double as their names, like the theme presets' labels. */
function presetLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

const PICKER_GRID = "grid grid-cols-3 gap-2 p-3 sm:grid-cols-6";

function UltraActive({ self, ultra, celebrating, onSave, onCancel, onError }: {
  self: UltraSelf;
  ultra: UltraProfile;
  celebrating: boolean;
  onSave: (ultra: UltraProfile) => Promise<void>;
  onCancel: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const intl = useIntl();
  const { theme, customTheme, applyCustomTheme } = useTheme();
  const [draft, setDraft] = useState(ultra);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const dirty = draft.name !== ultra.name || draft.frame !== ultra.frame || draft.effect !== ultra.effect;
  const none = intl.formatMessage({ id: "ultraSettings.none", defaultMessage: "None" });
  const date = ultra.since
    ? new Date(ultra.since * 1000).toLocaleDateString(intl.locale, { dateStyle: "long" })
    : undefined;

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ ...draft, since: ultra.since });
      toast({ title: intl.formatMessage({ id: "ultraSettings.saved", defaultMessage: "Looking fabulous" }) });
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<UltraProfile>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <>
      <UltraHero>
        <h3 className={cn("text-4xl font-black tracking-tight drop-shadow-[0_0_20px_hsl(var(--primary)/0.45)]", ULTRA_NAME_CLASS)} style={HERO_TITLE_STYLE}>
          {celebrating
            ? <FormattedMessage id="ultraSettings.welcome" defaultMessage="Welcome to Ultra!" />
            : <FormattedMessage id="ultraSettings.activeTitle" defaultMessage="You're Ultra" />}
        </h3>
        <div className="relative mx-auto flex w-fit items-center justify-center gap-4 rounded-lg bg-background/60 px-4 py-3 backdrop-blur">
          <UltraMessage self={self} name={draft.name} frame={draft.frame}>
            <FormattedMessage id="ultraSettings.previewMessage" defaultMessage="This is how everyone sees you." />
          </UltraMessage>
        </div>
        <GiftUltraButton size="default" />
      </UltraHero>

      <SettingsGroup title={intl.formatMessage({ id: "ultraSettings.nameStyle", defaultMessage: "Name style" })}>
        <div className={PICKER_GRID}>
          <OptionTile active={!draft.name} label={none} onClick={() => set({ name: undefined })}>
            <UltraName name={self.name} style={undefined} className="max-w-full text-sm" />
          </OptionTile>
          {(Object.keys(NAME_STYLES) as NameStyleId[]).map((id) => (
            <OptionTile key={id} active={draft.name === id} label={presetLabel(id)} onClick={() => set({ name: id })}>
              <UltraName name={self.name} style={id} className="max-w-full text-sm" />
            </OptionTile>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={intl.formatMessage({ id: "ultraSettings.avatarFrame", defaultMessage: "Avatar frame" })}>
        <div className={PICKER_GRID}>
          <OptionTile active={!draft.frame} label={none} onClick={() => set({ frame: undefined })}>
            <UltraAvatar self={self} frame={undefined} className="size-9" />
          </OptionTile>
          {(Object.keys(AVATAR_FRAMES) as AvatarFrameId[]).map((id) => (
            <OptionTile key={id} active={draft.frame === id} label={presetLabel(id)} onClick={() => set({ frame: id })}>
              <UltraAvatar self={self} frame={id} className="size-9" />
            </OptionTile>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={intl.formatMessage({ id: "ultraSettings.profileEffect", defaultMessage: "Profile effect" })}
        footer={intl.formatMessage({ id: "ultraSettings.profileEffectFooter", defaultMessage: "Plays when someone opens your profile." })}
      >
        <div className="flex flex-col items-center gap-3 p-3 sm:flex-row sm:items-stretch">
          {draft.effect && (
            <div className="flex shrink-0 items-center justify-center">
              <EffectIllustration key={draft.effect} self={self} effect={draft.effect} frame={draft.frame} name={draft.name} />
            </div>
          )}
          <div className="grid w-full grid-cols-3 gap-2 sm:grid-cols-5">
            <OptionTile active={!draft.effect} label={none} onClick={() => set({ effect: undefined })}>
              <span className="text-lg leading-none">∅</span>
            </OptionTile>
            {(Object.keys(PROFILE_EFFECTS) as ProfileEffectId[]).map((id) => (
              <OptionTile key={id} active={draft.effect === id} label={presetLabel(id)} onClick={() => set({ effect: id })}>
                <span className="text-xl leading-none font-emoji">{PROFILE_EFFECTS[id]}</span>
              </OptionTile>
            ))}
          </div>
        </div>
      </SettingsGroup>

      {dirty && (
        <div className="sticky bottom-3 z-10 flex gap-2">
          <Button className="flex-1" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
            <FormattedMessage id="ultraSettings.saveStyle" defaultMessage="Save my look" />
          </Button>
          <Button variant="secondary" onClick={() => setDraft(ultra)} disabled={saving}>
            <FormattedMessage id="ultraSettings.reset" defaultMessage="Reset" />
          </Button>
        </div>
      )}

      <SettingsGroup
        title={intl.formatMessage({ id: "ultraSettings.themesTitle", defaultMessage: "Ultra themes" })}
        footer={intl.formatMessage({ id: "ultraSettings.themesFooter", defaultMessage: "Themes change only this device." })}
      >
        <div className="grid grid-cols-3 gap-2 p-3">
          {Object.entries(ULTRA_THEMES).map(([id, preset]) => (
            <OptionTile
              key={id}
              active={theme === "custom" && JSON.stringify(customTheme?.colors) === JSON.stringify(preset.colors)}
              label={preset.label}
              onClick={() => applyCustomTheme({ title: preset.label, colors: preset.colors })}
            >
              <ThemeWindow colors={preset.colors} className="h-12 w-full" />
              <span><span className="font-emoji">{preset.emoji}</span> {preset.label}</span>
            </OptionTile>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={intl.formatMessage({ id: "ultraSettings.membershipTitle", defaultMessage: "Membership" })}>
        <SettingsRow
          icon={Gem}
          tone="accent2"
          label={intl.formatMessage({ id: "ultraSettings.status", defaultMessage: "Ultra is active" })}
          description={date && intl.formatMessage({ id: "ultraSettings.since", defaultMessage: "Since {date}" }, { date })}
        />
        <SettingsRow
          label={intl.formatMessage({ id: "ultraSettings.cancel", defaultMessage: "Cancel Ultra" })}
          destructive
          onClick={cancelling ? undefined : () => {
            setCancelling(true);
            void onCancel().finally(() => setCancelling(false));
          }}
        />
      </SettingsGroup>
    </>
  );
}

type Coin = "bitcoin" | "monero";

const DONATION_METHODS: Record<Coin, { method: PaymentMethodDef; target: PaymentTarget }> = {
  bitcoin: {
    // The zap dialog draws Bitcoin itself, so its def has no URI; a donation wants the button.
    method: { ...PAYMENT_METHODS.bitcoin, uri: (a) => `bitcoin:${a}` },
    target: { type: "bitcoin", authority: DONATION_BITCOIN },
  },
  monero: {
    method: PAYMENT_METHODS.monero,
    target: { type: "monero", authority: DONATION_MONERO },
  },
};

function MoneroIcon({ className }: { className?: string }) {
  return <span aria-hidden className={className}>{PAYMENT_METHODS.monero.symbol}</span>;
}

/** One quiet line at the bottom; the addresses wait behind a link. */
function DonationFooter() {
  const [open, setOpen] = useState(false);
  const [coin, setCoin] = useState<Coin>("bitcoin");
  const donation = DONATION_METHODS[coin];

  return (
    <>
      <p className="px-4 pt-4 text-center text-xs text-muted-foreground/70">
        <FormattedMessage
          id="ultraSettings.donateLine"
          defaultMessage="Armada is free and runs on donations. <link>Chip in</link> if you like."
          values={{
            link: (chunks: ReactNode) => (
              <button type="button" onClick={() => setOpen(true)} className="underline underline-offset-2 hover:text-foreground">
                {chunks}
              </button>
            ),
          }}
        />
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <FormattedMessage id="ultraSettings.donateTitle" defaultMessage="Support Armada" />
            </DialogTitle>
            <DialogDescription>
              <FormattedMessage id="ultraSettings.donateBody" defaultMessage="Totally optional. Ultra stays free either way." />
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center">
            <PillTabs<Coin>
              labels="always"
              value={coin}
              onChange={setCoin}
              tabs={[
                { id: "bitcoin", label: PAYMENT_METHODS.bitcoin.label, icon: Bitcoin },
                { id: "monero", label: PAYMENT_METHODS.monero.label, icon: MoneroIcon },
              ]}
            />
          </div>
          <GenericPaymentContent key={coin} method={donation.method} target={donation.target} />
        </DialogContent>
      </Dialog>
    </>
  );
}
