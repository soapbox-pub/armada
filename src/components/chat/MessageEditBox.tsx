import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { MentionAutocomplete } from "@/components/chat/MentionAutocomplete";
import { MentionRosterContext } from "@/components/chat/mentionRoster";
import { RichTextarea } from "@/components/chat/RichTextarea";
import { useRichText } from "@/components/chat/useRichText";
import { useAutosizeTextarea } from "@/hooks/useAutosizeTextarea";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { FormattedMessage, common } from "@/i18n";

interface MessageEditBoxProps {
  /** The message's canonical content. */
  content: string;
  /** The message's tags: its own NIP-30 emoji draw as images too. */
  tags: string[][];
  sendOnEnter: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

/** In-place edit of a sent message: the composer's mention rendering and autocomplete, and its markdown. */
export function MessageEditBox({ content, tags, sendOnEnter, onSubmit, onCancel }: MessageEditBoxProps) {
  const [text, setText] = useState(content);
  useEffect(() => setText(content), [content]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { emojis } = useCustomEmojis();
  const emojiUrl = useMemo(() => {
    const urls = new Map(emojis.map((e) => [e.shortcode, e.url]));
    for (const [name, code, url] of tags) if (name === "emoji" && code && url) urls.set(code, url);
    return (shortcode: string) => urls.get(shortcode);
  }, [emojis, tags]);
  const rich = useRichText({ value: text, onValueChange: setText, textareaRef, emojiUrl });
  const { replaceRange } = rich.handle;
  const insertMention = useCallback(
    ({ start, end, replacement }: { start: number; end: number; replacement: string }) => replaceRange(start, end, replacement),
    [replaceRange],
  );
  // An edit carries content only, so it offers profiles but no @everyone or roles (nothing would notify).
  const mentionRoster = useContext(MentionRosterContext);
  const autosizeRef = useAutosizeTextarea(rich.display);
  // Place the caret at the end when an edit opens (autoFocus puts it at the start).
  const caretPlacedRef = useRef(false);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      autosizeRef(el);
      if (!el) {
        caretPlacedRef.current = false;
        return;
      }
      if (caretPlacedRef.current) return;
      caretPlacedRef.current = true;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    },
    [autosizeRef],
  );

  return (
    <div className="relative mt-0.5">
      <RichTextarea
        rich={rich}
        ref={setRef}
        onKeyDown={(e) => {
          // The mention menu claims Enter/Tab/Escape while open; Enter may also be confirming an IME composition.
          if (e.defaultPrevented || e.nativeEvent.isComposing) return;
          const saveKey = sendOnEnter
            ? e.key === "Enter" && !e.shiftKey
            : e.key === "Enter" && (e.ctrlKey || e.metaKey);
          if (saveKey) {
            e.preventDefault();
            onSubmit(text);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={1}
        className="block w-full resize-none rounded-md bg-background border border-input px-2 py-1.5 text-chat max-h-40 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {mentionRoster && (
        <MentionAutocomplete
          textareaRef={textareaRef}
          content={rich.display}
          isMentionStart={rich.handle.isMentionStart}
          onInsertMention={insertMention}
          restrictToPubkeys={mentionRoster}
        />
      )}
      <div className="flex items-center gap-2 touch:gap-4 mt-1 text-2xs text-muted-foreground">
        <button
          type="button"
          className="font-semibold text-primary hover:underline touch:py-2"
          onClick={() => onSubmit(text)}
        >
          <FormattedMessage {...common.save} />
        </button>
        <button type="button" className="hover:text-foreground touch:py-2" onClick={onCancel}>
          <FormattedMessage {...common.cancel} />
        </button>
        <span className="opacity-70">
          <FormattedMessage id="messageEditBox.hint" defaultMessage="escape to cancel · enter to save" />
        </span>
      </div>
    </div>
  );
}
