import { useQuery } from "@tanstack/react-query";
import { Plus, RotateCcw, ShieldOff, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { OwnerAvatar, OwnerName } from "@/components/settings/DiscoverCurationSettings";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { FormattedMessage, useIntl } from "@/i18n";
import { BLOCKLIST_AUTHORS_NONE, resolveBlocklistAuthors } from "@/lib/blocklist";
import { isStoreInstall } from "@/lib/storeInstall";

/** A pubkey from an npub, nprofile or hex key; undefined when it is none of them. */
function parseKey(input: string): string | undefined {
  const value = input.trim().replace(/^nostr:/i, "");
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    // Not NIP-19.
  }
  return undefined;
}

/** What `AppConfig.blocklistAuthors` stores for a chosen list of keys. */
function storeKeys(keys: readonly string[]): string {
  return keys.length === 0 ? BLOCKLIST_AUTHORS_NONE : keys.join(",");
}

/**
 * The moderation keys whose blocklist entries this client honours
 * (`lib/blocklist.ts`). Not offered in store installs, which keep the build's.
 */
export function BlocklistAuthorsSettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  // Until the install is known, as a store one, so the control never flashes there.
  const store = useQuery({ queryKey: ["store-install"], queryFn: isStoreInstall, staleTime: Infinity }).data ?? true;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (store) return null;

  const keys = resolveBlocklistAuthors(config.blocklistAuthors);
  const overridden = config.blocklistAuthors.trim() !== "";
  const setSetting = (blocklistAuthors: string) => updateConfig((current) => ({ ...current, blocklistAuthors }));

  const add = () => {
    const pubkey = parseKey(draft);
    if (!pubkey) {
      setError(intl.formatMessage({ id: "blocklistAuthors.invalid", defaultMessage: "Enter an npub or a hex public key." }));
      return;
    }
    if (!keys.includes(pubkey)) setSetting(storeKeys([...keys, pubkey]));
    setDraft("");
    setError(null);
  };

  return (
    <SettingsGroup id="moderation" title={intl.formatMessage({ id: "blocklistAuthors.group", defaultMessage: "Blocklist" })}>
      <div>
        <SettingsRow
          label={intl.formatMessage({ id: "blocklistAuthors.label", defaultMessage: "Moderation keys" })}
          description={intl.formatMessage({
            id: "blocklistAuthors.description",
            defaultMessage: "Communities and people these keys block are hidden in Armada. Remove them all to turn the blocklist off.",
          })}
        />
        <SettingsRow className="pt-0">
          <div className="space-y-2">
            {keys.length > 0 ? (
              <ul className="space-y-1">
                {keys.map((pubkey) => (
                  <li key={pubkey} className="flex items-center gap-3 px-3 py-2.5 clip-corner-lg bg-background/40">
                    <OwnerAvatar pubkey={pubkey} />
                    <p className="min-w-0 flex-1 break-words text-sm"><OwnerName pubkey={pubkey} /></p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 touch:size-11 shrink-0 text-muted-foreground"
                      aria-label={intl.formatMessage({ id: "blocklistAuthors.remove", defaultMessage: "Remove moderation key" })}
                      onClick={() => setSetting(storeKeys(keys.filter((k) => k !== pubkey)))}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                <ShieldOff className="size-3.5 shrink-0" />
                <FormattedMessage id="blocklistAuthors.empty" defaultMessage="No moderation keys. Nothing is blocked." />
              </p>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <Input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                placeholder={intl.formatMessage({ id: "blocklistAuthors.placeholder", defaultMessage: "npub1…" })}
                aria-label={intl.formatMessage({ id: "blocklistAuthors.addLabel", defaultMessage: "Add a moderation key" })}
                aria-invalid={error ? true : undefined}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-base md:text-sm"
              />
              <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
                <Plus className="size-4" />
                <FormattedMessage id="blocklistAuthors.add" defaultMessage="Add" />
              </Button>
            </form>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {overridden && (
              <div className="flex flex-wrap -ml-2">
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setSetting("")}>
                  <RotateCcw className="size-3.5 mr-1.5" />
                  <FormattedMessage id="blocklistAuthors.reset" defaultMessage="Reset to default" />
                </Button>
              </div>
            )}
          </div>
        </SettingsRow>
      </div>
    </SettingsGroup>
  );
}
