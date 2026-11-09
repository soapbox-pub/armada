import { nip19 } from "nostr-tools";
import { AtSign, UsersRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BotPill } from "@/components/BotPill";
import { UltraPill } from "@/components/UltraPill";
import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { usePortalDropdown } from "@/hooks/usePortalDropdown";
import { useSearchProfiles, useMemberProfiles, type SearchProfile } from "@/hooks/useSearchProfiles";
import { getAvatarShape } from "@/lib/avatarShape";
import { getCaretCoordinates } from "@/lib/caretCoordinates";
import { menuPickHandlers } from "@/lib/menuPick";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";
import { parseProfileImeta } from "@/lib/profileImeta";
import { AvatarInitial } from "@/components/AvatarInitial";

interface MentionAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  onInsertMention: (params: { start: number; end: number; replacement: string }) => void;
  /** Restrict candidates to these pubkeys (room members) instead of all of Nostr. */
  restrictToPubkeys?: string[];
  /** Offer Concord's @everyone; the caller has checked MENTION_EVERYONE. */
  allowEveryone?: boolean;
  /** Where an already-inserted `@Name` mention begins: not a query. */
  isMentionStart?: (pos: number) => boolean;
  /** Concord Roles this author may ping (CORD-04 §8); picking one inserts `@Name`. */
  roles?: readonly MentionRole[];
  onPickRole?: (roleId: string) => void;
}

export interface MentionRole {
  id: string;
  name: string;
}

/** `@query` profile autocomplete at the caret; inserts `nostr:npub1...` (NIP-27). */
export function MentionAutocomplete({
  textareaRef,
  content,
  onInsertMention,
  restrictToPubkeys,
  allowEveryone = false,
  isMentionStart,
  roles,
  onPickRole,
}: MentionAutocompleteProps) {
  const [mentionQuery, setMentionQuery] = useState("");
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
    dropdownHeight: 240, // must match max-h-[240px] below
  });

  const restricted = Array.isArray(restrictToPubkeys);
  const { data: searchProfiles } = useSearchProfiles(isOpen && !restricted ? mentionQuery : "");
  const memberProfiles = useMemberProfiles(restrictToPubkeys ?? [], isOpen ? mentionQuery : "");
  const profiles = restricted ? memberProfiles : searchProfiles;
  const showEveryone = allowEveryone
    && "everyone".startsWith(mentionQuery.trim().toLowerCase());
  const query = mentionQuery.trim().toLowerCase();
  const roleMatches = (roles ?? []).filter((r) => r.name !== "" && r.name.toLowerCase().startsWith(query)).slice(0, 8);
  const profileCount = profiles?.length ?? 0;
  const itemCount = profileCount + roleMatches.length + (showEveryone ? 1 : 0);

  const detectMention = useCallback((text?: string, cursorPos?: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursor = cursorPos ?? textarea.selectionStart;
    const value = text ?? textarea.value;

    let atPos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === " " || ch === "\n" || ch === "\t") break;
      if (ch === "@") {
        if (i === 0 || /\s/.test(value[i - 1])) {
          atPos = i;
        }
        break;
      }
    }

    if (atPos === -1 || isMentionStart?.(atPos)) {
      setIsOpen(false);
      setMentionQuery("");
      setMentionStart(-1);
      return;
    }

    const query = value.slice(atPos + 1, cursor);

    if (query.length > 50) {
      setIsOpen(false);
      setMentionQuery("");
      setMentionStart(-1);
      return;
    }

    setMentionQuery(query);
    setMentionStart(atPos);
    setIsOpen(true);
    setSelectedIndex(0);

    // Anchor the bottom just above the composer; track the caret horizontally.
    const caret = getCaretCoordinates(textarea, atPos);
    const rect = textarea.getBoundingClientRect();
    setDropdownPos({
      bottom: window.innerHeight - rect.top + 6,
      left: Math.max(8, Math.min(rect.left + caret.left, window.innerWidth - 280 - 8)),
    });
  }, [textareaRef, isMentionStart]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleInput = () => {
      detectMention(textarea.value, textarea.selectionStart);
    };
    const handleClick = () => detectMention();
    const handleKeyUp = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        detectMention();
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
  }, [textareaRef, detectMention, content]);

  // Re-detect on external content changes (e.g. emoji insertion).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    detectMention(content, textarea.selectionStart);
  }, [content, detectMention, textareaRef]);

  const selectProfile = useCallback((profile: SearchProfile) => {
    const npub = nip19.npubEncode(profile.pubkey);
    const replacement = `nostr:${npub} `;
    const cursor = textareaRef.current?.selectionStart ?? mentionStart + mentionQuery.length + 1;

    onInsertMention({
      start: mentionStart,
      end: cursor,
      replacement,
    });

    setIsOpen(false);
    setMentionQuery("");
    setMentionStart(-1);
  }, [mentionStart, mentionQuery, textareaRef, onInsertMention]);

  const selectEveryone = useCallback(() => {
    const cursor = textareaRef.current?.selectionStart ?? mentionStart + mentionQuery.length + 1;
    onInsertMention({ start: mentionStart, end: cursor, replacement: "@everyone " });
    setIsOpen(false);
    setMentionQuery("");
    setMentionStart(-1);
  }, [mentionStart, mentionQuery, textareaRef, onInsertMention]);

  const selectRole = useCallback((role: MentionRole) => {
    const cursor = textareaRef.current?.selectionStart ?? mentionStart + mentionQuery.length + 1;
    onInsertMention({ start: mentionStart, end: cursor, replacement: `@${role.name} ` });
    onPickRole?.(role.id);
    setIsOpen(false);
    setMentionQuery("");
    setMentionStart(-1);
  }, [mentionStart, mentionQuery, textareaRef, onInsertMention, onPickRole]);

  useEffect(() => {
    if (!isOpen || itemCount === 0) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev < itemCount - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : itemCount - 1));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          e.stopImmediatePropagation();
          if (profiles && selectedIndex < profileCount) selectProfile(profiles[selectedIndex]);
          else if (selectedIndex < profileCount + roleMatches.length) selectRole(roleMatches[selectedIndex - profileCount]);
          else if (showEveryone) selectEveryone();
          break;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          break;
      }
    };

    textarea.addEventListener("keydown", handleKeyDown);
    return () => textarea.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, itemCount, profiles, profileCount, roleMatches, selectedIndex, textareaRef, selectProfile, selectRole, selectEveryone, showEveryone]);

  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-mention-item]");
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen || !dropdownPos || itemCount === 0) {
    return null;
  }

  const dropdown = (
    <div
      data-autocomplete-dropdown
      className="fixed z-[300] w-[280px] max-w-[calc(100vw-1rem)] vessel-lift pointer-events-auto"
      style={{ bottom: dropdownPos.bottom, left: dropdownPos.left }}
    >
      <div className="vessel overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150">
        <div ref={listRef} className="max-h-[240px] overflow-y-auto scroll-py-1 p-1">
          {(profiles ?? []).map((profile, index) => (
            <MentionItem
              key={profile.pubkey}
              profile={profile}
              isSelected={index === selectedIndex}
              onSelect={() => selectProfile(profile)}
            />
          ))}
          {roleMatches.map((role, index) => (
            <RoleMentionItem
              key={role.id}
              name={role.name}
              isSelected={selectedIndex === profileCount + index}
              onSelect={() => selectRole(role)}
            />
          ))}
          {showEveryone && (
            <EveryoneMentionItem
              isSelected={selectedIndex === profileCount + roleMatches.length}
              onSelect={selectEveryone}
            />
          )}
        </div>
      </div>
    </div>
  );

  // Portal escapes overflow clipping.
  return renderPortal(dropdown, document.body);
}

function RoleMentionItem({
  name,
  isSelected,
  onSelect,
}: {
  name: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      data-mention-item
      data-highlighted={isSelected || undefined}
      className={cn(
        "relative w-full flex items-center gap-3 menu-row clip-corner px-2 py-1.5 text-left transition-colors cursor-pointer",
        isSelected ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
      )}
      {...menuPickHandlers(onSelect)}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
        <AtSign className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">@{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          <FormattedMessage id="mentionAutocomplete.roleDescription" defaultMessage="Notify everyone with this role" />
        </span>
      </span>
    </button>
  );
}

function EveryoneMentionItem({
  isSelected,
  onSelect,
}: {
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      data-mention-item
      data-highlighted={isSelected || undefined}
      className={cn(
        "relative w-full flex items-center gap-3 menu-row clip-corner px-2 py-1.5 text-left transition-colors cursor-pointer",
        isSelected ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
      )}
      {...menuPickHandlers(onSelect)}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
        <UsersRound className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">@everyone</span>
        <span className="block truncate text-xs text-muted-foreground">
          <FormattedMessage id="mentionAutocomplete.everyoneDescription" defaultMessage="Notify everyone in this channel" />
        </span>
      </span>
    </button>
  );
}

function MentionItem({
  profile,
  isSelected,
  onSelect,
}: {
  profile: SearchProfile;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const intl = useIntl();
  const { metadata, pubkey } = profile;
  const displayName = metadata.name || metadata.display_name
    || intl.formatMessage({ id: "mentionAutocomplete.anonymous", defaultMessage: "Anonymous" });
  const identifier = metadata.nip05 || nip19.npubEncode(pubkey);

  return (
    <button
      data-mention-item
      data-highlighted={isSelected || undefined}
      className={cn(
        "relative w-full flex items-center gap-3 menu-row clip-corner px-2 py-1.5 text-left transition-colors cursor-pointer",
        isSelected ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
      )}
      {...menuPickHandlers(onSelect)}
    >
      <Avatar shape={getAvatarShape(metadata)} className="size-8 shrink-0">
        <AvatarImage src={metadata.picture} imeta={parseProfileImeta(profile.event.tags, metadata)?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          <AvatarInitial name={displayName} pubkey={pubkey} />
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="font-semibold text-sm truncate">
            <DisplayName pubkey={pubkey} name={displayName} tags={profile.event.tags} />
          </div>
          <BotPill metadata={metadata} />
          <UltraPill metadata={metadata} interactive={false} />
        </div>
        <div className="text-xs text-muted-foreground truncate font-mono text-2xs">
          {identifier}
        </div>
      </div>
    </button>
  );
}
