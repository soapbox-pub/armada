import { useRef, useState } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMediaPolicy } from "@/hooks/useMediaPolicy";
import { toast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "@/i18n";
import { uploadFailureReason } from "@/lib/blossomPreflight";
import { loadThemeFont } from "@/lib/fontLoader";
import { findThemeFont, themeFontOptions, type ThemeFontCategory } from "@/lib/themeFonts";
import type { ThemeFont } from "@/themes";

const CATEGORY_LABELS: Record<ThemeFontCategory, MessageDescriptor> = defineMessages({
  sans: { id: "themeFontFields.category.sans", defaultMessage: "Sans serif" },
  serif: { id: "themeFontFields.category.serif", defaultMessage: "Serif" },
  mono: { id: "themeFontFields.category.mono", defaultMessage: "Monospace" },
  display: { id: "themeFontFields.category.display", defaultMessage: "Display" },
  handwriting: { id: "themeFontFields.category.handwriting", defaultMessage: "Handwriting" },
});

const FONT_CATEGORIES: ThemeFontCategory[] = ["sans", "serif", "mono", "display", "handwriting"];

/** Radix Select forbids an empty-string value. */
const DEFAULT_FONT = "__default__";
const UPLOAD_FONT = "__upload__";
const UPLOADED_FONT = "__uploaded__";

const FONT_ACCEPT = ".woff2,.woff,.ttf,.otf";

/** "MyFont-Bold.woff2" → "MyFont", as Ditto names an uploaded font. */
function familyFromFilename(filename: string): string {
  const base = filename.replace(/\.(woff2?|ttf|otf)$/i, "");
  const cleaned = base.replace(/[-_\s]?(Regular|Bold|Italic|Light|Medium|SemiBold|ExtraBold|Thin|Black|Variable|VF)$/i, "");
  return cleaned.replace(/[-_]/g, " ").trim() || base;
}

/** A font picked from the catalog is stored by family alone; an uploaded one keeps its URL. */
function isUploaded(font: ThemeFont | undefined): font is ThemeFont & { url: string } {
  return !!font?.url && !findThemeFont(font.family);
}

function FontSelect({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: ThemeFont | undefined;
  onChange: (font: ThemeFont | undefined) => void;
  placeholder: string;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { mutateAsync: uploadFile } = useUploadFile();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploaded = isUploaded(value) ? value : undefined;
  const mediaPolicy = useMediaPolicy();

  const selected = uploaded ? UPLOADED_FONT : value?.family || DEFAULT_FONT;

  const onPick = (v: string) => {
    if (v === UPLOAD_FONT) {
      fileInput.current?.click();
      return;
    }
    if (v === UPLOADED_FONT) return;
    onChange(v === DEFAULT_FONT ? undefined : { family: v });
  };

  // Uploaded in the clear: a theme font is read by everyone the theme is shown to.
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.(woff2?|ttf|otf)$/i.test(file.name)) {
      toast({
        title: intl.formatMessage({ id: "themeFontFields.invalidFile", defaultMessage: "That isn't a font file" }),
        description: intl.formatMessage({ id: "themeFontFields.invalidFileDescription", defaultMessage: "Choose a .woff2, .woff, .ttf or .otf file." }),
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const [[, url]] = await uploadFile(file);
      onChange({ family: familyFromFilename(file.name), url });
    } catch (error) {
      toast({
        title: intl.formatMessage({ id: "themeFontFields.uploadFailed", defaultMessage: "Couldn't upload the font" }),
        description: uploadFailureReason(error),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex-1 space-y-1.5 min-w-0">
      <Label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Select value={selected} onValueChange={onPick} disabled={uploading}>
        <SelectTrigger id={id}>
          {uploading ? (
            <span className="text-muted-foreground">
              <FormattedMessage id="themeFontFields.uploading" defaultMessage="Uploading…" />
            </span>
          ) : (
            <SelectValue placeholder={placeholder} />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_FONT}>{placeholder}</SelectItem>
          {uploaded && (
            <SelectItem value={UPLOADED_FONT} style={{ fontFamily: loadThemeFont(uploaded, mediaPolicy) }}>
              {uploaded.family}
            </SelectItem>
          )}
          {FONT_CATEGORIES.map((cat) => (
            <SelectGroup key={cat}>
              <SelectLabel>
                <FormattedMessage {...CATEGORY_LABELS[cat]} />
              </SelectLabel>
              {themeFontOptions
                .filter((f) => f.category === cat)
                .map((f) => (
                  <SelectItem
                    key={f.family}
                    value={f.family}
                    style={{ fontFamily: loadThemeFont({ family: f.family }) }}
                  >
                    {f.family}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
          {user && (
            <>
              <SelectSeparator />
              <SelectItem value={UPLOAD_FONT} className="text-muted-foreground">
                <FormattedMessage id="themeFontFields.upload" defaultMessage="Upload a font…" />
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      <input ref={fileInput} type="file" accept={FONT_ACCEPT} className="hidden" onChange={onFile} />
    </div>
  );
}

/**
 * Body and heading font pickers over the catalog Ditto shares, plus an
 * uploaded font file (Blossom), as Ditto's picker offers. Undefined is the default font.
 */
export function ThemeFontFields({
  font,
  onFontChange,
  titleFont,
  onTitleFontChange,
}: {
  font: ThemeFont | undefined;
  onFontChange: (font: ThemeFont | undefined) => void;
  titleFont: ThemeFont | undefined;
  onTitleFontChange: (font: ThemeFont | undefined) => void;
}) {
  const intl = useIntl();
  const defaultFont = intl.formatMessage({ id: "themeFontFields.defaultFont", defaultMessage: "Default" });
  return (
    <div className="flex gap-3">
      <FontSelect
        id="theme-font"
        label={intl.formatMessage({ id: "themeFontFields.font", defaultMessage: "Font" })}
        value={font}
        onChange={onFontChange}
        placeholder={defaultFont}
      />
      <FontSelect
        id="theme-title-font"
        label={intl.formatMessage({ id: "themeFontFields.nameFont", defaultMessage: "Name font" })}
        value={titleFont}
        onChange={onTitleFontChange}
        placeholder={font?.family || defaultFont}
      />
    </div>
  );
}
