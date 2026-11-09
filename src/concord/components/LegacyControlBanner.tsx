import { ShieldAlert, X } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";

const dismissedKey = (communityIdHex: string) => `armada:legacy-control-dismissed:${communityIdHex}`;

function readDismissed(communityIdHex: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(communityIdHex)) === "1";
  } catch {
    return false;
  }
}

/**
 * Sidebar prompt for staff of a pre-split Community (no `control_pk`, CORD-02 §5):
 * its Control Plane is member-writable until a base rotation mints the split
 * (CORD-06 §3, "a client SHOULD offer staff a deliberate upgrade Refounding").
 * Dismissal is per device and community; the community menu keeps the action.
 */
export function LegacyControlBanner({ communityIdHex, onUpgrade }: { communityIdHex: string; onUpgrade: () => void }) {
  const intl = useIntl();
  const [dismissed, setDismissed] = useState(() => readDismissed(communityIdHex));
  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(dismissedKey(communityIdHex), "1");
    } catch {
      /* storage unavailable: dismiss for this session only */
    }
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        "flex w-full items-center gap-1 text-sm clip-corner-lg",
        "bg-warning/15 text-warning font-semibold",
      )}
    >
      <button
        type="button"
        onClick={onUpgrade}
        className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 touch:py-3 text-left transition-colors hover:bg-warning/10 clip-corner-lg"
      >
        <ShieldAlert className="size-4 shrink-0" />
        <span className="truncate flex-1 min-w-0">
          <FormattedMessage id="legacyControlBanner.label" defaultMessage="Upgrade security" />
        </span>
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={intl.formatMessage({ id: "legacyControlBanner.dismiss", defaultMessage: "Dismiss" })}
        className="flex shrink-0 items-center justify-center size-7 touch:size-11 transition-colors hover:bg-warning/10 clip-corner-lg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
