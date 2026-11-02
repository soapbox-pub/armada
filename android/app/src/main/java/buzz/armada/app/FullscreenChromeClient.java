package buzz.armada.app;

import android.graphics.Color;
import android.net.Uri;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Capacitor's chrome client, plus HTML fullscreen and an origin gate on
 * permission requests.
 *
 * BridgeWebChromeClient answers onShowCustomView by calling
 * onCustomViewHidden() straight away, so every element fullscreen request —
 * the YouTube, Streamable and Mini App fullscreen buttons — is cancelled the
 * moment it is made. This puts the view the WebView hands over on top of the
 * activity with the system bars hidden, and takes it down again when the page
 * exits fullscreen or the user presses back.
 */
public class FullscreenChromeClient extends BridgeWebChromeClient {
    private final AppCompatActivity activity;
    private final Bridge bridge;
    private View customView;
    private CustomViewCallback customViewCallback;

    // Back exits fullscreen before it reaches the app's own back handling.
    // Registered last, so it wins while enabled; disabled otherwise.
    private final OnBackPressedCallback exitOnBack = new OnBackPressedCallback(false) {
        @Override
        public void handleOnBackPressed() {
            exitFullscreen();
        }
    };

    public FullscreenChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        this.activity = bridge.getActivity();
        activity.getOnBackPressedDispatcher().addCallback(activity, exitOnBack);
    }

    // BridgeWebChromeClient grants capture and geolocation to whichever frame
    // asks once the app holds the Android permission; a Mini App is sender-
    // written code in a subframe and must not inherit the app's grant.
    @Override
    public void onPermissionRequest(PermissionRequest request) {
        if (!isAppOrigin(request.getOrigin())) {
            request.deny();
            return;
        }
        super.onPermissionRequest(request);
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        if (!isAppOrigin(origin == null ? null : Uri.parse(origin))) {
            callback.invoke(origin, false, false);
            return;
        }
        super.onGeolocationPermissionsShowPrompt(origin, callback);
    }

    private boolean isAppOrigin(Uri origin) {
        if (origin == null) return false;
        Uri app = Uri.parse(bridge.getLocalUrl());
        return app.getScheme() != null && app.getScheme().equalsIgnoreCase(origin.getScheme())
                && app.getEncodedAuthority() != null
                && app.getEncodedAuthority().equalsIgnoreCase(origin.getEncodedAuthority());
    }

    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        if (customView != null) {
            callback.onCustomViewHidden();
            return;
        }
        customView = view;
        customViewCallback = callback;
        view.setBackgroundColor(Color.BLACK);
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        decor.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(activity.getWindow(), decor);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
        exitOnBack.setEnabled(true);
        // The WebView shows no exit hint of its own, and a Mini App (sender-
        // written code) can go fullscreen too: without one it can pass off a
        // fake of the app or the system as the real thing. A toast is its own
        // window, so nothing the fullscreen view draws can cover it.
        Toast.makeText(activity, AppLocale.string(activity, R.string.fullscreen_exit_hint),
                Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onHideCustomView() {
        View view = customView;
        if (view == null) return;
        customView = null;
        exitOnBack.setEnabled(false);
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        decor.removeView(view);
        WindowCompat.getInsetsController(activity.getWindow(), decor)
                .show(WindowInsetsCompat.Type.systemBars());
        CustomViewCallback callback = customViewCallback;
        customViewCallback = null;
        if (callback != null) callback.onCustomViewHidden();
    }

    private void exitFullscreen() {
        // Tell the page first so it leaves fullscreen state; the WebView then
        // calls onHideCustomView, and the direct call covers one that doesn't.
        CustomViewCallback callback = customViewCallback;
        customViewCallback = null;
        if (callback != null) callback.onCustomViewHidden();
        onHideCustomView();
    }
}
