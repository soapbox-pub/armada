import { useState, useMemo, useRef, useEffect, useId } from 'react';
import { Sticker } from 'lucide-react';
import { SearchField } from '@/components/ui/search-field';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CustomEmojiImg } from '@/components/chat/CustomEmoji';
import { paletteSections, type CustomEmojiSection } from '@/lib/customEmoji';
import type { CustomEmoji } from '@/hooks/useCustomEmojis';
import { FormattedMessage, useIntl, type IntlShape } from '@/i18n';

interface StickerPickerProps {
  customEmojis: CustomEmoji[];
  onSelect: (emoji: CustomEmoji) => void;
  /** Fixed height for the picker. Defaults to 350px. */
  height?: number;
  /** Auto-focus the search input on mount (default true on desktop). */
  autoFocus?: boolean;
}

/** The scrolling element is Radix's viewport inside the ScrollArea root, not the root itself. */
function viewportOf(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? null;
}

export function StickerPicker({ customEmojis, onSelect, height = 350, autoFocus = true }: StickerPickerProps) {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  useEffect(() => {
    const viewport = viewportOf(scrollRef.current);
    const list = listRef.current;
    if (!viewport || !list) return;
    const update = () => {
      if (jumpTimer.current !== undefined) {
        // The scroll a tab click started: keep the clicked pack until it stops.
        holdJump();
        return;
      }
      const top = viewport.getBoundingClientRect().top;
      let index = 0;
      if (viewport.scrollTop > 0 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1) {
        // A short last pack never reaches the top, so the end of the list selects it.
        index = list.children.length - 1;
      } else {
        for (let i = 0; i < list.children.length; i++) {
          if (list.children[i].getBoundingClientRect().top - top <= 8) index = i;
        }
      }
      setActiveKey(sections[index]?.key ?? null);
    };
    // Input from the user ends a jump's hold, so the scroll they take over is followed.
    const takeOver = () => {
      clearTimeout(jumpTimer.current);
      jumpTimer.current = undefined;
    };
    const takeOverEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    viewport.addEventListener('scroll', update, { passive: true });
    for (const type of takeOverEvents) viewport.addEventListener(type, takeOver, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', update);
      for (const type of takeOverEvents) viewport.removeEventListener(type, takeOver);
    };
  }, [sections]);

  const changeQuery = (value: string) => {
    setQuery(value);
    setActiveKey(null);
    clearTimeout(jumpTimer.current);
    jumpTimer.current = undefined;
    const viewport = viewportOf(scrollRef.current);
    if (viewport) viewport.scrollTop = 0;
  };

  useEffect(() => () => clearTimeout(jumpTimer.current), []);

  const holdJump = () => {
    clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => { jumpTimer.current = undefined; }, 150);
  };

  const jumpTo = (index: number) => {
    const viewport = viewportOf(scrollRef.current);
    const target = listRef.current?.children[index];
    if (!viewport || !target) return;
    const top = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    holdJump();
    viewport.scrollTo({ top, behavior: 'smooth' });
    setActiveKey(sections[index].key);
  };

  const activeSectionKey = (sections.find((s) => s.key === activeKey) ?? sections[0])?.key;

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
        <SearchField ref={inputRef} value={query} onChange={changeQuery} placeholder={intl.formatMessage({ id: "stickerPicker.search", defaultMessage: "Search stickers" })} />
      </div>

      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
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
          <div ref={listRef} className="flex flex-col gap-3 px-3 pb-3">
            {sections.map((section) => (
              <StickerSection key={section.key} section={section} onSelect={onSelect} />
            ))}
          </div>
        )}
      </ScrollArea>

      {sections.length > 1 && (
        <nav
          aria-label={intl.formatMessage({ id: 'stickerPicker.packs', defaultMessage: 'Sticker packs' })}
          className="flex shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {sections.map((section, index) => {
            const name = sectionName(section, intl);
            const selected = section.key === activeSectionKey;
            return (
              <button
                key={section.key}
                type="button"
                aria-current={selected || undefined}
                aria-label={name}
                title={name}
                onClick={() => jumpTo(index)}
                className="relative flex h-10 touch:h-12 min-w-11 flex-1 items-center justify-center opacity-60 transition-opacity hover:opacity-100 aria-[current=true]:opacity-100"
              >
                <CustomEmojiImg name={section.emojis[0].shortcode} url={section.emojis[0].url} className="size-6 object-contain" />
                {selected && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

function sectionName(section: CustomEmojiSection, intl: IntlShape): string {
  if (section.source === 'workspace') return intl.formatMessage({ id: 'stickerPicker.workspace', defaultMessage: 'Workspace' });
  return section.name ?? intl.formatMessage({ id: 'stickerPicker.custom', defaultMessage: 'Custom' });
}

function StickerSection({ section, onSelect }: { section: CustomEmojiSection; onSelect: (emoji: CustomEmoji) => void }) {
  const intl = useIntl();
  const headingId = useId();
  const name = sectionName(section, intl);
  return (
    <div role="group" aria-labelledby={headingId}>
      <div id={headingId} className="sticky top-0 z-10 -mx-3 px-3 py-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wider truncate bg-background/70 backdrop-blur-md">
        {name}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1.5">
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
