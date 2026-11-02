import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { defineMessage, useIntl, type MessageDescriptor } from "@/i18n";
import { setEffectPart, setReduceEffects, useEffectSettings, type EffectPart } from "@/lib/reducedMotion";

const PARTS: Array<{ part: EffectPart; label: MessageDescriptor }> = [
  { part: "motion", label: defineMessage({ id: "motionSettings.motion", defaultMessage: "Stop animations" }) },
  { part: "media", label: defineMessage({ id: "motionSettings.media", defaultMessage: "Pause GIFs and animated images" }) },
  { part: "blur", label: defineMessage({ id: "motionSettings.blur", defaultMessage: "Remove blur" }) },
  { part: "flair", label: defineMessage({ id: "motionSettings.flair", defaultMessage: "Hide Ultra halos and effects" }) },
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
        PARTS.map(({ part, label }) => (
          <SettingsRow key={part} label={intl.formatMessage(label)} className="pl-8">
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
