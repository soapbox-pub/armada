import { ColorPicker } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormattedMessage, useIntl } from "@/i18n";
import { hexToHslString, hslStringToHex } from "@/lib/colorUtils";
import { coreToTokens, type CoreThemeColors } from "@/themes";

interface ThemeBuilderFieldsProps {
  colors: CoreThemeColors;
  onColorsChange: (colors: CoreThemeColors) => void;
  title: string;
  onTitleChange: (title: string) => void;
  placeholder?: string;
}

/** Custom-theme builder body, shared by Settings → Appearance and the Discover creator so they can't drift. */
export function ThemeBuilderFields({
  colors,
  onColorsChange,
  title,
  onTitleChange,
  placeholder,
}: ThemeBuilderFieldsProps) {
  const intl = useIntl();
  const update = (channel: keyof CoreThemeColors) => (hex: string) =>
    onColorsChange({ ...colors, [channel]: hexToHslString(hex) });

  const tokens = coreToTokens(colors);

  return (
    <div className="space-y-5">
      <div
        className="clip-corner-lg p-4 space-y-3"
        style={{ backgroundColor: `hsl(${tokens.background})`, color: `hsl(${tokens.foreground})` }}
      >
        <div className="flex items-center gap-2">
          <span className="size-8 rounded-full" style={{ backgroundColor: `hsl(${tokens.primary})` }} />
          <div className="flex-1">
            {/* Names in chat are drawn in Primary, so the sample's is too. */}
            <div className="text-sm font-semibold" style={{ color: `hsl(${tokens.primary})` }}>{title || <FormattedMessage id="themeBuilderFields.preview" defaultMessage="Preview" />}</div>
            <div className="text-xs" style={{ color: `hsl(${tokens.mutedForeground})` }}>
              <FormattedMessage id="themeBuilderFields.sampleText" defaultMessage="The quick brown fox." />
            </div>
          </div>
          <span
            className="clip-corner-lg px-2 py-1 text-xs font-medium"
            style={{ backgroundColor: `hsl(${tokens.primary})`, color: `hsl(${tokens.primaryForeground})` }}
          >
            <FormattedMessage id="themeBuilderFields.sampleButton" defaultMessage="Button" />
          </span>
        </div>
        <div className="rounded-md p-2 text-xs" style={{ backgroundColor: `hsl(${tokens.secondary})` }}>
          <FormattedMessage id="themeBuilderFields.sampleSurface" defaultMessage="A muted surface row." />
        </div>
      </div>

      <div className="flex items-start justify-around">
        <ColorPicker label={intl.formatMessage({ id: "themeBuilderFields.background", defaultMessage: "Background" })} value={hslStringToHex(colors.background)} onChange={update("background")} />
        <ColorPicker label={intl.formatMessage({ id: "themeBuilderFields.text", defaultMessage: "Text" })} value={hslStringToHex(colors.text)} onChange={update("text")} />
        <ColorPicker label={intl.formatMessage({ id: "themeBuilderFields.primary", defaultMessage: "Primary" })} value={hslStringToHex(colors.primary)} onChange={update("primary")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="theme-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <FormattedMessage id="themeBuilderFields.name" defaultMessage="Name" />
        </Label>
        <Input
          id="theme-title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder={placeholder}
          maxLength={40}
        />
      </div>
    </div>
  );
}
