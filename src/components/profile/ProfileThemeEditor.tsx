import { Loader2 } from "lucide-react";
import { useState } from "react";

import { ThemeBackgroundField } from "@/components/ThemeBackgroundField";
import { ThemeBuilderFields } from "@/components/ThemeBuilderFields";
import { ThemeFontFields } from "@/components/ThemeFontFields";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { usePublishProfileTheme } from "@/hooks/usePublishProfileTheme";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { claimedThemeFont } from "@/lib/fontLoader";
import { toast } from "@/hooks/useToast";

import { builderStarterColors, type CoreThemeColors, type ThemeFont } from "@/themes";
import type { DittoTheme, ThemeBackground } from "@/lib/themeEvent";

/** Edit and publish the profile theme (kind 16767, Ditto-compatible). Save and Remove are the only publishes. */
export function ProfileThemeEditor({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current?: DittoTheme;
}) {
  const intl = useIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "profileThemeEditor.title", defaultMessage: "Profile theme" })}>
        {open && <ThemeEditorForm current={current} onDone={() => onOpenChange(false)} />}
      </ChromeDialogContent>
    </Dialog>
  );
}

function ThemeEditorForm({ current, onDone }: { current?: DittoTheme; onDone: () => void }) {
  const intl = useIntl();
  const { save, remove, isPending } = usePublishProfileTheme();
  const [uploading, setUploading] = useState(false);

  const [colors, setColors] = useState<CoreThemeColors>(current?.colors ?? builderStarterColors);
  const [title, setTitle] = useState(current?.title === "Untitled theme" ? "" : current?.title ?? "");
  const [font, setFont] = useState<ThemeFont | undefined>(current?.font);
  const [titleFont, setTitleFont] = useState<ThemeFont | undefined>(current?.titleFont);
  const [background, setBackground] = useState<ThemeBackground | undefined>(current?.background);

  const unchanged = !!current
    && JSON.stringify([colors, background, font, titleFont])
      === JSON.stringify([current.colors, current.background, current.font, current.titleFont]);

  const doSave = async () => {
    try {
      await save({
        colors,
        title: title.trim() || undefined,
        font: unchanged ? font : claimedThemeFont(font, current),
        titleFont: unchanged ? titleFont : claimedThemeFont(titleFont, current),
        background,
        description: current?.description,
        // The creator stays credited only while the theme is still their work.
        sourceRef: unchanged ? current?.sourceRef : undefined,
        source: unchanged ? current?.source : undefined,
      });
      toast({ title: t({ id: "profileThemeEditor.saved", defaultMessage: "Profile theme saved" }) });
      onDone();
    } catch (e) {
      toast({
        title: t({ id: "profileThemeEditor.saveFailed", defaultMessage: "Couldn't save theme" }),
        description: e instanceof Error ? e.message : t({ id: "profileThemeEditor.publishFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
    }
  };

  const doRemove = async () => {
    try {
      await remove();
      toast({ title: t({ id: "profileThemeEditor.removed", defaultMessage: "Profile theme removed" }) });
      onDone();
    } catch (e) {
      toast({
        title: t({ id: "profileThemeEditor.removeFailed", defaultMessage: "Couldn't remove theme" }),
        description: e instanceof Error ? e.message : t({ id: "profileThemeEditor.publishFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        <FormattedMessage
          id="profileThemeEditor.description"
          defaultMessage="Anyone viewing your profile sees it in these colors, fonts, and background. Published publicly (works in Ditto too)."
        />
      </p>

      <ThemeBuilderFields
        colors={colors}
        onColorsChange={setColors}
        title={title}
        onTitleChange={setTitle}
        placeholder={intl.formatMessage({ id: "profileThemeEditor.titlePlaceholder", defaultMessage: "My theme" })}
      />

      <ThemeFontFields
        font={font}
        onFontChange={setFont}
        titleFont={titleFont}
        onTitleFontChange={setTitleFont}
      />

      <ThemeBackgroundField value={background} onChange={setBackground} onUploadingChange={setUploading} />

      <div className="space-y-2">
        <Button className="w-full clip-corner-lg" onClick={doSave} disabled={isPending || uploading}>
          {isPending && <Loader2 className="size-4 animate-spin" />}
          <FormattedMessage id="profileThemeEditor.save" defaultMessage="Save theme" />
        </Button>
        {current && (
          <Button
            variant="ghost"
            className="w-full text-muted-foreground hover:text-destructive"
            onClick={doRemove}
            disabled={isPending}
          >
            <FormattedMessage id="profileThemeEditor.remove" defaultMessage="Remove theme" />
          </Button>
        )}
      </div>
    </div>
  );
}
