import { BookmarkPlus, Check, Palette, Pencil, Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { ThemeCreatorDialog } from "@/components/discover/ThemeCreatorDialog";
import { ThemeBackgroundField } from "@/components/ThemeBackgroundField";
import { ThemeBuilderFields } from "@/components/ThemeBuilderFields";
import { ThemeFontFields } from "@/components/ThemeFontFields";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMediaPolicy, useMediaSrc } from "@/hooks/useMediaPolicy";
import { useTheme } from "@/hooks/useTheme";
import { useUserThemes, type UserTheme } from "@/hooks/useUserThemes";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { claimedThemeFont, loadThemeFont } from "@/lib/fontLoader";
import { getDisplayName } from "@/lib/getDisplayName";
import { themeToConfig } from "@/lib/themeEvent";
import { cn } from "@/lib/utils";
import {
  builderStarterColors,
  builtinThemes,
  coreToTokens,
  themePresets,
  type CoreThemeColors,
  type ThemeBackground,
  type ThemeConfig,
  type ThemeFont,
  type ThemeSource,
  type ThemeTokens,
} from "@/themes";

import type { Theme } from "@/contexts/AppContext";

/** What makes two themes look the same: colors, background image and body font. */
function lookKey(t: { colors: CoreThemeColors; background?: ThemeBackground; font?: ThemeFont }): string {
  return JSON.stringify([t.colors, t.background?.url ?? "", t.font?.family ?? "", t.font?.url ?? ""]);
}

/** Same creator's same theme. Adopting can rehost the background, so the look alone can't tell. */
function sameSource(a: ThemeSource | undefined, b: ThemeSource | undefined): boolean {
  return !!a && !!b && a.pubkey === b.pubkey && (a.identifier ?? "") === (b.identifier ?? "");
}

/** "by {creator}" for a theme adopted from someone else, optionally marked unsaved. */
function ThemeCredit({ source, unsaved }: { source?: ThemeSource; unsaved: boolean }) {
  const author = useAuthor(source?.pubkey);
  if (!source) {
    return unsaved ? <FormattedMessage id="themeSelector.notSaved" defaultMessage="Not saved" /> : null;
  }
  return (
    <FormattedMessage
      id="themeSelector.credit"
      defaultMessage="{unsaved, select, true {Not saved · by {name}} other {by {name}}}"
      values={{ unsaved: unsaved ? "true" : "false", name: getDisplayName(author.data?.metadata, source.pubkey) }}
    />
  );
}

function MiniPage({ tokens, font, className }: { tokens: ThemeTokens; font?: string; className?: string }) {
  return (
    <div className={cn("relative space-y-1 p-1.5 pt-2.5", className)}>
      <div className="flex items-center gap-1">
        <span className="h-1 w-3/5 rounded-full opacity-70" style={{ backgroundColor: `hsl(${tokens.foreground})` }} />
        {font && (
          <span className="ml-auto text-2xs leading-none" style={{ fontFamily: font, color: `hsl(${tokens.foreground})` }}>
            Aa
          </span>
        )}
      </div>
      <span className="block h-1 w-2/5 rounded-full opacity-50" style={{ backgroundColor: `hsl(${tokens.mutedForeground})` }} />
      <span className="block h-2 w-8 rounded-sm" style={{ backgroundColor: `hsl(${tokens.primary})` }} />
    </div>
  );
}

function Swatch({ colors, background, font }: { colors: CoreThemeColors; background?: ThemeBackground; font?: ThemeFont }) {
  const tokens = useMemo(() => coreToTokens(colors), [colors]);
  const backgroundSrc = useMediaSrc(background?.url);
  const mediaPolicy = useMediaPolicy();
  return (
    <div className="relative size-full" style={{ backgroundColor: `hsl(${tokens.background})` }}>
      {backgroundSrc && (
        <img
          src={backgroundSrc}
          alt=""
          aria-hidden
          className="absolute inset-0 size-full object-cover opacity-50"
          decoding="async"
          loading="lazy"
        />
      )}
      <MiniPage tokens={tokens} font={loadThemeFont(font, mediaPolicy)} />
    </div>
  );
}

function SystemSwatch() {
  const light = useMemo(() => coreToTokens(builtinThemes.light), []);
  const dark = useMemo(() => coreToTokens(builtinThemes.dark), []);
  return (
    <div className="grid size-full grid-cols-2">
      <div style={{ backgroundColor: `hsl(${light.background})` }}><MiniPage tokens={light} /></div>
      <div style={{ backgroundColor: `hsl(${dark.background})` }}><MiniPage tokens={dark} /></div>
    </div>
  );
}

interface TileProps {
  label: string;
  active: boolean;
  onClick: () => void;
  preview: ReactNode;
  /** A small caption under the label (e.g. "Not saved", the creator). */
  note?: ReactNode;
  /** A corner action on the tile: edit or save. */
  action?: { icon: ReactNode; label: string; onClick: () => void };
}

function ThemeTile({ label, active, onClick, preview, note, action }: TileProps) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className="group/tile relative flex w-full flex-col items-stretch gap-1.5 clip-corner-lg p-1.5 text-left transition-colors hover:bg-secondary/60"
      >
        {/* Drawn inside: an outer ring would be cut off by the tile's clip-path. */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-[1] clip-corner-lg-ring transition-opacity",
            active
              ? "[--ring-edge:hsl(var(--primary))]"
              : "opacity-0 [--ring-edge:hsl(var(--border))] group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100",
          )}
        />
        <div className="relative aspect-[4/3] w-full overflow-hidden clip-corner">
          {preview}
          {active && (
            <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-3" />
            </span>
          )}
        </div>
        <span className={cn("min-w-0 px-0.5", action && "pr-7")}>
          <span className="block truncate text-xs font-medium">{label}</span>
          {note && <span className="block truncate text-3xs text-muted-foreground">{note}</span>}
        </span>
      </button>
      {action && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute bottom-0.5 right-0.5 size-7 touch:size-11 text-muted-foreground hover:text-foreground"
          onClick={action.onClick}
          aria-label={action.label}
          title={action.label}
        >
          {action.icon}
        </Button>
      )}
    </div>
  );
}

function NewThemeTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/tile flex w-full flex-col items-stretch gap-1.5 clip-corner-lg p-1.5 text-left transition-colors hover:bg-secondary/60"
    >
      <div className="flex aspect-[4/3] w-full items-center justify-center clip-corner bg-secondary/60 text-muted-foreground transition-colors group-hover/tile:text-primary">
        <Plus className="size-6" />
      </div>
      <span className="truncate px-0.5 text-xs font-medium">
        <FormattedMessage id="themeSelector.newTheme" defaultMessage="New theme" />
      </span>
    </button>
  );
}

const GRID = "grid grid-cols-3 gap-2 sm:grid-cols-4";

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">{children}</h3>;
}

/**
 * Theme picker, after Ditto's: the user's own themes first, then presets.
 * Creating a theme saves it to the library (kind 36767) and wears it.
 */
export function ThemeSelector() {
  const intl = useIntl();
  const { theme, customTheme, setTheme, applyCustomTheme } = useTheme();
  const { data: userThemes, isLoading: userThemesLoading } = useUserThemes();
  const { user } = useCurrentUser();
  const [creator, setCreator] = useState<{ editing?: UserTheme; initial?: ThemeConfig } | undefined>();
  const [builderOpen, setBuilderOpen] = useState(false);

  const presetKeys = Object.keys(themePresets);
  const activeKey = theme === "custom" && customTheme ? lookKey(customTheme) : undefined;
  const activePresetKey = activeKey
    ? presetKeys.find((k) => lookKey(themePresets[k]) === activeKey)
    : undefined;
  const activeUserTheme = activeKey && !activePresetKey
    ? userThemes?.find((t) => lookKey(t) === activeKey)
      ?? userThemes?.find((t) => sameSource(t.source, customTheme?.source)
        && JSON.stringify(t.colors) === JSON.stringify(customTheme?.colors))
    : undefined;
  // A custom theme in use that is neither a preset nor in the library: shown so it can be saved.
  const unsaved = theme === "custom" && customTheme && !activePresetKey && !activeUserTheme && !userThemesLoading
    ? customTheme
    : undefined;

  const selectMode = (mode: Theme) => setTheme(mode);
  const startNew = () => (user ? setCreator({}) : setBuilderOpen(true));

  const editLabel = (label: string) =>
    intl.formatMessage({ id: "themeSelector.editLabel", defaultMessage: "Edit {label}" }, { label });

  return (
    <div className="space-y-5">
      <div>
        <SectionTitle>
          <FormattedMessage id="themeSelector.myThemes" defaultMessage="My themes" />
        </SectionTitle>
        <div className={GRID}>
          {unsaved && (
            <ThemeTile
              label={unsaved.title || intl.formatMessage({ id: "themeSelector.customLabel", defaultMessage: "Custom" })}
              note={<ThemeCredit source={unsaved.source} unsaved={!!user} />}
              preview={<Swatch colors={unsaved.colors} background={unsaved.background} font={unsaved.font} />}
              active
              onClick={() => applyCustomTheme(unsaved)}
              action={user
                ? {
                  icon: <BookmarkPlus className="size-3.5" />,
                  label: intl.formatMessage({ id: "themeSelector.saveToMyThemes", defaultMessage: "Save to my themes" }),
                  onClick: () => setCreator({ initial: unsaved }),
                }
                : {
                  icon: <Pencil className="size-3.5" />,
                  label: editLabel(unsaved.title || "Custom"),
                  onClick: () => setBuilderOpen(true),
                }}
            />
          )}
          {userThemes?.map((t) => (
            <ThemeTile
              key={t.identifier || t.title}
              label={t.title}
              note={t.source && <ThemeCredit source={t.source} unsaved={false} />}
              preview={<Swatch colors={t.colors} background={t.background} font={t.font} />}
              active={activeUserTheme?.identifier === t.identifier}
              onClick={() => applyCustomTheme(themeToConfig(t))}
              action={{
                icon: <Pencil className="size-3.5" />,
                label: editLabel(t.title),
                onClick: () => setCreator({ editing: t }),
              }}
            />
          ))}
          <NewThemeTile onClick={startNew} />
        </div>
        {userThemesLoading && (
          <p className="mt-2 text-xs text-muted-foreground">
            <FormattedMessage id="themeSelector.loadingThemes" defaultMessage="Loading your themes…" />
          </p>
        )}
      </div>

      <div>
        <SectionTitle>
          <FormattedMessage id="themeSelector.presets" defaultMessage="Presets" />
        </SectionTitle>
        <div className={GRID}>
          <ThemeTile
            label={intl.formatMessage({ id: "themeSelector.system", defaultMessage: "System" })}
            preview={<SystemSwatch />}
            active={theme === "system"}
            onClick={() => selectMode("system")}
          />
          <ThemeTile
            label={intl.formatMessage({ id: "themeSelector.light", defaultMessage: "Light" })}
            preview={<Swatch colors={builtinThemes.light} />}
            active={theme === "light"}
            onClick={() => selectMode("light")}
          />
          <ThemeTile
            label={intl.formatMessage({ id: "themeSelector.dark", defaultMessage: "Dark" })}
            preview={<Swatch colors={builtinThemes.dark} />}
            active={theme === "dark"}
            onClick={() => selectMode("dark")}
          />
          {presetKeys.map((key) => {
            const preset = themePresets[key];
            return (
              <ThemeTile
                key={key}
                label={`${preset.emoji} ${preset.label}`}
                preview={<Swatch colors={preset.colors} />}
                active={activePresetKey === key}
                onClick={() => applyCustomTheme({ title: preset.label, colors: preset.colors })}
              />
            );
          })}
        </div>
      </div>

      {creator && (
        <ThemeCreatorDialog
          open
          onOpenChange={(open) => { if (!open) setCreator(undefined); }}
          editing={creator.editing}
          initial={creator.initial}
        />
      )}

      {builderOpen && (
        <LocalThemeBuilderDialog
          onOpenChange={setBuilderOpen}
          initial={unsaved}
          onApply={applyCustomTheme}
        />
      )}
    </div>
  );
}

/** Signed out there is no library: build a theme on this device only. */
function LocalThemeBuilderDialog({
  onOpenChange,
  initial,
  onApply,
}: {
  onOpenChange: (open: boolean) => void;
  initial?: ThemeConfig;
  onApply: (config: ThemeConfig) => void;
}) {
  const intl = useIntl();
  const [colors, setColors] = useState<CoreThemeColors>(initial?.colors ?? builderStarterColors);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [font, setFont] = useState<ThemeFont | undefined>(initial?.font);
  const [titleFont, setTitleFont] = useState<ThemeFont | undefined>(initial?.titleFont);
  const [background, setBackground] = useState<ThemeBackground | undefined>(initial?.background);
  const [uploading, setUploading] = useState(false);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "themeSelector.builder.dialogTitle", defaultMessage: "Custom theme" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Palette className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="themeSelector.builder.title" defaultMessage="custom theme" />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage
              id="themeSelector.builder.localDescription"
              defaultMessage="Kept on this device. Log in to save themes to your library and share them."
            />
          </p>
        </div>

        <div className="mt-6 space-y-5">
          <ThemeBuilderFields
            colors={colors}
            onColorsChange={setColors}
            title={title}
            onTitleChange={setTitle}
            placeholder={intl.formatMessage({ id: "themeSelector.builder.namePlaceholder", defaultMessage: "My theme" })}
          />

          <ThemeFontFields
            font={font}
            onFontChange={setFont}
            titleFont={titleFont}
            onTitleFontChange={setTitleFont}
          />

          <ThemeBackgroundField value={background} onChange={setBackground} onUploadingChange={setUploading} />

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button
              className="flex-1 clip-corner-lg"
              disabled={uploading}
              onClick={() => {
                // The creator stays credited only while the theme is still their work.
                const unchanged = !!initial && JSON.stringify([colors, background, font, titleFont])
                  === JSON.stringify([initial.colors, initial.background, initial.font, initial.titleFont]);
                const ownFont = unchanged ? font : claimedThemeFont(font, initial);
                const ownTitleFont = unchanged ? titleFont : claimedThemeFont(titleFont, initial);
                onApply({
                  title: title.trim() || "Custom",
                  colors,
                  ...(ownFont && { font: ownFont }),
                  ...(ownTitleFont && { titleFont: ownTitleFont }),
                  ...(background && { background }),
                  ...(unchanged && initial?.source && { source: initial.source }),
                });
                onOpenChange(false);
              }}
            >
              <FormattedMessage id="themeSelector.builder.apply" defaultMessage="Apply theme" />
            </Button>
          </div>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
