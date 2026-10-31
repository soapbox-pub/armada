import { Loader2, Palette, Trash2 } from "lucide-react";
import { useState } from "react";

import { ThemeBackgroundField } from "@/components/ThemeBackgroundField";
import { ThemeBuilderFields } from "@/components/ThemeBuilderFields";
import { ThemeFontFields } from "@/components/ThemeFontFields";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ToastAction } from "@/components/ui/toast";
import { useCopyNaddrLink } from "@/hooks/useNaddrLink";
import { useTheme } from "@/hooks/useTheme";
import { useThemeLibrary } from "@/hooks/useThemeLibrary";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { claimedThemeFont } from "@/lib/fontLoader";

import { builderStarterColors, type CoreThemeColors, type ThemeBackground, type ThemeConfig, type ThemeFont } from "@/themes";
import type { UserTheme } from "@/hooks/useUserThemes";

/**
 * Create, edit or delete a theme in the user's library (kind 36767). Never
 * touches the active profile theme (kind 16767). `editing` is one of the
 * user's own themes; `initial` seeds a new one (e.g. the theme in use).
 */
export function ThemeCreatorDialog({
  open,
  onOpenChange,
  editing,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: UserTheme;
  initial?: ThemeConfig;
}) {
  const intl = useIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={editing ? intl.formatMessage({ id: "themeCreatorDialog.editTitle", defaultMessage: "Edit theme" }) : intl.formatMessage({ id: "themeCreatorDialog.createTitle", defaultMessage: "Create theme" })}
      >
        <ThemeCreatorForm editing={editing} initial={initial} onDone={() => onOpenChange(false)} />
      </ChromeDialogContent>
    </Dialog>
  );
}

function ThemeCreatorForm({ editing, initial, onDone }: { editing?: UserTheme; initial?: ThemeConfig; onDone: () => void }) {
  const intl = useIntl();
  const { publishTheme, deleteTheme, isPending: publishing } = useThemeLibrary();
  const { applyCustomTheme } = useTheme();
  const copyLinkFor = useCopyNaddrLink();
  const seed = editing ?? initial;
  const [colors, setColors] = useState<CoreThemeColors>(seed?.colors ?? builderStarterColors);
  const [name, setName] = useState(seed?.title ?? "");
  const [font, setFont] = useState<ThemeFont | undefined>(seed?.font);
  const [titleFont, setTitleFont] = useState<ThemeFont | undefined>(seed?.titleFont);
  const [background, setBackground] = useState<ThemeBackground | undefined>(seed?.background);
  const [uploading, setUploading] = useState(false);
  const [applyToMine, setApplyToMine] = useState(!editing);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const named = name.trim().length > 0;
  const busy = publishing || uploading || deleting;
  const canPublish = named && !busy;

  const hint = publishing
    ? intl.formatMessage({ id: "themeCreatorDialog.publishing", defaultMessage: "Publishing…" })
    : uploading
      ? intl.formatMessage({ id: "themeCreatorDialog.uploadingBackground", defaultMessage: "Uploading background…" })
      : !named
        ? intl.formatMessage({ id: "themeCreatorDialog.giveName", defaultMessage: "Give the theme a name." })
        : intl.formatMessage({ id: "themeCreatorDialog.publicHint", defaultMessage: "Anyone will be able to find and apply this theme." });

  const publish = async () => {
    if (!canPublish) return;
    const title = name.trim();
    // A credited copy stays credited only while it is still the creator's work.
    const unchanged = !!seed && JSON.stringify([colors, background, font, titleFont])
      === JSON.stringify([seed.colors, seed.background, seed.font, seed.titleFont]);
    const ownFont = unchanged ? font : claimedThemeFont(font, seed);
    const ownTitleFont = unchanged ? titleFont : claimedThemeFont(titleFont, seed);

    let result: Awaited<ReturnType<typeof publishTheme>>;
    try {
      result = await publishTheme({
        title,
        colors,
        background,
        font: ownFont,
        titleFont: ownTitleFont,
        description: editing?.description,
        source: unchanged ? seed?.source : undefined,
        editing,
      });
    } catch (e) {
      toast({
        title: editing
          ? t({ id: "themeCreatorDialog.saveFailed", defaultMessage: "Couldn't save theme" })
          : t({ id: "themeCreatorDialog.publishFailed", defaultMessage: "Couldn't publish theme" }),
        description: e instanceof Error ? e.message : t({ id: "themeCreatorDialog.publishingFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
      return;
    }

    if (applyToMine) {
      applyCustomTheme({
        title,
        colors,
        ...(ownFont && { font: ownFont }),
        ...(ownTitleFont && { titleFont: ownTitleFont }),
        ...(background && { background }),
        ...(unchanged && seed?.source && { source: seed.source }),
      });
    }

    const copyLink = copyLinkFor(result.event);
    toast({
      title: editing ? t({ id: "themeCreatorDialog.themeSaved", defaultMessage: "Theme saved" }) : t({ id: "themeCreatorDialog.themePublished", defaultMessage: "Theme published" }),
      description: t(
        {
          id: "themeCreatorDialog.publishedDescription",
          defaultMessage:
            "{title}{applied, select, true {, applied as your theme} other {}}{syncing, select, true { (syncing when the network is back)} other {}}",
        },
        { title, applied: applyToMine ? "true" : "false", syncing: result.queued ? "true" : "false" },
      ),
      ...(copyLink && {
        action: (
          <ToastAction altText={t({ id: "themeCreatorDialog.copyThemeLink", defaultMessage: "Copy theme link" })} onClick={copyLink}>
            {t(common.copyLink)}
          </ToastAction>
        ),
      }),
    });
    onDone();
  };

  const remove = async () => {
    if (!editing) return;
    setDeleting(true);
    try {
      await deleteTheme(editing);
      toast({ title: t({ id: "themeCreatorDialog.themeDeleted", defaultMessage: "Theme deleted" }), description: editing.title });
      onDone();
    } catch (e) {
      toast({
        title: t({ id: "themeCreatorDialog.deleteFailed", defaultMessage: "Couldn't delete theme" }),
        description: e instanceof Error ? e.message : t({ id: "themeCreatorDialog.publishingFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
          <Palette className="size-6" />
        </div>
        <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
          {editing ? <FormattedMessage id="themeCreatorDialog.editHeading" defaultMessage="edit theme" /> : <FormattedMessage id="themeCreatorDialog.newHeading" defaultMessage="new theme" />}
        </h2>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="themeCreatorDialog.intro" defaultMessage="Pick three colors, a font and a background. Every other shade is derived from the colors." />
        </p>
      </div>

      <ThemeBuilderFields
        colors={colors}
        onColorsChange={setColors}
        title={name}
        onTitleChange={setName}
        placeholder={intl.formatMessage({ id: "themeCreatorDialog.namePlaceholder", defaultMessage: "My theme" })}
      />

      <ThemeFontFields
        font={font}
        onFontChange={setFont}
        titleFont={titleFont}
        onTitleFontChange={setTitleFont}
      />

      <ThemeBackgroundField value={background} onChange={setBackground} onUploadingChange={setUploading} />

      <div className="space-y-2">
        <Label className="flex cursor-pointer items-center gap-2 py-1 text-sm font-normal text-muted-foreground">
          <Checkbox
            checked={applyToMine}
            onCheckedChange={(v) => setApplyToMine(v === true)}
            className="shrink-0"
          />
          <FormattedMessage id="themeCreatorDialog.applyAsMine" defaultMessage="Apply as my theme" />
        </Label>
        <Button className="w-full clip-corner-lg" onClick={publish} disabled={!canPublish}>
          {publishing && <Loader2 className="size-4 animate-spin" />}
          {editing ? <FormattedMessage id="themeCreatorDialog.saveChanges" defaultMessage="Save changes" /> : <FormattedMessage id="themeCreatorDialog.publishTheme" defaultMessage="Publish theme" />}
        </Button>
        <p className="text-center text-xs text-muted-foreground">{hint}</p>
        {editing && (
          <Button
            variant="ghost"
            className="w-full text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            <FormattedMessage id="themeCreatorDialog.deleteTheme" defaultMessage="Delete theme" />
          </Button>
        )}
      </div>

      {editing && (
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="themeCreatorDialog.deleteConfirmTitle"
                  defaultMessage="Delete “{title}”?"
                  values={{ title: editing.title }}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="themeCreatorDialog.deleteConfirmDescription"
                  defaultMessage="It's removed from your themes and from Discover. Anyone already using it keeps their copy."
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <FormattedMessage {...common.cancel} />
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void remove()}
              >
                <FormattedMessage {...common.delete} />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
