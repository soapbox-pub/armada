import { ArrowLeft, Loader2, Server, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppContext } from "@/hooks/useAppContext";
import { useCommunityAdmin, communityAdminEnabled } from "@/hooks/useCommunityAdmin";
import { useConcordActions } from "@/hooks/useConcordActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { parseConcordInvite, type ConcordCommunity } from "@/lib/concord";
import { normalizeRelayUrl, PLATFORM_RELAYS, relayToHttpUrl } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface AddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Which branch of the wizard the user is on. */
type Step =
  | { name: "choose" }
  | { name: "nip29" }
  | { name: "create-community" }
  | { name: "concord-choose" }
  | { name: "concord-start" }
  | { name: "concord-join" };

/**
 * The "Add" wizard. NIP-29 servers and Concord chats are different things —
 * one connects to a relay, the other mints/joins a serverless E2E community —
 * so the wizard asks *what you're doing* first, then branches. NIP-29 is fully
 * baked in here; Concord routes through the (stubbed) protocol layer.
 */
export function AddDialog({ open, onOpenChange }: AddDialogProps) {
  const [step, setStep] = useState<Step>({ name: "choose" });

  const close = () => {
    onOpenChange(false);
    // Reset to the chooser for the next open (after the close animation).
    setTimeout(() => setStep({ name: "choose" }), 200);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        {step.name === "choose" && <ChooseStep onPick={setStep} />}
        {step.name === "nip29" && (
          <Nip29Step onBack={() => setStep({ name: "choose" })} onDone={close} />
        )}
        {step.name === "create-community" && (
          <CreateCommunityStep onBack={() => setStep({ name: "choose" })} onDone={close} />
        )}
        {step.name === "concord-choose" && (
          <ConcordChooseStep onBack={() => setStep({ name: "choose" })} onPick={setStep} />
        )}
        {step.name === "concord-start" && (
          <ConcordStartStep onBack={() => setStep({ name: "concord-choose" })} onDone={close} />
        )}
        {step.name === "concord-join" && (
          <ConcordJoinStep onBack={() => setStep({ name: "concord-choose" })} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Step 1: what are you doing? ─────────────────────────────────────────────

function ChoiceCard({
  icon: Icon,
  title,
  blurb,
  accent,
  onClick,
}: {
  icon: typeof Server;
  title: string;
  blurb: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors",
        "hover:border-primary/50 hover:bg-accent/40",
        accent && "hover:border-success/50",
      )}
    >
      <Icon className={cn("size-5 shrink-0 mt-0.5 text-muted-foreground", accent && "text-success")} />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{blurb}</span>
      </span>
    </button>
  );
}

function ChooseStep({ onPick }: { onPick: (s: Step) => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add</DialogTitle>
        <DialogDescription>What would you like to do?</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <ChoiceCard
          icon={Server}
          title="Add a server"
          blurb="Connect to a relay that hosts channels. Fast, searchable, voice-capable — the server can read messages."
          onClick={() => onPick({ name: "nip29" })}
        />
        {communityAdminEnabled() && (
          <ChoiceCard
            icon={Sparkles}
            title="Create a community"
            blurb="Provision a brand-new server (virtual relay) on this platform. Operator-only."
            onClick={() => onPick({ name: "create-community" })}
          />
        )}
        <ChoiceCard
          icon={ShieldCheck}
          title="Start or join an encrypted chat"
          blurb="A serverless, end-to-end-encrypted community. No host can read it; membership is your key. (Concord)"
          accent
          onClick={() => onPick({ name: "concord-choose" })}
        />
      </div>
    </>
  );
}

function StepHeader({ onBack, title, description }: { onBack: () => void; title: string; description: string }) {
  return (
    <DialogHeader>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="size-7 -ml-1" aria-label="Back" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <DialogTitle>{title}</DialogTitle>
      </div>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
  );
}

// ── Step 2a: add a NIP-29 server ────────────────────────────────────────────

function Nip29Step({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const handleAdd = async () => {
    setError(null);
    const normalized = normalizeRelayUrl(url);
    if (!normalized) {
      setError("Enter a valid ws:// or wss:// relay URL.");
      return;
    }
    if (PLATFORM_RELAYS.includes(normalized) || config.addedRelays.includes(normalized)) {
      setError("That server is already in your list.");
      return;
    }

    setChecking(true);
    try {
      const res = await fetch(relayToHttpUrl(normalized), {
        headers: { Accept: "application/nostr+json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
    } catch {
      setChecking(false);
      setError("Could not reach that relay's NIP-11 endpoint. Check the URL and your network.");
      return;
    }
    setChecking(false);

    updateConfig((current) => ({
      ...current,
      addedRelays: [...current.addedRelays, normalized],
    }));
    if (user) {
      updateList({ type: "add-server", url: normalized }).catch((err) =>
        console.warn("Failed to sync server to group list:", err));
    }
    toast({ title: "Server added", description: normalized });
    onDone();
  };

  return (
    <>
      <StepHeader
        onBack={onBack}
        title="Add a server"
        description="Connect to a relay. Servers host their own channels and members."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleAdd();
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="server-url">Relay URL</Label>
          <Input
            id="server-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="wss://relay.internal"
            autoComplete="off"
            autoFocus
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Alert>
          <ShieldCheck className="size-4" />
          <AlertDescription>
            Pinned platform servers cannot be removed; servers you add here can be managed from Settings.
          </AlertDescription>
        </Alert>

        <DialogFooter>
          <Button type="submit" disabled={checking || !url.trim()}>
            {checking ? <><Loader2 className="size-4 mr-2 animate-spin" /> Checking…</> : "Add server"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

// ── Step 2b: create a community (tenant CRUD via API_HOST) ──────────────────

/** Derive a default schema id from a host (lowercase identifier). */
function schemaFromHost(host: string): string {
  const base = host.split(":")[0].split(".")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return /^[a-z_]/.test(base) ? base : `c_${base}`;
}

function CreateCommunityStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  // The management API is served by any already-loaded community (path-mounted
  // mode) or a dedicated host. Target the first platform relay's origin — the
  // brand-new community's own host doesn't exist yet, so we can't post there.
  const apiRelay = PLATFORM_RELAYS[0] ?? config.addedRelays[0];
  const { createCommunity } = useCommunityAdmin(apiRelay);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setError(null);
    if (!user) {
      setError("You must be signed in.");
      return;
    }
    const cleanHost = host.trim().toLowerCase();
    if (!cleanHost || !/^[a-z0-9.-]+(:\d+)?$/.test(cleanHost)) {
      setError("Enter a valid host, e.g. community.example.com.");
      return;
    }

    const secret = bytesToHex(generateSecretKey());
    const id = cleanHost; // zooid config basename == host by convention
    try {
      await createCommunity.mutateAsync({
        id,
        config: {
          host: cleanHost,
          schema: schemaFromHost(cleanHost),
          secret,
          info: { name: name.trim() || cleanHost, pubkey: user.pubkey },
          policy: { public_join: true },
          groups: { enabled: true },
          management: { enabled: true },
        },
      });
    } catch {
      return; // toast handled in hook
    }

    // Add the new community to the user's server list and open it. Assume
    // wss:// (the API host serves HTTPS, so the community is reachable over TLS).
    const relayUrl = normalizeRelayUrl(cleanHost);
    if (relayUrl) {
      if (!PLATFORM_RELAYS.includes(relayUrl) && !config.addedRelays.includes(relayUrl)) {
        updateConfig((current) => ({ ...current, addedRelays: [...current.addedRelays, relayUrl] }));
        updateList({ type: "add-server", url: relayUrl }).catch(() => undefined);
      }
    }
    onDone();
  };

  return (
    <>
      <StepHeader
        onBack={onBack}
        title="Create a community"
        description="Provision a new virtual relay on this platform. You'll be its owner."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="community-name">Community name</Label>
          <Input
            id="community-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Community"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="community-host">Host</Label>
          <Input
            id="community-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="community.example.com"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            DNS for this host must already point at the platform edge.
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="submit" disabled={createCommunity.isPending || !host.trim()}>
            {createCommunity.isPending ? (
              <><Loader2 className="size-4 mr-2 animate-spin" /> Creating…</>
            ) : (
              "Create community"
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

// ── Step 2c: Concord — start vs join ────────────────────────────────────────

function ConcordChooseStep({ onBack, onPick }: { onBack: () => void; onPick: (s: Step) => void }) {
  return (
    <>
      <StepHeader
        onBack={onBack}
        title="Encrypted chat"
        description="Start a new end-to-end-encrypted community, or join one you were invited to."
      />
      <div className="space-y-3">
        <ChoiceCard
          icon={ShieldCheck}
          title="Start a new encrypted chat"
          blurb="Create a community. You become the owner; only people you invite can read it."
          accent
          onClick={() => onPick({ name: "concord-start" })}
        />
        <ChoiceCard
          icon={ShieldCheck}
          title="Join with an invite link"
          blurb="Paste an invite link. The secret lives in the link; the relay never sees it."
          accent
          onClick={() => onPick({ name: "concord-join" })}
        />
      </div>
    </>
  );
}

function useConcordToast(onDone: () => void) {
  const navigate = useNavigate();
  return (community: ConcordCommunity) => {
    onDone();
    toast({ title: "Encrypted chat ready", description: community.name });
    navigate(`/c/${encodeURIComponent(community.communityId)}`);
  };
}

function ConcordStartStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { createCommunity, isWorking } = useConcordActions();
  const finish = useConcordToast(onDone);

  const handleStart = async () => {
    setError(null);
    try {
      const community = await createCommunity({ name: name.trim() });
      finish(community);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the chat.");
    }
  };

  return (
    <>
      <StepHeader
        onBack={onBack}
        title="Start an encrypted chat"
        description="No host can read it. You become the owner."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleStart();
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="concord-name">Name</Label>
          <Input
            id="concord-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My private community"
            autoComplete="off"
            autoFocus
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="submit" disabled={isWorking || !name.trim()}>
            {isWorking ? <><Loader2 className="size-4 mr-2 animate-spin" /> Creating…</> : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function ConcordJoinStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { joinViaInvite, isWorking } = useConcordActions();
  const finish = useConcordToast(onDone);

  const invite = parseConcordInvite(link);
  const looksLikeLink = link.trim().length > 0;

  const handleJoin = async () => {
    setError(null);
    const parsed = parseConcordInvite(link);
    if (!parsed) {
      setError("That doesn't look like an encrypted-chat invite link.");
      return;
    }
    try {
      const community = await joinViaInvite({ invite: parsed });
      finish(community);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join that chat.");
    }
  };

  return (
    <>
      <StepHeader
        onBack={onBack}
        title="Join with an invite"
        description="The invite's secret rides in the link and never reaches the relay."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleJoin();
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="concord-invite">Invite link</Label>
          <Input
            id="concord-invite"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…/invite#…"
            autoComplete="off"
            autoFocus
          />
          <div className="min-h-5 text-xs text-muted-foreground">
            {looksLikeLink &&
              (invite ? (
                <span className="text-success">Looks like a valid invite link.</span>
              ) : (
                <span>Not a recognized invite link yet…</span>
              ))}
          </div>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="submit" disabled={isWorking || !invite}>
            {isWorking ? <><Loader2 className="size-4 mr-2 animate-spin" /> Joining…</> : "Join"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
