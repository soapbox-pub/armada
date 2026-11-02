import { BookmarkPlus, Check, Link2, Loader2, Palette, Pencil } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ThemeCreatorDialog } from "@/components/discover/ThemeCreatorDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { useNaddrLink } from "@/hooks/useNaddrLink";
import { useTheme } from "@/hooks/useTheme";
import { useThemeLibrary } from "@/hooks/useThemeLibrary";
import { useUserThemes } from "@/hooks/useUserThemes";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { naddrPath } from "@/lib/naddrLink";
import { parseDittoTheme, themeEventToConfig } from "@/lib/themeEvent";
import { startThemePreview } from "@/lib/themePreview";
import { cn } from "@/lib/utils";
import { coreToTokens } from "@/themes";

import type { NostrRumor } from "@/lib/nostrRumor";
import { AvatarInitial } from "@/components/AvatarInitial";

interface ThemeDiscoverCardProps {
  event: NostrRumor;
  className?: string;
}

export function ThemeDiscoverCard({ event, className }: ThemeDiscoverCardProps) {
  const intl = useIntl();
  const theme = useMemo(() => parseDittoTheme(event), [event]);
  const { customTheme, theme: mode } = useTheme();
  const { user } = useCurrentUser();
  const { data: userThemes } = useUserThemes();
  const { publishTheme, isPending: saving } = useThemeLibrary();
  // A credited copy shows the theme's creator, not whoever kept it.
  const creator = theme?.source?.pubkey ?? event.pubkey;
  const author = useAuthor(creator);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, creator);
  const [justSaved, setJustSaved] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { naddr, copied, copy } = useNaddrLink(event);
  const backgroundSrc = useMediaSrc(theme?.background?.url);

  const tokens = useMemo(() => (theme ? coreToTokens(theme.colors) : null), [theme]);

  if (!theme || !tokens) return null;

  const isOwn = !!user && event.pubkey === user.pubkey;
  const config = themeEventToConfig(event);
  const savedCopy = !isOwn && config?.source
    ? userThemes?.find((t) =>
      t.source?.pubkey === config.source?.pubkey && t.source?.identifier === config.source?.identifier)
    : undefined;
  const saved = justSaved || !!savedCopy;

  const isActive =
    mode === "custom" &&
    !!customTheme &&
    JSON.stringify(customTheme.colors) === JSON.stringify(theme.colors) &&
    customTheme.background?.url === config?.background?.url;

  const onTry = () => {
    if (config) startThemePreview(config);
  };

  const onSave = async () => {
    if (!config || saved) return;
    try {
      await publishTheme({
        title: theme.title,
        colors: theme.colors,
        font: theme.font,
        titleFont: theme.titleFont,
        background: theme.background,
        description: theme.description,
        source: config.source,
      });
      setJustSaved(true);
      toast({ title: t({ id: "themeDiscoverCard.savedToThemes", defaultMessage: "Saved to your themes" }), description: theme.title });
    } catch (e) {
      toast({
        title: t({ id: "themeDiscoverCard.saveFailed", defaultMessage: "Couldn't save theme" }),
        description: e instanceof Error ? e.message : t({ id: "themeDiscoverCard.publishingFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col w-full p-px clip-hairline-lg [--fill:var(--card)] [--fill-hover:var(--card)] overflow-hidden",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="relative flex items-end gap-1.5 p-3 h-20"
        style={{ backgroundColor: `hsl(${tokens.background})` }}
      >
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
        <span className="relative size-6 rounded-full" style={{ backgroundColor: `hsl(${tokens.primary})` }} />
        <span className="relative size-6 rounded-full" style={{ backgroundColor: `hsl(${tokens.secondary})` }} />
        <span className="relative flex-1 h-2 rounded-full" style={{ backgroundColor: `hsl(${tokens.muted})` }} />
        <span
          className="relative clip-corner-lg px-2 py-1 text-xs font-medium"
          style={{ backgroundColor: `hsl(${tokens.primary})`, color: `hsl(${tokens.primaryForeground})` }}
        >
          Aa
        </span>
      </div>

      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Palette className="size-4 shrink-0 text-primary" />
          {naddr ? (
            <Link
              to={naddrPath(naddr)}
              className="font-semibold truncate leading-tight flex-1 hover:underline"
            >
              {theme.title}
            </Link>
          ) : (
            <p className="font-semibold truncate leading-tight flex-1">{theme.title}</p>
          )}
          <span
            className={cn(
              "text-3xs px-1.5 py-px rounded-full shrink-0",
              isActive ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
            )}
          >
            {isActive ? <FormattedMessage id="themeDiscoverCard.applied" defaultMessage="Applied" /> : <FormattedMessage id="themeDiscoverCard.theme" defaultMessage="Theme" />}
          </span>
        </div>

        {theme.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 -mt-1">{theme.description}</p>
        )}

        <ProfilePreviewCard pubkey={creator}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
          >
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-monogram">
                <AvatarInitial name={displayName} />
              </AvatarFallback>
            </Avatar>
            <span className="truncate">
              <FormattedMessage
                id="themeDiscoverCard.byAuthor"
                defaultMessage="by {name}"
                values={{ name: <DisplayName pubkey={creator} name={displayName} /> }}
              />
            </span>
          </button>
        </ProfilePreviewCard>

        <div className="mt-auto flex items-center gap-2">
          {isActive ? (
            <Button variant="secondary" className="flex-1 clip-corner-lg" disabled>
              <Check className="size-4" />
              <FormattedMessage id="themeDiscoverCard.applied" defaultMessage="Applied" />
            </Button>
          ) : (
            <Button className="flex-1 clip-corner-lg" onClick={onTry}>
              <Palette className="size-4" />
              <FormattedMessage id="themeDiscoverCard.tryTheme" defaultMessage="Try this theme" />
            </Button>
          )}
          {isOwn ? (
            <Button
              variant="secondary"
              className="shrink-0 clip-corner-lg"
              onClick={() => setEditOpen(true)}
              aria-label={intl.formatMessage({ id: "themeDiscoverCard.editTheme", defaultMessage: "Edit theme" })}
              title={intl.formatMessage({ id: "themeDiscoverCard.editTheme", defaultMessage: "Edit theme" })}
            >
              <Pencil className="size-4" />
            </Button>
          ) : user && (
            <Button
              variant="secondary"
              className="shrink-0 clip-corner-lg"
              onClick={onSave}
              disabled={saving || saved}
              aria-label={saved ? intl.formatMessage({ id: "themeDiscoverCard.inYourThemes", defaultMessage: "In your themes" }) : intl.formatMessage({ id: "themeDiscoverCard.saveToMyThemes", defaultMessage: "Save to my themes" })}
              title={saved ? intl.formatMessage({ id: "themeDiscoverCard.inYourThemes", defaultMessage: "In your themes" }) : intl.formatMessage({ id: "themeDiscoverCard.saveToMyThemes", defaultMessage: "Save to my themes" })}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saved ? (
                <Check className="size-4" />
              ) : (
                <BookmarkPlus className="size-4" />
              )}
            </Button>
          )}
          {naddr && (
            <Button
              variant="secondary"
              className="shrink-0 clip-corner-lg"
              onClick={copy}
              aria-label={intl.formatMessage({ id: "themeDiscoverCard.copyThemeLink", defaultMessage: "Copy theme link" })}
              title={intl.formatMessage({ id: "themeDiscoverCard.copyThemeLink", defaultMessage: "Copy theme link" })}
            >
              {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
            </Button>
          )}
        </div>
      </div>

      {isOwn && editOpen && (
        <ThemeCreatorDialog open={editOpen} onOpenChange={setEditOpen} editing={{ ...theme, event }} />
      )}
    </div>
  );
}
