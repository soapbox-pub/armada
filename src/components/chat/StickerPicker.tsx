import { useState, useMemo, useRef, useEffect, useId } from 'react';
import { Sticker } from 'lucide-react';
import { SearchField } from '@/components/ui/search-field';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CustomEmojiImg } from '@/components/chat/CustomEmoji';
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

  // One section per source pack, as in EmojiPicker; stickers inlined on the
  // kind-10030 list share a "Custom" section.
  const packs = useMemo(() => {
    const q = query.trim() ? query.toLowerCase() : '';
    const customLabel = intl.formatMessage({ id: 'emojiPicker.custom', defaultMessage: 'Custom' });
    const groups = new Map<string, StickerPack>();
    for (const e of customEmojis) {
      if (q && !e.shortcode.toLowerCase().includes(q)) continue;
      const key = e.packCoord ?? '';
      let group = groups.get(key);
      if (!group) {
        groups.set(key, (group = { key, name: (key && e.packName) || customLabel, stickers: [] }));
      }
      group.stickers.push(e);
    }
    return [...groups.values()];
  }, [customEmojis, query, intl]);

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
        {packs.length === 0 ? (
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
            {packs.map((pack) => (
              <StickerPackSection key={pack.key} pack={pack} onSelect={onSelect} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface StickerPack {
  /** The pack's `30030:pubkey:dtag`, or '' for stickers inlined on the list. */
  key: string;
  name: string;
  stickers: CustomEmoji[];
}

function StickerPackSection({ pack, onSelect }: { pack: StickerPack; onSelect: (emoji: CustomEmoji) => void }) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId}>
      <div id={headingId} className="pb-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wider truncate">
        {pack.name}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {pack.stickers.map((emoji) => (
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
