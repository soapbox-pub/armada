import { Blocks, Maximize2, Minimize2, MonitorPlay, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { WebxdcApp } from "@/components/apps/WebxdcApp";
import { Watchalong } from "@/components/apps/Watchalong";
import { Button } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/i18n";
import { useConcordAppSync } from "@/concord/hooks/useConcordAppSync";
import { useDmAppSync } from "@/hooks/useDmAppSync";
import { useGroupAppSync } from "@/hooks/useGroupAppSync";
import {
  AppsContext,
  appScopeKey,
  defaultSessionId,
  type ActiveApp,
  type AppKind,
  type AppScope,
} from "@/contexts/AppsContext";
import type { AppSync } from "@/hooks/useWebxdcApi";

function appHeader(app: AppKind): { label: React.ReactNode; icon: React.ReactNode } {
  if (app.type === "youtube") {
    return {
      label: <FormattedMessage id="appsProvider.watchTogether" defaultMessage="Watch together" />,
      icon: <MonitorPlay className="size-3 text-primary" />,
    };
  }
  return {
    label: app.name ?? <FormattedMessage id="appsProvider.webxdcApp" defaultMessage="Webxdc app" />,
    icon: <Blocks className="size-3 text-primary" />,
  };
}

function AppSurface({ scope, app, sessionId, sync }: { scope: AppScope; app: AppKind; sessionId: string; sync: AppSync }) {
  if (app.type === "youtube") {
    return <Watchalong sync={sync} />;
  }
  return <WebxdcApp scope={scope} sync={sync} url={app.url} sessionId={sessionId} name={app.name} encryption={app.encryption} />;
}

function Nip29RunningApp({
  active,
  relayUrl,
  groupId,
  children,
}: {
  active: ActiveApp;
  relayUrl: string;
  groupId: string;
  children: (sync: AppSync) => React.ReactNode;
}) {
  const sync = useGroupAppSync(relayUrl, groupId, active.sessionId);
  return <>{children(sync)}</>;
}

function Concord2RunningApp({
  active,
  children,
}: {
  active: ActiveApp & { scope: Extract<AppScope, { kind: "concord" }> };
  children: (sync: AppSync) => React.ReactNode;
}) {
  const sync = useConcordAppSync(active.scope.community, active.scope.channel, active.sessionId);
  return <>{children(sync)}</>;
}

function DmRunningApp({
  active,
  children,
}: {
  active: ActiveApp & { scope: Extract<AppScope, { kind: "dm" }> };
  children: (sync: AppSync) => React.ReactNode;
}) {
  const sync = useDmAppSync(active.scope.conversation, active.sessionId);
  return <>{children(sync)}</>;
}

/**
 * The persistent app: resolves its scope's sync backend and portals the stage
 * into registered top-of-chat slots.
 */
function RunningApp({
  active,
  slots,
  stageOpen,
  onClose,
  onToggle,
}: {
  active: ActiveApp;
  slots: HTMLElement[];
  stageOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const { label, icon } = appHeader(active.app);

  const renderStage = (sync: AppSync) => {
    const stage = (
      <div className="mx-gutter mt-3">
        <div className="clip-corner-lg bg-chrome overflow-hidden">
          {/* The pinned bar's header: an uppercase label, then compact ghost actions. */}
          <div className="flex items-center gap-1.5 pl-3 pr-1.5 py-1.5">
            {icon}
            <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground/80 truncate flex-1 min-w-0">{label}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 touch:size-10 text-muted-foreground"
              aria-label={
                stageOpen
                  ? intl.formatMessage({ id: "appsProvider.minimize", defaultMessage: "Minimize app" })
                  : intl.formatMessage({ id: "appsProvider.expand", defaultMessage: "Expand app" })
              }
              onClick={onToggle}
            >
              {stageOpen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 touch:size-10 text-muted-foreground"
              aria-label={intl.formatMessage({ id: "appsProvider.close", defaultMessage: "Close app" })}
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          {stageOpen && (
            <div className="px-3 pb-3 max-h-[80vh] overflow-y-auto">
              <AppSurface scope={active.scope} app={active.app} sessionId={active.sessionId} sync={sync} />
            </div>
          )}
        </div>
      </div>
    );
    return (
      <>
        {slots.map((el, i) => createPortal(stage, el, `app-stage-slot-${i}`))}
      </>
    );
  };

  if (active.scope.kind === "nip29") {
    return (
      <Nip29RunningApp active={active} relayUrl={active.scope.relayUrl} groupId={active.scope.groupId}>
        {renderStage}
      </Nip29RunningApp>
    );
  }
  if (active.scope.kind === "dm") {
    return (
      <DmRunningApp active={active as ActiveApp & { scope: Extract<AppScope, { kind: "dm" }> }}>
        {renderStage}
      </DmRunningApp>
    );
  }
  return (
    <Concord2RunningApp active={active as ActiveApp & { scope: Extract<AppScope, { kind: "concord" }> }}>
      {renderStage}
    </Concord2RunningApp>
  );
}

/**
 * Holds the open in-chat app and renders it from never-unmounting MainLayout so
 * it survives navigation, like `CallProvider`.
 */
export function AppsProvider({ children }: { children: React.ReactNode }) {
  const [activeApp, setActiveApp] = useState<ActiveApp | null>(null);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const [stageOpen, setStageOpen] = useState(true);

  const launchApp = useCallback((scope: AppScope, app: AppKind, sessionId?: string) => {
    // Scope-derived session so everyone in the channel joins the SAME app.
    const id = sessionId ?? defaultSessionId(scope, app);
    setStageOpen(true);
    setActiveApp({ scope, app, sessionId: id });
  }, []);

  const closeApp = useCallback(() => {
    setActiveApp(null);
  }, []);

  const refreshScope = useCallback((scope: AppScope) => {
    setActiveApp((prev) => {
      if (!prev || appScopeKey(prev.scope) !== appScopeKey(scope)) return prev;
      // Identity matters: a new object would remount the app and reset the game.
      return prev.scope === scope ? prev : { ...prev, scope };
    });
  }, []);

  const registerAppStageSlot = useCallback((el: HTMLElement) => {
    setSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  const toggleStage = useCallback(() => setStageOpen((o) => !o), []);

  const value = useMemo(
    () => ({
      activeApp,
      launchApp,
      closeApp,
      refreshScope,
      registerAppStageSlot,
      stageOpen,
      toggleStage,
      setStageOpen,
    }),
    [activeApp, launchApp, closeApp, refreshScope, registerAppStageSlot, stageOpen, toggleStage],
  );

  return (
    <AppsContext.Provider value={value}>
      {children}
      {activeApp && (
        <RunningApp
          key={`${appScopeKey(activeApp.scope)}|${activeApp.sessionId}`}
          active={activeApp}
          slots={slots}
          stageOpen={stageOpen}
          onClose={closeApp}
          onToggle={toggleStage}
        />
      )}
    </AppsContext.Provider>
  );
}
