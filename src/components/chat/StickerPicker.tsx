import { useState, useMemo, useRef, useEffect, useId } from 'react';
import { Sticker } from 'lucide-react';
import { SearchField } from '@/components/ui/search-field';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CustomEmojiImg } from '@/components/chat/CustomEmoji';
import { paletteSections, type CustomEmojiSection } from '@/lib/customEmoji';
import type { CustomEmoji } from '@/hooks/useCustomEmojis';
import { FormattedMessage, useIntl } from '@/i18n';

interface StickerPickerProps {
  customEmojis: CustomEmoji[];
  onSelect: (emoji: CustomEmoji) => void;
  /** Fixed height for the picker. Defaults to 350px. */
  height?: number;
  /** Auto-focus the search input on mount (default true on desktop). */
  autoFocus?: boolean;
}

export function StickerPicker({ customEmojis, onSelect, height = 350, autoFocus = true }: StickerPickerProps) {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  const sections = useMemo(() => {
    const all = paletteSections(customEmojis);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all
      .map((section) => ({ ...section, emojis: section.emojis.filter((e) => e.shortcode.toLowerCase().includes(q)) }))
      .filter((section) => section.emojis.length > 0);
  }, [customEmojis, query]);

  if (customEmojis.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-muted-foreground gap-2" style={{ height }}>
        <Sticker className="size-8 opacity-40" />
        <p className="text-sm">
          <FormattedMessage id="stickerPicker.noPacks" defaultMessage="No sticker packs yet" />
        </p>
        <p className="text-xs">
          <FormattedMessage id="stickerPicker.noPacksHint" defaultMessage="Add emoji packs to your profile to use stickers" />
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ height }}>
      <div className="px-3 pt-3 pb-2 shrink-0">
        <SearchField ref={inputRef} value={query} onChange={setQuery} placeholder={intl.formatMessage({ id: "stickerPicker.search", defaultMessage: "Search stickers" })} />
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {sections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <p className="text-sm">
              <FormattedMessage id="stickerPicker.noResults" defaultMessage="No stickers found" />
            </p>
            <p className="text-xs mt-1">
              <FormattedMessage id="stickerPicker.noResultsHint" defaultMessage="Try a different search term" />
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-3 pb-3">
            {sections.map((section) => (
              <StickerSection key={section.key} section={section} onSelect={onSelect} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function StickerSection({ section, onSelect }: { section: CustomEmojiSection; onSelect: (emoji: CustomEmoji) => void }) {
  const intl = useIntl();
  const headingId = useId();
  const name =
    section.source === 'workspace'
      ? intl.formatMessage({ id: 'stickerPicker.workspace', defaultMessage: 'Workspace' })
      : section.name ?? intl.formatMessage({ id: 'stickerPicker.custom', defaultMessage: 'Custom' });
  return (
    <div role="group" aria-labelledby={headingId}>
      <div id={headingId} className="pb-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wider truncate">
        {name}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {section.emojis.map((emoji) => (
          <button
            key={emoji.shortcode}
            type="button"
            title={emoji.shortcode}
            onClick={() => onSelect(emoji)}
            className="aspect-square clip-corner-lg overflow-hidden hover:bg-muted transition-colors p-1 group"
          >
            <CustomEmojiImg
              name={emoji.shortcode}
              url={emoji.url}
              className="w-full h-full object-contain group-hover:scale-110 transition-transform duration-150"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
