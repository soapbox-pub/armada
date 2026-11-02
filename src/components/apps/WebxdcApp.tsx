import { Blocks } from "lucide-react";
import { useMemo } from "react";

import { Webxdc } from "@/components/Webxdc";
import { appScopeKey, type AppScope } from "@/contexts/AppsContext";
import { useIntl } from "@/i18n";
import { useWebxdcApi, type AppSync } from "@/hooks/useWebxdcApi";
import { webxdcSubdomain } from "@/lib/iframeSubdomain";
import type { ImetaEncryption } from "@/lib/imeta";

/**
 * Runs a `.xdc` app in the cross-origin sandbox, backing `window.webxdc` with
 * {@link AppSync}.
 */
export function WebxdcApp({
  scope,
  sync,
  url,
  sessionId,
  name,
  encryption,
}: {
  scope: AppScope;
  sync: AppSync;
  url: string;
  sessionId: string;
  name?: string;
  encryption?: ImetaEncryption;
}) {
  const intl = useIntl();
  const api = useWebxdcApi(sync);
  const title = name ?? intl.formatMessage({ id: "webxdcApp.defaultName", defaultMessage: "Webxdc app" });
  // Keyed on the scope KEY: a Concord rotation replaces the scope object only.
  const scopeKey = appScopeKey(scope);
  const iframeId = useMemo(
    () => webxdcSubdomain(scopeKey, sessionId, url, encryption),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey, sessionId, url, encryption?.key, encryption?.nonce],
  );

  return (
    <div className="relative w-full overflow-hidden rounded-lg bg-white" style={{ height: "min(70vh, 600px)" }}>
      <Webxdc
        id={iframeId}
        xdc={url}
        encryption={encryption}
        webxdc={api}
        title={title}
        className="w-full h-full border-0"
      />
      <noscript>
        <div className="flex items-center gap-2 p-4 text-sm">
          <Blocks className="size-4" /> {title}
        </div>
      </noscript>
    </div>
  );
}
