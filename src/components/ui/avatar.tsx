import * as React from "react"

import { useBuzzMediaSrc } from "@/buzz/useBuzzMediaSrc"
import { useImetaImage } from "@/hooks/useImetaImage"
import type { ImetaEntry } from "@/lib/imeta"
import { imetaFor } from "@/lib/profileImeta"
import { cn } from "@/lib/utils"
import { sanitizeImageSrc } from "@/lib/sanitizeUrl"
import { type AvatarShape, isEmoji, getAvatarMaskUrl, isValidAvatarShape } from "@/lib/avatarShape"
import { MotionImg } from "@/components/ui/MotionImg"
import { useImageThumb } from "@/hooks/useImageThumb"

/** Lets AvatarFallback see a sibling AvatarImage's src without state; mutating a ref in render is safe. */
const AvatarHasSrcContext = React.createContext<React.MutableRefObject<boolean>>({ current: false })

const AvatarShapeContext = React.createContext<AvatarShape | undefined>(undefined)

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Avatar mask shape. Defaults to "circle". */
  shape?: AvatarShape;
}

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, children, shape, style, ...props }, ref) => {
    const hasSrcRef = React.useRef(false)
    hasSrcRef.current = false

    const hasValidShape = !!shape && isValidAvatarShape(shape)
    const isEmojiShape = hasValidShape && isEmoji(shape)
    const hasCustomShape = isEmojiShape

    // Synchronous (cached canvas data-URL) to avoid a flash of the unmasked avatar.
    const maskUrl = hasCustomShape && shape ? getAvatarMaskUrl(shape) : ''

    const mergedStyle = React.useMemo<React.CSSProperties>(() => {
      if (maskUrl) {
        return {
          ...style,
          WebkitMaskImage: `url(${maskUrl})`,
          maskImage: `url(${maskUrl})`,
          WebkitMaskSize: 'contain',
          maskSize: 'contain' as string,
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat' as string,
          WebkitMaskPosition: 'center',
          maskPosition: 'center' as string,
        }
      }
      return style ?? {}
    }, [maskUrl, style])

    return (
      <AvatarHasSrcContext.Provider value={hasSrcRef}>
        <AvatarShapeContext.Provider value={shape}>
          <div
            ref={ref}
            className={cn(
              "relative flex h-10 w-10 shrink-0 overflow-hidden bg-muted",
              !hasCustomShape && "rounded-full",
              className
            )}
            style={mergedStyle}
            {...props}
          >
            {children}
          </div>
        </AvatarShapeContext.Provider>
      </AvatarHasSrcContext.Provider>
    )
  }
)
Avatar.displayName = "Avatar"

/** The APK WebView silently drops http:// images that web Chrome auto-upgrades. */
function upgradeToHttps(src: string | undefined): string | undefined {
  if (src && /^http:\/\//i.test(src)) return "https://" + src.slice(7)
  return src
}

/** Timed retries after every server failed: 3s, 6s, 12s, 24s — then only on online/visible. */
const RETRY_BASE_MS = 3000
const MAX_TIMED_RETRIES = 4

export interface AvatarImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /**
   * The kind 0's imeta for this picture (`author.data?.imeta?.picture`):
   * declared fallbacks, and decryption for an encrypted picture. Ignored
   * unless its `url` is `src`, so it's safe to pass while `src` is edited.
   */
  imeta?: ImetaEntry
}

/** Covers the fallback immediately; the browser renders progressively. */
const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(
  ({ className, onError, src: rawSrc, imeta, ...props }, ref) => {
  const hasSrcRef = React.useContext(AvatarHasSrcContext)
  // The one chokepoint for untrusted avatar URLs, so scheme/local-network
  // checks live here. Must run BEFORE useBuzzMediaSrc (its object URL is ours).
  const src0 = sanitizeImageSrc(typeof rawSrc === "string" ? rawSrc : undefined)
  const entry = imetaFor(src0, imeta)
  // Buzz avatars need a signed BUD-11 GET header, so they're fetched into an
  // object URL. An encrypted picture is fetched by the decrypt instead.
  const { src: resolvedSrc } = useBuzzMediaSrc(entry?.encryption ? undefined : src0)
  const primary = upgradeToHttps(entry?.encryption ? src0 : resolvedSrc)
  // Walk the declared fallbacks, then Blossom mirrors (BUD-04), before the
  // initial so one dead server doesn't blank its avatars. Loaded under the
  // media policy (`lib/mediaPolicy.ts`). Encrypted: the initial until decrypted.
  const { src, onError: advance, failed, reset } = useImetaImage(primary, entry)

  const prevSrc = React.useRef(primary)
  const attemptsRef = React.useRef(0)
  if (primary !== prevSrc.current) {
    prevSrc.current = primary
    attemptsRef.current = 0
  }

  // Don't latch the fallback: mobile fetch failures are routine. Retry with
  // backoff and on online/visible; remounting the <img> re-fetches.
  React.useEffect(() => {
    if (!failed) return
    attemptsRef.current += 1
    const retry = () => reset()
    const timer = attemptsRef.current <= MAX_TIMED_RETRIES
      ? setTimeout(retry, RETRY_BASE_MS * 2 ** (attemptsRef.current - 1))
      : undefined
    const onVisible = () => {
      if (document.visibilityState === "visible") retry()
    }
    window.addEventListener("online", retry)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener("online", retry)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [failed, reset])

  // Shown downscaled to its box (`lib/imageThumb.ts`); measured once, before
  // anything loads. An unlaid-out box (display:none, jsdom) assumes 40px.
  const [box, setBox] = React.useState(0)
  const measure = React.useCallback((el: HTMLElement | null) => {
    if (el) setBox(el.offsetWidth || 40)
  }, [])
  const thumb = useImageThumb(failed ? undefined : src, box)

  const showImage = !failed && !!src

  if (showImage) {
    hasSrcRef.current = true
  }

  if (!showImage) return null
  // Blank while the thumbnail is made, as a progressively loading <img> was.
  if (thumb.pending) return <span ref={measure} aria-hidden className="absolute inset-0" />

  return (
    <MotionImg
      {...props}
      src={thumb.src}
      ref={ref}
      alt=""
      // The APK's `https://localhost` Referer trips some hotlink protections.
      referrerPolicy="no-referrer"
      className={cn("absolute inset-0 h-full w-full object-cover", className)}
      onError={(e) => {
        advance()
        onError?.(e)
      }}
    />
  )
})
AvatarImage.displayName = "AvatarImage"

/** Letter initial, hidden while AvatarImage has a src (no flash during download). */
const AvatarFallback = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const hasSrcRef = React.useContext(AvatarHasSrcContext)
  const shape = React.useContext(AvatarShapeContext)

  const hasCustomShape = !!shape && isValidAvatarShape(shape)

  // AvatarImage renders first, so hasSrcRef is set by now.
  if (hasSrcRef.current) return null

  return (
    <div
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center",
        !hasCustomShape && "rounded-full",
        className
      )}
      {...props}
    />
  )
})
AvatarFallback.displayName = "AvatarFallback"

export { Avatar, AvatarImage, AvatarFallback }
