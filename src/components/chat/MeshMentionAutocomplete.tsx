import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getCaretCoordinates } from "@/lib/caretCoordinates";
import { usePortalDropdown } from "@/hooks/usePortalDropdown";
import { meshIdentity, meshMentionToken, type MeshIdentity } from "@/lib/meshIdentity";
import { menuPickHandlers } from "@/lib/menuPick";
import { cn } from "@/lib/utils";

import type { MeshPeer } from "@/lib/bluetoothMesh";

interface MeshMentionAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  peers: MeshPeer[];
  /** Splice the `@name#suffix ` token into the draft. */
  onInsertMention: (params: { start: number; end: number; replacement: string }) => void;
}

interface MeshCandidate extends MeshIdentity {
  peerID: string;
}

/**
 * Mesh `@`-mention autocomplete over nearby peers; inserts a plain-text
 * `@name#suffix` token that survives BLE (and reads on bitchat).
 */
export function MeshMentionAutocomplete({
  textareaRef,
  content,
  peers,
  onInsertMention,
}: MeshMentionAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [mentionStart, setMentionStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ bottom: number; left: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => setIsOpen(false), []);
  const { renderPortal } = usePortalDropdown({
    textareaRef,
    isOpen,
    onClose: handleClose,
    dropdownHeight: 240,
  });

  const q = query.trim().toLowerCase();
  const candidates: MeshCandidate[] = useMemo(
    () =>
      isOpen
        ? peers
            .map((p) => ({ peerID: p.peerID, ...meshIdentity(p.peerID, p.nickname) }))
            .filter((c) => !q || c.name.toLowerCase().includes(q) || c.suffix.includes(q))
        : [],
    [isOpen, peers, q],
  );

  const detectMention = useCallback(
    (text?: string, cursorPos?: number) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursor = cursorPos ?? textarea.selectionStart;
      const value = text ?? textarea.value;

      // An `@` at start-of-line or after a space.
      let atPos = -1;
      for (let i = cursor - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === " " || ch === "\n" || ch === "\t") break;
        if (ch === "@") {
          if (i === 0 || /\s/.test(value[i - 1])) atPos = i;
          break;
        }
      }

      if (atPos === -1) {
        setIsOpen(false);
        setQuery("");
        setMentionStart(-1);
        return;
      }

      const partial = value.slice(atPos + 1, cursor);
      if (partial.length > 50) {
        setIsOpen(false);
        return;
      }

      setQuery(partial);
      setMentionStart(atPos);
      setIsOpen(true);
      setSelectedIndex(0);

      const caret = getCaretCoordinates(textarea, atPos);
      const rect = textarea.getBoundingClientRect();
      setDropdownPos({
        bottom: window.innerHeight - rect.top + 6,
        left: Math.max(8, Math.min(rect.left + caret.left, window.innerWidth - 280 - 8)),
      });
    },
    [textareaRef],
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const onInput = () => detectMention(textarea.value, textarea.selectionStart);
    const onClick = () => detectMention();
    const onKeyUp = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) detectMention();
    };
    textarea.addEventListener("input", onInput);
    textarea.addEventListener("click", onClick);
    textarea.addEventListener("keyup", onKeyUp);
    return () => {
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("click", onClick);
      textarea.removeEventListener("keyup", onKeyUp);
    };
  }, [textareaRef, detectMention]);

  // Re-detect on external changes (e.g. a slash command seeds `@`).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    detectMention(content, textarea.selectionStart);
  }, [content, detectMention, textareaRef]);

  const selectCandidate = useCallback(
    (candidate: MeshCandidate) => {
      const cursor = textareaRef.current?.selectionStart ?? mentionStart + query.length + 1;
      onInsertMention({
        start: mentionStart,
        end: cursor,
        replacement: `${meshMentionToken(candidate)} `,
      });
      setIsOpen(false);
      setQuery("");
      setMentionStart(-1);
    },
    [mentionStart, query, textareaRef, onInsertMention],
  );

  useEffect(() => {
    if (!isOpen || candidates.length === 0) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((p) => (p < candidates.length - 1 ? p + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((p) => (p > 0 ? p - 1 : candidates.length - 1));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          e.stopImmediatePropagation();
          selectCandidate(candidates[selectedIndex]);
          break;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          break;
      }
    };
    textarea.addEventListener("keydown", onKeyDown);
    return () => textarea.removeEventListener("keydown", onKeyDown);
  }, [isOpen, candidates, selectedIndex, textareaRef, selectCandidate]);

  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-mesh-mention-item]");
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen || !dropdownPos || candidates.length === 0) return null;

  const dropdown = (
    <div
      data-autocomplete-dropdown
      className="fixed z-[300] w-[280px] vessel-lift pointer-events-auto"
      style={{ bottom: dropdownPos.bottom, left: dropdownPos.left }}
    >
      <div className="vessel overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150">
        <div ref={listRef} className="max-h-[240px] overflow-y-auto scroll-py-1 p-1">
          {candidates.map((candidate, index) => (
            <button
              key={candidate.peerID}
              data-mesh-mention-item
              data-highlighted={index === selectedIndex || undefined}
              className={cn(
                "relative w-full flex items-center gap-3 menu-row clip-corner px-2 py-1.5 text-left transition-colors cursor-pointer",
                index === selectedIndex ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
              )}
              {...menuPickHandlers(() => selectCandidate(candidate))}
            >
              <span
                className="size-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold"
                style={{ backgroundColor: `${candidate.color}33`, color: candidate.color }}
              >
                {candidate.name[0]?.toUpperCase() || "?"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate" style={{ color: candidate.color }}>
                  {candidate.name}
                </div>
                <div className="text-2xs text-muted-foreground truncate font-mono">
                  #{candidate.suffix}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return renderPortal(dropdown, document.body);
}
