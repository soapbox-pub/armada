import { CheckCircle2, Circle, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import { nwcWalletPubkey } from "@/lib/walletStorage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { useAppContext } from "@/hooks/useAppContext";
import { useToast } from "@/hooks/useToast";
import { useWallet } from "@/hooks/useWallet";

/**
 * Settings → Wallet: Nostr Wallet Connect management + zap preferences.
 *
 * The connection string is a SPENDING SECRET: it is validated, stored in
 * per-account local storage, and never rendered back — rows show only the
 * alias and the wallet service's pubkey prefix.
 */
export function WalletSettings() {
  const { connections, activeConnection, addConnection, removeConnection, setActive, webln } = useWallet();
  const { config, updateConfig } = useAppContext();
  const { toast } = useToast();

  const [uri, setUri] = useState("");
  const [alias, setAlias] = useState("");
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    if (!uri.trim() || connecting) return;
    setConnecting(true);
    try {
      await addConnection(uri, alias);
      setUri("");
      setAlias("");
      toast({ title: "Wallet connected" });
    } catch (e) {
      toast({
        title: "Couldn't connect wallet",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <SettingsRow>
        <div className="space-y-2">
          <div className="text-sm font-medium">Connect a wallet (NWC)</div>
          <p className="text-xs text-muted-foreground">
            Paste a Nostr Wallet Connect string from your wallet (Alby Hub, Coinos, Primal,
            lnbits…). It authorizes payments, so it stays on this device only — never synced.
          </p>
          <Input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="nostr+walletconnect://…"
            type="password"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Name (optional)"
              className="flex-1"
            />
            <Button onClick={handleConnect} disabled={!uri.trim() || connecting}>
              {connecting ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
            </Button>
          </div>
        </div>
      </SettingsRow>

      {connections.map((connection) => {
        const isActive = connection.connectionString === activeConnection?.connectionString;
        return (
          <SettingsRow
            key={connection.connectionString}
            label={
              <span className="flex items-center gap-2">
                {connection.alias}
                {isActive && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                    active
                  </span>
                )}
              </span>
            }
            description={`Wallet service ${nwcWalletPubkey(connection.connectionString).slice(0, 12) || "unknown"}…`}
          >
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActive(connection.connectionString)}
                disabled={isActive}
                title={isActive ? "Active wallet" : "Use this wallet"}
              >
                {isActive ? <CheckCircle2 className="size-4 text-primary" /> : <Circle className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeConnection(connection.connectionString)}
                title="Remove wallet"
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </div>
          </SettingsRow>
        );
      })}

      <SettingsRow
        label="Browser wallet (WebLN)"
        description={
          webln
            ? "A WebLN extension is available; it's used when no NWC wallet is active."
            : "No WebLN extension detected in this browser."
        }
      >
        <span className={`text-xs font-medium ${webln ? "text-primary" : "text-muted-foreground"}`}>
          {webln ? "Detected" : "—"}
        </span>
      </SettingsRow>

      <SettingsRow
        label="Default zap amount"
        description="Preselected amount (sats) when you open the zap dialog."
      >
        <Input
          type="number"
          min={1}
          value={config.defaultZapAmount}
          onChange={(e) => {
            const n = Math.max(1, Math.floor(Number(e.target.value) || 0));
            updateConfig((current) => ({ ...current, defaultZapAmount: n }));
          }}
          className="w-28 text-right"
        />
      </SettingsRow>
    </>
  );
}
