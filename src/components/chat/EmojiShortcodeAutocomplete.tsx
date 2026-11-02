import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { getCaretCoordinates } from "@/lib/caretCoordinates";
import { useEmojiData, type EmojiMartData } from "@/lib/emojiData";
import { findEmojiShortcodeColon } from "@/lib/emojiShortcode";
import { usePortalDropdown } from "@/hooks/usePortalDropdown";
import { useCustomEmojis, type CustomEmoji } from "@/hooks/useCustomEmojis";
import { cn } from "@/lib/utils";

interface EmojiShortcodeAutocompleteProps {
  /** The textarea or single-line input the autocomplete is attached to. */
  textareaRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  content: string;
  onInsertEmoji: (params: { start: number; end: number; replacement: string }) => void;
  onCustomEmojiInsert?: (emoji: CustomEmoji) => void;
}

const MAX_RESULTS = 8;

interface EmojiResult {
  id: string;
  name: string;
  native?: string;
  customUrl?: string;
  /** Lower = better match. */
  score: number;
}

function buildEmojiIndex(data: EmojiMartData): Array<{ id: string; name: string; native: string; keywords: string[] }> {
  const { emojis, aliases } = data;

  const results: Array<{ id: string; name: string; native: string; keywords: string[] }> = [];

  for (const [id, emoji] of Object.entries(emojis)) {
    const native = emoji.skins?.[0]?.native;
    if (!native) continue;

    const aliasNames: string[] = [];
    for (const [alias, target] of Object.entries(aliases)) {
      if (target === id) {
        aliasNames.push(alias);
      }
    }

    results.push({
      id,
      name: emoji.name,
      native,
      keywords: [...(emoji.keywords || []), ...aliasNames],
    });
  }

  return results;
}

let emojiIndex: ReturnType<typeof buildEmojiIndex> | null = null;
function getEmojiIndex(data: EmojiMartData | undefined) {
  if (!data) return [];
  emojiIndex ??= buildEmojiIndex(data);
  return emojiIndex;
}

function searchEmojis(query: string, customEmojis: CustomEmoji[], data: EmojiMartData | undefined): EmojiResult[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const results: EmojiResult[] = [];

  for (const emoji of customEmojis) {
    const sc = emoji.shortcode.toLowerCase();
    if (sc === q) {
      results.push({ id: `custom:${emoji.shortcode}`, name: emoji.shortcode, customUrl: emoji.url, score: -1 });
    } else if (sc.startsWith(q)) {
      results.push({ id: `custom:${emoji.shortcode}`, name: emoji.shortcode, customUrl: emoji.url, score: 0 });
    } else if (sc.includes(q)) {
      results.push({ id: `custom:${emoji.shortcode}`, name: emoji.shortcode, customUrl: emoji.url, score: 1 });
    }
  }

  const index = getEmojiIndex(data);
  for (const emoji of index) {
    if (emoji.id === q) {
      results.push({ id: emoji.id, name: emoji.name, native: emoji.native, score: 2 });
    } else if (emoji.id.startsWith(q)) {
      results.push({ id: emoji.id, name: emoji.name, native: emoji.native, score: 3 });
    } else if (emoji.id.includes(q)) {
      results.push({ id: emoji.id, name: emoji.name, native: emoji.native, score: 4 });
    } else if (emoji.name.toLowerCase().startsWith(q)) {
      results.push({ id: emoji.id, name: emoji.name, native: emoji.native, score: 5 });
    } else if (emoji.name.toLowerCase().includes(q)) {
      results.push({ id: emoji.id, name: emoji.name, native: emoji.native, score: 6 });
    } else if (emoji.keywords?.some((kw: string) => kw.startsWith(q) || kw.includes(q))) {
      results.push({ id: emoji.id, name: emoji.name, native: emoji.native, score: 7 });
    }
  }

  results.sort((a, b) => a.score - b.score);
  return results.slice(0, MAX_RESULTS);
}

/**
 * `:shortcode` autocomplete at the caret; inserts the native character or
 * `:shortcode:` for custom emojis.
 */
export function EmojiShortcodeAutocomplete({
  textareaRef,
  content,
  onInsertEmoji,
  onCustomEmojiInsert,
}: EmojiShortcodeAutocompleteProps) {
  const { emojis: customEmojis } = useCustomEmojis();

  const [query, setQuery] = useState("");
  const [colonStart, setColonStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ bottom: number; left: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => setIsOpen(false), []);
  const { computeBottomPosition, renderPortal } = usePortalDropdown({
    textareaRef,
    isOpen,
    onClose: handleClose,
    dropdownHeight: 280, // must match max-h-[280px] below
  });

  // Loaded once a shortcode is being typed; custom emoji match before then.
  const data = useEmojiData(query.length > 0);
  const results = useMemo(() => searchEmojis(query, customEmojis, data), [query, customEmojis, data]);

  const detectShortcode = useCallback((text?: string, cursorPos?: number | null) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = text ?? textarea.value;
    const cursor = cursorPos ?? textarea.selectionStart ?? value.length;
    const colonPos = findEmojiShortcodeColon(value, cursor);

    if (colonPos === -1) {
      setIsOpen(false);
      setQuery("");
      setColonStart(-1);
      return;
    }

    const q = value.slice(colonPos + 1, cursor);

    if (q.length < 2 || q.length > 32 || q.includes(":")) {
      setIsOpen(false);
      setQuery("");
      setColonStart(-1);
      return;
    }

    setQuery(q);
    setColonStart(colonPos);
    setIsOpen(true);
    setSelectedIndex(0);

    const coords = getCaretCoordinates(textarea, colonPos);
    setDropdownPos(computeBottomPosition(coords));
  }, [textareaRef, computeBottomPosition]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleInput = () => {
      detectShortcode(textarea.value, textarea.selectionStart);
    };
    const handleClick = () => detectShortcode();
    const handleKeyUp = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        detectShortcode();
      }
    };

    textarea.addEventListener("input", handleInput);
    textarea.addEventListener("click", handleClick);
    textarea.addEventListener("keyup", handleKeyUp);

    return () => {
      textarea.removeEventListener("input", handleInput);
      textarea.removeEventListener("click", handleClick);
      textarea.removeEventListener("keyup", handleKeyUp);
    };
  }, [textareaRef, detectShortcode, content]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    detectShortcode(content, textarea.selectionStart);
  }, [content, detectShortcode, textareaRef]);

  const selectEmoji = useCallback((emoji: EmojiResult) => {
    // Derived from the tracked colon, not selectionStart: tapping the portal
    // dropdown can collapse the selection on touch.
    const cursor = colonStart + query.length + 1;

    if (emoji.customUrl) {
      const shortcode = emoji.name;
      onInsertEmoji({
        start: colonStart,
        end: cursor,
        replacement: `:${shortcode}: `,
      });
      const entry = customEmojis.find((e) => e.shortcode === shortcode);
      if (entry && onCustomEmojiInsert) {
        onCustomEmojiInsert(entry);
      }
    } else if (emoji.native) {
      onInsertEmoji({
        start: colonStart,
        end: cursor,
        replacement: emoji.native,
      });
    }

    setIsOpen(false);
    setQuery("");
    setColonStart(-1);
  }, [colonStart, query, onInsertEmoji, onCustomEmojiInsert, customEmojis]);

  useEffect(() => {
    if (!isOpen || results.length === 0) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
          break;
        case "Enter":
        case "Tab":
          if (results.length > 0) {
            e.preventDefault();
            e.stopImmediatePropagation();
            selectEmoji(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          break;
      }
    };

    textarea.addEventListener("keydown", handleKeyDown);
    return () => textarea.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, results, selectedIndex, textareaRef, selectEmoji]);

  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-emoji-item]");
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen || !dropdownPos || results.length === 0) {
    return null;
  }

  const dropdown = (
    <div
      data-autocomplete-dropdown
      className="fixed z-[300] w-[280px] max-w-[calc(100vw-1rem)] vessel-lift pointer-events-auto"
      style={{ bottom: dropdownPos.bottom, left: dropdownPos.left }}
    >
      <div className="vessel overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150">
        <div ref={listRef} className="max-h-[280px] overflow-y-auto scroll-py-1 p-1">
          {results.map((emoji, index) => (
            <button
              key={emoji.id}
              data-emoji-item
              data-highlighted={index === selectedIndex || undefined}
              className={cn(
                "relative w-full flex items-center gap-3 menu-row clip-corner px-2 py-1.5 text-left text-popover-foreground transition-colors cursor-pointer",
                index === selectedIndex ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
              )}
              // Pointer-down fires reliably on touch; preventDefault keeps composer focus.
              onPointerDown={(e) => {
                e.preventDefault();
                selectEmoji(emoji);
              }}
            >
              {emoji.customUrl ? (
                <CustomEmojiImg
                  name={emoji.name}
                  url={emoji.customUrl}
                  className="size-5 object-contain shrink-0"
                />
              ) : (
                <span className="text-xl leading-none shrink-0">{emoji.native}</span>
              )}
              <span className="text-sm truncate">
                :{emoji.id.replace("custom:", "")}:
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return renderPortal(dropdown, document.body);
}
