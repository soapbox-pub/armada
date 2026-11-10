package buzz.armada.app;

import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tiny bridge the web layer calls once React has committed and painted its
 * first real frame, so the native launch splash can lift at the right moment.
 *
 * The native splash is held (MainActivity.setKeepOnScreenCondition) across the
 * cold start. The WebView's own onPageCommitVisible fires on the FIRST paint —
 * which is the blank background frame BEFORE React renders content — so lifting
 * on that alone flashes an empty WebView ("the void") before the app appears.
 * This plugin lets the web layer say "I've actually painted", which is the
 * correct dismiss signal. An 8s native timeout still guards against it never
 * arriving (e.g. a JS crash before paint).
 */
@CapacitorPlugin(name = "WebReady")
public class WebReadyPlugin extends Plugin {

    /** Set true once the web layer reports its first painted frame. */
    static volatile boolean webPainted = false;

    /**
     * Bumped each time the web layer reports it has handled (navigated and
     * painted for) a warm deep link. MainActivity's deep-link gate polls this
     * to lift the crest overlay it threw over the WebView in onNewIntent.
     */
    static volatile long deepLinkNavCount = 0;

    @PluginMethod
    public void signalReady(PluginCall call) {
        webPainted = true;
        call.resolve();
    }

    @PluginMethod
    public void signalDeepLinkNavigated(PluginCall call) {
        deepLinkNavCount++;
        call.resolve();
    }

    /**
     * The package that installed this app, or null for a sideload. The APK and the
     * Play AAB share one web bundle, so store installs are told apart at runtime.
     */
    @PluginMethod
    public void installSource(PluginCall call) {
        String installer = null;
        try {
            PackageManager pm = getContext().getPackageManager();
            String pkg = getContext().getPackageName();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                installer = pm.getInstallSourceInfo(pkg).getInstallingPackageName();
            } else {
                installer = pm.getInstallerPackageName(pkg);
            }
        } catch (Exception ignored) {
            // unknown: treated as a sideload
        }
        JSObject out = new JSObject();
        out.put("installer", installer);
        call.resolve(out);
    }
}
