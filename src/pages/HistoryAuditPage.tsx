import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";

import { HistoryAuditView } from "@/concord/components/HistoryAuditView";
import { useCommunity } from "@/concord/hooks/useCommunityList";

/**
 * The history audit + export tool, as a route.
 *
 * A route rather than a dialog (mirroring {@link DiscordImportPage}): the audit
 * outlives the settings dialog its entry point sits in, so owning it here means
 * nothing below can unmount it, and the settings dialog disappears on its own
 * because the route changed. Portalled to `<body>` because `WizardShell` is
 * `position: fixed` and a transformed ancestor would shrink it to that box.
 */
export function HistoryAuditPage() {
  const navigate = useNavigate();
  const { communityId } = useParams<{ communityId: string }>();
  const community = useCommunity(communityId);

  const close = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(communityId ? `/c/${communityId}` : "/", { replace: true });
  };

  // Not joined / still resolving — the community view is the right place to be.
  if (!community) return null;

  return createPortal(<HistoryAuditView community={community} onClose={close} />, document.body);
}
