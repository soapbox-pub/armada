import { Blocks } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApps } from "@/hooks/useApps";
import { useChatScope } from "@/hooks/useChatScope";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { deriveUrlTopicId } from "@/lib/webxdcRealtime";
import { appScopeKey } from "@/contexts/AppsContext";
import type { ImetaEntry } from "@/lib/imeta";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { FormattedMessage, useIntl } from "@/i18n";

/**
 * A `.xdc` attachment: launches in the app stage, joined to the session keyed by
 * the attachment's `webxdc` uuid. Falls back to a download link without a chat scope.
 */
export function XdcAttachment({
  url,
  imeta,
  messageId,
  hideIcon = false,
}: {
  url: string;
  imeta?: ImetaEntry;
  messageId?: string;
  /** The sender's icon is held (`mediaHold.ts`); the app still opens on request. */
  hideIcon?: boolean;
}) {
  const intl = useIntl();
  const scope = useChatScope();
  const { activeApp, launchApp } = useApps();
  const name = imeta?.summary || intl.formatMessage({ id: "xdcAttachment.defaultName", defaultMessage: "Webxdc app" });
  // A pasted link has no minted topic, so every client derives the same one from
  // the URL and message id; otherwise each client gets a solo session.
  const sessionId = imeta?.webxdc ?? (messageId ? deriveUrlTopicId(url, messageId) : undefined);
  // An encrypted attachment's thumb is ciphertext; only show plaintext icons.
  const icon = useMediaSrc(imeta?.encryption || hideIcon ? undefined : sanitizeImageSrc(imeta?.thumbnail));

  const openHere = Boolean(
    activeApp &&
      scope &&
      appScopeKey(activeApp.scope) === appScopeKey(scope) &&
      activeApp.app.type === "webxdc" &&
      sessionId &&
      activeApp.sessionId === sessionId,
  );

  const handleLaunch = () => {
    if (!scope) return;
    launchApp(scope, { type: "webxdc", url, name, encryption: imeta?.encryption }, sessionId);
  };

  return (
    <div
      className="my-1.5 flex items-center gap-3 max-w-sm clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.3] px-3.5 py-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="size-9 clip-corner-lg bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
        {icon ? (
          <img src={icon} alt="" className="size-full object-cover" />
        ) : (
          <Blocks className="size-4.5 text-primary" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold truncate">{name}</p>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage id="xdcAttachment.kind" defaultMessage="Webxdc app" />
        </p>
      </div>
      {scope ? (
        <Button size="sm" className="h-8 shrink-0" onClick={handleLaunch} disabled={openHere}>
          {openHere
            ? intl.formatMessage({ id: "xdcAttachment.open", defaultMessage: "Open" })
            : intl.formatMessage({ id: "xdcAttachment.launch", defaultMessage: "Launch" })}
        </Button>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline shrink-0"
        >
          <FormattedMessage id="xdcAttachment.download" defaultMessage="Download" />
        </a>
      )}
    </div>
  );
}
