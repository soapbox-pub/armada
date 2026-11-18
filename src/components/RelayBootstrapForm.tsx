import { HelpCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { RelayListEditor } from "@/components/RelayListEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  ExistingRelayListError,
  relayListAbsenceConfirmed,
  useNip65RelaySetup,
} from "@/hooks/useNip65RelaySetup";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { normalizeRelayUrl } from "@/lib/platform";
import type { RelayListDiscovery, RelayPreference } from "@/lib/nip65";

const EMPTY_RELAY_PREFERENCES: RelayPreference[] = [];

function savedDescription(accepted: number, rejected: number): string {
  return rejected > 0
    ? t(
        {
          id: "relayBootstrapForm.savedPartial",
          defaultMessage: "Saved on {accepted} {accepted, plural, one {relay} other {relays}}; {rejected} didn't accept it.",
        },
        { accepted, rejected },
      )
    : t(
        { id: "relayBootstrapForm.saved", defaultMessage: "Saved on {accepted} {accepted, plural, one {relay} other {relays}}." },
        { accepted },
      );
}

const tryAgainReach = () =>
  t({
    id: "relayBootstrapForm.unconfirmedAppRelays",
    defaultMessage:
      "Couldn't reach enough relays to confirm your account has no saved setup yet. Try again, or look up a relay you've used before.",
  });
const couldNotSave = () => t({ id: "relayBootstrapForm.couldNotSave", defaultMessage: "Couldn't save. Try again." });

export function RelayBootstrapForm({
  onDone,
  onSkip,
}: {
  onDone?: () => void;
  onSkip?: () => void;
}) {
  const intl = useIntl();
  const { discoverWithStatus, adopt, publish } = useNip65RelaySetup();
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const inputId = useId();
  const [value, setValue] = useState("");
  const [checkedRelay, setCheckedRelay] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ownsRelayList = config.relayMetadata.pubkey === user?.pubkey;
  const currentRelays = ownsRelayList
    ? config.relayMetadata.relays
    : EMPTY_RELAY_PREFERENCES;
  const [editedRelays, setEditedRelays] = useState<string[]>(() =>
    currentRelays.map((relay) => relay.url),
  );

  useEffect(() => {
    setEditedRelays(currentRelays.map((relay) => relay.url));
  }, [currentRelays, user?.pubkey]);

  const normalized = normalizeRelayUrl(value);

  const restore = (found: RelayListDiscovery) => {
    adopt(found);
    toast({
      title: t({ id: "relayBootstrapForm.setupFound", defaultMessage: "Setup found" }),
      description: t(
        {
          id: "relayBootstrapForm.restored",
          defaultMessage: "Restored {count} {count, plural, one {relay} other {relays}} for your account.",
        },
        { count: found.relays.length },
      ),
    });
    onDone?.();
  };

  const find = async () => {
    if (!normalized) {
      setError(t({ id: "relayBootstrapForm.enterWss", defaultMessage: "Enter a relay address that starts with wss://." }));
      return;
    }
    setBusy(true);
    setError(undefined);
    setCheckedRelay(undefined);
    try {
      const read = await discoverWithStatus([normalized]);
      if (read.discovery) {
        restore(read.discovery);
      } else if (relayListAbsenceConfirmed(read.answered, [normalized, ...config.appRelays])) {
        // "Use this relay" writes there and to the app relays, so all must answer before "not found".
        setCheckedRelay(normalized);
      } else {
        setError(
          t({
            id: "relayBootstrapForm.unconfirmedRelay",
            defaultMessage:
              "Couldn't reach enough relays to confirm your account has no saved setup yet. Check the address and try again.",
          }),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t({ id: "relayBootstrapForm.lookupFailed", defaultMessage: "Couldn't look that up. Try again." }));
    } finally {
      setBusy(false);
    }
  };

  const create = async (urls: string[]) => {
    if (urls.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await publish(urls.map((url) => ({ url, read: true, write: true })));
      toast({
        title: t({ id: "relayBootstrapForm.savedTitle", defaultMessage: "Saved" }),
        description: savedDescription(result.accepted.length, result.rejected.length),
      });
      onDone?.();
    } catch (err) {
      if (err instanceof ExistingRelayListError) {
        restore(err.discovery);
        return;
      }
      setError(err instanceof Error ? err.message : couldNotSave());
    } finally {
      setBusy(false);
    }
  };

  // Adopt an existing list if found; refuse to publish when the read is too thin
  // to tell "no list" from "unreachable".
  const chooseAppRelays = async () => {
    const urls = config.appRelays;
    if (urls.length === 0) return;
    setBusy(true);
    setError(undefined);
    setCheckedRelay(undefined);
    let read: Awaited<ReturnType<typeof discoverWithStatus>>;
    try {
      read = await discoverWithStatus(urls);
    } catch (err) {
      setError(err instanceof Error ? err.message : t({ id: "relayBootstrapForm.lookupSetupFailed", defaultMessage: "Couldn't look up your setup. Try again." }));
      setBusy(false);
      return;
    }
    if (read.discovery) {
      setBusy(false);
      restore(read.discovery);
      return;
    }
    if (!relayListAbsenceConfirmed(read.answered, urls)) {
      setError(tryAgainReach());
      setBusy(false);
      return;
    }
    await create(urls);
  };

  const saveExisting = async () => {
    if (editedRelays.length === 0) {
      setError(
        t({
          id: "relayBootstrapForm.keepOne",
          defaultMessage: "Keep at least one relay so your account can be found on your other devices.",
        }),
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await publish(editedRelays.map((url) => {
        const existing = currentRelays.find((relay) => relay.url === url);
        return existing ?? { url, read: true, write: true };
      }));
      toast({
        title: t({ id: "relayBootstrapForm.savedTitle", defaultMessage: "Saved" }),
        description: savedDescription(result.accepted.length, result.rejected.length),
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : couldNotSave());
    } finally {
      setBusy(false);
    }
  };

  if (currentRelays.length > 0) {
    return (
      <div className="w-full space-y-3 text-left">
        <RelayListEditor
          relays={editedRelays}
          onChange={(relays) => {
            setEditedRelays(relays);
            setError(undefined);
          }}
          emptyText={intl.formatMessage({ id: "relayBootstrapForm.emptyText", defaultMessage: "Add at least one relay before saving." })}
        />
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button
          type="button"
          className="h-11 w-full clip-corner-lg touch:h-12"
          onClick={() => void saveExisting()}
          disabled={busy || editedRelays.length === 0}
        >
          {busy ? <FormattedMessage {...common.saving} /> : <FormattedMessage {...common.save} />}
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full space-y-3 text-left">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
            <FormattedMessage id="relayBootstrapForm.relayAddress" defaultMessage="Relay address" />
          </label>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={intl.formatMessage({ id: "relayBootstrapForm.whatIsRelay", defaultMessage: "What is a relay address?" })}
                className="-m-1.5 flex size-7 items-center justify-center clip-corner-lg p-1.5 text-muted-foreground/60 hover:text-muted-foreground touch:size-11"
              >
                <HelpCircle className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="max-w-64 text-xs leading-relaxed text-muted-foreground"
            >
              <FormattedMessage
                id="relayBootstrapForm.relayHelp"
                defaultMessage="A relay is a server that stores your account's data. If you've used Armada or another Nostr app before, enter a relay you used. It looks like <mono>wss://relay.example.com</mono>. Not sure? You can skip this; Armada still works with its built-in relays."
                values={{ mono: (chunks) => <span className="font-mono text-foreground">{chunks}</span> }}
              />
            </PopoverContent>
          </Popover>
        </div>
        <Input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setCheckedRelay(undefined);
            setError(undefined);
          }}
          placeholder="wss://relay.example.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-12 font-mono text-base"
        />
      </div>

      {checkedRelay && (
        <div className="clip-corner-lg bg-secondary/50 p-3 text-xs leading-relaxed text-muted-foreground">
          <FormattedMessage
            id="relayBootstrapForm.notFound"
            defaultMessage="We didn't find a saved setup on that relay. You can start fresh here. Armada will remember <b>{relay}</b> as your account's home so your servers and settings follow you to your other devices. Nothing is saved until you confirm."
            values={{ relay: checkedRelay, b: (chunks) => <strong>{chunks}</strong> }}
          />
        </div>
      )}

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      {checkedRelay ? (
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={() => void create([checkedRelay])}
          disabled={busy}
        >
          <FormattedMessage id="relayBootstrapForm.useThisRelay" defaultMessage="Use this relay" />
        </Button>
      ) : (
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={find}
          disabled={busy || !value.trim()}
        >
          {busy ? (
            <FormattedMessage id="relayBootstrapForm.looking" defaultMessage="Looking…" />
          ) : (
            <FormattedMessage id="relayBootstrapForm.lookUp" defaultMessage="Look up my setup" />
          )}
        </Button>
      )}

      {config.appRelays.length > 0 && (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full clip-corner-lg touch:h-12"
            onClick={() => void chooseAppRelays()}
            disabled={busy}
          >
            <FormattedMessage id="relayBootstrapForm.useAppRelays" defaultMessage="Use this app's relays" />
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            <FormattedMessage
              id="relayBootstrapForm.appRelaysHelp"
              defaultMessage="Checks for an existing setup first; if there is none, saves {relays} as your account's home so your servers and settings follow you to your other devices."
              values={{
                relays: config.appRelays.map((url, index) => (
                  <span key={url}>
                    {index > 0 && ", "}
                    <span className="font-mono text-foreground">{url.replace(/^wss?:\/\//, "").replace(/\/$/, "")}</span>
                  </span>
                )),
              }}
            />
          </p>
        </div>
      )}

      {onSkip && (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={onSkip}
            disabled={busy}
          >
            <FormattedMessage id="relayBootstrapForm.skipForNow" defaultMessage="Skip for now" />
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            <FormattedMessage
              id="relayBootstrapForm.skipHelp"
              defaultMessage="Armada keeps working with its default relays. You can set up your own anytime in Settings."
            />
          </p>
        </div>
      )}
    </div>
  );
}
