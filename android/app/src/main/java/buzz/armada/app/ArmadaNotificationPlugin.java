package buzz.armada.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
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

import buzz.armada.app.db.ServiceStore;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

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
    private static long lastConfigRevision;

    /**
     * Return a process-wide unique commit marker for notification config.
     * Both the WebView bridge and the background service write the same
     * SharedPreferences file. Reading {@code rev + 1} independently lets two
     * concurrent editors choose the same value, after which the rev-only
     * listener can miss the second update forever.
     */
    static synchronized long nextConfigRevision(SharedPreferences prefs) {
        long next = nextConfigRevisionValue(
                prefs.getLong("rev", 0L), lastConfigRevision, System.currentTimeMillis());
        lastConfigRevision = next;
        return next;
    }

    static long nextConfigRevisionValue(long stored, long previousProcessValue, long now) {
        return Math.max(now, Math.max(stored + 1L, previousProcessValue + 1L));
    }

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
    static boolean emitAuthChallenge(String relayUrl, String challenge, boolean user, boolean streams) {
        ArmadaNotificationPlugin p = instance;
        if (p == null) return false;
        JSObject data = new JSObject();
        data.put("relayUrl", relayUrl);
        data.put("challenge", challenge);
        data.put("user", user);
        data.put("streams", streams);
        p.notifyListeners("authChallenge", data);
        return true;
    }

    /** Max rows per drainEvents page (the JS side loops until empty). */
    private static final int DRAIN_PAGE = 500;

    /**
     * SharedPreferences file holding pending "Mark read" markers the service
     * recorded from notification-action taps, for the WebView to drain and apply
     * to the in-app read state on its next open/resume. One JSON object under
     * key "markers": {@code {roomKey: {ts}, …}} — keyed by room so a
     * later tap in the same room just raises the (monotonic) timestamp.
     */
    static final String READ_MARKERS_PREFS = "armada_read_markers";
    private static final String READ_MARKERS_KEY = "markers";
    /** Guards the read-modify-write of the read-marker map (service ⇄ bridge). */
    private static final Object READ_MARKERS_LOCK = new Object();

    /**
     * Record a "Mark read" marker (called by the service on an action tap). Keyed
     * by room, monotonic in timestamp; the WebView derives the conversation
     * from the room key itself.
     */
    static void enqueueReadMarker(Context ctx, String roomKey, long tsSec) {
        if (ctx == null || roomKey == null || roomKey.isEmpty()) return;
        synchronized (READ_MARKERS_LOCK) {
            SharedPreferences sp = ctx.getSharedPreferences(READ_MARKERS_PREFS, Context.MODE_PRIVATE);
            try {
                JSONObject map;
                try {
                    map = new JSONObject(sp.getString(READ_MARKERS_KEY, "{}"));
                } catch (Exception e) {
                    map = new JSONObject();
                }
                JSONObject existing = map.optJSONObject(roomKey);
                long prev = existing != null ? existing.optLong("ts", 0L) : 0L;
                if (tsSec >= prev) {
                    JSONObject entry = new JSONObject();
                    entry.put("ts", tsSec);
                    map.put(roomKey, entry);
                    sp.edit().putString(READ_MARKERS_KEY, map.toString()).apply();
                }
            } catch (Exception e) {
                Log.w(TAG, "enqueueReadMarker failed", e);
            }
        }
    }

    /** Drop all pending read markers (on logout / disable, so they don't cross accounts). */
    private static void clearReadMarkers(Context ctx) {
        synchronized (READ_MARKERS_LOCK) {
            ctx.getSharedPreferences(READ_MARKERS_PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        }
    }

    /**
     * The call parameters of the ring currently in the tray, for the Answer
     * action to hand to the WebView — the ONE way those parameters travel.
     *
     * Not the Answer action's deep-link URL: anyone can send a URL, so call
     * parameters in one would answer a call the client was never offered, over
     * a broker the sender chose. A URL is a hint, never the proof.
     *
     * So the parameters go through a channel only this app can write: the
     * service records them here when it posts a ring it has ALREADY vetted
     * (fresh, from a followed peer, with a well-formed secret and an https
     * broker — see NotificationRelayService#handleDmCallRumor), and the WebView
     * exchanges the call id for them exactly once.
     *
     * App-private storage rather than a field, so an Answer tap still works if
     * the process was replaced while the phone rang. The secret is per-call and
     * ephemeral, it is removed the moment it is consumed or the ring is
     * cancelled, and this file sits beside a database of decrypted messages —
     * so nothing here is newly at risk if the sandbox is.
     */
    static final String CALL_ANSWER_PREFS = "armada_call_answer";
    private static final String CALL_ANSWER_KEY = "answer";
    /** Guards the single-slot ticket (service ⇄ bridge). */
    private static final Object CALL_ANSWER_LOCK = new Object();

    /**
     * Record the parameters of a ring being posted, replacing any previous one
     * — the service rings one call at a time. Returns the answer token that
     * only the Answer action's PendingIntent carries, or null on failure.
     */
    static String setCallAnswer(Context ctx, String callId, String peer, String secret,
                                String broker, long createdAtMs) {
        if (ctx == null || callId == null || peer == null || secret == null || broker == null) return null;
        byte[] raw = new byte[32];
        new java.security.SecureRandom().nextBytes(raw);
        String token = NostrCrypto.bytesToHex(raw);
        synchronized (CALL_ANSWER_LOCK) {
            try {
                JSONObject entry = new JSONObject();
                entry.put("callId", callId);
                entry.put("peer", peer);
                entry.put("secret", secret);
                entry.put("broker", broker);
                entry.put("createdAtMs", createdAtMs);
                entry.put("token", token);
                ctx.getSharedPreferences(CALL_ANSWER_PREFS, Context.MODE_PRIVATE)
                        .edit().putString(CALL_ANSWER_KEY, entry.toString()).apply();
                return token;
            } catch (Exception e) {
                Log.w(TAG, "setCallAnswer failed", e);
                return null;
            }
        }
    }

    /** A ring whose "end" was lost keeps its ticket; it must not outlive the window. */
    private static boolean callTicketFresh(JSONObject entry) {
        long at = entry.optLong("createdAtMs", 0);
        return at > 0 && System.currentTimeMillis() - at <= NotificationRelayService.CALL_RING_WINDOW_MS;
    }

    /**
     * Drop the recorded parameters when the ring ends for any reason — a call
     * that is no longer ringing is not one an Answer tap may still join.
     * `callId` null clears whatever is there (logout / disable).
     */
    static void clearCallAnswer(Context ctx, String callId) {
        if (ctx == null) return;
        IncomingCallActivity.dismiss(callId);
        synchronized (CALL_ANSWER_LOCK) {
            SharedPreferences sp = ctx.getSharedPreferences(CALL_ANSWER_PREFS, Context.MODE_PRIVATE);
            if (callId != null) {
                String raw = sp.getString(CALL_ANSWER_KEY, null);
                if (raw == null) return;
                try {
                    if (!callId.equals(new JSONObject(raw).optString("callId"))) return;
                } catch (Exception ignored) {
                    // Unparseable — drop it either way.
                }
            }
            sp.edit().remove(CALL_ANSWER_KEY).apply();
        }
    }

    /**
     * Rolling per-room cache of raw outer events, keyed by room
     * ("h:<groupId>" / "c2:<channelId>" / "dm"), newest last. Unlike the
     * drain queue it survives drains and retains the last screenful per room
     * for the service's lifetime, so opening a room from a notification can
     * paint natively-received history. LRU-bounded.
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
     * Emits live when the bridge is up; durability is the shared database (the
     * service already wrote the event before calling this — see
     * NotificationRelayService.handleEvent) plus the handoff queue the WebView
     * drains on open/resume. Also recorded in the per-room rolling cache regardless of
     * bridge state. Same event for NIP-29 (kind 9/1068/…), DMs (kind 4,
     * ciphertext) and Concord (wrapped kind 1059) — the
     * WebView routes it through wire ingest and its read path decodes it.
     *
     * @param roomKey per-room cache key ("h:<groupId>" / "c2:<channelId>" /
     *                "dm"), or null to skip the room cache.
     * @param relayUrl the relay it arrived from, which the WebView's ingest needs
     *                 to file a NIP-29 event under the right server (see
     *                 RelayScope). May be null for events with no relay scope.
     */
    static void feedRelayEvent(String roomKey, String eventJson, String relayUrl) {
        if (eventJson == null) return;
        recordRoomEvent(roomKey, eventJson);
        ArmadaNotificationPlugin p = instance;
        if (p != null) {
            JSObject data = new JSObject();
            data.put("event", eventJson);
            if (relayUrl != null) data.put("relay", relayUrl);
            p.notifyListeners("relayEvent", data);
        }
    }

    /**
     * Drain a page of the events the service ingested, oldest first. Returns
     * { events: [json, …], ids, relay }; the JS layer routes them through wire
     * ingest and then calls {@link #ackDrain} with those ids AND that relay —
     * peek+ack, so a WebView crash mid-page replays instead of losing events, and
     * a service restart loses nothing (the queue is a durable ArmadaDB tenant).
     *
     * A page is one relay's worth, and `relay` names it, because the WebView
     * routes NIP-29 events into the tenant for the relay that served them and a
     * rumor carries no record of that. The queues are per relay so the fact lives
     * in a tenant id, where a sender cannot forge it by spelling a tag.
     *
     * This is ROUTING, not storage: the events themselves are already in the
     * tenants the WebView reads (the service wrote them there), and what a drain
     * still buys is a pass through ingest — parking undecryptable wraps, ringing
     * the scopes that repaint a timeline, feeding notification candidates.
     */
    @PluginMethod
    public void drainEvents(PluginCall call) {
        ServiceStore.Page page = ServiceStore.drain(getContext(), DRAIN_PAGE);
        JSArray events = new JSArray();
        for (String event : page.getEvents()) events.put(event);
        JSArray ids = new JSArray();
        for (String id : page.getIds()) ids.put(id);

        JSObject ret = new JSObject();
        ret.put("events", events);
        ret.put("ids", ids);
        if (page.getRelay() != null) ret.put("relay", page.getRelay());
        call.resolve(ret);
    }

    /**
     * Drop an acknowledged page from the queue, once the JS layer has ingested it.
     * `relay` selects the queue: it must be the value the page was drained with,
     * or the ids would be removed from a queue that never held them.
     */
    @PluginMethod
    public void ackDrain(PluginCall call) {
        JSArray ids = call.getArray("ids");
        if (ids != null) {
            try {
                ServiceStore.ackDrain(getContext(), ids.toList(), call.getString("relay"));
            } catch (org.json.JSONException e) {
                Log.w(TAG, "ackDrain failed", e);
            }
        }
        call.resolve();
    }

    /**
     * Return (without consuming) the rolling per-room cache for one room —
     * the newest raw outer events the service received for it this service
     * lifetime. Keys: "h:<groupId>", "c2:<channelId>", "dm".
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
     * Drain (and clear) the pending "Mark read" markers the service recorded
     * from notification-action taps. Returns { markers: [{ room, ts }, …] };
     * the JS layer maps each room key to the right per-protocol read-state
     * write. Consumed once — a clean drain, since read state is monotonic so a
     * lost marker is at worst a stale badge the next real read corrects.
     */
    @PluginMethod
    public void drainReadMarkers(PluginCall call) {
        JSArray markers = new JSArray();
        synchronized (READ_MARKERS_LOCK) {
            SharedPreferences sp = getContext().getSharedPreferences(READ_MARKERS_PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(READ_MARKERS_KEY, null);
            if (raw != null) {
                try {
                    JSONObject map = new JSONObject(raw);
                    java.util.Iterator<String> keys = map.keys();
                    while (keys.hasNext()) {
                        String room = keys.next();
                        JSONObject entry = map.optJSONObject(room);
                        if (entry == null) continue;
                        JSObject o = new JSObject();
                        o.put("room", room);
                        o.put("ts", entry.optLong("ts", 0L));
                        markers.put(o);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "drainReadMarkers parse failed", e);
                }
                sp.edit().remove(READ_MARKERS_KEY).apply();
            }
        }
        JSObject ret = new JSObject();
        ret.put("markers", markers);
        call.resolve(ret);
    }

    /**
     * Exchange a call id for the parameters of the ring the service posted for
     * it, or resolve empty when there is no such ring.
     *
     * This is the authorization to join a DM call from a notification tap: the
     * service only records a call it decided to RING, which means it was fresh,
     * from a peer the user follows, and carried a well-formed secret and an
     * https broker. A URL naming any other call id, or this one without the
     * answer token only the Answer action carries, gets nothing back.
     *
     * Consumed once — a second tap, or a revisit of the same history entry,
     * must not re-answer a call that has already been answered or has ended.
     */
    @PluginMethod
    public void consumeCallAnswer(PluginCall call) {
        String callId = call.getString("callId");
        String token = call.getString("token");
        JSObject ret = new JSObject();
        if (callId == null || callId.isEmpty() || token == null || token.isEmpty()) {
            call.resolve(ret);
            return;
        }
        synchronized (CALL_ANSWER_LOCK) {
            SharedPreferences sp = getContext()
                    .getSharedPreferences(CALL_ANSWER_PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(CALL_ANSWER_KEY, null);
            if (raw != null) {
                try {
                    JSONObject entry = new JSONObject(raw);
                    String expected = entry.optString("token", "");
                    if (callId.equals(entry.optString("callId"))
                            && callTicketFresh(entry)
                            && !expected.isEmpty()
                            && java.security.MessageDigest.isEqual(
                                    expected.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                                    token.getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
                        ret.put("peer", entry.optString("peer"));
                        ret.put("secret", entry.optString("secret"));
                        ret.put("broker", entry.optString("broker"));
                        sp.edit().remove(CALL_ANSWER_KEY).apply();
                    }
                } catch (Exception e) {
                    Log.w(TAG, "consumeCallAnswer parse failed", e);
                }
            }
        }
        call.resolve(ret);
    }

    /** The ring for `callId`, unconsumed and without its token: enough to ring, not to join. */
    @PluginMethod
    public void peekCallRing(PluginCall call) {
        String callId = call.getString("callId");
        JSObject ret = new JSObject();
        if (callId == null || callId.isEmpty()) {
            call.resolve(ret);
            return;
        }
        synchronized (CALL_ANSWER_LOCK) {
            String raw = getContext()
                    .getSharedPreferences(CALL_ANSWER_PREFS, Context.MODE_PRIVATE)
                    .getString(CALL_ANSWER_KEY, null);
            if (raw != null) {
                try {
                    JSONObject entry = new JSONObject(raw);
                    if (callId.equals(entry.optString("callId")) && callTicketFresh(entry)) {
                        ret.put("peer", entry.optString("peer"));
                        ret.put("secret", entry.optString("secret"));
                        ret.put("broker", entry.optString("broker"));
                        ret.put("createdAtMs", entry.optLong("createdAtMs", 0));
                    }
                } catch (Exception e) {
                    Log.w(TAG, "peekCallRing parse failed", e);
                }
            }
        }
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
            return true;
        }
        return getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Per DM relay, since when the service's NIP-17 inbox has been continuously
     * live ({@code {relays: {url: ms}}}); see NotificationRelayService.dmCoverage.
     */
    @PluginMethod
    public void getDmCoverage(PluginCall call) {
        NotificationRelayService.dmCoverage(coverage -> {
            JSObject ret = new JSObject();
            ret.put("relays", coverage);
            call.resolve(ret);
        });
    }

    /** Non-secret diagnostics for permission, channels and the live relay service. */
    @PluginMethod
    public void getHealth(PluginCall call) {
        Context ctx = getContext();
        JSONObject snapshot = NotificationRelayService.healthSnapshot(ctx);
        JSObject ret = new JSObject();
        java.util.Iterator<String> keys = snapshot.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            ret.put(key, snapshot.opt(key));
        }
        ret.put("postNotificationsGranted", hasNotificationPermission());
        ret.put("notificationsEnabled",
                NotificationManagerCompat.from(ctx).areNotificationsEnabled());

        NotificationManager manager =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        ret.put("messageChannelImportance", channelImportance(
                manager, NotificationRelayService.MSG_CHANNEL_ID));
        ret.put("callChannelImportance", channelImportance(
                manager, NotificationRelayService.CALL_CHANNEL_ID));
        ret.put("serviceChannelImportance", channelImportance(
                manager, NotificationRelayService.SVC_CHANNEL_ID));
        ret.put("activeNotificationCount", activeNotificationCount(manager));
        call.resolve(ret);
    }

    /** Open app notification settings, focused on a channel where supported. */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        String requested = call.getString("channel");
        String channelId = null;
        if ("messages".equals(requested)) channelId = NotificationRelayService.MSG_CHANNEL_ID;
        else if ("calls".equals(requested)) channelId = NotificationRelayService.CALL_CHANNEL_ID;
        else if ("service".equals(requested)) channelId = NotificationRelayService.SVC_CHANNEL_ID;

        try {
            Intent intent;
            if (channelId != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
                        .putExtra(Settings.EXTRA_CHANNEL_ID, channelId);
            } else {
                intent = appNotificationSettingsIntent();
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception channelFailure) {
            try {
                Intent fallback = appNotificationSettingsIntent();
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception appFailure) {
                call.reject("Unable to open notification settings", appFailure);
            }
        }
    }

    private Intent appNotificationSettingsIntent() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        }
        return new Intent("android.settings.APP_NOTIFICATION_SETTINGS")
                .putExtra("app_package", getContext().getPackageName())
                .putExtra("app_uid", getContext().getApplicationInfo().uid);
    }

    private static int channelImportance(NotificationManager manager, String channelId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager == null) return -1;
        NotificationChannel channel = manager.getNotificationChannel(channelId);
        return channel != null ? channel.getImportance() : -1;
    }

    private static int activeNotificationCount(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || manager == null) return -1;
        try {
            return manager.getActiveNotifications().length;
        } catch (Exception ignored) {
            return -1;
        }
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
     * Tell the running service which roomKey(s) the WebView is currently
     * showing (so it can suppress redundant notifications for those rooms — the
     * live timeline already paints the message). Pass an empty array / omit
     * when the app is backgrounded or on a non-chat screen. The value is
     * volatile and heartbeat-bound: it lives only in process and expires if a
     * dead WebView cannot clear it.
     *
     * Room-key shapes (must match the service's enqueueRoomMessage keys):
     *   - NIP-29 group: {@code "h:<relayUrl>|<groupId>"}
     *   - Concord:      {@code "c2:<channelIdHex>"}
     *   - DM:           {@code "dm:<peerPubkey>"}
     */
    @PluginMethod
    public void setActiveRooms(PluginCall call) {
        JSArray arr = call.getArray("roomKeys");
        java.util.Set<String> set = new java.util.HashSet<>();
        if (arr != null) {
            try {
                for (int i = 0; i < arr.length(); i++) {
                    String k = arr.optString(i);
                    if (k != null && !k.isEmpty()) set.add(k);
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to read roomKeys", e);
            }
        }
        NotificationRelayService.setActiveRooms(set);
        call.resolve();
    }

    /**
     * The peer the WebView is dialing or in a DM call with ({@code peer}, empty
     * or absent = none). The service neither rings for nor posts a missed call
     * about that peer's offers while the report is fresh: they are the other
     * half of a call the WebView already owns. Volatile and heartbeat-bound
     * like {@link #setActiveRooms}; it touches no socket or subscription.
     */
    @PluginMethod
    public void setCallPeer(PluginCall call) {
        String peer = call.getString("peer", "");
        NotificationRelayService.setCallPeer(peer);
        call.resolve();
    }

    /**
     * The WebView answered, declined or is itself ringing {@code callId}: the
     * service drops its tray ring for that call (no "Missed call") and won't
     * post one for it later.
     */
    @PluginMethod
    public void dismissCallRing(PluginCall call) {
        NotificationRelayService.dismissCallRing(call.getString("callId", ""));
        call.resolve();
    }

    /**
     * Cancel tray notifications for conversations the WebView reports as read.
     * Payload: {@code { markers: [{ room, ts }, …] }} where {@code room} is the
     * WebView's read-state key (`dm:<pk>` / `c2:<id>` /
     * `<relayUrl>::<groupId>`) and {@code ts} the last-read unix seconds. The
     * running service cancels each matching room whose newest notified message
     * is at/older than that stamp — the reverse of a "Mark read" tap. No-op when
     * the service isn't running (nothing posted) or on web/iOS.
     */
    @PluginMethod
    public void dismissRead(PluginCall call) {
        JSArray arr = call.getArray("markers");
        java.util.Map<String, Long> map = new java.util.HashMap<>();
        if (arr != null) {
            try {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    String room = o.optString("room", null);
                    if (room == null || room.isEmpty()) continue;
                    long ts = o.optLong("ts", 0L);
                    if (ts <= 0) continue;
                    Long prev = map.get(room);
                    if (prev == null || ts > prev) map.put(room, ts);
                }
            } catch (Exception e) {
                Log.w(TAG, "dismissRead parse failed", e);
            }
        }
        if (!map.isEmpty()) NotificationRelayService.dismissRead(map);
        call.resolve();
    }

    @PluginMethod
    public void configure(PluginCall call) {
        if (ServiceProfiler.ON) ServiceProfiler.count("plugin.configure");
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        // Device-wide, so it is stored apart from the account config cleared
        // below, and a change only re-words: no revision bump of its own.
        if (call.hasOption("locale")
                && AppLocale.set(getContext(), call.getString("locale"))) {
            NotificationRelayService.onLocaleChanged(getContext());
        }
        String userPubkey = call.getString("userPubkey");
        // Missing flags mean "replace", preserving the all-at-once contract of
        // older web bundles. Current bundles send one authority bit per async
        // plane so a failed relay read cannot erase (or freeze) unrelated state.
        boolean groupPlaneReady = Boolean.TRUE.equals(call.getBoolean("groupPlaneReady", true));
        boolean dmRelayPlaneReady = Boolean.TRUE.equals(call.getBoolean("dmRelayPlaneReady", true));
        boolean dmRosterPlaneReady = Boolean.TRUE.equals(call.getBoolean("dmRosterPlaneReady", true));
        boolean concordPlaneReady = Boolean.TRUE.equals(call.getBoolean("concordPlaneReady", true));
        boolean gitPlaneReady = Boolean.TRUE.equals(call.getBoolean("gitPlaneReady", true));
        boolean policyPlaneReady = Boolean.TRUE.equals(call.getBoolean("policyPlaneReady", true));

        String relayUrlsRaw = arrayToString(call.getArray("relayUrls"));
        String groupIdsRaw = arrayToString(call.getArray("groupIds"));
        String groupSubsRaw = arrayToString(call.getArray("groupSubs"));
        // Flat "mentions only" ids — only consulted when no groupSubs was sent
        // (see parseGroupSubs); the relay-scoped flag rides on groupSubs itself.
        String mentionOnlyGroupIdsRaw = arrayToString(call.getArray("mentionOnlyGroupIds"));
        String dmRelaysRaw = arrayToString(call.getArray("dmRelays"));
        String dmFollowsRaw = arrayToString(call.getArray("dmFollows"));
        String dmKnownPeersRaw = arrayToString(call.getArray("dmKnownPeers"));
        String dmKnownConversationsRaw = arrayToString(call.getArray("dmKnownConversations"));
        String dmLevelsRaw = null;
        try {
            if (call.getObject("dmLevels") != null) {
                dmLevelsRaw = call.getObject("dmLevels").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read DM notification levels", e);
        }
        // Running timed mutes by room key; the subscriptions above stay through one.
        String roomMutesRaw = null;
        try {
            if (call.getObject("roomMutes") != null) {
                roomMutesRaw = call.getObject("roomMutes").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read room mutes", e);
        }
        String dmMutedPeersRaw = arrayToString(call.getArray("dmMutedPeers"));
        String dmRequestsRaw = call.getString("dmRequests");
        // Where the service may fetch an avatar from (see MediaPolicy). Stored
        // verbatim; the service parses it and treats a missing or unreadable
        // one as the default policy.
        String mediaPolicyRaw = null;
        try {
            if (call.getObject("mediaPolicy") != null) {
                mediaPolicyRaw = call.getObject("mediaPolicy").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read media policy", e);
        }
        String selfRelaysRaw = arrayToString(call.getArray("selfRelays"));
        String selfDTagsRaw = arrayToString(call.getArray("selfDTags"));
        // The documents under keys derived from the settings root, with the
        // read-state ones' conversation keys (see NotificationRelayService.selfDocs).
        String selfDocsRaw = arrayToString(call.getArray("selfDocs"));
        String concordSubsRaw = arrayToString(call.getArray("concordSubs"));
        String gitSubsRaw = arrayToString(call.getArray("gitSubs"));
        java.util.Set<String> concordLeft =
                lowerCaseSet(arrayToString(call.getArray("concordLeftCommunities")));
        // The level policy behind concordSubs, so a merge can apply a mute the
        // snapshot could only express by omission. Absent from older WebViews.
        String concordLevelsRaw = null;
        try {
            if (call.getObject("concordLevels") != null) {
                concordLevelsRaw = call.getObject("concordLevels").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read Concord notification levels", e);
        }
        // prefs is a flat object of booleans; store its JSON verbatim.
        String prefsRaw = null;
        try {
            if (call.getObject("prefs") != null) {
                prefsRaw = call.getObject("prefs").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read prefs", e);
        }
        // The shared signer credential ({type:"key"|"amber"|"nip46", …} — see
        // NativeSigner). Secret-bearing, so it is sealed with an Android
        // Keystore key before touching SharedPreferences and wiped with the
        // rest of the config on disable/logout.
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String signerSealed = null;
        String signerDigest = null;
        try {
            if (call.getObject("signer") != null) {
                String signerRaw = call.getObject("signer").toString();
                signerDigest = sha256Hex(signerRaw);
                // The SAME credential as last time keeps its sealed copy. Sealing
                // uses a fresh IV, so re-sealing an unchanged signer would read
                // to the service as "the signer changed", rebuilding it (and
                // redialing a NIP-46 bunker) and reconnecting every relay.
                String previousSealed = prefs.getString("signerSealed", null);
                if (previousSealed != null && signerDigest.equals(prefs.getString("signerDigest", null))) {
                    signerSealed = previousSealed;
                } else {
                    signerSealed = SealedStore.seal(signerRaw);
                    if (signerSealed == null) Log.w(TAG, "Failed to seal signer credential");
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read signer", e);
        }

        boolean sameAccountConfig = prefs.getBoolean("enabled", false)
                && userPubkey != null
                && userPubkey.equals(prefs.getString("userPubkey", null));
        boolean incomingHasWatch = hasArrayItems(relayUrlsRaw)
                || hasArrayItems(groupSubsRaw)
                || hasArrayItems(dmRelaysRaw)
                || hasArrayItems(selfRelaysRaw)
                || hasArrayItems(concordSubsRaw)
                || hasArrayItems(gitSubsRaw);
        // A partial same-account refresh may contain no currently-ready watch
        // at all (for example, the group-list relay is offline while only a
        // local preference changed). Keep the service alive from its last-good
        // watch set; a complete authoritative empty view is sent as
        // {enabled:false} by the WebView and still clears everything below.
        boolean hasConfig = enabled && userPubkey != null
                && NotificationRelayService.hasUsableNotificationPolicy(
                        sameAccountConfig, policyPlaneReady)
                && (incomingHasWatch || (sameAccountConfig && hasPersistedWatch(prefs)));

        if (hasConfig) {
            boolean replaceGroup = NotificationRelayService.shouldReplaceConfigPlane(
                    sameAccountConfig, groupPlaneReady);
            boolean replaceDmRelays = NotificationRelayService.shouldReplaceConfigPlane(
                    sameAccountConfig, dmRelayPlaneReady);
            boolean replaceDmRoster = NotificationRelayService.shouldReplaceConfigPlane(
                    sameAccountConfig, dmRosterPlaneReady);
            boolean replaceConcord = NotificationRelayService.shouldReplaceConfigPlane(
                    sameAccountConfig, concordPlaneReady);
            boolean replaceGit = NotificationRelayService.shouldReplaceConfigPlane(
                    sameAccountConfig, gitPlaneReady);

            SharedPreferences.Editor editor = prefs.edit();
            // Never merge the outgoing account into a new one. Even a useful
            // partial fresh bootstrap starts from a blank slate; unready-plane
            // preservation is strictly a same-pubkey operation.
            if (!sameAccountConfig) {
                editor.clear();
                // Account-scoped state outside the config must cross the same
                // boundary: a missed/failed JS exit barrier cannot leave the
                // outgoing account's tray, read actions or call ticket behind.
                clearReadMarkers(getContext());
                NotificationRelayService.clearPersistedCursors(getContext());
                clearCallAnswer(getContext(), null);
                NotificationRelayService.clearAccountNotifications(getContext());
            }
            editor
                    .putBoolean("enabled", true)
                    .putString("userPubkey", userPubkey);
            if (replaceGroup) {
                putOrRemove(editor, "relayUrls", relayUrlsRaw);
                putOrRemove(editor, "groupIds", groupIdsRaw);
                putOrRemove(editor, "groupSubs", groupSubsRaw);
                putOrRemove(editor, "mentionOnlyGroupIds", mentionOnlyGroupIdsRaw);
            } else {
                putOrRemove(editor, "relayUrls", mergeStringArrays(
                        prefs.getString("relayUrls", null), relayUrlsRaw));
                putOrRemove(editor, "groupIds", mergeStringArrays(
                        prefs.getString("groupIds", null), groupIdsRaw));
                String oldGroupSubs = prefs.getString("groupSubs", null);
                // Keep the key absent for a legacy last-good config when the
                // partial current snapshot is empty. Presence of groupSubs=[]
                // deliberately disables the relayUrls/groupIds fallback.
                String mergedGroupSubs = oldGroupSubs == null
                        && !hasArrayItems(groupSubsRaw)
                        ? null
                        : mergeObjectArrays(oldGroupSubs, groupSubsRaw,
                                "relay", "id");
                putOrRemove(editor, "groupSubs", mergedGroupSubs);
                putOrRemove(editor, "mentionOnlyGroupIds", mergeFlagsForKnownIds(
                        prefs.getString("mentionOnlyGroupIds", null),
                        mentionOnlyGroupIdsRaw, groupIdsRaw));
            }
            if (replaceDmRelays) {
                putOrRemove(editor, "dmRelays", dmRelaysRaw);
            } else {
                putOrRemove(editor, "dmRelays", mergeStringArrays(
                        prefs.getString("dmRelays", null), dmRelaysRaw));
            }
            if (replaceDmRoster) {
                putOrRemove(editor, "dmFollows", dmFollowsRaw);
                putOrRemove(editor, "dmKnownPeers", dmKnownPeersRaw);
                putOrRemove(editor, "dmKnownConversations", dmKnownConversationsRaw);
                putOrRemove(editor, "dmMutedPeers", dmMutedPeersRaw);
            } else {
                putOrRemove(editor, "dmFollows", mergeStringArrays(
                        prefs.getString("dmFollows", null), dmFollowsRaw));
                putOrRemove(editor, "dmKnownPeers", mergeStringArrays(
                        prefs.getString("dmKnownPeers", null), dmKnownPeersRaw));
                putOrRemove(editor, "dmKnownConversations", mergeStringArrays(
                        prefs.getString("dmKnownConversations", null),
                        dmKnownConversationsRaw));
                putOrRemove(editor, "dmMutedPeers", mergeStringArrays(
                        prefs.getString("dmMutedPeers", null), dmMutedPeersRaw));
            }
            // These values are local once the account's NIP-78 settings have
            // either synchronized or proven a durable account-scoped
            // last-good. Unrelated relay planes never gate them, but startup
            // defaults must not replace an existing policy (or bootstrap a
            // fresh account) before that authority exists.
            if (policyPlaneReady) {
                putOrRemove(editor, "dmLevels", dmLevelsRaw);
                putOrRemove(editor, "roomMutes", roomMutesRaw);
                putOrRemove(editor, "dmRequests", dmRequestsRaw);
                putOrRemove(editor, "prefs", prefsRaw);
                putOrRemove(editor, "mediaPolicy", mediaPolicyRaw);
            }
            putOrRemove(editor, "selfRelays", selfRelaysRaw);
            // Absent leaves the pref absent, which the service reads as
            // SelfState.DEFAULT_D_TAGS — never as an empty set, which would
            // drop the kind-30078 subscription entirely. That is also what an
            // older WebView (which doesn't send this) gets.
            putOrRemove(editor, "selfDTags", selfDTagsRaw);
            putOrRemove(editor, "selfDocs", selfDocsRaw);
            // The "concord2Subs" PREF key keeps its old spelling on purpose:
            // the service reads it on boot, before the WebView can re-register.
            // Respelling it would leave an upgraded device with no Concord
            // notifications until the user next opens the app.
            if (replaceConcord) {
                putOrRemove(editor, "concord2Subs", concordSubsRaw);
            } else {
                // A merge keeps whatever the unready snapshot didn't mention,
                // which for a community the member LEFT is every channel of it.
                // The tombstone is positive knowledge, so drop those here.
                // Entries it kept are re-resolved against the current levels, or a
                // channel muted since they were stored would keep notifying.
                putOrRemove(editor, "concord2Subs", applyConcordLevels(
                        withoutCommunities(mergeConcordSubscriptions(
                                prefs.getString("concord2Subs", null), concordSubsRaw), concordLeft),
                        concordSubsRaw, concordLevelsRaw));
            }
            if (signerSealed != null) {
                editor.putString("signerSealed", signerSealed);
                editor.putString("signerDigest", signerDigest);
            } else if (!sameAccountConfig) {
                editor.remove("signerSealed");
                editor.remove("signerDigest");
            }
            // Missing login material and a transient sealing failure both keep
            // the same account's last-good signer. Logout/account replacement
            // clears first, so another identity can never inherit it.
            if (replaceGit) {
                if (gitSubsRaw != null) {
                    editor.putString("gitSubs", mergeGitRoots(
                            sameAccountConfig ? prefs.getString("gitSubs", null) : null,
                            gitSubsRaw));
                } else {
                    editor.remove("gitSubs");
                }
            } else {
                putOrRemove(editor, "gitSubs", withoutQuietGitAttachments(withoutGitCommunities(
                        gitSubsRaw != null
                                ? mergeGitSubscriptions(prefs.getString("gitSubs", null), gitSubsRaw)
                                : prefs.getString("gitSubs", null),
                        concordLeft), concordLevelsRaw));
            }
            // Versioned only for the additive Git plane. Existing installations
            // without this key retain their message/DM configuration unchanged.
            editor.putInt("schemaVersion", 2);
            // Bump a revision so the running service's SharedPreferences
            // listener always fires even if the values look unchanged.
            editor.putLong("rev", nextConfigRevision(prefs));
            editor.apply();
            if (BuildConfig.DEBUG) Log.d(TAG, "Configured: relays=" + relayUrlsRaw + " groups=" + groupIdsRaw
                    + " dmRelays=" + dmRelaysRaw
                    + " concordSubs=" + (concordSubsRaw != null ? "yes" : "none"));
        } else {
            prefs.edit().clear().apply();
            // Drop any un-drained read markers too, so they can't apply to a
            // different account after a logout/switch.
            clearReadMarkers(getContext());
            NotificationRelayService.clearPersistedCursors(getContext());
            // And any ring's parameters, which name a peer of the account that
            // just went away.
            clearCallAnswer(getContext(), null);
            NotificationRelayService.clearAccountNotifications(getContext());
            Log.d(TAG, "Config cleared (disabled or logged out)");
        }

        manageService(hasConfig);
        call.resolve();
    }

    private void manageService(boolean start) {
        Context ctx = getContext();
        Intent serviceIntent = new Intent(ctx, NotificationRelayService.class);
        if (start) {
            // If already live, the single `rev` preference callback below
            // reloads it. Delivering another start would run onStartCommand too
            // and rebuild every socket twice for one logical configuration.
            NotificationRelayService.startIfConfigured(ctx);
        } else {
            BootReceiver.cancelWatchdog(ctx);
            ctx.stopService(serviceIntent);
            Log.d(TAG, "Stopped NotificationRelayService");
        }
    }

    private static String arrayToString(JSONArray arr) {
        return arr != null ? arr.toString() : null;
    }

    private static void putOrRemove(
            SharedPreferences.Editor editor, String key, String value) {
        if (value != null) editor.putString(key, value);
        else editor.remove(key);
    }

    private static boolean hasArrayItems(String raw) {
        if (raw == null) return false;
        try {
            return new JSONArray(raw).length() > 0;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean hasPersistedWatch(SharedPreferences prefs) {
        return hasArrayItems(prefs.getString("relayUrls", null))
                || hasArrayItems(prefs.getString("groupSubs", null))
                || hasArrayItems(prefs.getString("dmRelays", null))
                || hasArrayItems(prefs.getString("selfRelays", null))
                || hasArrayItems(prefs.getString("concord2Subs", null))
                || hasArrayItems(prefs.getString("gitSubs", null));
    }

    /** Additive merge used while a relay-backed plane is not authoritative. */
    static String mergeStringArrays(String oldJson, String nextJson) {
        if (nextJson == null) return oldJson;
        if (oldJson == null) return nextJson;
        try {
            java.util.LinkedHashSet<String> values = new java.util.LinkedHashSet<>();
            JSONArray oldValues = new JSONArray(oldJson);
            JSONArray nextValues = new JSONArray(nextJson);
            for (int i = 0; i < oldValues.length(); i++) {
                String value = oldValues.optString(i, null);
                if (value != null) values.add(value);
            }
            for (int i = 0; i < nextValues.length(); i++) {
                String value = nextValues.optString(i, null);
                if (value != null) values.add(value);
            }
            return new JSONArray(values).toString();
        } catch (Exception ignored) {
            return nextJson;
        }
    }

    /**
     * Merge object arrays by a stable composite identity. Incoming objects win
     * for matching records, so policy flags such as {@code mentionOnly} can
     * advance even before the source is complete; unmatched old records stay
     * until a ready-plane replacement prunes them.
     */
    static String mergeObjectArrays(
            String oldJson, String nextJson, String... identityKeys) {
        if (nextJson == null) return oldJson;
        if (oldJson == null) return nextJson;
        try {
            java.util.LinkedHashMap<String, JSONObject> values =
                    new java.util.LinkedHashMap<>();
            addObjectsByIdentity(values, new JSONArray(oldJson), identityKeys);
            addObjectsByIdentity(values, new JSONArray(nextJson), identityKeys);
            JSONArray merged = new JSONArray();
            for (JSONObject value : values.values()) merged.put(value);
            return merged.toString();
        } catch (Exception ignored) {
            return nextJson;
        }
    }

    /** Additive same-account Concord merge, including nested relay/key sets. */
    static String mergeConcordSubscriptions(String oldJson, String nextJson) {
        if (nextJson == null) return oldJson;
        if (oldJson == null) return nextJson;
        try {
            java.util.LinkedHashMap<String, JSONObject> values =
                    objectMap(new JSONArray(oldJson), "communityId", "channelId");
            JSONArray incoming = new JSONArray(nextJson);
            for (int i = 0; i < incoming.length(); i++) {
                JSONObject next = incoming.optJSONObject(i);
                String identity = objectIdentity(next, "communityId", "channelId");
                if (next == null || identity == null) continue;
                JSONObject old = values.get(identity);
                JSONObject merged = new JSONObject(next.toString());
                if (old != null) {
                    putMergedArray(merged, "relays", mergeStringArrays(
                            arrayString(old, "relays"), arrayString(next, "relays")));
                    putMergedArray(merged, "streams", mergeObjectArrays(
                            arrayString(old, "streams"), arrayString(next, "streams"), "pk"));
                    putMergedArray(merged, "banned", mergeStringArrays(
                            arrayString(old, "banned"), arrayString(next, "banned")));
                }
                values.put(identity, merged);
            }
            return objectValues(values).toString();
        } catch (Exception ignored) {
            return nextJson;
        }
    }

    /** Lower-cased members of a JSON string array; empty for null/invalid input. */
    static java.util.Set<String> lowerCaseSet(String json) {
        java.util.Set<String> out = new java.util.HashSet<>();
        if (json == null) return out;
        try {
            JSONArray values = new JSONArray(json);
            for (int i = 0; i < values.length(); i++) {
                String value = values.optString(i, "");
                if (!value.isEmpty()) out.add(value.toLowerCase(java.util.Locale.ROOT));
            }
        } catch (Exception ignored) {
            // No removals rather than a guess.
        }
        return out;
    }

    /** Concord subscriptions minus every channel of the named communities. */
    static String withoutCommunities(String json, java.util.Set<String> communityIds) {
        if (json == null || communityIds.isEmpty()) return json;
        try {
            JSONArray input = new JSONArray(json);
            JSONArray kept = new JSONArray();
            for (int i = 0; i < input.length(); i++) {
                JSONObject value = input.optJSONObject(i);
                if (value == null) continue;
                String community = value.optString("communityId", "").toLowerCase(java.util.Locale.ROOT);
                if (!communityIds.contains(community)) kept.put(value);
            }
            return kept.toString();
        } catch (Exception ignored) {
            return json;
        }
    }

    /**
     * A Concord channel's level under the WebView's policy
     * ({@code {default, communities, channels}}): channel, then community, then
     * default, as {@code concordChannelLevel} resolves it. Null without a policy.
     */
    static String concordLevel(JSONObject policy, String communityId, String channelId) {
        if (policy == null) return null;
        String community = communityId.toLowerCase(java.util.Locale.ROOT);
        String channel = channelId.toLowerCase(java.util.Locale.ROOT);
        JSONObject channels = policy.optJSONObject("channels");
        String level = channels != null ? channels.optString(community + ":" + channel, "") : "";
        if (level.isEmpty()) {
            JSONObject communities = policy.optJSONObject("communities");
            level = communities != null ? communities.optString(community, "") : "";
        }
        if (level.isEmpty()) level = policy.optString("default", "");
        return level.isEmpty() ? null : level;
    }

    private static JSONObject parsePolicy(String policyJson) {
        if (policyJson == null) return null;
        try {
            return new JSONObject(policyJson);
        } catch (Exception ignored) {
            return null;
        }
    }

    /**
     * Merged Concord subscriptions with every entry the incoming snapshot did NOT
     * carry re-resolved by {@code policyJson}: dropped at "nothing", mention-only
     * at "mentions". Incoming entries are already resolved and pass through.
     */
    static String applyConcordLevels(String mergedJson, String incomingJson, String policyJson) {
        JSONObject policy = parsePolicy(policyJson);
        if (mergedJson == null || policy == null) return mergedJson;
        try {
            java.util.Set<String> incoming = new java.util.HashSet<>();
            if (incomingJson != null) {
                incoming.addAll(objectMap(new JSONArray(incomingJson), "communityId", "channelId").keySet());
            }
            JSONArray input = new JSONArray(mergedJson);
            JSONArray kept = new JSONArray();
            for (int i = 0; i < input.length(); i++) {
                JSONObject value = input.optJSONObject(i);
                if (value == null) continue;
                String identity = objectIdentity(value, "communityId", "channelId");
                if (identity == null || incoming.contains(identity)) {
                    kept.put(value);
                    continue;
                }
                String level = concordLevel(
                        policy, value.optString("communityId"), value.optString("channelId"));
                if ("nothing".equals(level)) continue;
                if ("mentions".equals(level) || "all".equals(level)) {
                    value = new JSONObject(value.toString());
                    value.put("mentionOnly", "mentions".equals(level));
                }
                kept.put(value);
            }
            return kept.toString();
        } catch (Exception ignored) {
            return mergedJson;
        }
    }

    /**
     * Git subscriptions minus attachments whose channel is not at "all" under
     * {@code policyJson} (Git events carry no mention, so mentions-only gets none).
     */
    static String withoutQuietGitAttachments(String json, String policyJson) {
        JSONObject policy = parsePolicy(policyJson);
        if (json == null || policy == null) return json;
        try {
            JSONArray input = new JSONArray(json);
            JSONArray kept = new JSONArray();
            for (int i = 0; i < input.length(); i++) {
                JSONObject repository = input.optJSONObject(i);
                if (repository == null) continue;
                JSONArray attachments = repository.optJSONArray("attachments");
                JSONArray keptAttachments = new JSONArray();
                if (attachments != null) for (int j = 0; j < attachments.length(); j++) {
                    JSONObject attachment = attachments.optJSONObject(j);
                    if (attachment == null) continue;
                    String community = attachment.optString("communityId", "");
                    String level = community.isEmpty() ? null : concordLevel(
                            policy, community, attachment.optString("channelId", ""));
                    if (level == null || "all".equals(level)) keptAttachments.put(attachment);
                }
                if (keptAttachments.length() == 0) continue;
                JSONObject next = new JSONObject(repository.toString());
                next.put("attachments", keptAttachments);
                kept.put(next);
            }
            return kept.toString();
        } catch (Exception ignored) {
            return json;
        }
    }

    /**
     * Git subscriptions minus attachments to the named communities; a repository
     * left with no attachment is dropped, as the service would skip it anyway.
     */
    static String withoutGitCommunities(String json, java.util.Set<String> communityIds) {
        if (json == null || communityIds.isEmpty()) return json;
        try {
            JSONArray input = new JSONArray(json);
            JSONArray kept = new JSONArray();
            for (int i = 0; i < input.length(); i++) {
                JSONObject repository = input.optJSONObject(i);
                if (repository == null) continue;
                JSONArray attachments = repository.optJSONArray("attachments");
                JSONArray keptAttachments = new JSONArray();
                if (attachments != null) for (int j = 0; j < attachments.length(); j++) {
                    JSONObject attachment = attachments.optJSONObject(j);
                    if (attachment == null) continue;
                    String community = attachment.optString("communityId", "")
                            .toLowerCase(java.util.Locale.ROOT);
                    if (!communityIds.contains(community)) keptAttachments.put(attachment);
                }
                if (keptAttachments.length() == 0) continue;
                JSONObject next = new JSONObject(repository.toString());
                next.put("attachments", keptAttachments);
                kept.put(next);
            }
            return kept.toString();
        } catch (Exception ignored) {
            return json;
        }
    }

    /** Additive same-account Git merge; ready replacement still prunes. */
    static String mergeGitSubscriptions(String oldJson, String nextJson) {
        if (nextJson == null) return oldJson;
        if (oldJson == null) return nextJson;
        try {
            java.util.LinkedHashMap<String, JSONObject> values =
                    objectMap(new JSONArray(oldJson), "address");
            JSONArray incoming = new JSONArray(nextJson);
            for (int i = 0; i < incoming.length(); i++) {
                JSONObject next = incoming.optJSONObject(i);
                String identity = objectIdentity(next, "address");
                if (next == null || identity == null) continue;
                JSONObject old = values.get(identity);
                JSONObject merged = new JSONObject(next.toString());
                if (old != null) {
                    putMergedArray(merged, "relays", mergeStringArrays(
                            arrayString(old, "relays"), arrayString(next, "relays")));
                    putMergedArray(merged, "maintainers", mergeStringArrays(
                            arrayString(old, "maintainers"), arrayString(next, "maintainers")));
                    putMergedArray(merged, "attachments", mergeObjectArrays(
                            arrayString(old, "attachments"), arrayString(next, "attachments"),
                            "channelId", "attachedAt"));
                    putMergedArray(merged, "ticketRoots", mergeObjectArrays(
                            arrayString(old, "ticketRoots"), arrayString(next, "ticketRoots"),
                            "id"));
                }
                values.put(identity, merged);
            }
            return objectValues(values).toString();
        } catch (Exception ignored) {
            return nextJson;
        }
    }

    private static java.util.LinkedHashMap<String, JSONObject> objectMap(
            JSONArray input, String... identityKeys) {
        java.util.LinkedHashMap<String, JSONObject> values =
                new java.util.LinkedHashMap<>();
        for (int i = 0; i < input.length(); i++) {
            JSONObject value = input.optJSONObject(i);
            String identity = objectIdentity(value, identityKeys);
            if (identity != null) values.put(identity, value);
        }
        return values;
    }

    private static String objectIdentity(JSONObject value, String... identityKeys) {
        if (value == null) return null;
        StringBuilder identity = new StringBuilder();
        for (String key : identityKeys) {
            String part = value.optString(key, "");
            if (part.isEmpty()) return null;
            identity.append(part.length()).append(':').append(part);
        }
        return identity.toString();
    }

    private static JSONArray objectValues(
            java.util.LinkedHashMap<String, JSONObject> values) {
        JSONArray result = new JSONArray();
        for (JSONObject value : values.values()) result.put(value);
        return result;
    }

    private static String arrayString(JSONObject value, String key) {
        JSONArray array = value != null ? value.optJSONArray(key) : null;
        return array != null ? array.toString() : null;
    }

    private static void putMergedArray(
            JSONObject target, String key, String mergedJson) throws JSONException {
        if (mergedJson != null) target.put(key, new JSONArray(mergedJson));
    }

    private static void addObjectsByIdentity(
            java.util.LinkedHashMap<String, JSONObject> values,
            JSONArray input,
            String... identityKeys) {
        for (int i = 0; i < input.length(); i++) {
            JSONObject value = input.optJSONObject(i);
            if (value == null) continue;
            String identity = objectIdentity(value, identityKeys);
            if (identity != null) values.put(identity, value);
        }
    }

    /** Update flags for records present in a partial snapshot without pruning. */
    static String mergeFlagsForKnownIds(
            String oldFlagsJson, String nextFlagsJson, String knownIdsJson) {
        if (knownIdsJson == null) return oldFlagsJson;
        try {
            java.util.LinkedHashSet<String> flags = new java.util.LinkedHashSet<>();
            JSONArray oldFlags = oldFlagsJson != null
                    ? new JSONArray(oldFlagsJson) : new JSONArray();
            JSONArray nextFlags = nextFlagsJson != null
                    ? new JSONArray(nextFlagsJson) : new JSONArray();
            JSONArray knownIds = new JSONArray(knownIdsJson);
            for (int i = 0; i < oldFlags.length(); i++) {
                String value = oldFlags.optString(i, null);
                if (value != null) flags.add(value);
            }
            for (int i = 0; i < knownIds.length(); i++) {
                String value = knownIds.optString(i, null);
                if (value != null) flags.remove(value);
            }
            for (int i = 0; i < nextFlags.length(); i++) {
                String value = nextFlags.optString(i, null);
                if (value != null) flags.add(value);
            }
            return new JSONArray(flags).toString();
        } catch (Exception ignored) {
            return nextFlagsJson != null ? nextFlagsJson : oldFlagsJson;
        }
    }

    /** Keep roots dynamically learned by the service if a WebView config refresh
     * races before IndexedDB has observed them. Attachments/relays always come
     * from the fresh verified web config; only public ticket ids are merged. */
    private static String mergeGitRoots(String oldJson, String nextJson) {
        if (oldJson == null) return nextJson;
        try {
            JSONArray oldRepos = new JSONArray(oldJson), nextRepos = new JSONArray(nextJson);
            for (int i = 0; i < nextRepos.length(); i++) {
                org.json.JSONObject next = nextRepos.optJSONObject(i); if (next == null) continue;
                String address = next.optString("address", "");
                org.json.JSONObject old = null;
                for (int j = 0; j < oldRepos.length(); j++) { org.json.JSONObject candidate = oldRepos.optJSONObject(j); if (candidate != null && address.equals(candidate.optString("address"))) { old = candidate; break; } }
                if (old == null) continue;
                JSONArray roots = next.optJSONArray("ticketRoots"); if (roots == null) next.put("ticketRoots", roots = new JSONArray());
                JSONArray oldRoots = old.optJSONArray("ticketRoots"); if (oldRoots == null) continue;
                for (int j = 0; j < oldRoots.length(); j++) {
                    org.json.JSONObject root = oldRoots.optJSONObject(j); if (root == null) continue;
                    boolean exists = false; for (int k = 0; k < roots.length(); k++) { org.json.JSONObject present = roots.optJSONObject(k); if (present != null && root.optString("id").equals(present.optString("id"))) exists = true; }
                    if (!exists) roots.put(root);
                }
            }
            return nextRepos.toString();
        } catch (Exception ignored) { return nextJson; }
    }

    /** Lowercase hex SHA-256 of a string's UTF-8 bytes. */
    static String sha256Hex(String text) throws java.security.NoSuchAlgorithmException {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                .digest(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder(digest.length * 2);
        for (byte b : digest) out.append(String.format("%02x", b));
        return out.toString();
    }

}
