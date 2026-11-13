import { Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { RelayLed, RelayPing } from "@/components/RelayLed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { normalizeRelayUrl } from "@/lib/platform";

function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^wss?:\/\//, "");
  }
}

function RelayCapability({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="clip-corner bg-muted/60 px-1.5 py-0.5 font-mono text-3xs lowercase leading-none tracking-wide text-muted-foreground"
    >
      {label}
    </span>
  );
}

/** Relay row with NIP-11 identity and NIP-42/50 capabilities (adapted from Ditto). */
function RelayIdentity({ url }: { url: string }) {
  const intl = useIntl();
  const { data: info } = useRelayInfo(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const nips = (info?.supported_nips ?? []).filter((nip) => nip === 42 || nip === 50);

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar className="size-7 rounded-md shrink-0">
        <AvatarImage src={info?.icon} alt={name} />
        <AvatarFallback className="rounded-md bg-secondary text-secondary-foreground text-xs">
          {name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-medium truncate leading-tight">{name}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono leading-tight">
          <RelayLed url={url} />
          <span className="truncate">{host}</span>
          <RelayPing url={url} />
        </div>
      </div>
      <div className="flex items-center gap-1 ml-auto shrink-0">
        {nips.includes(50) && <RelayCapability label="search" title={intl.formatMessage({ id: "relayListEditor.supportsSearch", defaultMessage: "Supports search (NIP-50)" })} />}
        {nips.includes(42) && <RelayCapability label="auth" title={intl.formatMessage({ id: "relayListEditor.supportsAuth", defaultMessage: "Supports auth (NIP-42)" })} />}
      </div>
    </div>
  );
}

export interface RelayListEditorProps {
  relays: string[];
  /** Omit (with `readOnly`) for a display-only list. */
  onChange?: (relays: string[]) => void;
  /** Read-only, non-removable relays shown first (e.g. the app defaults). */
  pinned?: string[];
  pinnedLabel?: string;
  onReset?: () => void;
  emptyText?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Locks every control, e.g. while a save is in flight. */
  disabled?: boolean;
  /** Removal stops at this many relays. */
  min?: number;
  /** The add form is replaced by `maxText` at this many relays. */
  max?: number;
  maxText?: string;
}

/** Relay list editor mirroring Ditto's RelayListManager, as a plain `string[]` (no read/write markers). */
export function RelayListEditor({
  relays,
  onChange,
  pinned = [],
  pinnedLabel,
  onReset,
  emptyText,
  placeholder = "wss://relay.example.com",
  readOnly = false,
  disabled = false,
  min = 0,
  max = Infinity,
  maxText,
}: RelayListEditorProps) {
  const intl = useIntl();
  const [newUrl, setNewUrl] = useState("");

  const handleAdd = () => {
    const normalized = normalizeRelayUrl(newUrl);
    if (!normalized) {
      toast({
        title: t({ id: "relayListEditor.invalidUrl.title", defaultMessage: "Invalid relay URL" }),
        description: t({ id: "relayListEditor.invalidUrl.description", defaultMessage: "Enter a ws:// or wss:// URL." }),
        variant: "destructive",
      });
      return;
    }
    if (pinned.includes(normalized) || relays.includes(normalized)) {
      toast({ title: t({ id: "relayListEditor.alreadyInList", defaultMessage: "Already in the list" }), description: normalized });
      return;
    }
    if (relays.length >= max) return;
    onChange?.([...relays, normalized]);
    setNewUrl("");
  };

  return (
    <div className="space-y-1.5">
      {pinned.map((url) => (
        <div key={url} className="flex items-center gap-2 clip-corner bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <RelayIdentity url={url} />
          </div>
          <span className="text-xs text-muted-foreground shrink-0 ml-1">{pinnedLabel ?? <FormattedMessage id="relayListEditor.pinnedDefault" defaultMessage="Default" />}</span>
        </div>
      ))}

      {relays.map((url) => (
        <div key={url} className="flex items-center gap-2 clip-corner bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <RelayIdentity url={url} />
          </div>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "relayListEditor.remove", defaultMessage: "Remove {url}" }, { url })}
              className="size-7 touch:size-11 text-muted-foreground hover:text-destructive shrink-0"
              disabled={disabled || relays.length <= min}
              onClick={() => onChange?.(relays.filter((u) => u !== url))}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      ))}

      {relays.length === 0 && pinned.length === 0 && (
        <p className="text-sm text-muted-foreground py-1">{emptyText ?? <FormattedMessage id="relayListEditor.empty" defaultMessage="No relays configured." />}</p>
      )}

      {!readOnly && relays.length >= max && maxText && (
        <p className="text-xs text-muted-foreground py-1">{maxText}</p>
      )}

      {!readOnly && relays.length < max && (
        <form
          className="flex gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder={placeholder}
            aria-label={intl.formatMessage({ id: "relayListEditor.addRelay", defaultMessage: "Add relay" })}
            autoComplete="off"
            disabled={disabled}
            className="text-base md:text-sm bg-background/40 border-transparent"
          />
          <Button type="submit" disabled={disabled || !newUrl.trim()} className="clip-corner-lg shrink-0">
            <Plus className="size-4 mr-1.5" /> <FormattedMessage {...common.add} />
          </Button>
        </form>
      )}

      {!readOnly && onReset && (
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2" disabled={disabled} onClick={onReset}>
          <RotateCcw className="size-3.5 mr-1.5" /> <FormattedMessage id="relayListEditor.resetToDefaults" defaultMessage="Reset to defaults" />
        </Button>
      )}
    </div>
  );
}
