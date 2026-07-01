package pub.armada.app;

import android.app.ForegroundServiceStartNotAllowedException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONArray;

/**
 * Capacitor bridge that lets the web layer configure the native background
 * notification service.
 *
 * The web app calls {@code configure({ enabled, userPubkey, relayUrls,
 * groupIds, prefs })}. We persist the config to SharedPreferences (the running
 * service watches it and re-subscribes on change) and start/stop the
 * {@link NotificationRelayService} foreground service accordingly.
 *
 * This is a fully de-Googled instant-push path: the service holds a persistent
 * Nostr REQ to the relay, so notifications fire the moment an event arrives —
 * no FCM, no Web Push, no polling.
 */
@CapacitorPlugin(
        name = "ArmadaNotification",
        permissions = {
                @Permission(alias = "notifications", strings = { android.Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class ArmadaNotificationPlugin extends Plugin {

    private static final String TAG = "ArmadaNotifPlugin";
    static final String PREFS_NAME = "armada_notification_config";

    /**
     * Live plugin instance, so the background service can reach back into the
     * Capacitor bridge to ask the WebView's signer for a NIP-42 signature.
     * Null when the activity/bridge isn't up (WebView dead) — the service then
     * simply can't authenticate until the app is reopened.
     */
    private static ArmadaNotificationPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /**
     * Emit a NIP-42 challenge to the JS layer so it can sign a kind-22242 with
     * the user's signer (nsec/bunker/extension — all handled in the WebView).
     * Returns false if the bridge isn't available (WebView not running).
     */
    static boolean emitAuthChallenge(String relayUrl, String challenge) {
        ArmadaNotificationPlugin p = instance;
        if (p == null) return false;
        JSObject data = new JSObject();
        data.put("relayUrl", relayUrl);
        data.put("challenge", challenge);
        p.notifyListeners("authChallenge", data);
        return true;
    }

    /**
     * Raw outer events the background service received but the WebView may not
     * have yet (it was backgrounded / its socket was down). Buffered while the
     * bridge is dead so a freshly-opened app can drain them straight into its
     * event store — no relay round-trip, so a tapped notification's message is
     * already on screen. Capped to avoid unbounded growth.
     */
    private static final java.util.ArrayDeque<String> eventBuffer = new java.util.ArrayDeque<>();
    private static final int EVENT_BUFFER_MAX = 200;

    /**
     * Rolling per-room cache of raw outer events, keyed by room
     * ("h:<groupId>" / "z:<pseudonym>" / "c2:<channelId>" / "dm"), newest last.
     * Unlike {@link #eventBuffer} (a one-shot drain of what arrived while the
     * WebView was down, shared across ALL rooms), this survives drains and
     * retains the last screenful per room for the service's lifetime — so
     * opening a room from a notification can paint natively-received history
     * even when the global buffer overflowed or was already drained. LRU-bounded.
     */
    private static final int ROOM_CACHE_MAX_ROOMS = 24;
    private static final int ROOM_CACHE_MAX_EVENTS = 30;
    private static final java.util.LinkedHashMap<String, java.util.ArrayDeque<String>> roomEvents =
            new java.util.LinkedHashMap<String, java.util.ArrayDeque<String>>(16, 0.75f, /*accessOrder=*/true) {
                @Override
                protected boolean removeEldestEntry(java.util.Map.Entry<String, java.util.ArrayDeque<String>> eldest) {
                    return size() > ROOM_CACHE_MAX_ROOMS;
                }
            };

    /** Record an event into its room's rolling cache (no-op without a room key). */
    private static void recordRoomEvent(String roomKey, String eventJson) {
        if (roomKey == null || eventJson == null) return;
        synchronized (roomEvents) {
            java.util.ArrayDeque<String> q = roomEvents.get(roomKey);
            if (q == null) {
                q = new java.util.ArrayDeque<>();
                roomEvents.put(roomKey, q);
            }
            if (q.size() >= ROOM_CACHE_MAX_EVENTS) q.pollFirst();
            q.addLast(eventJson);
        }
    }

    /**
     * Hand a raw outer event (the wire JSON the service received) to the WebView.
     * Emits live if the bridge is up; otherwise buffers for the next drain. Also
     * recorded in the per-room rolling cache regardless of bridge state.
     * Same event for NIP-29 (kind 9/1068/…), DMs (kind 4, ciphertext) and
     * Concord (sealed kind 3300) — the WebView writes it into its IndexedDB
     * store and its read path decodes it.
     *
     * @param roomKey per-room cache key ("h:<groupId>" / "z:<z>" / "dm"), or
     *                null to skip the room cache.
     */
    static void feedRelayEvent(String roomKey, String eventJson) {
        if (eventJson == null) return;
        recordRoomEvent(roomKey, eventJson);
        ArmadaNotificationPlugin p = instance;
        if (p != null) {
            JSObject data = new JSObject();
            data.put("event", eventJson);
            p.notifyListeners("relayEvent", data);
            return;
        }
        synchronized (eventBuffer) {
            if (eventBuffer.size() >= EVENT_BUFFER_MAX) eventBuffer.pollFirst();
            eventBuffer.addLast(eventJson);
        }
    }

    /**
     * Concord inner events the service ALREADY decrypted (it holds the channel
     * key to render the notification). Buffered like {@link #eventBuffer} so a
     * cold-launched app drains them too. Each entry is a 3-line tuple:
     * inner-event JSON, the outer `z` pseudonym, and the outer event id — enough
     * for the WebView to bind it to a held epoch, verify the inner Schnorr
     * signature, and fold it in WITHOUT re-decrypting or hitting the relay.
     */
    private static final java.util.ArrayDeque<String[]> concordBuffer = new java.util.ArrayDeque<>();

    /**
     * Hand a decrypted Concord inner event to the WebView. The WebView still
     * fully verifies it (the service only checked HMAC + channel/epoch binding,
     * not the author's Schnorr signature), so a forged inner is dropped there.
     * Emits live if the bridge is up; otherwise buffers for the next drain.
     */
    static void feedConcordInner(String innerJson, String z, String outerId) {
        if (innerJson == null || z == null || outerId == null) return;
        ArmadaNotificationPlugin p = instance;
        if (p != null) {
            JSObject data = new JSObject();
            data.put("inner", innerJson);
            data.put("z", z);
            data.put("outerId", outerId);
            p.notifyListeners("concordMessage", data);
            return;
        }
        synchronized (concordBuffer) {
            if (concordBuffer.size() >= EVENT_BUFFER_MAX) concordBuffer.pollFirst();
            concordBuffer.addLast(new String[] { innerJson, z, outerId });
        }
    }

    /**
     * Drain buffered raw outer events (received while the WebView was down).
     * Returns { events: [json, …] }; the JS layer writes them to its store.
     * (Concord decrypted inners are a SEPARATE buffer — see drainConcord — so
     * the two consumers, useNativeEventFeed and useConcordChannel, don't race to
     * empty a shared queue.)
     */
    @PluginMethod
    public void drainEvents(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (eventBuffer) {
            String e;
            while ((e = eventBuffer.pollFirst()) != null) arr.put(e);
        }
        JSObject ret = new JSObject();
        ret.put("events", arr);
        call.resolve(ret);
    }

    /**
     * Return (without consuming) the rolling per-room cache for one room —
     * the newest raw outer events the service received for it this service
     * lifetime. Keys: "h:<groupId>", "z:<pseudonym>", "c2:<channelId>", "dm".
     * The JS layer merges them by event id, so re-reads are idempotent.
     */
    @PluginMethod
    public void getRoomEvents(PluginCall call) {
        String room = call.getString("room");
        JSArray arr = new JSArray();
        if (room != null) {
            synchronized (roomEvents) {
                java.util.ArrayDeque<String> q = roomEvents.get(room);
                if (q != null) {
                    for (String e : q) arr.put(e);
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("events", arr);
        call.resolve(ret);
    }

    /**
     * Drain buffered Concord inner events the service already decrypted. Returns
     * { concord: [{ inner, z, outerId }, …] }. The open channel verifies each
     * inner's signature + binding and folds it straight in — no second decrypt,
     * no relay round-trip.
     */
    @PluginMethod
    public void drainConcord(PluginCall call) {
        JSArray concord = new JSArray();
        synchronized (concordBuffer) {
            String[] c;
            while ((c = concordBuffer.pollFirst()) != null) {
                JSObject o = new JSObject();
                o.put("inner", c[0]);
                o.put("z", c[1]);
                o.put("outerId", c[2]);
                concord.put(o);
            }
        }
        JSObject ret = new JSObject();
        ret.put("concord", concord);
        call.resolve(ret);
    }

    /**
     * Receive a signed kind-22242 event from JS and hand it to the running
     * service to send as ["AUTH", event] on the matching relay connection.
     */
    @PluginMethod
    public void submitAuth(PluginCall call) {
        String relayUrl = call.getString("relayUrl");
        try {
            if (relayUrl != null && call.getObject("event") != null) {
                NotificationRelayService.submitAuth(relayUrl, call.getObject("event").toString());
            }
        } catch (Exception e) {
            Log.w(TAG, "submitAuth failed", e);
        }
        call.resolve();
    }

    /** Whether the POST_NOTIFICATIONS runtime permission is granted (always true < API 33). */
    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasNotificationPermission());
        call.resolve(ret);
    }

    /** Request POST_NOTIFICATIONS (API 33+). Resolves { granted } either way. */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (hasNotificationPermission()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasNotificationPermission());
        call.resolve(ret);
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        }
        return getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Check whether the app is exempt from battery optimizations (Doze).
     *
     * Battery optimization tears down the persistent relay websockets while
     * the device is idle, and on Android 15+ an exemption is also what permits
     * restarting the foreground service from the boot-retry alarm (see
     * BootReceiver). The settings UI uses this to decide whether to show the
     * exemption prompt.
     */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject ret = new JSObject();
        ret.put("ignoring", ignoring);
        call.resolve(ret);
    }

    /**
     * Show the system dialog asking the user to exempt Armada from battery
     * optimizations (one tap: "Allow"). Falls back to the battery
     * optimization settings list on OEM builds that don't handle the direct
     * request intent.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "Direct battery optimization request failed, opening settings list", e);
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Unable to open battery optimization settings", e2);
            }
        }
    }

    /**
     * Return this device's FCM registration token and the Firebase project ID.
     *
     * Called by the JS layer (useFcmNotifications) to register the token with
     * the shared nostr-push server for battery-free OS-delivered push. Rejects
     * if Firebase is not configured (no google-services.json) or Google Play
     * Services is unavailable — the caller then falls back to the persistent
     * relay service.
     */
    @PluginMethod
    public void getFcmToken(PluginCall call) {
        final String projectId;
        try {
            FirebaseApp app = FirebaseApp.getInstance();
            projectId = app.getOptions().getProjectId();
        } catch (IllegalStateException e) {
            // FirebaseApp not initialized — google-services.json missing or the
            // google-services Gradle plugin was not applied.
            call.reject("Firebase is not configured on this build", e);
            return;
        }

        if (projectId == null || projectId.isEmpty()) {
            call.reject("Firebase project ID is unavailable");
            return;
        }

        FirebaseMessaging.getInstance().getToken()
                .addOnCompleteListener(task -> {
                    if (!task.isSuccessful()) {
                        Exception ex = task.getException();
                        Log.w(TAG, "Failed to fetch FCM token", ex);
                        call.reject("Failed to fetch FCM token: " + (ex != null ? ex.getMessage() : "unknown"), ex);
                        return;
                    }

                    String token = task.getResult();
                    if (token == null || token.isEmpty()) {
                        call.reject("FCM returned an empty token");
                        return;
                    }

                    Log.d(TAG, "Fetched FCM token (len=" + token.length() + "), project=" + projectId);
                    JSObject result = new JSObject();
                    result.put("token", token);
                    result.put("projectId", projectId);
                    call.resolve(result);
                });
    }

    @PluginMethod
    public void configure(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String userPubkey = call.getString("userPubkey");

        String relayUrlsRaw = arrayToString(call.getArray("relayUrls"));
        String groupIdsRaw = arrayToString(call.getArray("groupIds"));
        String dmRelaysRaw = arrayToString(call.getArray("dmRelays"));
        String dmFollowsRaw = arrayToString(call.getArray("dmFollows"));
        String concordSubsRaw = arrayToString(call.getArray("concordSubs"));
        String concord2SubsRaw = arrayToString(call.getArray("concord2Subs"));
        // prefs is a flat object of booleans; store its JSON verbatim.
        String prefsRaw = null;
        try {
            if (call.getObject("prefs") != null) {
                prefsRaw = call.getObject("prefs").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read prefs", e);
        }

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        boolean hasWatch = relayUrlsRaw != null || concordSubsRaw != null || concord2SubsRaw != null
                || dmRelaysRaw != null;
        boolean hasConfig = enabled && userPubkey != null && hasWatch;

        if (hasConfig) {
            SharedPreferences.Editor editor = prefs.edit()
                    .putBoolean("enabled", true)
                    .putString("userPubkey", userPubkey)
                    .putString("relayUrls", relayUrlsRaw != null ? relayUrlsRaw : "[]");
            if (groupIdsRaw != null) editor.putString("groupIds", groupIdsRaw);
            else editor.remove("groupIds");
            if (dmRelaysRaw != null) editor.putString("dmRelays", dmRelaysRaw);
            else editor.remove("dmRelays");
            if (dmFollowsRaw != null) editor.putString("dmFollows", dmFollowsRaw);
            else editor.remove("dmFollows");
            if (concordSubsRaw != null) editor.putString("concordSubs", concordSubsRaw);
            else editor.remove("concordSubs");
            if (concord2SubsRaw != null) editor.putString("concord2Subs", concord2SubsRaw);
            else editor.remove("concord2Subs");
            if (prefsRaw != null) editor.putString("prefs", prefsRaw);
            // Bump a revision so the running service's SharedPreferences
            // listener always fires even if the values look unchanged.
            editor.putLong("rev", System.currentTimeMillis());
            editor.apply();
            if (BuildConfig.DEBUG) Log.d(TAG, "Configured: relays=" + relayUrlsRaw + " groups=" + groupIdsRaw
                    + " dmRelays=" + dmRelaysRaw
                    + " concordSubs=" + (concordSubsRaw != null ? "yes" : "none")
                    + " concord2Subs=" + (concord2SubsRaw != null ? "yes" : "none"));
        } else {
            prefs.edit().clear().apply();
            Log.d(TAG, "Config cleared (disabled or logged out)");
        }

        manageService(hasConfig);
        call.resolve();
    }

    private void manageService(boolean start) {
        Context ctx = getContext();
        Intent serviceIntent = new Intent(ctx, NotificationRelayService.class);
        if (start) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(serviceIntent);
                } else {
                    ctx.startService(serviceIntent);
                }
                Log.d(TAG, "Started NotificationRelayService");
            } catch (Exception e) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        && e instanceof ForegroundServiceStartNotAllowedException) {
                    Log.w(TAG, "Could not start foreground service: " + e.getMessage());
                } else {
                    Log.w(TAG, "Failed to start service", e);
                }
            }
        } else {
            ctx.stopService(serviceIntent);
            Log.d(TAG, "Stopped NotificationRelayService");
        }
    }

    private static String arrayToString(JSONArray arr) {
        return arr != null ? arr.toString() : null;
    }
}
