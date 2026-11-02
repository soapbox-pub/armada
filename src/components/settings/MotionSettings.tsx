import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { useIntl } from "@/i18n";
import {
  setHideFlairSetting,
  setReduceBlurSetting,
  setReduceMotionSetting,
  setStillMediaSetting,
  useEffectSettings,
} from "@/lib/reducedMotion";

export function MotionSettings() {
  const intl = useIntl();
  const { motion, system, media, blur, flair } = useEffectSettings();

  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "motionSettings.label", defaultMessage: "Reduce motion" })}
        description={
          system
            ? intl.formatMessage({
                id: "motionSettings.systemDescription",
                defaultMessage: "Your device is set to reduce motion, so this stays on. Animations, transitions and smooth scrolling are off.",
              })
            : intl.formatMessage({
                id: "motionSettings.description",
                defaultMessage: "Turns off animations, transitions and smooth scrolling. Also lighter on older devices.",
              })
        }
      >
        <Switch checked={motion || system} disabled={system} onCheckedChange={setReduceMotionSetting} />
      </SettingsRow>
      <SettingsRow
        label={intl.formatMessage({ id: "motionSettings.media", defaultMessage: "Pause animated images" })}
        description={intl.formatMessage({
          id: "motionSettings.mediaDescription",
          defaultMessage: "Animated avatars, emoji and images show as stills, and GIFs play only when you hover over or tap them. Follows Reduce motion unless you change it.",
        })}
      >
        <Switch checked={media} onCheckedChange={setStillMediaSetting} />
      </SettingsRow>
      <SettingsRow
        label={intl.formatMessage({ id: "motionSettings.blur", defaultMessage: "Reduce blur" })}
        description={intl.formatMessage({
          id: "motionSettings.blurDescription",
          defaultMessage: "Turns off the blur behind menus, dialogs and panels, which is costly on older graphics. Follows Reduce motion unless you change it.",
        })}
      >
        <Switch checked={blur} onCheckedChange={setReduceBlurSetting} />
      </SettingsRow>
      <SettingsRow
        label={intl.formatMessage({ id: "motionSettings.flair", defaultMessage: "Hide Ultra flair" })}
        description={intl.formatMessage({
          id: "motionSettings.flairDescription",
          defaultMessage: "Hides the glowing halos around Ultra members' avatars and their profile effects.",
        })}
      >
        <Switch checked={flair} onCheckedChange={setHideFlairSetting} />
      </SettingsRow>
    </>
  );
}
