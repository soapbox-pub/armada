import { ArrowUpToLine, Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BlossomLed, BlossomPing } from "@/components/RelayLed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { normalizeBlossomServerUrl } from "@/lib/blossom";

function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

/**
 * Favicon candidates for a server: its own host, then its root domain (a
 * `cdn.` or `blossom.` host often serves no icon of its own).
 */
export function serverFavicons(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname;
  const out = [`${parsed.origin}/favicon.ico`];
  const labels = host.split(".");
  const isIp = /^[\d.]+$/.test(host) || host.includes(":");
  if (!isIp && labels.length > 2) out.push(`https://${labels.slice(-2).join(".")}/favicon.ico`);
  return out;
}

function ServerIdentity({ url }: { url: string }) {
  const host = serverHost(url);
  const favicons = serverFavicons(url);
  const [attempt, setAttempt] = useState(0);
  const icon = favicons[attempt];
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar className="size-7 rounded-md shrink-0">
        {icon && (
          <AvatarImage key={icon} src={icon} alt={host} onError={() => setAttempt((n) => n + 1)} />
        )}
        <AvatarFallback className="rounded-md bg-secondary text-secondary-foreground text-xs">
          {host.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-medium truncate leading-tight">{host}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono leading-tight">
          <BlossomLed url={url} />
          <span className="truncate">{url}</span>
          <BlossomPing url={url} />
        </div>
      </div>
    </div>
  );
}

export interface BlossomServerListEditorProps {
  /** Editable server URLs (the user's kind 10063 list), most trusted first. */
  servers: string[];
  onChange: (servers: string[]) => void;
  onReset?: () => void;
  emptyText?: string;
  placeholder?: string;
  /**
   * The server whose URL uploads embed; the first server unless given. `null`
   * when there is none (the app's default list on a build with no preferred
   * server), so no row claims to be it.
   */
  primary?: string | null;
  /** The rows are the app's defaults, not yet the user's own list. */
  defaults?: boolean;
}

function RowTag({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground shrink-0 ml-1">{children}</span>;
}

/**
 * Blossom server list editor; the https sibling of RelayListEditor. The first
 * server is the primary one (BUD-03), whose links uploads embed.
 */
export function BlossomServerListEditor({
  servers,
  onChange,
  onReset,
  emptyText,
  placeholder = "https://blossom.example.com",
  primary = servers[0],
  defaults = false,
}: BlossomServerListEditorProps) {
  const intl = useIntl();
  const [newUrl, setNewUrl] = useState("");

  const handleAdd = () => {
    const normalized = normalizeBlossomServerUrl(newUrl);
    if (!normalized) {
      toast({
        title: t({ id: "blossomServerListEditor.invalidTitle", defaultMessage: "Invalid server URL" }),
        description: t({ id: "blossomServerListEditor.invalidDescription", defaultMessage: "Enter an https:// URL." }),
        variant: "destructive",
      });
      return;
    }
    if (servers.includes(normalized)) {
      toast({
        title: t({ id: "blossomServerListEditor.duplicate", defaultMessage: "Already in the list" }),
        description: normalized,
      });
      return;
    }
    onChange([...servers, normalized]);
    setNewUrl("");
  };

  return (
    <div className="space-y-1.5">
      {servers.map((url) => (
        <div key={url} className="flex items-center gap-2 clip-corner bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <ServerIdentity url={url} />
          </div>
          {defaults && (
            <RowTag>
              <FormattedMessage id="blossomServerListEditor.default" defaultMessage="Default" />
            </RowTag>
          )}
          {url === primary ? (
            <RowTag>
              <FormattedMessage id="blossomServerListEditor.primary" defaultMessage="Primary" />
            </RowTag>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage(
                { id: "blossomServerListEditor.makePrimaryLabel", defaultMessage: "Make {url} primary" },
                { url },
              )}
              title={intl.formatMessage({ id: "blossomServerListEditor.makePrimary", defaultMessage: "Make primary" })}
              className="size-7 touch:size-11 text-muted-foreground hover:text-foreground shrink-0"
              onClick={() => onChange([url, ...servers.filter((u) => u !== url)])}
            >
              <ArrowUpToLine className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={intl.formatMessage({ id: "blossomServerListEditor.remove", defaultMessage: "Remove {url}" }, { url })}
            className="size-7 touch:size-11 text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => onChange(servers.filter((u) => u !== url))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}

      {servers.length === 0 && (
        <p className="text-sm text-muted-foreground py-1">
          {emptyText ?? (
            <FormattedMessage id="blossomServerListEditor.empty" defaultMessage="No media servers configured." />
          )}
        </p>
      )}

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
          aria-label={intl.formatMessage({ id: "blossomServerListEditor.addLabel", defaultMessage: "Add media server" })}
          autoComplete="off"
          className="text-base md:text-sm bg-background/40 border-transparent"
        />
        <Button type="submit" disabled={!newUrl.trim()} className="clip-corner-lg shrink-0">
          <Plus className="size-4 mr-1.5" /> <FormattedMessage {...common.add} />
        </Button>
      </form>

      {onReset && (
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2" onClick={onReset}>
          <RotateCcw className="size-3.5 mr-1.5" />{" "}
          <FormattedMessage id="blossomServerListEditor.reset" defaultMessage="Reset to defaults" />
        </Button>
      )}
    </div>
  );
}
