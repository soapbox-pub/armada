import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { NostrEvent } from "@nostrify/nostrify";

import { ArmadaIdentity } from "@/components/brand/ArmadaCrest";
import { ProfileStepBody } from "@/components/onboarding/ProfileStep";
import { WizardShell } from "@/components/onboarding/WizardShell";
import {
  CreatingAccountStepBody,
  useSignupKey,
} from "@/components/onboarding/signupSteps";
import { SignupTerms } from "@/components/onboarding/SignupTerms";
import { TermsGate } from "@/components/onboarding/TermsGate";
import { termsNeeded } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { FormattedMessage } from "@/i18n";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { suppressNextSyncGate } from "@/hooks/useFreshLogin";
import { setOnboardingActive } from "@/hooks/useOnboarding";
import { useSignupLists } from "@/hooks/useSignupLists";
import { clearPendingJoin, peekPendingJoin, type JoinLink } from "@/lib/joinLink";
import { clearKeyBackupPending, markKeyBackupPending } from "@/lib/keyBackup";
import { defaultSignupSetup } from "@/lib/signupLists";
import { markNotificationSettingsReady } from "@/lib/notificationSettingsAuthority";
import { markRelayRecoveryPromptShown } from "@/lib/relayRecoveryPrompt";
import { useLoginActions } from "@/hooks/useLoginActions";

/**
 * Full-page account-creation wizard (Ditto-style): the minted key signs in at
 * once → profile (skippable) → Discover, on the default relays. Backing the key
 * up is asked for later (`KeyBackupReminder`). Step bodies are shared with
 * {@link SignupDialog} (`signupSteps.tsx`); this adds a `/join` confirmation
 * (whose relays become the home relays) and the exit onto /discover.
 * Lazy-loaded: the landing doesn't need its deps.
 */

type WizardStep = "create" | "profile";

export interface SignupWizardProps {
  /** Leave without finishing (back off step one, close, or declining a join link). */
  onExit: () => void;
}

export function SignupWizard({ onExit }: SignupWizardProps) {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const login = useLoginActions();
  const signupKey = useSignupKey();
  // A stashed `/join` link: the operator's relays to seed onto. Its
  // confirmation screen precedes key generation.
  const [join, setJoin] = useState<JoinLink | undefined>(() => peekPendingJoin());
  // `null` is the join confirmation step.
  const [step, setStep] = useState<WizardStep | null>(() => (peekPendingJoin() ? null : "create"));
  const [termsOk, setTermsOk] = useState(() => !termsNeeded());
  const dismissJoin = () => {
    clearPendingJoin();
    setJoin(undefined);
    onExit();
  };
  // One login per attempt; `createFailed` offers the retry.
  const creatingRef = useRef(false);
  const [createFailed, setCreateFailed] = useState(false);
  // Home relays are the join link's, else the app's; the rest follow the app defaults.
  const [setup] = useState(() => defaultSignupSetup(join ? join.relays : config.appRelays, config));

  // Clear on any exit; it's set synchronously at login (createAccount) to beat the race.
  useEffect(() => () => setOnboardingActive(false), []);

  const signupLists = useSignupLists();
  // The profile step's kind 0, re-sent to the full relay set at the end.
  const profileRef = useRef<NostrEvent | undefined>(undefined);

  // The ONE exception to never-auto-publish: a key minted moments ago has
  // provably no existing list to overwrite. Closing the profile step finishes
  // too. Then exit onto Discover: browsing live communities beats a blank form.
  const finishOnboarding = () => {
    void signupLists.publish(signupKey.nsec, setup, profileRef.current);
    navigate("/discover");
  };

  // Log in as the new account; its backup is asked for later.
  const createAccount = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreateFailed(false);
    const { identity, nsec } = signupKey;
    // Brand-new account: skip the post-login SyncGate, whose overlay (z-100)
    // would cover the wizard (z-50).
    if (identity) {
      suppressNextSyncGate(identity.pubkey);
      markRelayRecoveryPromptShown(identity.pubkey);
      // The skipped gate is what would prove it, but a key minted moments ago has
      // no notifications document anywhere: the defaults are its policy.
      markNotificationSettingsReady(identity.pubkey);
      // Before login: the login may reload the app (adding an account is a switch).
      markKeyBackupPending(identity.pubkey);
    }

    if (join) clearPendingJoin();

    // Home relays only, so the profile step publishes there; the lists follow at the end.
    if (identity) signupLists.seed(identity.pubkey, setup.home);

    // Set BEFORE login so the first commit exposing the user already suppresses
    // the web-push opt-in and native notification step.
    setOnboardingActive(true);
    try {
      // Awaited: advancing before the login persists blanks the wizard and
      // leaves a rejected persist unhandled.
      await login.nsec(nsec);
    } catch {
      creatingRef.current = false;
      setCreateFailed(true);
      setOnboardingActive(false);
      if (identity) clearKeyBackupPending(identity.pubkey);
      return;
    }
    setStep("profile");
  };

  useEffect(() => {
    if (step === "create" && termsOk) void createAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, termsOk]);

  if (step === "create" && !termsOk) {
    return (
      <WizardShell index={0} total={0} stepKey="terms" onClose={onExit}>
        <TermsGate onAccepted={() => setTermsOk(true)} />
      </WizardShell>
    );
  }

  if (step === "create") {
    return (
      // No way out mid-login: leaving would land a half-created account in the app.
      <WizardShell
        index={0}
        total={0}
        stepKey="create"
        onBack={createFailed ? onExit : undefined}
        onClose={createFailed ? onExit : undefined}
      >
        <CreatingAccountStepBody failed={createFailed} onRetry={() => void createAccount()} />
      </WizardShell>
    );
  }

  // No back arrow: the account exists now, and back would loop.
  if (user && step === "profile") {
    return (
      <WizardShell index={0} total={0} stepKey="profile" onClose={finishOnboarding}>
        <ProfileStepBody
          expectedPubkey={signupKey.identity?.pubkey}
          onPublished={(event) => { profileRef.current = event; }}
          onFinish={finishOnboarding}
        />
      </WizardShell>
    );
  }

  // Join link: name the operator and relays, then hand off to key generation
  // (relays are adopted at account creation, not here).
  if (!user && join && step === null) {
    const host = (url: string) => url.replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
    return (
      <WizardShell index={0} total={0} stepKey="join" onClose={dismissJoin}>
        <div className="flex flex-col items-center gap-6 text-center">
          <ArmadaIdentity size={96} />
          <div className="space-y-2.5">
            <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
              <FormattedMessage
                id="signupWizard.join.title"
                defaultMessage="join {name}"
                values={{ name: join.name ?? host(join.relays[0]) }}
              />
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              <FormattedMessage
                id="signupWizard.join.body"
                defaultMessage="You've been invited to create a new Armada account hosted on {count, plural, one {this relay} other {these relays}}. Your account's data will live here so it's ready wherever you sign in. You can change this later in Settings."
                values={{ count: join.relays.length }}
              />
            </p>
          </div>
          <div className="w-full space-y-1 clip-corner-lg bg-secondary/50 p-3 text-left">
            {join.relays.map((url) => (
              <p key={url} className="break-all font-mono text-xs text-foreground">
                {host(url)}
              </p>
            ))}
          </div>
          <div className="w-full space-y-2">
            <Button
              size="lg"
              className="h-12 w-full clip-corner-lg text-base font-medium"
              onClick={() => setStep("create")}
            >
              <FormattedMessage id="signupWizard.join.create" defaultMessage="Create my account" />
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={dismissJoin}
            >
              <FormattedMessage id="signupWizard.join.notNow" defaultMessage="Not now" />
            </Button>
            <SignupTerms />
          </div>
        </div>
      </WizardShell>
    );
  }

  // Nothing matches (closed, or login landed mid signed-out step): the landing route re-decides.
  return null;
}

export default SignupWizard;
