import { ChevronDown, ClipboardPaste, Hash, Link2, Loader2, Server, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { ImportFromDiscordButton } from "@/components/ImportFromDiscord";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { useCommunityActions } from "@/concord/hooks/useCommunityActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { readClipboardText } from "@/lib/clipboard";
import { claimBuzzInvite, fetchBuzzJoinPolicy, parseBuzzInviteUrl, type BuzzInvite, type BuzzJoinPolicy } from "@/buzz/invite";
import { parseInviteLink, type ParsedInviteLink } from "@/concord/lib/invite";
import { nip29GroupPath, parseGroupAddress, parseGroupNaddr } from "@/lib/nip29";
import { bridgePortalUrl, normalizeRelayUrl, relayToHttpUrl, relayToRouteParam } from "@/lib/platform";

import { cn } from "@/lib/utils";

interface AddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The "Add" wizard: start an encrypted Concord community, or smart-paste to join something existing. */
export function AddDialog({ open, onOpenChange }: AddDialogProps) {
  const intl = useIntl();
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "addDialog.title", defaultMessage: "Add an encrypted chat or server" })}
      >
        <AddBody onDone={close} />
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

/**
 * Add wizard body. Creating navigates to the full-screen CreateCommunityWizard.
 * Standalone hosts must render ArmadaCrestKeyframes and provide `onDone`.
 */
export function AddBody({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <ArmadaCrest size={84} />

      <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
        <FormattedMessage id="addDialog.gatherYourCrew" defaultMessage="gather your crew" />
      </h2>

      <div className="w-full max-w-sm">
        <Button
          type="button"
          size="lg"
          onClick={() => {
            // The wizard is owned by its route, so this dialog unmounting can't take its state down.
            navigate("/create");
            onDone();
          }}
          className="h-12 w-full clip-corner-lg text-base font-medium"
        >
          <ShieldCheck className="size-4 mr-2" />
          <FormattedMessage id="addDialog.createCommunity" defaultMessage="Create encrypted community" />
        </Button>
      </div>

      <ImportFromDiscordSection onOpen={onDone} />

      <EscapeHatch onDone={onDone} />
    </div>
  );
}

function ImportFromDiscordSection({ onOpen }: { onOpen: () => void }) {
  if (!bridgePortalUrl("/import")) return null;

  return (
    <div className="w-full max-w-sm space-y-2">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="addDialog.or" defaultMessage="or" />
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <ImportFromDiscordButton onOpen={onOpen} />
    </div>
  );
}

/**
 * Smart-paste classifier, checked in order: NIP-29 group naddr (kind 39000,
 * optional `?invite=<code>`), legacy `<host>'<group-id>` address, Buzz invite (`https://<host>/invite/<code>`,
 * dotted HMAC code), Concord invite (`…/invite/<naddr>#…` or `naddr#fragment`),
 * or a NIP-29 relay URL.
 */
type Classified =
  | { kind: "buzz"; invite: BuzzInvite; identity: string }
  | { kind: "concord"; invite: ParsedInviteLink; identity: string }
  | { kind: "nip29-group"; group: { relay: string; groupId: string; inviteCode?: string }; identity: string }
  | { kind: "nip29"; relay: string; identity: string }
  | { kind: "unknown"; identity: "" };

function classify(input: string): Classified {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "unknown", identity: "" };
  // Must precede the relay-URL fallback, which would swallow a bare naddr.
  // Concord bundle naddrs (kind 33301) fall through.
  const groupNaddr = parseGroupNaddr(trimmed);
  if (groupNaddr?.relay) {
    const relay = normalizeRelayUrl(groupNaddr.relay);
    if (relay) {
      return {
        kind: "nip29-group",
        group: { relay, groupId: groupNaddr.groupId, inviteCode: groupNaddr.inviteCode },
        identity: `g:${relay}:${groupNaddr.groupId}:${groupNaddr.inviteCode ?? ""}`,
      };
    }
  }
  // Also ahead of the relay-URL fallback, which would read `host'id` as a hostname.
  const groupAddress = parseGroupAddress(trimmed);
  if (groupAddress) {
    return {
      kind: "nip29-group",
      group: groupAddress,
      identity: `g:${groupAddress.relay}:${groupAddress.groupId}:${groupAddress.inviteCode ?? ""}`,
    };
  }
  const buzz = parseBuzzInviteUrl(trimmed);
  if (buzz) return { kind: "buzz", invite: buzz, identity: `buzz:${buzz.host}:${buzz.code}` };
  const invite = parseInviteLink(trimmed);
  if (invite) return { kind: "concord", invite, identity: `c2:${invite.naddr}` };
  const relay = normalizeRelayUrl(trimmed);
  if (relay) return { kind: "nip29", relay, identity: `n:${relay}` };
  return { kind: "unknown", identity: "" };
}

type Target =
  | { kind: "buzz"; relay: string; name?: string; description?: string; policy?: BuzzJoinPolicy; origin: string }
  | { kind: "concord"; name: string; channelCount: number; relays: string[] }
  | { kind: "nip29-group"; relay: string; groupId: string; inviteCode?: string }
  | { kind: "nip29"; relay: string; name?: string; description?: string };

function EscapeHatch({ onDone }: { onDone: () => void }) {
  const servers = useNip29Servers();
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const intl = useIntl();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const actions = useCommunityActions();

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [committing, setCommitting] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);

  const classified = useMemo(() => classify(value), [value]);
  const identity = classified.identity;

  const handlePaste = async () => {
    try {
      const text = (await readClipboardText()).trim();
      if (text) {
        setValue(text);
        setError(null);
      }
    } catch {
      toast({
        title: t({ id: "addDialog.pasteFailed", defaultMessage: "Paste failed" }),
        description: t({
          id: "addDialog.pasteFailedDescription",
          defaultMessage: "Couldn't read the clipboard. Paste manually instead.",
        }),
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    setTarget(null);
    setError(null);
    setPolicyAccepted(false);
    setAgeConfirmed(false);
    if (!identity) {
      setResolving(false);
      return;
    }

    let cancelled = false;
    setResolving(true);
    const timer = setTimeout(async () => {
      try {
        if (classified.kind === "buzz") {
          const relay = classified.invite.relayUrl;
          const [info, policy] = await Promise.all([
            fetch(relayToHttpUrl(relay), {
              headers: { Accept: "application/nostr+json" },
              signal: AbortSignal.timeout(8000),
            })
              .then((res) =>
                res.ok
                  ? (res.json() as Promise<{ name?: string; description?: string }>)
                  : ({} as { name?: string; description?: string }),
              )
              .catch(() => ({}) as { name?: string; description?: string }),
            fetchBuzzJoinPolicy(classified.invite.origin).catch(() => undefined),
          ]);
          if (cancelled) return;
          setTarget({
            kind: "buzz",
            relay,
            name: info.name,
            description: info.description,
            policy,
            origin: classified.invite.origin,
          });
        } else if (classified.kind === "concord") {
          const p = await actions.preview({ invite: classified.invite });
          if (cancelled) return;
          setTarget({ kind: "concord", name: p.name, channelCount: p.channelCount, relays: p.relays });
        } else if (classified.kind === "nip29-group") {
          if (cancelled) return;
          setTarget({
            kind: "nip29-group",
            relay: classified.group.relay,
            groupId: classified.group.groupId,
            inviteCode: classified.group.inviteCode,
          });
        } else if (classified.kind === "nip29") {
          const relay = classified.relay;
          if (servers.includes(relay)) {
            throw new Error(t({ id: "addDialog.alreadyInList", defaultMessage: "That server is already in your list." }));
          }
          // NIP-11 is only a preview; the join (kind 9021 over WebSocket) isn't CORS-gated,
          // and many relays lack CORS on NIP-11, so a failed fetch must not block joining.
          const info = await fetch(relayToHttpUrl(relay), {
            headers: { Accept: "application/nostr+json" },
            signal: AbortSignal.timeout(8000),
          })
            .then((res) =>
              res.ok
                ? (res.json() as Promise<{ name?: string; description?: string }>)
                : ({} as { name?: string; description?: string }),
            )
            .catch(() => ({}) as { name?: string; description?: string });
          if (cancelled) return;
          setTarget({ kind: "nip29", relay, name: info.name, description: info.description });
        }
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error
            ? e.message
            : classified.kind === "nip29"
              ? t({
                  id: "addDialog.relayUnreachable",
                  defaultMessage: "Could not reach that relay's NIP-11 endpoint. Check the URL and your network.",
                })
              : t({ id: "addDialog.inviteLoadFailed", defaultMessage: "Couldn't load that invite." }),
        );
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `identity` captures the parts of `classified` that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, servers]);

  const handleCommit = async () => {
    if (!target) return;
    setError(null);
    setCommitting(true);
    try {
      if (target.kind === "buzz") {
        if (classified.kind !== "buzz") return;
        if (!user) {
          throw new Error(
            t({ id: "addDialog.signInBuzz", defaultMessage: "Sign in first. A Buzz invite is claimed with your key." }),
          );
        }
        if (target.policy && !policyAccepted) {
          throw new Error(t({ id: "addDialog.acceptTermsRequired", defaultMessage: "Accept the server's terms to join." }));
        }
        if (target.policy?.ageAttestationRequired && !ageConfirmed) {
          throw new Error(
            t({ id: "addDialog.ageRequired", defaultMessage: "This server requires an age confirmation to join." }),
          );
        }
        await claimBuzzInvite(user.signer, classified.invite, {
          policy: target.policy,
          ageConfirmed,
        });
        // The 10009 list is the only rail source, so this write IS the add; awaited so failures surface.
        await updateList({ type: "add-server", url: target.relay });
        onDone();
        toast({ title: t({ id: "addDialog.joined", defaultMessage: "Joined" }), description: target.name || target.relay });
        navigate(`/s/${relayToRouteParam(target.relay)}`);
        return;
      }
      if (target.kind === "concord") {
        if (classified.kind !== "concord") return;
        const { communityId, name, alreadyMember } = await actions.join({ invite: classified.invite });
        onDone();
        toast({
          title: alreadyMember
            ? t({ id: "addDialog.alreadyMember", defaultMessage: "You're already in this community" })
            : t({ id: "addDialog.communityJoined", defaultMessage: "Encrypted community joined" }),
          description: name,
        });
        navigate(`/c/${encodeURIComponent(communityId)}`);
        return;
      }
      if (target.kind === "nip29-group") {
        // Joining on the channel page adds the server to the rail.
        onDone();
        navigate(nip29GroupPath(target));
        return;
      }
      // The 10009 list is the only store for added servers, so this needs a signer
      // and is awaited so failures surface.
      if (!user) {
        throw new Error(
          t({
            id: "addDialog.signInServerList",
            defaultMessage: "Sign in first. Your server list is stored on your Nostr account.",
          }),
        );
      }
      await updateList({ type: "add-server", url: target.relay });
      toast({ title: t({ id: "addDialog.serverAdded", defaultMessage: "Server added" }), description: target.name || target.relay });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "addDialog.genericError", defaultMessage: "Something went wrong." }));
    } finally {
      setCommitting(false);
    }
  };

  const busy = actions.isJoining || committing;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-sm">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="mx-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Link2 className="size-3.5" />
          <FormattedMessage id="addDialog.haveInvite" defaultMessage="Have an invite or server URL?" />
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCommit();
          }}
          className="mt-4 text-left"
        >
          <div className="flex gap-2">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={intl.formatMessage({ id: "addDialog.inputPlaceholder", defaultMessage: "Paste invite or server URL" })}
              aria-label={intl.formatMessage({
                id: "addDialog.inputLabel",
                defaultMessage: "Invite link, invite code, or server URL",
              })}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0"
            />
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={intl.formatMessage({ id: "addDialog.pasteFromClipboard", defaultMessage: "Paste from clipboard" })}
                    onClick={handlePaste}
                  >
                    <ClipboardPaste className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="z-[260] max-w-60 text-center text-xs">
                  <FormattedMessage
                    id="addDialog.pasteHint"
                    defaultMessage="Paste a Concord invite link, a bare invite code, or a server relay URL. We detect which it is."
                  />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {resolving && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {classified.kind === "nip29" ? (
                <FormattedMessage id="addDialog.reachingServer" defaultMessage="Reaching server..." />
              ) : (
                <FormattedMessage id="addDialog.loadingInvite" defaultMessage="Loading invite..." />
              )}
            </div>
          )}

          {error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {target && !resolving && (
            <>
              <TargetPreview target={target} />
              {/* Buzz: operator terms must be accepted; the receipt is bound to the invite code. */}
              {target.kind === "buzz" && target.policy && (
                <div className="mt-3 space-y-2 text-left text-xs text-muted-foreground">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={policyAccepted}
                      onChange={(e) => setPolicyAccepted(e.target.checked)}
                    />
                    <span>
                      <FormattedMessage
                        id="addDialog.acceptTerms"
                        defaultMessage="I accept this server's {hasTerms, select, true {<terms>Terms of Service</terms>} other {terms}}{hasPrivacy, select, true { and <privacy>Privacy Policy</privacy>} other {}}."
                        values={{
                          hasTerms: target.policy.termsMarkdown ? "true" : "false",
                          hasPrivacy: target.policy.privacyMarkdown ? "true" : "false",
                          terms: (chunks) => (
                            <a
                              href={`${target.origin}/api/join-policy/terms`}
                              target="_blank"
                              rel="noreferrer"
                              className="underline hover:text-foreground"
                            >
                              {chunks}
                            </a>
                          ),
                          privacy: (chunks) => (
                            <a
                              href={`${target.origin}/api/join-policy/privacy`}
                              target="_blank"
                              rel="noreferrer"
                              className="underline hover:text-foreground"
                            >
                              {chunks}
                            </a>
                          ),
                        }}
                      />
                    </span>
                  </label>
                  {target.policy.ageAttestationRequired && (
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={ageConfirmed}
                        onChange={(e) => setAgeConfirmed(e.target.checked)}
                      />
                      <span>
                        <FormattedMessage
                          id="addDialog.confirmAge"
                          defaultMessage="I confirm I meet this server's minimum age requirement."
                        />
                      </span>
                    </label>
                  )}
                </div>
              )}
              <Button
                type="submit"
                disabled={
                  busy ||
                  (target.kind === "buzz" && !user) ||
                  (target.kind === "buzz" && Boolean(target.policy) && !policyAccepted) ||
                  (target.kind === "buzz" && Boolean(target.policy?.ageAttestationRequired) && !ageConfirmed)
                }
                className="mt-3 w-full clip-corner-lg"
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                    {target.kind === "nip29" ? (
                      <FormattedMessage id="addDialog.adding" defaultMessage="Adding..." />
                    ) : (
                      <FormattedMessage id="addDialog.joining" defaultMessage="Joining..." />
                    )}
                  </>
                ) : target.kind === "nip29" ? (
                  <FormattedMessage id="addDialog.addServer" defaultMessage="Add server" />
                ) : target.kind === "nip29-group" ? (
                  <FormattedMessage id="addDialog.openChannel" defaultMessage="Open channel" />
                ) : target.kind === "buzz" && !user ? (
                  <FormattedMessage id="addDialog.signInToJoin" defaultMessage="Sign in to join" />
                ) : (
                  <FormattedMessage id="addDialog.join" defaultMessage="Join" />
                )}
              </Button>
            </>
          )}
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TargetPreview({ target }: { target: Target }) {
  const intl = useIntl();
  const isConcord = target.kind === "concord";
  const Icon = isConcord ? ShieldCheck : target.kind === "nip29-group" ? Hash : Server;
  const title =
    target.kind === "nip29-group"
      ? `#${target.groupId}`
      : target.kind === "nip29" || target.kind === "buzz"
        ? target.name || target.relay
        : target.name;
  const subtitle =
    target.kind === "nip29-group"
      ? target.relay
      : target.kind === "buzz"
        ? target.description ||
          intl.formatMessage({ id: "addDialog.buzzWorkspace", defaultMessage: "Buzz workspace · {relay}" }, { relay: target.relay })
        : target.kind === "nip29"
          ? target.description || target.relay
          : intl.formatMessage(
              {
                id: "addDialog.encryptedCommunityChannels",
                defaultMessage: "Encrypted community · {count, plural, one {# channel} other {# channels}}",
              },
              { count: target.channelCount },
            );

  return (
    <div className="mt-3 flex items-start gap-3 rounded-lg bg-secondary/50 p-3 text-left">
      <Icon className={cn("mt-0.5 size-5 shrink-0", isConcord ? "text-success" : "text-muted-foreground")} />
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-wider text-muted-foreground">
          {isConcord ? (
            <FormattedMessage id="addDialog.youreJoining" defaultMessage="You're joining" />
          ) : target.kind === "nip29-group" ? (
            <FormattedMessage id="addDialog.youreOpeningChannel" defaultMessage="You're opening the channel" />
          ) : target.kind === "buzz" ? (
            <FormattedMessage id="addDialog.youreJoiningWorkspace" defaultMessage="You're joining the workspace" />
          ) : (
            <FormattedMessage id="addDialog.youreAddingServer" defaultMessage="You're adding the server" />
          )}
        </div>
        <div className="truncate font-medium">{title || <FormattedMessage id="addDialog.untitled" defaultMessage="Untitled" />}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
}
