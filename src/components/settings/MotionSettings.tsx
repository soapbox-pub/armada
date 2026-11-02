import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { useIntl } from "@/i18n";
import { setReduceMotionSetting, useReduceMotionSetting } from "@/lib/reducedMotion";

export function MotionSettings() {
  const intl = useIntl();
  const { setting, system } = useReduceMotionSetting();

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "motionSettings.label", defaultMessage: "Reduce motion" })}
      description={
        system
          ? intl.formatMessage({
              id: "motionSettings.systemDescription",
              defaultMessage: "Your device is set to reduce motion, so this stays on. Animations and effects are stopped, animated avatars, emoji and images show as stills, and GIFs play only when you hover over or tap them.",
            })
          : intl.formatMessage({
              id: "motionSettings.description",
              defaultMessage: "Stops animations and effects, shows animated avatars, emoji and images as stills, and plays GIFs only when you hover over or tap them. Also lighter on older devices.",
            })
      }
    >
      <Switch checked={setting || system} disabled={system} onCheckedChange={setReduceMotionSetting} />
    </SettingsRow>
  );
}
