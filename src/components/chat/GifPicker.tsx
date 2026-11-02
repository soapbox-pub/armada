import { useCallback, useRef, useEffect, useState } from 'react';
import { Star, ImageOff } from 'lucide-react';
import { SearchField } from '@/components/ui/search-field';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useGifSearch, registerGifShare, type GifResult } from '@/hooks/useGifSearch';
import { useFavoriteGifs } from '@/hooks/useFavoriteGifs';
import { useIsMobile } from '@/hooks/useIsMobile';
import { MotionImg } from '@/components/ui/MotionImg';
import { useReducedMotion } from '@/lib/reducedMotion';
import { cn } from '@/lib/utils';
import { FormattedMessage, useIntl } from '@/i18n';

interface GifPickerProps {
  onSelect: (gif: GifResult) => void;
  className?: string;
}

/** Reference column width used to derive thumbnail heights from aspect ratios. */
const THUMB_REF_WIDTH = 170;

/** Height from the aspect ratio, clamped so extreme GIFs aren't ultrawide/slivers. */
function thumbHeight(gif: GifResult): number {
  const rawRatio = gif.width && gif.height ? gif.width / gif.height : 1;
  const aspectRatio = Math.min(Math.max(rawRatio, 0.6), 1.2);
  return Math.round(THUMB_REF_WIDTH / aspectRatio);
}

function GifThumbnail({ gif, onClick, isFavorite, onToggleFavorite }: { gif: GifResult; onClick: (gif: GifResult) => void; isFavorite?: boolean; onToggleFavorite?: (gif: GifResult) => void }) {
  const intl = useIntl();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  // Reduced motion: a still tile that plays only while pointed at.
  const reduced = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);

  const displayHeight = thumbHeight(gif);

  const sources = gif.previewSources ?? [];

  return (
    <button
      type="button"
      onClick={() => onClick(gif)}
      onPointerEnter={reduced ? () => void videoRef.current?.play().catch(() => {}) : undefined}
      onPointerLeave={reduced ? () => videoRef.current?.pause() : undefined}
      className={cn(
        'group relative w-full overflow-hidden cursor-pointer clip-corner-lg bg-secondary/40',
        'focus-visible:outline-none',
      )}
      style={{ height: displayHeight }}
      title={gif.title}
    >
      {!loaded && !error && (
        <Skeleton className="absolute inset-0 rounded-none" />
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <ImageOff className="size-5 text-muted-foreground/40" />
        </div>
      )}

      {/* KLIPY's muted MP4 renditions; favorites without preview metadata fall back to the GIF. */}
      {sources.length > 0 ? (
        <video
          ref={videoRef}
          autoPlay={!reduced}
          loop
          muted
          playsInline
          aria-label={gif.title}
          disablePictureInPicture
          className={cn(
            // `pointer-events-none` passes taps to the tile and keeps long-press off the
            // WebView's native media menu.
            'pointer-events-none w-full h-full object-cover transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoadedData={() => setLoaded(true)}
        >
          {sources.map((source, i) => (
            <source
              key={source.src}
              src={source.src}
              type={source.type}
              onError={i === sources.length - 1 ? () => setError(true) : undefined}
            />
          ))}
        </video>
      ) : (
        <MotionImg
          src={gif.url}
          alt={gif.title}
          className={cn(
            'pointer-events-none w-full h-full object-cover transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      )}

      {onToggleFavorite && (
        <div
          className="absolute top-1.5 right-1.5 z-10"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onToggleFavorite(gif);
          }}
        >
          <span
            role="button"
            tabIndex={0}
            className={cn(
              'flex items-center justify-center size-7 touch:size-9 clip-corner backdrop-blur-sm transition-colors cursor-pointer',
              isFavorite
                ? 'bg-amber-500/90 text-white opacity-100'
                : 'bg-black/40 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-black/60',
            )}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                onToggleFavorite(gif);
              }
            }}
            title={isFavorite
              ? intl.formatMessage({ id: 'gifPicker.removeFavorite', defaultMessage: 'Remove from favorites' })
              : intl.formatMessage({ id: 'gifPicker.addFavorite', defaultMessage: 'Add to favorites' })}
          >
            <Star className={cn('size-3.5', isFavorite && 'fill-current')} />
          </span>
        </div>
      )}

      {/* Drawn inside: an outer ring would be cut off by the tile's clip-path. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] clip-corner-lg-ring opacity-0 transition-opacity [--ring-edge:hsl(var(--primary)/0.8)] group-hover:opacity-100 group-focus-visible:opacity-100"
      />

      <div className={cn(
        'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent',
        'px-2 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150',
      )}>
        <span className="text-3xs text-white line-clamp-1 font-medium">
          {gif.title}
        </span>
      </div>
    </button>
  );
}

/** Masonry-style multi-column grid for GIF results. */
function GifGrid({ results, columns: columnCount, onSelect, isFavorite, onToggleFavorite }: { results: GifResult[]; columns: number; onSelect: (gif: GifResult) => void; isFavorite?: (id: string) => boolean; onToggleFavorite?: (gif: GifResult) => void }) {
  const columns: GifResult[][] = Array.from({ length: columnCount }, () => []);
  const columnHeights = new Array<number>(columnCount).fill(0);

  for (const gif of results) {
    const height = thumbHeight(gif);

    let shortest = 0;
    for (let i = 1; i < columnCount; i++) {
      if (columnHeights[i] < columnHeights[shortest]) shortest = i;
    }
    columns[shortest].push(gif);
    columnHeights[shortest] += height + 8; // 8px gap
  }

  return (
    <div className="flex gap-2 px-3 pb-3">
      {columns.map((col, colIdx) => (
        <div key={colIdx} className="flex-1 flex flex-col gap-2">
          {col.map((gif) => (
            <GifThumbnail key={gif.id} gif={gif} onClick={onSelect} isFavorite={isFavorite?.(gif.id)} onToggleFavorite={onToggleFavorite} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function GifPicker({ onSelect, className }: GifPickerProps) {
  const intl = useIntl();
  const { query, setQuery, clearQuery, results, isLoading, isError, isSearching, providerName } = useGifSearch();
  const favoritesLabel = intl.formatMessage({ id: 'gifPicker.favorites', defaultMessage: 'Favorites' });
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const columnCount = isMobile ? 2 : 3;
  const { isFavorite, toggleFavorite, favoriteList, count: favoriteCount } = useFavoriteGifs();
  const [showFavorites, setShowFavorites] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!showFavorites) inputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [showFavorites]);

  const handleSelect = useCallback((gif: GifResult) => {
    void registerGifShare(gif.id);
    onSelect(gif);
  }, [onSelect]);

  const favorites = showFavorites ? favoriteList() : [];

  return (
    <div className={cn('flex flex-col w-full h-[min(360px,55dvh)] min-h-[220px] overflow-hidden', className)}>
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <SearchField
          ref={inputRef}
          value={query}
          onChange={(q) => {
            if (showFavorites) setShowFavorites(false);
            if (q) setQuery(q);
            else clearQuery();
          }}
          placeholder={intl.formatMessage(
            { id: 'gifPicker.searchProvider', defaultMessage: 'Search {provider}' },
            { provider: providerName },
          )}
          hint={intl.formatMessage(
            { id: 'gifPicker.poweredBy', defaultMessage: 'Powered by {provider}' },
            { provider: providerName },
          )}
          className="flex-1"
        />
        <button
          type="button"
          onClick={() => setShowFavorites((v) => !v)}
          aria-pressed={showFavorites}
          aria-label={favoritesLabel}
          title={favoritesLabel}
          className={cn(
            'flex size-9 touch:size-11 shrink-0 items-center justify-center clip-corner-lg transition-colors',
            showFavorites
              ? 'bg-primary text-primary-foreground'
              : 'bg-chrome text-muted-foreground hover:text-foreground',
          )}
        >
          <Star className={cn('size-4', showFavorites && 'fill-current')} />
        </button>
      </div>

      <div className="px-3 pb-1.5">
        <span className="text-2xs font-medium text-muted-foreground uppercase tracking-wider">
          {showFavorites
            ? favoriteCount > 0
              ? intl.formatMessage(
                { id: 'gifPicker.favoriteCount', defaultMessage: '{count, plural, one {# favorite} other {# favorites}}' },
                { count: favoriteCount },
              )
              : favoritesLabel
            : isSearching
              ? intl.formatMessage({ id: 'gifPicker.results', defaultMessage: 'Results' })
              : intl.formatMessage({ id: 'gifPicker.trending', defaultMessage: 'Trending' })}
        </span>
      </div>

      {showFavorites ? (
        <ScrollArea className="flex-1">
          {favorites.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <Star className="size-8 mb-2 opacity-40" />
              <p className="text-sm">
                <FormattedMessage id="gifPicker.noFavorites" defaultMessage="No favorite GIFs yet" />
              </p>
              <p className="text-xs mt-1">
                <FormattedMessage id="gifPicker.noFavoritesHint" defaultMessage="Tap the star on any GIF to save it here" />
              </p>
            </div>
          ) : (
            <GifGrid results={favorites} columns={columnCount} onSelect={handleSelect} isFavorite={isFavorite} onToggleFavorite={toggleFavorite} />
          )}
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="px-3 pb-3">
              <div className="flex gap-2">
                {Array.from({ length: columnCount }).map((_, col) => (
                  <div key={col} className="flex-1 flex flex-col gap-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton
                        key={i}
                        className="w-full rounded-[0.55rem] clip-corner-lg"
                        style={{ height: 60 + Math.random() * 50 }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <ImageOff className="size-8 mb-2 opacity-40" />
              <p className="text-sm">
                <FormattedMessage id="gifPicker.loadFailed" defaultMessage="Failed to load GIFs" />
              </p>
              <p className="text-xs mt-1">
                <FormattedMessage id="gifPicker.pleaseTryAgain" defaultMessage="Please try again" />
              </p>
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <p className="text-sm">
                <FormattedMessage id="gifPicker.noResults" defaultMessage="No GIFs found" />
              </p>
              <p className="text-xs mt-1">
                <FormattedMessage id="gifPicker.noResultsHint" defaultMessage="Try a different search term" />
              </p>
            </div>
          ) : (
            <GifGrid results={results} columns={columnCount} onSelect={handleSelect} isFavorite={isFavorite} onToggleFavorite={toggleFavorite} />
          )}
        </ScrollArea>
      )}
    </div>
  );
}
