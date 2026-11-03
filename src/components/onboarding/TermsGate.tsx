import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormattedMessage } from "@/i18n";
import { TERMS_ACCEPTED_KEY, termsNeeded } from "@/lib/platform";

/**
 * On the iOS app, an explicit agreement to the Terms before logging in or
 * creating an account (App Review guideline 1.2). Asked once per device;
 * elsewhere the passive line in `SignupTerms` stands.
 */
export function TermsGate({ children, onAccepted }: { children?: ReactNode; onAccepted?: () => void }) {
  const [accepted, setAccepted] = useState(() => !termsNeeded());
  const [checked, setChecked] = useState(false);

  if (accepted) return <>{children}</>;

  const accept = () => {
    try {
      localStorage.setItem(TERMS_ACCEPTED_KEY, "1");
    } catch { /* still let them in this session */ }
    setAccepted(true);
    onAccepted?.();
  };

  const link = (chunks: ReactNode[]) => (
    <a href="/terms" className="text-primary hover:underline">
      {chunks}
    </a>
  );

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
        <FormattedMessage id="termsGate.title" defaultMessage="before you start" />
      </h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <FormattedMessage
          id="termsGate.body"
          defaultMessage="There is no tolerance for objectionable content or abusive users. You can report messages, block people and filter words, and reports sent to support are acted on within 24 hours."
        />
      </p>
      <label className="flex items-start gap-3 text-left text-sm text-foreground">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => setChecked(v === true)}
          className="mt-0.5 touch:size-5"
          aria-describedby="terms-gate-label"
        />
        <span id="terms-gate-label">
          <FormattedMessage
            id="termsGate.agree"
            defaultMessage="I agree to the <link>Terms of Service</link>."
            values={{ link }}
          />
        </span>
      </label>
      <Button size="lg" className="w-full clip-corner-lg" disabled={!checked} onClick={accept}>
        <FormattedMessage id="termsGate.continue" defaultMessage="Continue" />
      </Button>
    </div>
  );
}
