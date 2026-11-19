import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useIntl } from "@/i18n";

/** Whether Armada Ultra is drawn for anyone: badges, name styles, halos, effects and gift cards. Synced. */
export function UltraVisibilitySettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "ultraVisibility.label", defaultMessage: "Show Armada Ultra" })}
      description={intl.formatMessage({
        id: "ultraVisibility.description",
        defaultMessage: "Ultra badges, name styles, avatar halos, profile effects and gifts. When off, everyone looks the same.",
      })}
    >
      <Switch
        checked={config.showUltra}
        onCheckedChange={(showUltra) => updateConfig((current) => ({ ...current, showUltra }))}
      />
    </SettingsRow>
  );
}
