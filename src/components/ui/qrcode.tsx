import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { useIntl } from '@/i18n';
import { getThemedQRColors } from '@/lib/qrColors';
import { cn } from '@/lib/utils';

interface QRCodeCanvasProps {
  value: string;
  size?: number;
  level?: 'L' | 'M' | 'Q' | 'H';
  className?: string;
}

/**
 * QR code as an `<img>` from an SVG data URL, never a `<canvas>`: fingerprint
 * blockers poison canvas readback. Name kept for call sites.
 */
export function QRCodeCanvas({ value, size = 256, level = 'M', className }: QRCodeCanvasProps) {
  const intl = useIntl();
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    let active = true;
    QRCode.toString(value, {
      type: 'svg',
      width: size,
      margin: 1,
      errorCorrectionLevel: level,
    })
      .then((svg) => {
        if (active) setDataUrl(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
      })
      .catch((error) => {
        console.error('QR Code generation error:', error);
        if (active) setDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [value, size, level]);

  // Sized placeholder so an empty `src` never flashes a broken image.
  if (!dataUrl) {
    return <div style={{ width: size, height: size }} className={className} />;
  }

  return (
    <img
      src={dataUrl}
      alt={intl.formatMessage({ id: 'qrcode.alt', defaultMessage: 'QR code' })}
      width={size}
      height={size}
      className={className}
      decoding="async"
    />
  );
}

interface ThemedQRCodeProps {
  /** Encoded value; empty shows the placeholder. */
  value: string;
  alt: string;
  /** Sizes the image and its placeholder; it is rendered at 400 and scaled. */
  className?: string;
}

/**
 * The share-link QR: SVG `<img>` (see {@link QRCodeCanvas}) tinted with
 * {@link getThemedQRColors}, which carries its own background, so it needs no
 * white frame.
 */
export function ThemedQRCode({ value, alt, className = 'w-64' }: ThemedQRCodeProps) {
  // Keyed by value so a replaced code (a new login secret) never shows the old one.
  const [rendered, setRendered] = useState<{ value: string; url: string } | null>(null);

  useEffect(() => {
    if (!value) return;
    let active = true;
    // Read at mount so a theme switch is reflected.
    const { dark, light } = getThemedQRColors();
    QRCode.toString(value, {
      type: 'svg',
      width: 400,
      margin: 2,
      color: { dark, light },
      errorCorrectionLevel: 'M',
    })
      .then((svg) => {
        if (active) setRendered({ value, url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` });
      })
      .catch(() => {
        if (active) setRendered(null);
      });
    return () => {
      active = false;
    };
  }, [value]);

  const dataUrl = rendered?.value === value ? rendered.url : '';
  if (!dataUrl) {
    return <div className={cn('mx-auto aspect-square clip-corner-lg bg-muted animate-pulse', className)} />;
  }

  return (
    <img
      src={dataUrl}
      alt={alt}
      className={cn('mx-auto aspect-square clip-corner-lg', className)}
      decoding="async"
    />
  );
}
