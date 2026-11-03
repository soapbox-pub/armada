package buzz.armada.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Settings › Storage: the on-disk caches the WebView can't see — the
 * notification service's sender avatars and the WebView's own HTTP cache —
 * measured and cleared. The web side gates on `getPlatform() === "android"`.
 */
@CapacitorPlugin(name = "ArmadaStorage")
public class ArmadaStoragePlugin extends Plugin {

    /** The service's decoded avatars and its OkHttp cache (`NotificationRelayService`). */
    private File[] avatarDirs() {
        File cache = getContext().getCacheDir();
        return new File[] { new File(cache, "avatars"), new File(cache, "avatar-http") };
    }

    /** Chromium's disk cache, wherever this WebView version keeps it. */
    private File[] webCacheDirs() {
        File cache = getContext().getCacheDir();
        return new File[] { new File(cache, "WebView"), new File(cache, "org.chromium.android_webview") };
    }

    @PluginMethod
    public void usage(PluginCall call) {
        JSObject result = new JSObject();
        result.put("avatars", sizeOf(avatarDirs()));
        result.put("webCache", sizeOf(webCacheDirs()));
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        String kind = call.getString("kind", "");
        if ("avatars".equals(kind)) {
            // OkHttp's journal stays: an entry whose files are gone reads as a miss.
            for (File dir : avatarDirs()) deleteContents(dir, "journal");
            call.resolve();
        } else if ("webCache".equals(kind)) {
            getBridge().executeOnMainThread(() -> {
                getBridge().getWebView().clearCache(true);
                call.resolve();
            });
        } else {
            call.reject("unknown cache: " + kind);
        }
    }

    private static long sizeOf(File[] dirs) {
        long total = 0;
        for (File dir : dirs) total += sizeOf(dir);
        return total;
    }

    private static long sizeOf(File file) {
        if (file.isFile()) return file.length();
        File[] children = file.listFiles();
        if (children == null) return 0;
        long total = 0;
        for (File child : children) total += sizeOf(child);
        return total;
    }

    /** Delete everything under `dir`, sparing top-level files whose names start with `keepPrefix`. */
    private static void deleteContents(File dir, String keepPrefix) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isFile() && child.getName().startsWith(keepPrefix)) continue;
            deleteRecursively(child);
        }
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
