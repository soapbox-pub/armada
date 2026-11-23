import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import type { Area, Point } from 'react-easy-crop';
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Crop, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { hasTransparency } from '@/lib/canvasAlpha';
import { canvasReadbackIntact } from '@/lib/canvasProbe';
import { stripMetadataWithoutCanvas } from '@/lib/imageMetadataStrip';
import { isGifBytes, runGifCrop } from '@/lib/runGifCrop';
import { FormattedMessage, common, useIntl } from '@/i18n';

interface ImageCropDialogProps {
  open: boolean;
  imageSrc: string;
  aspect: number;
  title?: string;
  /** Longest edge of the output in pixels; larger crops are scaled down. */
  maxEdge?: number;
  onCancel: () => void;
  onCrop: (croppedBlob: Blob) => void;
}

class CanvasBlockedError extends Error {}

async function getCroppedBlob(imageSrc: string, pixelCrop: Area, maxEdge?: number): Promise<Blob> {
  const source = await (await fetch(imageSrc)).blob();
  if (isGifBytes(new Uint8Array(await source.slice(0, 4).arrayBuffer()))) {
    return (await runGifCrop(source, pixelCrop, maxEdge)) ?? source;
  }
  // A fingerprint blocker (Tor Browser, resistFingerprinting) hands back noise
  // from toBlob: the picked image goes up uncropped instead.
  if (!canvasReadbackIntact()) {
    const stripped = stripMetadataWithoutCanvas(new Uint8Array(await source.arrayBuffer()));
    if (!stripped) throw new CanvasBlockedError();
    return new Blob([stripped], { type: source.type });
  }
  const image = await createImageBitmap(source);
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(pixelCrop.width, pixelCrop.height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(pixelCrop.width * scale));
  canvas.height = Math.max(1, Math.round(pixelCrop.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  image.close();
  // JPEG has no alpha channel and would paint a transparent icon's background black.
  const type = hasTransparency(ctx, canvas.width, canvas.height) ? 'image/png' : 'image/jpeg';
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create blob'));
    }, type, 0.92);
  });
}

export function ImageCropDialog({ open, imageSrc, aspect, title: titleProp, maxEdge, onCancel, onCrop }: ImageCropDialogProps) {
  const intl = useIntl();
  const title = titleProp ?? intl.formatMessage({ id: 'imageCropDialog.title', defaultMessage: 'Crop Image' });
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [canvasBlocked] = useState(() => !canvasReadbackIntact());
  const [blockedError, setBlockedError] = useState(false);

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const handleReset = () => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  };

  const handleConfirm = async () => {
    if (!croppedAreaPixels) return;
    setIsProcessing(true);
    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels, maxEdge);
      onCrop(blob);
    } catch (error) {
      if (!(error instanceof CanvasBlockedError)) throw error;
      setBlockedError(true);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <ChromeDialogContent title={title} className="sm:max-w-lg">
        <ChromeDialogHeader icon={Crop} title={title} />

        <div className="relative mt-5 overflow-hidden clip-corner-lg bg-black" style={{ height: 320 }}>
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            style={{
              containerStyle: { borderRadius: 0 },
              cropAreaStyle: { border: '2px solid hsl(var(--primary))' },
            }}
          />
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-3">
            <ZoomOut className="size-4 text-muted-foreground shrink-0" />
            <Slider
              min={1}
              max={3}
              step={0.01}
              value={[zoom]}
              onValueChange={([v]) => setZoom(v)}
              className="flex-1"
            />
            <ZoomIn className="size-4 text-muted-foreground shrink-0" />
          </div>
          <div className="flex justify-between items-center">
            <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs gap-1.5 h-8">
              <RotateCcw className="size-3" />
              <FormattedMessage id="imageCropDialog.reset" defaultMessage="Reset" />
            </Button>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage id="imageCropDialog.hint" defaultMessage="Drag to reposition · Pinch or scroll to zoom" />
            </p>
          </div>
        </div>

        {canvasBlocked && (
          <p className="mt-3 text-xs text-muted-foreground">
            <FormattedMessage
              id="imageCropDialog.canvasBlocked"
              defaultMessage="This browser blocks the canvas used to crop images, so only GIFs are cropped here. Other images are used as they are."
            />
          </p>
        )}
        {blockedError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            <FormattedMessage
              id="imageCropDialog.canvasBlockedUnsupported"
              defaultMessage="This image can't be used in this browser. Try a JPEG, PNG, WebP or GIF."
            />
          </p>
        )}

        <ChromeDialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={isProcessing}>
            <FormattedMessage {...common.cancel} />
          </Button>
          <Button onClick={handleConfirm} disabled={isProcessing}>
            {isProcessing ? (
              <FormattedMessage id="imageCropDialog.processing" defaultMessage="Processing…" />
            ) : (
              <FormattedMessage id="imageCropDialog.apply" defaultMessage="Apply crop" />
            )}
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
