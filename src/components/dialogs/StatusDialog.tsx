import { Loader2, Smile, SmilePlus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { EmojiShortcodeAutocomplete } from "@/components/chat/EmojiShortcodeAutocomplete";
import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { useInsertText } from "@/hooks/useInsertText";
import { toast } from "@/hooks/useToast";
import { common, defineMessages, FormattedMessage, t, useIntl } from "@/i18n";
import { useSetUserStatus, useUserStatus } from "@/hooks/useUserStatus";
import { collectEmojiTags } from "@/lib/customEmoji";

/** Lazy so emoji-mart stays out of the main bundle. */
const LazyEmojiPicker = lazy(() =>
  import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);

interface StatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Formatted in the viewer's language; the chosen text is what gets published. */
const PRESETS = Object.values(
  defineMessages({
    available: { id: "statusDialog.preset.available", defaultMessage: "Available" },
    focusing: { id: "statusDialog.preset.focusing", defaultMessage: "Focusing" },
    away: { id: "statusDialog.preset.away", defaultMessage: "Away" },
    sleeping: { id: "statusDialog.preset.sleeping", defaultMessage: "Sleeping" },
    atLunch: { id: "statusDialog.preset.atLunch", defaultMessage: "At lunch" },
  }),
);

const MAX_LEN = 140;

/** Set or clear the user's NIP-38 status (kind 30315, `d: "general"`). Saving empty clears it. */
export function StatusDialog({ open, onOpenChange }: StatusDialogProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { data } = useUserStatus(user?.pubkey);
  const { mutateAsync: setStatus, isPending } = useSetUserStatus();
  const { emojis: customEmojis } = useCustomEmojis();

  const [content, setContent] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const setClampedContent = useCallback((value: string) => setContent(value.slice(0, MAX_LEN)), []);
  const { insertAtCursor, insertEmoji } = useInsertText(inputRef, content, setClampedContent);

  useEffect(() => {
    if (open) {
      setContent(data?.status?.content ?? "");
      setPickerOpen(false);
    }
  }, [open, data?.status?.content]);

  const save = async (next: string) => {
    try {
      await setStatus({
        content: next,
        emojiTags: collectEmojiTags(next, customEmojis),
      });
      toast({
        title: next.trim()
          ? t({ id: "statusDialog.statusUpdated", defaultMessage: "Status updated" })
          : t({ id: "statusDialog.statusCleared", defaultMessage: "Status cleared" }),
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: t({ id: "statusDialog.updateFailed", defaultMessage: "Couldn’t update status" }),
        description: err instanceof Error ? err.message : t({ id: "statusDialog.pleaseTryAgain", defaultMessage: "Please try again." }),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "statusDialog.title", defaultMessage: "Set a status" })}
        // The autocomplete dropdown portals to body; don't treat taps on it as outside.
        onInteractOutside={(e) => {
          const target = e.target as Element | null;
          if (target?.closest?.("[data-autocomplete-dropdown]")) {
            e.preventDefault();
          }
        }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Smile className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="statusDialog.heading" defaultMessage="set a status" />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage
              id="statusDialog.intro"
              defaultMessage="A short message shown next to your name. Visible to everyone. Clear it any time."
            />
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(content);
          }}
          className="mt-6 space-y-5"
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="user-status"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              <FormattedMessage id="statusDialog.whatsHappening" defaultMessage="What's happening?" />
            </Label>
            <div className="relative">
              <Input
                ref={inputRef}
                id="user-status"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={intl.formatMessage({ id: "statusDialog.placeholder", defaultMessage: "e.g. 🎧 Heads down or :shortcode:" })}
                autoComplete="off"
                maxLength={MAX_LEN}
                autoFocus
                className="pr-10"
              />
              <EmojiShortcodeAutocomplete
                textareaRef={inputRef}
                content={content}
                onInsertEmoji={insertAtCursor}
              />
              <Popover open={pickerOpen} onOpenChange={setPickerOpen} modal>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={intl.formatMessage({ id: "statusDialog.addEmoji", defaultMessage: "Add emoji" })}
                    className="absolute right-1 top-1/2 -translate-y-1/2 size-8 text-muted-foreground hover:text-primary"
                  >
                    <SmilePlus className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  sideOffset={8}
                  className="flex w-[min(20rem,90vw)] h-[min(360px,55dvh)] max-h-[var(--radix-popover-content-available-height)] p-0 overflow-hidden"
                >
                  <Suspense fallback={<div className="w-full" />}>
                    <LazyEmojiPicker
                      customEmojis={customEmojis}
                      onSelect={(selection) => {
                        if (selection.type === "native") {
                          insertEmoji(selection.emoji);
                        } else {
                          insertEmoji(`:${selection.shortcode}:`);
                        }
                        setPickerOpen(false);
                      }}
                    />
                  </Suspense>
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {PRESETS.map((descriptor) => {
                const preset = intl.formatMessage(descriptor);
                return (
                  <button
                    key={descriptor.id}
                    type="button"
                    onClick={() => setContent(preset)}
                    className="clip-corner-lg bg-background/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            {data?.status?.content && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto clip-corner-lg text-muted-foreground"
                disabled={isPending}
                onClick={() => save("")}
              >
                <FormattedMessage id="statusDialog.clearStatus" defaultMessage="Clear status" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="flex-1 clip-corner-lg"
              onClick={() => onOpenChange(false)}
            >
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" /> <FormattedMessage {...common.saving} />
                </>
              ) : (
                <FormattedMessage {...common.save} />
              )}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
