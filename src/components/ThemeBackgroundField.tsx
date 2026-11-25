import { Image as ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";

import { DEFAULT_SURFACE_OPACITY, MIN_SURFACE_OPACITY, type ThemeBackground } from "@/themes";

export function ThemeBackgroundField({
  value,
  onChange,
  onUploadingChange,
}: {
  value: ThemeBackground | undefined;
  onChange: (background: ThemeBackground | undefined) => void;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const intl = useIntl();
  const { mutateAsync: uploadFile, isPending: uploading } = useUploadFile();
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbSrc = useMediaSrc(value?.url);
  const surfaceLabelId = useId();
  const surfaceOpacity = value?.surfaceOpacity ?? DEFAULT_SURFACE_OPACITY;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    onUploadingChange?.(true);
    try {
      const tags = await uploadFile(file);
      const url = tags[0][1];
      const mimeType = tags.find(([n]) => n === "m")?.[1];
      const dimensions = tags.find(([n]) => n === "dim")?.[1];
      onChange({ url, mode: value?.mode ?? "cover", mimeType, dimensions, surfaceOpacity: value?.surfaceOpacity });
    } catch (e) {
      toast({
        title: t({ id: "themeBackgroundField.uploadFailed.title", defaultMessage: "Couldn't upload background" }),
        description: e instanceof Error
          ? e.message
          : t({ id: "themeBackgroundField.uploadFailed.description", defaultMessage: "Upload failed." }),
        variant: "destructive",
      });
    } finally {
      onUploadingChange?.(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <FormattedMessage id="themeBackgroundField.label" defaultMessage="Background image" />
      </Label>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="flex items-center gap-2">
        {value?.url && thumbSrc ? (
          <div
            className="size-11 shrink-0 clip-corner-lg bg-cover bg-center bg-secondary"
            style={{ backgroundImage: `url("${thumbSrc.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")` }}
          />
        ) : (
          <div className="flex size-11 shrink-0 items-center justify-center clip-corner-lg bg-secondary text-muted-foreground">
            <ImageIcon className="size-5" />
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="clip-corner-lg"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {value?.url ? (
            <FormattedMessage id="themeBackgroundField.replace" defaultMessage="Replace" />
          ) : (
            <FormattedMessage id="themeBackgroundField.upload" defaultMessage="Upload" />
          )}
        </Button>
        {value?.url && (
          <>
            <Select
              value={value.mode ?? "cover"}
              onValueChange={(v) => onChange({ ...value, mode: v === "tile" ? "tile" : "cover" })}
            >
              <SelectTrigger className="h-9 w-24" aria-label={intl.formatMessage({ id: "themeBackgroundField.fit", defaultMessage: "Background fit" })}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cover">
                  <FormattedMessage id="themeBackgroundField.fill" defaultMessage="Fill" />
                </SelectItem>
                <SelectItem value="tile">
                  <FormattedMessage id="themeBackgroundField.tile" defaultMessage="Tile" />
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 touch:size-11 text-muted-foreground hover:text-destructive"
              aria-label={intl.formatMessage({ id: "themeBackgroundField.remove", defaultMessage: "Remove background" })}
              onClick={() => onChange(undefined)}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </div>
      {value?.url && (
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span id={surfaceLabelId}>
              <FormattedMessage id="themeBackgroundField.surfaceOpacity" defaultMessage="Panel opacity" />
            </span>
            <span className="tabular-nums">{intl.formatNumber(surfaceOpacity, { style: "percent" })}</span>
          </div>
          <Slider
            aria-labelledby={surfaceLabelId}
            min={MIN_SURFACE_OPACITY}
            max={1}
            step={0.05}
            value={[surfaceOpacity]}
            onValueChange={([v]) => onChange({ ...value, surfaceOpacity: v })}
          />
        </div>
      )}
    </div>
  );
}
