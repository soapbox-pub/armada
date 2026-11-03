package buzz.armada.app;

import android.content.Intent;
import android.graphics.drawable.Animatable;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.activity.EdgeToEdge;
import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Held true from launch until the web layer reports it has painted its first
    // real frame (WebReadyPlugin) or a safety timeout fires. While true, the
    // native animated-crest splash stays up, covering the whole cold start.
    private volatile boolean webNotReady = true;

    // Hard cap on how long the splash may cover a cold start. The web "painted"
    // signal is the normal dismisser; this only guards against it never arriving
    // (e.g. a JS crash before paint) so the splash can't hang forever.
    private static final long SPLASH_MAX_MS = 8000;

    // Floor on how long the splash stays up, matching the crest entrance
    // animation (splash_logo_anim.xml ends at ~960ms, inside the 1000ms
    // windowSplashScreenAnimationDuration in styles.xml). The WebView can paint
    // before the animation finishes; without this floor an early paint lifts the
    // splash mid-animation, which looks janky. The web-painted signal still gates
    // dismissal past this point — this only stops the splash lifting EARLY, never
    // extends a slow cold start.
    private static final long SPLASH_MIN_MS = 1000;

    // How often to check WebReadyPlugin.webPainted (ms).
    private static final long SPLASH_POLL_MS = 16;

    // The WARM deep-link gate: a native crest overlay thrown over the WebView
    // the moment a notification-tap intent arrives while the app is already
    // running. The resumed WebView frame still shows whatever was on screen
    // when the app went to background — Capacitor only delivers `appUrlOpen`
    // to JS a beat after onResume, so without this the user sees the WRONG
    // room for a few hundred ms before the router moves. The gate lifts when
    // the web layer signals it has navigated and painted
    // (WebReadyPlugin.signalDeepLinkNavigated). (The transition snapshot
    // Android itself animates in is out of app control and may still show the
    // old frame for the system animation's duration.)
    private View deepLinkGate;
    // Last resort for a frozen WebView, not the normal dismisser (the web
    // signal has its own 2.5s fallback) — generous beats lifting mid-navigation.
    private static final long GATE_MAX_MS = 4000;
    private static final long GATE_POLL_MS = 16;

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (CallAudioSession.handleVolumeKey(this, event)) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins before super.onCreate.
        registerPlugin(ArmadaNotificationPlugin.class);
        registerPlugin(buzz.armada.app.db.ArmadaDbPlugin.class);
        registerPlugin(ArmadaCredentialPlugin.class);
        registerPlugin(BluetoothMeshPlugin.class);
        registerPlugin(ArmadaCallPlugin.class);
        registerPlugin(WebReadyPlugin.class);
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(MediaGalleryPlugin.class);
        registerPlugin(ArmadaSignerPlugin.class);
        registerPlugin(ArmadaStoragePlugin.class);

        // Install the androidx splash screen. This dismisses the launch
        // (Theme.SplashScreen) window and hands off to postSplashScreenTheme
        // (AppTheme.NoActionBar) once the activity is up — without this the
        // launch theme's splash window can linger as a band after launch.
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);

        // Hold the branded ANIMATED-crest splash on screen until the WEB LAYER
        // reports it has painted its first real frame (WebReadyPlugin.signalReady,
        // called from React after commit + a rAF). The in-HTML animated crest
        // can't cover the cold start (it only exists once the WebView paints,
        // ~1-2s in), so the animated NATIVE splash owns the whole cold start:
        // it plays its entrance, then the finished crest sits until the app is
        // actually on screen. We deliberately do NOT lift on the WebView's
        // onPageCommitVisible — that fires on the blank background frame BEFORE
        // React renders, which would flash an empty WebView between the splash
        // and the app.
        splashScreen.setKeepOnScreenCondition(() -> webNotReady);

        // Enable edge-to-edge so the WebView draws under the status and
        // navigation bars. The @capacitor-community/safe-area plugin then
        // feeds the resulting insets to the web layer (env(safe-area-inset-*)
        // on modern Chromium, padding fallback on older webviews), which the
        // app's CSS consumes for top/bottom safe-area handling.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        // Replace Capacitor's chrome client with one that honours HTML
        // fullscreen (embedded video players). Must happen in onCreate: the
        // client registers activity-result launchers, which may not be
        // registered once the activity has started.
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().setWebChromeClient(new FullscreenChromeClient(this.bridge));
        }

        // Poll the web-painted flag; lift the splash once it's set AND the crest
        // animation has had its SPLASH_MIN_MS to play out, with a safety timeout
        // (SPLASH_MAX_MS) that overrides both so it can never hang.
        final Handler handler = new Handler(Looper.getMainLooper());
        final long start = System.currentTimeMillis();
        final long deadline = start + SPLASH_MAX_MS;
        final long animationDone = start + SPLASH_MIN_MS;
        handler.post(
            new Runnable() {
                @Override
                public void run() {
                    long now = System.currentTimeMillis();
                    if ((WebReadyPlugin.webPainted && now >= animationDone) || now >= deadline) {
                        webNotReady = false;
                    } else {
                        handler.postDelayed(this, SPLASH_POLL_MS);
                    }
                }
            }
        );
    }

    // The androidx starting window held by setKeepOnScreenCondition does NOT
    // consume input: while the cold-launch splash is still up, touches are
    // delivered to the live WebView underneath, where the app is already
    // interactive. An impatient tap during the splash therefore lands on
    // whatever control sits at those coordinates — invisibly, so the splash
    // lifts onto its result (e.g. the account switcher's full-width trigger at
    // the bottom of list views opens its menu on bare pointerdown). Swallow
    // touches until the splash's dismiss condition clears; the warm deep-link
    // gate already eats its own via setClickable(true) in showDeepLinkGate.
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (webNotReady) return true;
        return super.dispatchTouchEvent(ev);
    }

    // Notification taps deep-link via the `armada://open<path>` data URI set on
    // the launch Intent (see NotificationRelayService.roomPendingIntent). We rely
    // on Capacitor's @capacitor/app plugin to surface it — `App.getLaunchUrl()`
    // on a cold launch and the `appUrlOpen` event on a warm one. BridgeActivity
    // already forwards the launch Intent to that plugin (its own onCreate +
    // onNewIntent), so no custom intent handling is needed here. The web layer
    // (useNotificationNavigation) routes via React Router — a soft navigation,
    // never a document reload, which would cold-boot the whole app.

    @Override
    protected void onNewIntent(Intent intent) {
        // Gate genuine deep links (ACTION_VIEW + data URI: notification taps'
        // armada://open<path> and verified https App Links) and incoming
        // shares (ACTION_SEND[_MULTIPLE], routed to the share flow by
        // ShareTargetPlugin). The plain "open the app" tap on the
        // foreground-service notification carries neither, and resuming to
        // the previous screen is exactly right there.
        if ((Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null)
                || ShareTargetPlugin.isShareIntent(intent)) {
            showDeepLinkGate();
        }
        // BridgeActivity forwards the intent to @capacitor/app (appUrlOpen).
        super.onNewIntent(intent);
    }

    /**
     * Cover the WebView with the branded crest (same background + mark as the
     * launch splash) until the web layer reports it has navigated for the
     * deep link, or GATE_MAX_MS passes. Added before super.onNewIntent so it
     * is part of the first resumed frame this activity draws.
     */
    private void showDeepLinkGate() {
        if (deepLinkGate == null) {
            FrameLayout gate = new FrameLayout(this);
            gate.setBackgroundColor(ContextCompat.getColor(this, R.color.armadaBackground));
            // Eat touches so taps meant for the destination can't land on the
            // stale frame underneath.
            gate.setClickable(true);
            ImageView crest = new ImageView(this);
            crest.setImageResource(R.drawable.splash_logo_anim);
            int size = Math.round(getResources().getDisplayMetrics().density * 180);
            gate.addView(crest, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
            addContentView(gate, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            Drawable mark = crest.getDrawable();
            if (mark instanceof Animatable) ((Animatable) mark).start();
            deepLinkGate = gate;
        }
        // Poll for the web layer's "navigated" signal, mirroring the splash's
        // webPainted poll. Re-showing while up just extends the deadline.
        final long seen = WebReadyPlugin.deepLinkNavCount;
        final long deadline = System.currentTimeMillis() + GATE_MAX_MS;
        final Handler handler = new Handler(Looper.getMainLooper());
        handler.post(
            new Runnable() {
                @Override
                public void run() {
                    View gate = deepLinkGate;
                    if (gate == null) return;
                    if (WebReadyPlugin.deepLinkNavCount > seen || System.currentTimeMillis() >= deadline) {
                        ViewGroup parent = (ViewGroup) gate.getParent();
                        if (parent != null) parent.removeView(gate);
                        deepLinkGate = null;
                    } else {
                        handler.postDelayed(this, GATE_POLL_MS);
                    }
                }
            }
        );
    }

    // Recover from the WebView getting STUCK reporting `document.visibilityState
    // === "hidden"` while the app is actually foreground. On some background→
    // foreground / screen-off→on transitions the Android WebView fails to
    // propagate its restored visibility to the renderer's page-visibility state,
    // so Chromium keeps the document "hidden" and FREEZES all timers, intervals,
    // rAF and background tasks in it, stalling every timer-driven subsystem.
    // A document reload does NOT fix it (the reloaded document is still
    // hidden); only re-resuming the WebView does.
    //
    // `WebView.onResume()` + `resumeTimers()` un-freeze the renderer's timer and
    // task queues for this (now genuinely foreground) activity, so the frozen
    // subsystems resume even if the WebView's `visibilityState` stays cosmetically
    // "hidden". The existing `appStateChange`→`focusManager` wiring (see App.tsx)
    // then drives the catch-up refetch. Cheap and idempotent, so running it on
    // every resume is safe; it's a no-op when the WebView was never frozen.
    @Override
    public void onResume() {
        super.onResume();
        try {
            if (this.bridge != null) {
                WebView webView = this.bridge.getWebView();
                if (webView != null) {
                    webView.onResume();
                    webView.resumeTimers();
                }
            }
        } catch (Exception ignored) {
            // Best-effort: never let a resume-recovery attempt crash the activity.
        }
    }
}
