// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { NostrLoginProvider } from "@nostrify/react/login";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";

import { ensureAndroidBackListener } from "@/hooks/useAndroidBack";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { AccountExitGate } from "@/components/AccountExitGate";
import { ActiveAccountSync } from "@/components/ActiveAccountSync";
import { AppProvider } from "@/components/AppProvider";
import { ArmadaDBProvider } from "@/components/ArmadaDBProvider";
import { DeepLinkWarmup } from "@/components/DeepLinkWarmup";
import { MeshProvider } from "@/components/MeshProvider";
import { MutedPubkeysProvider } from "@/components/MutedPubkeysProvider";
import NostrProvider from "@/components/NostrProvider";
import { ReadStateProvider } from "@/components/ReadStateProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import WalletProvider from "@/components/WalletProvider";
import { WebPushNotifications } from "@/components/WebPushNotifications";
import { initGroupKeyPersistence } from "@/concord/lib/groupKeyPersist";
import { secureStorage } from "@/lib/secureStorage";
import { APP_CONFIG_STORAGE_KEY } from "@/lib/activeAccount";
import { likelySignedIn } from "@/lib/likelySignedIn";
import { instrumentQueryCache } from "@/lib/perfRuntime";
import { LOGIN_STORAGE_KEY } from "@/lib/switchAccount";

import AppRouter from "./AppRouter";

const LazySignedInServices = lazy(() =>
  import("@/components/SignedInServices").then((m) => ({ default: m.SignedInServices })),
);
const LazySignedInPushServices = lazy(() =>
  import("@/components/SignedInServices").then((m) => ({ default: m.SignedInPushServices })),
);

// Prefetch on a likely-signed-in launch so deferring the services doesn't slow it.
if (likelySignedIn()) {
  void import("@/components/SignedInServices").catch(() => undefined);
}

/**
 * The `user` gate lives outside the lazy boundary so signed-out visitors never
 * fetch the chunk.
 */
function SignedInServicesGate({ variant }: { variant: "core" | "push" }) {
  const { user } = useCurrentUser();
  if (!user) return null;
  const Services = variant === "core" ? LazySignedInServices : LazySignedInPushServices;
  return (
    <Suspense fallback={null}>
      <Services />
    </Suspense>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: 300000, // 5 minutes
      // Most queries read ArmadaDB; the default "online" mode pauses them whenever
      // `navigator.onLine` is false (unreliable in Android WebView, and mesh is offline).
      networkMode: "always",
    },
    mutations: {
      // Same for mutations: a paused one blocks its scoped queue.
      networkMode: "always",
    },
  },
});

// Profiling builds only (`__armadaPerf.runtime()`).
if (import.meta.env.VITE_PROFILE === "1") instrumentQueryCache(queryClient.getQueryCache());

// Hydrate the Concord groupKey memo before channelsView derives stream keys.
void initGroupKeyPersistence();

// Android WebView's visibilitychange/focus don't fire reliably on resume; drive
// focusManager from Capacitor's `appStateChange` instead.
if (Capacitor.isNativePlatform()) {
  void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    focusManager.setFocused(isActive);
  });
  ensureAndroidBackListener();
}

export function App() {
  return (
    <AppProvider storageKey={APP_CONFIG_STORAGE_KEY}>
      <ArmadaDBProvider>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey={LOGIN_STORAGE_KEY} storage={secureStorage}>
            <ActiveAccountSync />
            {/* Above the signed-in gate so it survives logout's removal of the login before reload. */}
            <AccountExitGate />
            <NostrProvider>
              <WalletProvider>
                <TooltipProvider>
                  <ReadStateProvider>
                    <MutedPubkeysProvider>
                    <SignedInServicesGate variant="core" />
                    {/* Eager: overlaps a cold deep link's first REQ with React mounting the route. */}
                    <DeepLinkWarmup />
                    <WebPushNotifications>
                      <SignedInServicesGate variant="push" />
                      <MeshProvider>
                        <AppRouter />
                      </MeshProvider>
                    </WebPushNotifications>
                    </MutedPubkeysProvider>
                  </ReadStateProvider>
                </TooltipProvider>
              </WalletProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </ArmadaDBProvider>
    </AppProvider>
  );
}

export default App;
