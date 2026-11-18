import { useContext, useMemo } from "react";

import { AppContext, defaultConfig } from "@/contexts/AppContext";
import {
  mediaSrc,
  parseProxyList,
  type MediaPolicy,
  type MediaPolicyConfig,
} from "@/lib/mediaPolicy";

/**
 * Reads the context directly: avatars render outside the provider too, where the default
 * (proxying off) applies.
 */
function useProxyPool(): readonly string[] {
  const config = useContext(AppContext)?.config;
  const list = config?.mediaProxies ?? defaultConfig.mediaProxies;
  return useMemo(() => parseProxyList(list.join("\n")), [list]);
}

/**
 * Memoized so every image shares one object. The primary proxy only (no rotation); see
 * {@link useMediaProxyRotation} for the pool.
 */
export function useMediaPolicy(): MediaPolicy {
  const pool = useProxyPool();
  const proxy = pool[0] ?? "";
  return useMemo(() => ({ proxy }), [proxy]);
}

/** Bridge shape for the background writers' configs; primary proxy only (native doesn't rotate). */
export function useMediaPolicyConfig(): MediaPolicyConfig {
  return useMediaPolicy();
}

/** With several proxies, the whole set is the pool `useRoutedCandidates` rotates across. */
export function useMediaProxyRotation(): MediaPolicy {
  const pool = useProxyPool();
  return useMemo(() => {
    if (pool.length === 0) return { proxy: "" };
    if (pool.length === 1) return { proxy: pool[0] };
    return { proxy: pool[0], proxies: pool };
  }, [pool]);
}

/** Undefined when the URL must not load — for one-image sites with no room for a placeholder. */
export function useMediaSrc(url: string | undefined): string | undefined {
  const policy = useMediaPolicy();
  return useMemo(() => mediaSrc(url, policy), [url, policy]);
}
