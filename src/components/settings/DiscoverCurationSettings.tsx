import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useDiscoverCuration } from "@/hooks/useDiscover";
import { FormattedMessage, useIntl } from "@/i18n";
import { parseDiscoverCuration, type DiscoverCuration } from "@/lib/discoverSource";
import { tryNpubEncode } from "@/lib/safeNip19";

/** A pubkey's profile name, or a shortened npub while it has none. */
function OwnerName({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = data?.metadata?.name || data?.metadata?.display_name;
  if (name) return <span className="font-medium text-foreground">{name}</span>;
  const npub = tryNpubEncode(pubkey);
  return <span className="font-mono">{npub ? `${npub.slice(0, 12)}…` : pubkey.slice(0, 8)}</span>;
}

/** The source as a phrase naming whoever owns it, since they decide what Discover shows. */
function CurationSourceText({ curation }: { curation: DiscoverCuration }) {
  switch (curation.type) {
    case "none":
      return <FormattedMessage id="discoverCuration.sourceNone" defaultMessage="no curated list" />;
    case "follows":
      return (
        <FormattedMessage
          id="discoverCuration.sourceFollows"
          defaultMessage="the people {name} follows"
          values={{ name: <OwnerName pubkey={curation.pubkey} /> }}
        />
      );
    case "list":
      return (
        <FormattedMessage
          id="discoverCuration.sourceList"
          defaultMessage="a list by {name}"
          values={{ name: <OwnerName pubkey={curation.pubkey} /> }}
        />
      );
  }
}

/**
 * Discover's curated list (`lib/discoverSource.ts`): whose picks Discover shows
 * besides the viewer's own network. Only changes what this client reads.
 */
export function DiscoverCurationSettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const curation = useDiscoverCuration();
  const overridden = config.discoverCuration.trim() !== "";
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setCuration = (discoverCuration: string) => {
    updateConfig((current) => ({ ...current, discoverCuration }));
  };

  const save = () => {
    const parsed = parseDiscoverCuration(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setCuration(draft.trim());
    setDraft("");
    setError(null);
  };

  return (
    <SettingsRow
      stack
      label={intl.formatMessage({ id: "discoverCuration.label", defaultMessage: "Curated list" })}
      description={
        <>
          <FormattedMessage
            id="discoverCuration.description"
            defaultMessage="Discover only shows what this list's members, you, people you follow and people they follow have shared."
          />{" "}
          {overridden ? (
            <FormattedMessage
              id="discoverCuration.current"
              defaultMessage="Currently {source}."
              values={{ source: <CurationSourceText curation={curation} /> }}
            />
          ) : (
            <FormattedMessage
              id="discoverCuration.currentDefault"
              defaultMessage="Currently {source} (default)."
              values={{ source: <CurationSourceText curation={curation} /> }}
            />
          )}
        </>
      }
    >
      <div className="space-y-1.5 sm:w-72">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder={intl.formatMessage({ id: "discoverCuration.placeholder", defaultMessage: "naddr1…, npub1…, or none" })}
            aria-label={intl.formatMessage({ id: "discoverCuration.label", defaultMessage: "Curated list" })}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-base md:text-sm bg-background/40 border-transparent"
          />
          <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
            <FormattedMessage id="discoverCuration.use" defaultMessage="Use" />
          </Button>
        </form>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {overridden && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2"
            onClick={() => setCuration("")}
          >
            <RotateCcw className="size-3.5 mr-1.5" />
            <FormattedMessage id="discoverCuration.reset" defaultMessage="Reset to default" />
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}
