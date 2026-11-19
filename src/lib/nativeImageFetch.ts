import { Capacitor, registerPlugin } from "@capacitor/core";

/** `ImageFetchPlugin.java`: an image's bytes from a host without CORS, under `ImageFetch.java`'s rules. */
interface ArmadaImageFetchPlugin {
  fetchImage(opts: { url: string; userAgent?: string }): Promise<{ type?: string; data?: string }>;
}

let plugin: ArmadaImageFetchPlugin | undefined;

/** Android only, and only an APK that carries the plugin. */
export function canFetchNativeImages(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("ArmadaImageFetch");
}

/** An image's bytes through the app, for a host without CORS. Null when refused or unavailable. */
export async function fetchNativeImage(url: string): Promise<Blob | null> {
  try {
    plugin ??= registerPlugin<ArmadaImageFetchPlugin>("ArmadaImageFetch");
    const out = await plugin.fetchImage({ url, userAgent: navigator.userAgent });
    if (!out.data || !out.type) return null;
    const bytes = Uint8Array.from(atob(out.data), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: out.type });
  } catch {
    return null;
  }
}
