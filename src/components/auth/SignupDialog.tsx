import React, { useEffect, useRef, useState } from 'react';

import type { NostrEvent } from '@nostrify/nostrify';

import { ProfileStepBody } from '@/components/onboarding/ProfileStep';
import { WizardShell } from '@/components/onboarding/WizardShell';
import { TermsGate } from '@/components/onboarding/TermsGate';
import { termsNeeded } from '@/lib/platform';
import {
  CreatingAccountStepBody,
  signupIdentity,
  useSignupKey,
} from '@/components/onboarding/signupSteps';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useSignupLists } from '@/hooks/useSignupLists';
import { defaultSignupSetup } from '@/lib/signupLists';
import { suppressNextSyncGate } from '@/hooks/useFreshLogin';
import { setOnboardingActive } from '@/hooks/useOnboarding';
import { clearKeyBackupPending, markKeyBackupPending } from '@/lib/keyBackup';
import { markNotificationSettingsReady } from '@/lib/notificationSettingsAuthority';
import { markRelayRecoveryPromptShown } from '@/lib/relayRecoveryPrompt';

interface SignupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after account creation and the profile step, so the caller can resume. */
  onComplete?: () => void;
}

/**
 * In-app account creation (from {@link LoginScreen}'s "Create account"). Shares
 * step bodies with the landing {@link SignupWizard} (`signupSteps.tsx`,
 * `ProfileStep.tsx`) and the default lists ({@link useSignupLists}) but doesn't
 * navigate; it hands back through `onComplete`. A fresh key suppresses the sync gate and
 * {@link LoginSetup}'s restore step.
 */
const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose, onComplete }) => {
  const login = useLoginActions();
  const { user } = useCurrentUser();
  const signupKey = useSignupKey();
  const { config } = useAppContext();
  const signupLists = useSignupLists();
  const [step, setStep] = useState<'create' | 'profile'>('create');
  const [setup, setSetup] = useState(() => defaultSignupSetup(config.appRelays, config));
  // The profile step's kind 0, re-sent to the full relay set at the end.
  const profileRef = useRef<NostrEvent | undefined>(undefined);
  // One login per attempt; `createFailed` offers the retry.
  const creatingRef = useRef(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [termsOk, setTermsOk] = useState(() => !termsNeeded());

  // Awaited: the profile step renders on `user`, and a rejected persist must be handled.
  const createAccount = async (nsec: string, home: string[]) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreateFailed(false);
    const identity = signupIdentity(nsec);
    // Brand-new key: skip the post-login sync gate and LoginSetup's restore step
    // (see SignupWizard.createAccount).
    if (identity) {
      suppressNextSyncGate(identity.pubkey);
      markRelayRecoveryPromptShown(identity.pubkey);
      markNotificationSettingsReady(identity.pubkey);
      markKeyBackupPending(identity.pubkey);
      // Home relays only, so the profile step publishes there; the lists follow at the end.
      signupLists.seed(identity.pubkey, home);
    }
    // BEFORE login, so LoginSetup (z-[260]) never paints over the profile step (z-[255]).
    setOnboardingActive(true);
    try {
      await login.nsec(nsec);
    } catch {
      creatingRef.current = false;
      setCreateFailed(true);
      setOnboardingActive(false);
      if (identity) clearKeyBackupPending(identity.pubkey);
      return;
    }
    setStep('profile');
  };

  // Opening the dialog IS the request to create an account.
  useEffect(() => {
    if (!isOpen || !termsOk) return;
    setStep('create');
    const fresh = defaultSignupSetup(config.appRelays, config);
    setSetup(fresh);
    profileRef.current = undefined;
    creatingRef.current = false;
    void createAccount(signupKey.reset(), fresh.home);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, termsOk]);

  // Backstop for an unmount that skips finishOnboarding.
  useEffect(() => () => setOnboardingActive(false), []);

  // Fresh key only: the sanctioned signup list publish, of the default lists.
  const finishOnboarding = () => {
    void signupLists.publish(signupKey.nsec, setup, profileRef.current);
    setOnboardingActive(false);
    onComplete?.();
    onClose();
  };

  if (!isOpen) return null;

  if (!termsOk) {
    return (
      <WizardShell index={0} total={0} stepKey="terms" zClassName="z-[255]" onClose={onClose}>
        <TermsGate onAccepted={() => setTermsOk(true)} />
      </WizardShell>
    );
  }

  if (step === 'create') {
    return (
      <WizardShell
        index={0}
        total={0}
        stepKey="create"
        zClassName="z-[255]"
        onClose={createFailed ? onClose : undefined}
      >
        <CreatingAccountStepBody
          failed={createFailed}
          onRetry={() => void createAccount(signupKey.nsec, setup.home)}
        />
      </WizardShell>
    );
  }

  // No back arrow: the account can't be un-created. Waits for `user` to commit.
  if (step === 'profile' && user) {
    return (
      <WizardShell index={0} total={0} stepKey="profile" zClassName="z-[255]" onClose={finishOnboarding}>
        <ProfileStepBody
          expectedPubkey={signupKey.identity?.pubkey}
          onPublished={(event) => { profileRef.current = event; }}
          onFinish={finishOnboarding}
        />
      </WizardShell>
    );
  }

  // Login landed but `user` not yet committed.
  return null;
};

export default SignupDialog;
