import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { defineMessage, useIntl, type MessageDescriptor } from "@/i18n";
import { setEffectPart, setReduceEffects, useEffectSettings, type EffectPart } from "@/lib/reducedMotion";

const PARTS: Array<{ part: EffectPart; label: MessageDescriptor; hint: MessageDescriptor }> = [
  {
    part: "motion",
    label: defineMessage({ id: "motionSettings.motion", defaultMessage: "Stop animations" }),
    hint: defineMessage({ id: "motionSettings.motionHint", defaultMessage: "Transitions, spinners and smooth scrolling." }),
  },
  {
    part: "media",
    label: defineMessage({ id: "motionSettings.media", defaultMessage: "Pause GIFs and animated images" }),
    hint: defineMessage({ id: "motionSettings.mediaHint", defaultMessage: "They play when you hover over or tap them." }),
  },
  {
    part: "blur",
    label: defineMessage({ id: "motionSettings.blur", defaultMessage: "Remove blur" }),
    hint: defineMessage({ id: "motionSettings.blurHint", defaultMessage: "Behind menus and dialogs. Easier on older graphics." }),
  },
  {
    part: "flair",
    label: defineMessage({ id: "motionSettings.flair", defaultMessage: "Hide Ultra halos and effects" }),
    hint: defineMessage({ id: "motionSettings.flairHint", defaultMessage: "Glowing avatar rings and profile particles." }),
  },
];

export function MotionSettings() {
  const intl = useIntl();
  const settings = useEffectSettings();

  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "motionSettings.label", defaultMessage: "Reduce effects" })}
        description={
          settings.system
            ? intl.formatMessage({ id: "motionSettings.system", defaultMessage: "On because your device reduces motion." })
            : intl.formatMessage({ id: "motionSettings.description", defaultMessage: "A calmer, lighter app on this device." })
        }
      >
        <Switch checked={settings.enabled} disabled={settings.system} onCheckedChange={setReduceEffects} />
      </SettingsRow>
      {settings.enabled &&
        PARTS.map(({ part, label, hint }) => (
          <SettingsRow key={part} label={intl.formatMessage(label)} description={intl.formatMessage(hint)} className="pl-8">
            <Switch
              checked={settings[part]}
              // The OS setting always stops animations.
              disabled={part === "motion" && settings.system}
              onCheckedChange={(on) => setEffectPart(part, on)}
            />
          </SettingsRow>
        ))}
    </>
  );
}
