import { AlertTriangle, GripVertical, ImagePlus, Loader2, Smile, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNostr } from "@nostrify/react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { FallbackImage } from "@/components/ui/FallbackImage";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  emojiPackCoord,
  KIND_EMOJI_SET,
  readOwnEmojiPack,
  useAddEmojiPack,
  type MyEmojiPack,
} from "@/hooks/useEmojiPacks";
import { useEventStore } from "@/hooks/useEventStore";
import { useFlipReorder } from "@/hooks/useFlipReorder";
import { usePressDrag } from "@/hooks/usePressDrag";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";

import type { NostrRumor } from "@/lib/nostrRumor";

interface Entry {
  id: string;
  shortcode: string;
  url: string;
  uploading: boolean;
}

/** Tags the form owns; an edit rewrites these and keeps every other tag. */
const MANAGED_TAGS = new Set(["d", "name", "title", "about", "image", "picture", "emoji"]);

/**
 * Sanitize a shortcode as typed. Doesn't trim underscores (that would eat a
 * trailing `_` per keystroke); `finalShortcode()` trims at publish time.
 */
function sanitizeShortcode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 32);
}

function finalShortcode(raw: string): string {
  return raw.replace(/^_+|_+$/g, "");
}

function shortcodeFromFilename(name: string): string {
  return finalShortcode(sanitizeShortcode(name.replace(/\.[a-z0-9]+$/i, "")));
}

function slugify(title: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "pack";
}

/** Where a dragged row lands: before `before` (null = last), with the indicator at `y`. */
interface InsertPoint {
  before: string | null;
  y: number;
}

/** Half the rows' `space-y-1.5`, so the indicator sits in the gap. */
const ROW_GAP_HALF = 3;

/** Insert before the first row whose middle is below `y`, else at the end. */
function planInsert(y: number, slots: { id: string; top: number; height: number }[]): InsertPoint {
  for (const s of slots) {
    if (y < s.top + s.height / 2) return { before: s.id, y: s.top - ROW_GAP_HALF };
  }
  const last = slots[slots.length - 1];
  return { before: null, y: last ? last.top + last.height + ROW_GAP_HALF : 0 };
}

function moveEntry(entries: Entry[], id: string, before: string | null): Entry[] {
  const moving = entries.find((e) => e.id === id);
  if (!moving || before === id) return entries;
  const rest = entries.filter((e) => e.id !== id);
  const at = before === null ? rest.length : rest.findIndex((e) => e.id === before);
  const out = [...rest];
  out.splice(at < 0 ? rest.length : at, 0, moving);
  return out.every((e, i) => e === entries[i]) ? entries : out;
}

function nextEntryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Files from a drop, descending into dropped folders. */
async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length === 0) return Array.from(dataTransfer.files);

  // Entries must be taken synchronously: the DataTransfer is emptied once the handler returns.
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  if (entries.length === 0) return loose.length ? loose : Array.from(dataTransfer.files);

  const readEntry = (entry: FileSystemEntry, out: File[]): Promise<void> =>
    new Promise((resolve) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file((file) => {
          out.push(file);
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        // readEntries returns at most ~100 entries per call; read until it returns none.
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const children: FileSystemEntry[] = [];
        const next = () =>
          reader.readEntries((batch) => {
            if (batch.length === 0) {
              void Promise.all(children.map((c) => readEntry(c, out))).then(() => resolve());
            } else {
              children.push(...batch);
              next();
            }
          }, () => resolve());
        next();
      } else {
        resolve();
      }
    });

  const collected = [...loose];
  await Promise.all(entries.map((entry) => readEntry(entry, collected)));
  return collected;
}

/** Create a NIP-30 emoji pack (kind 30030), or edit one of the user's own with `editEvent`. */
export function EmojiPackDialog({
  open,
  onOpenChange,
  editEvent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editEvent?: NostrRumor;
}) {
  const intl = useIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={editEvent ? intl.formatMessage({ id: "emojiPackDialog.editTitle", defaultMessage: "Edit emoji pack" }) : intl.formatMessage({ id: "emojiPackDialog.createTitle", defaultMessage: "Create emoji pack" })}
      >
        {open && <EmojiPackForm editEvent={editEvent} onDone={() => onOpenChange(false)} />}
      </ChromeDialogContent>
    </Dialog>
  );
}

function EmojiPackForm({ editEvent, onDone }: { editEvent?: NostrRumor; onDone: () => void }) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const { mutateAsync: uploadFile } = useUploadFile();
  const { mutateAsync: publishEvent, isPending: publishing } = useNostrPublish();
  const { mutateAsync: addPack } = useAddEmojiPack();
  const queryClient = useQueryClient();

  const isEditMode = !!editEvent;
  const initial = useMemo(() => {
    if (!editEvent) return null;
    const tag = (n: string) => editEvent.tags.find(([k]) => k === n)?.[1];
    return {
      identifier: tag("d") ?? "",
      name: tag("title") || tag("name") || "",
      about: tag("about") ?? "",
      icon: tag("image") || tag("picture") || "",
      entries: editEvent.tags
        .filter((t) => t[0] === "emoji" && t[1] && t[2])
        .map((t): Entry => ({ id: nextEntryId(), shortcode: t[1], url: t[2], uploading: false })),
    };
  }, [editEvent]);

  const fileInput = useRef<HTMLInputElement>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [about, setAbout] = useState(initial?.about ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [iconUploading, setIconUploading] = useState(false);
  const [entries, setEntries] = useState<Entry[]>(initial?.entries ?? []);
  const [dragging, setDragging] = useState(false);
  const [addToMine, setAddToMine] = useState(!isEditMode);
  // Covers the whole handler, including the fresh read before an edit and
  // `addPack`'s slow list read-modify-write after `publishing` finishes.
  const [submitting, setSubmitting] = useState(false);
  const busy = publishing || submitting;

  // Cover image (`picture`/`image` tags); other clients (Ditto) show nothing without it.
  const addIcon = async (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    setIconUploading(true);
    try {
      const tags = await uploadFile(file);
      setIcon(tags[0]?.[1] ?? "");
    } catch {
      toast({ title: t({ id: "emojiPackDialog.iconUploadFailed", defaultMessage: "Icon upload failed" }), description: file.name, variant: "destructive" });
    } finally {
      setIconUploading(false);
    }
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      toast({ title: t({ id: "emojiPackDialog.noImages", defaultMessage: "No images found" }), variant: "destructive" });
      return;
    }
    await Promise.all(images.map(async (file) => {
      const id = nextEntryId();
      setEntries((prev) => [
        ...prev,
        { id, shortcode: shortcodeFromFilename(file.name), url: "", uploading: true },
      ]);
      try {
        const tags = await uploadFile(file);
        const url = tags[0]?.[1] ?? "";
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, url, uploading: false } : e)),
        );
      } catch {
        setEntries((prev) => prev.filter((e) => e.id !== id));
        toast({ title: t({ id: "emojiPackDialog.uploadFailed", defaultMessage: "Upload failed" }), description: file.name, variant: "destructive" });
      }
    }));
  };

  const setShortcode = (id: string, value: string) =>
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, shortcode: sanitizeShortcode(value) } : e)),
    );

  const removeEntry = (id: string) => setEntries((prev) => prev.filter((e) => e.id !== id));

  // Reorder by the grip handle, on the server rail's machinery: geometry frozen at pickup
  // in the list's content coordinates (so edge auto-scroll stays true), a ghost moved by
  // writing its transform, state touched only when the insertion point changes, and a
  // FLIP settle on drop. The emoji tags publish in this order.
  const listRef = useRef<HTMLElement | null>(null);
  const sortSlots = useRef<{ id: string; top: number; height: number }[]>([]);
  const listTop = useRef(0);
  const [ghostBox, setGhostBox] = useState<{ left: number; width: number } | null>(null);
  const ghostEl = useRef<HTMLDivElement | null>(null);
  const ghostY = useRef(0);
  const [insertAt, setInsertAt] = useState<InsertPoint | null>(null);
  const insertRef = useRef<InsertPoint | null>(null);
  const flip = useFlipReorder(listRef, "data-emoji-row");

  const placeGhost = () => {
    const el = ghostEl.current;
    if (el) el.style.transform = `translate3d(0, ${ghostY.current}px, 0) translateY(-50%)`;
  };
  const attachGhost = (el: HTMLDivElement | null) => {
    ghostEl.current = el;
    placeGhost();
  };

  const aimSort = (id: string, _x: number, y: number) => {
    ghostY.current = y;
    placeGhost();
    const contentY = y - listTop.current + (listRef.current?.scrollTop ?? 0);
    const next = planInsert(contentY, sortSlots.current.filter((s) => s.id !== id));
    if (next.before === insertRef.current?.before && next.y === insertRef.current?.y) return;
    insertRef.current = next;
    setInsertAt(next);
  };

  const endSort = () => {
    insertRef.current = null;
    setInsertAt(null);
    setGhostBox(null);
  };

  const sortDrag = usePressDrag<string>({
    containerRef: listRef,
    pickupOnMove: "all",
    onPickup: (id, x, y) => {
      const list = listRef.current;
      if (!list) return;
      const rect = list.getBoundingClientRect();
      listTop.current = rect.top;
      sortSlots.current = Array.from(list.querySelectorAll<HTMLElement>("[data-emoji-row]")).map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.emojiRow!, top: r.top - rect.top + list.scrollTop, height: r.height };
      });
      setGhostBox({ left: rect.left + 6, width: rect.width - 12 });
      insertRef.current = null;
      aimSort(id, x, y);
    },
    onAim: aimSort,
    onDrop: (id) => {
      const target = insertRef.current;
      const ghostRect = ghostEl.current?.getBoundingClientRect();
      endSort();
      if (!target) return;
      flip.capture({ [id]: ghostRect });
      setEntries((prev) => moveEntry(prev, id, target.before));
    },
    onAbort: endSort,
  });

  const moveBy = (id: string, step: -1 | 1) => {
    const i = entries.findIndex((e) => e.id === id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= entries.length) return;
    flip.capture();
    // Before the entry after the destination, or last.
    setEntries((prev) => moveEntry(prev, id, step < 0 ? prev[j].id : (prev[j + 1]?.id ?? null)));
  };

  const playFlip = flip.play;
  useLayoutEffect(() => {
    playFlip();
  }, [entries, playFlip]);

  const sortable = entries.length > 1 && !busy;
  const sortingId = sortDrag.source;
  const sortingEntry = sortingId ? entries.find((e) => e.id === sortingId) : undefined;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    void filesFromDrop(e.dataTransfer).then(addFiles);
  };

  const uploading = entries.filter((e) => e.uploading).length;
  const uploaded = entries.filter((e) => !e.uploading && e.url);
  // Shortcodes must be present and unique, or colliding entries get dropped.
  const counts = new Map<string, number>();
  for (const e of uploaded) {
    const code = finalShortcode(e.shortcode);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const isDuplicate = (raw: string) => (counts.get(finalShortcode(raw)) ?? 0) > 1;
  const duplicates = [...counts.values()].filter((n) => n > 1).length;
  const missing = uploaded.filter((e) => !finalShortcode(e.shortcode)).length;
  const named = name.trim().length > 0;
  const canPublish =
    !!user && named && uploaded.length > 0 && !uploading && !iconUploading && !busy &&
    duplicates === 0 && missing === 0 && (!isEditMode || !!initial?.identifier);

  const hint = busy
    ? intl.formatMessage({ id: "emojiPackDialog.publishing", defaultMessage: "Publishing…" })
    : uploading > 0 || iconUploading
      ? intl.formatMessage(
        { id: "emojiPackDialog.uploadingImages", defaultMessage: "Uploading {count, plural, one {# image} other {# images}}…" },
        { count: uploading + (iconUploading ? 1 : 0) },
      )
      : missing > 0
        ? intl.formatMessage({ id: "emojiPackDialog.missingShortcode", defaultMessage: "Every emoji needs a shortcode." })
        : duplicates > 0
          ? intl.formatMessage({ id: "emojiPackDialog.duplicateShortcode", defaultMessage: "Two emojis share a shortcode. Make each one unique." })
          : !named
            ? intl.formatMessage({ id: "emojiPackDialog.giveName", defaultMessage: "Give the pack a name." })
            : uploaded.length === 0
              ? intl.formatMessage({ id: "emojiPackDialog.addImage", defaultMessage: "Add at least one image." })
              : isEditMode
                ? intl.formatMessage({ id: "emojiPackDialog.editHint", defaultMessage: "Everyone who added this pack will get the changes." })
                : intl.formatMessage({ id: "emojiPackDialog.publicHint", defaultMessage: "Anyone will be able to find and add this pack." });

  const publish = async () => {
    if (!canPublish || !user) return;
    setSubmitting(true);
    // A new pack gets a random suffix so two packs with the same name never replace each other.
    const identifier = isEditMode
      ? initial!.identifier
      : `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      let prev: NostrRumor | null = null;
      if (isEditMode) {
        const store = await eventStore;
        prev = await readOwnEmojiPack(nostr, store, user.pubkey, identifier, AbortSignal.timeout(10_000));
        prev ??= editEvent ?? null;
      }

      // Emit both `title` and `name` (Ditto reads `name`, else the `d` slug), and
      // both `image` and `picture` for the cover.
      const tags: string[][] = [
        ["d", identifier],
        ["title", name.trim()],
        ["name", name.trim()],
      ];
      if (about.trim()) tags.push(["about", about.trim()]);
      if (icon) {
        tags.push(["image", icon], ["picture", icon]);
      }
      if (prev) tags.push(...prev.tags.filter(([n]) => !MANAGED_TAGS.has(n)).map((t) => [...t]));
      for (const e of uploaded) {
        tags.push(["emoji", finalShortcode(e.shortcode), e.url]);
      }

      const event = await publishEvent({
        kind: KIND_EMOJI_SET,
        content: prev?.content ?? "",
        tags,
        prev: prev ?? undefined,
      });
      seedCaches(queryClient, event, user.pubkey);

      // Explicit opt-in. A failure here must not read as a failed publish.
      if (addToMine && !isEditMode) {
        try {
          await addPack({ pubkey: user.pubkey, identifier });
          toast({
            title: t({ id: "emojiPackDialog.packPublished", defaultMessage: "Emoji pack published" }),
            description: t(
              { id: "emojiPackDialog.addedToEmojis", defaultMessage: "{name} was added to your emojis" },
              { name: name.trim() },
            ),
          });
        } catch (e) {
          toast({
            title: t({ id: "emojiPackDialog.publishedNotAdded", defaultMessage: "Published, but not added to your emojis" }),
            description: e instanceof Error ? e.message : t({ id: "emojiPackDialog.listUpdateFailed", defaultMessage: "Couldn't update your emoji list." }),
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: isEditMode
            ? t({ id: "emojiPackDialog.packUpdated", defaultMessage: "Emoji pack updated" })
            : t({ id: "emojiPackDialog.packPublished", defaultMessage: "Emoji pack published" }),
          description: name.trim(),
        });
      }
      onDone();
    } catch (e) {
      toast({
        title: isEditMode
          ? t({ id: "emojiPackDialog.updateFailed", defaultMessage: "Couldn't update pack" })
          : t({ id: "emojiPackDialog.publishFailed", defaultMessage: "Couldn't publish pack" }),
        description: e instanceof Error ? e.message : t({ id: "emojiPackDialog.publishingFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const iconSrc = sanitizeImageSrc(icon);
  const iconPlaceholder = <ImagePlus className="size-5" />;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
          <Smile className="size-6" />
        </div>
        <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
          {isEditMode ? <FormattedMessage id="emojiPackDialog.editHeading" defaultMessage="edit emoji pack" /> : <FormattedMessage id="emojiPackDialog.createHeading" defaultMessage="create emoji pack" />}
        </h2>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="emojiPackDialog.intro" defaultMessage="Upload images, give each a shortcode, and publish a pack anyone can add." />
        </p>
      </div>

      <input
        ref={iconInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void addIcon(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className="flex items-end gap-3">
        <button
          type="button"
          onClick={() => iconInput.current?.click()}
          disabled={busy}
          aria-label={intl.formatMessage({ id: "emojiPackDialog.packIcon", defaultMessage: "Pack icon" })}
          className={cn(
            "flex size-14 shrink-0 items-center justify-center overflow-hidden clip-corner-lg transition-colors",
            icon
              ? "bg-secondary/40"
              : "bg-secondary/40 text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
          )}
        >
          {iconUploading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : iconSrc ? (
            <FallbackImage src={iconSrc} className="size-full object-cover" fallback={iconPlaceholder} />
          ) : (
            iconPlaceholder
          )}
        </button>
        <div className="flex-1 space-y-1.5">
          <Label
            htmlFor="pack-name"
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            <FormattedMessage id="emojiPackDialog.packName" defaultMessage="Pack name" />
          </Label>
          <Input
            id="pack-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={intl.formatMessage({ id: "emojiPackDialog.namePlaceholder", defaultMessage: "My emoji pack" })}
            maxLength={60}
            disabled={busy}
            autoFocus
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="pack-about"
          className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          <FormattedMessage
            id="emojiPackDialog.descriptionOptional"
            defaultMessage="Description<opt>optional</opt>"
            values={{
              opt: (chunks) => (
                <span className="ml-1 normal-case tracking-normal text-muted-foreground/60">{chunks}</span>
              ),
            }}
          />
        </Label>
        <Textarea
          id="pack-about"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder={intl.formatMessage({ id: "emojiPackDialog.descriptionPlaceholder", defaultMessage: "What's in this pack?" })}
          maxLength={280}
          rows={2}
          disabled={busy}
          className="resize-none"
        />
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <FormattedMessage id="emojiPackDialog.emojis" defaultMessage="Emojis" />
          </span>
          {uploaded.length > 0 && (
            <span className="text-xs text-muted-foreground/70">{uploaded.length}</span>
          )}
          {entries.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 touch:h-9 gap-1.5 text-xs text-muted-foreground"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              <ImagePlus className="size-3.5" />
              <FormattedMessage id="emojiPackDialog.addMore" defaultMessage="Add more" />
            </Button>
          )}
        </div>

        {entries.length === 0 ? (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            disabled={busy}
            className={cn(
              "flex w-full flex-col items-center gap-2 clip-corner-lg px-6 py-8 text-center transition-colors",
              dragging
                ? "bg-primary/15 text-foreground"
                : "bg-secondary/40 text-muted-foreground hover:bg-secondary/70",
            )}
          >
            <ImagePlus className="size-6" />
            <span className="text-sm font-medium text-foreground">
              <FormattedMessage id="emojiPackDialog.addImages" defaultMessage="Add emoji images" />
            </span>
            <span className="text-xs">
              <FormattedMessage
                id="emojiPackDialog.dropHint"
                defaultMessage="Drop images or a folder here, or click to browse. PNG, GIF or WebP."
              />
            </span>
          </button>
        ) : (
          <div
            ref={sortDrag.attachContainer}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "relative max-h-56 space-y-1.5 overflow-y-auto scrollbar-stable clip-corner-lg p-1.5 transition-colors",
              dragging ? "bg-primary/10" : "bg-foreground/5",
            )}
          >
            {entries.map((e, i) => {
              const invalid = !e.uploading && (!finalShortcode(e.shortcode) || isDuplicate(e.shortcode));
              return (
                <div
                  key={e.id}
                  data-emoji-row={e.id}
                  className={cn(
                    "flex items-center gap-2 transition-opacity",
                    sortingId === e.id && "opacity-30",
                  )}
                >
                  <button
                    type="button"
                    aria-label={intl.formatMessage(
                      {
                        id: "emojiPackDialog.moveEmoji",
                        defaultMessage:
                          "{named, select, true {Move {code}. Use the arrow keys, or drag.} other {Move emoji. Use the arrow keys, or drag.}}",
                      },
                      { named: e.shortcode ? "true" : "false", code: e.shortcode },
                    )}
                    aria-disabled={!sortable}
                    tabIndex={sortable ? 0 : -1}
                    onPointerDown={(ev) => {
                      if (sortable) sortDrag.begin(e.id)(ev.nativeEvent);
                    }}
                    onKeyDown={(ev) => {
                      if (!sortable) return;
                      if (ev.key === "ArrowUp" && i > 0) {
                        ev.preventDefault();
                        moveBy(e.id, -1);
                      } else if (ev.key === "ArrowDown" && i < entries.length - 1) {
                        ev.preventDefault();
                        moveBy(e.id, 1);
                      }
                    }}
                    className={cn(
                      "-mr-1 flex h-9 w-5 touch:w-7 shrink-0 touch-none items-center justify-center rounded text-muted-foreground/50 outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      sortable ? "cursor-grab hover:text-foreground" : "cursor-default opacity-40",
                    )}
                  >
                    <GripVertical className="size-4" />
                  </button>
                  <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background">
                    {e.uploading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <CustomEmojiImg
                        name={e.shortcode}
                        url={e.url}
                        className="size-7 object-contain"
                      />
                    )}
                  </span>
                  <div className="field flex min-w-0 flex-1 items-center px-2">
                    <span className="text-sm text-muted-foreground">:</span>
                    <Input
                      variant="bare"
                      value={e.shortcode}
                      onChange={(ev) => setShortcode(e.id, ev.target.value)}
                      placeholder={intl.formatMessage({ id: "emojiPackDialog.shortcodePlaceholder", defaultMessage: "shortcode" })}
                      aria-label={intl.formatMessage({ id: "emojiPackDialog.shortcodeLabel", defaultMessage: "Emoji shortcode" })}
                      aria-invalid={invalid}
                      disabled={busy}
                      className="h-auto touch:h-auto min-w-0 flex-1 px-0 py-1.5 touch:py-2.5 text-sm md:text-sm"
                    />
                    <span className="text-sm text-muted-foreground">:</span>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 touch:size-10 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeEntry(e.id)}
                    disabled={busy}
                    aria-label={intl.formatMessage(
                      {
                        id: "emojiPackDialog.removeEmoji",
                        defaultMessage: "{named, select, true {Remove {code}} other {Remove emoji}}",
                      },
                      { named: e.shortcode ? "true" : "false", code: e.shortcode },
                    )}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              );
            })}
            {/* Last child: as the first, `space-y` would shift the rows mid-drag. */}
            {insertAt && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-1.5 z-10 h-0.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.7)] transition-[top] duration-100 ease-out"
                style={{ top: insertAt.y - 1 }}
              />
            )}
          </div>
        )}
      </div>

      {/* Portaled: the dialog is transformed, which would make `fixed` relative to it. */}
      {sortingEntry && ghostBox && createPortal(
        <div
          ref={attachGhost}
          aria-hidden
          className="pointer-events-none fixed top-0 z-[300] will-change-transform"
          style={{ left: ghostBox.left, width: ghostBox.width }}
        >
          <div className="flex items-center gap-2 rounded-md bg-popover px-1 py-0.5 shadow-lg ring-1 ring-primary/60 animate-in zoom-in-95 duration-100">
            <GripVertical className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background">
              {sortingEntry.url && (
                <CustomEmojiImg name={sortingEntry.shortcode} url={sortingEntry.url} className="size-7 object-contain" />
              )}
            </span>
            <span className="truncate text-sm">:{sortingEntry.shortcode}:</span>
          </div>
        </div>,
        document.body,
      )}

      <div className="space-y-2">
        {user && !isEditMode && (
          <Label className="flex cursor-pointer items-center gap-2 py-1 text-sm font-normal text-muted-foreground">
            <Checkbox
              checked={addToMine}
              onCheckedChange={(v) => setAddToMine(v === true)}
              disabled={busy}
              className="shrink-0"
            />
            <FormattedMessage id="emojiPackDialog.addToMine" defaultMessage="Add to my emojis" />
          </Label>
        )}
        <Button className="w-full clip-corner-lg" onClick={publish} disabled={!canPublish}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {isEditMode ? <FormattedMessage id="emojiPackDialog.updatePack" defaultMessage="Update pack" /> : <FormattedMessage id="emojiPackDialog.publishPack" defaultMessage="Publish pack" />}
        </Button>
        <p
          className={cn(
            "flex items-center justify-center gap-1.5 text-center text-xs",
            duplicates > 0 || missing > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {(duplicates > 0 || missing > 0) && <AlertTriangle className="size-3.5 shrink-0" />}
          {hint}
        </p>
      </div>
    </div>
  );
}

/**
 * Put a just-published pack into the caches that show it. Seeded rather than refetched: an
 * immediate refetch races relay indexing and can return LESS than is on screen. The stale
 * mark lets the next fetch reconcile.
 */
function seedCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  event: NostrRumor,
  pubkey: string,
) {
  const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
  const coord = emojiPackCoord(event.pubkey, d);
  const sameCoord = (e: NostrRumor) =>
    e.kind === event.kind && e.pubkey === event.pubkey && e.tags.find(([n]) => n === "d")?.[1] === d;

  // Key: ["discover", "emoji-packs", relays, authorFilter, q]. An edited pack replaces its
  // old version wherever it is listed; a new one joins only the unsearched feeds.
  type Feed = InfiniteData<{ events: NostrRumor[] }>;
  for (const [key, data] of queryClient.getQueriesData<Feed>({ queryKey: ["discover", "emoji-packs"] })) {
    if (!data?.pages.length) continue;
    let found = false;
    const pages = data.pages.map((page) => ({
      ...page,
      events: page.events.map((e) => {
        if (!sameCoord(e)) return e;
        found = true;
        return event;
      }),
    }));
    if (!found) {
      if (key[4] !== "") continue;
      pages[0] = { ...pages[0], events: [event, ...pages[0].events] };
    }
    queryClient.setQueryData<Feed>(key, { ...data, pages });
  }
  void queryClient.invalidateQueries({ queryKey: ["discover", "emoji-packs"], refetchType: "none" });

  queryClient.setQueryData<MyEmojiPack[]>(["my-published-packs", pubkey], (prev) =>
    prev && [{ coord, event }, ...prev.filter((p) => p.coord !== coord)],
  );
  void queryClient.invalidateQueries({ queryKey: ["my-published-packs"], refetchType: "none" });

  // The list and palette resolve packs from the local store, which already holds this event.
  void queryClient.invalidateQueries({ queryKey: ["my-emoji-packs"] });
  void queryClient.invalidateQueries({ queryKey: ["custom-emojis"] });
}
