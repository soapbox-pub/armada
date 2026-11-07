package buzz.armada.app;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;
import android.util.LruCache;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.graphics.drawable.IconCompat;

import buzz.armada.app.db.SelfState;
import buzz.armada.app.db.ServiceStore;
import buzz.armada.app.relayfleet.CircuitBreakerPolicy;
import buzz.armada.app.relayfleet.CursorGate;
import buzz.armada.app.relayfleet.DmRelayCover;
import buzz.armada.app.relayfleet.FloodBreaker;
import buzz.armada.app.relayfleet.GitRelayCover;
import buzz.armada.app.relayfleet.Keepalive;
import buzz.armada.app.relayfleet.RelayCover;
import buzz.armada.app.relayfleet.NetworkSettle;
import buzz.armada.app.relayfleet.RelayFleetPolicy;
import buzz.armada.app.relayfleet.RelayFleetPolicy.ConnectionResult;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetDecision;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetEdge;
import buzz.armada.app.relayfleet.RelayFleetPolicy.Outcome;
import buzz.armada.app.relayfleet.RelayFleetPolicy.RelayInfo;

import com.bitchat.android.nostr.Bech32;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.net.ConnectException;
import java.net.UnknownHostException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;

import okhttp3.Cache;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Foreground service that holds a persistent Nostr REQ subscription to the
 * user's relay(s) and posts a native notification the instant a matching event
 * arrives. This is the de-Googled instant-push path — no FCM, no Web Push, no
 * polling.
 *
 * One WebSocket per relay is kept open with a live REQ:
 *   - {@code {kinds:[9], #h:[...ids-hosted-here], since}} group messages (a
 *     NIP-29 group lives on one relay, so #h is scoped per relay)
 *   - {@code {kinds:[7,1111], #h:[...ids-hosted-here], #p:[userPubkey], since}} reactions/replies
 *   - {@code {kinds:[4], authors:[...follows], #p:[userPubkey], since}} DMs (friends only)
 *   - {@code {kinds:[1059], authors:[...stream pks], since}} Concord wraps
 *
 * On each EVENT we apply the user's prefs (mention vs all-group, per-type
 * toggles), dedupe by id, skip self, and post it into its room's conversation
 * notification (see {@code enqueueRoomMessage}).
 *
 * All of that state is single-threaded on one dedicated looper — see
 * {@code handler}, which is emphatically NOT the main one: the service shares
 * a process with the WebView, and this work is far too heavy for the thread
 * that draws frames.
 *
 * Resilience:
 *   - Exponential reconnect backoff per relay (1s → 5min cap), reset only
 *     after a connection survives long enough to be considered stable.
 *   - Network-aware: reconnects immediately when connectivity returns.
 *   - Re-reads config (login/logout/relay/group changes) via a SharedPreferences
 *     listener and rebuilds subscriptions live.
 */
public class NotificationRelayService extends Service {

    private static final String TAG = "ArmadaNotifSvc";
    // Bumped to _v2: IMPORTANCE_MIN (no status bar icon) is less intrusive than
    // LOW, so users are less likely to disable it and break the background service;
    // the channel bump resets any existing disable to the new enabled default.
    static final String SVC_CHANNEL_ID = "armada_background_service_v2";
    private static final String SVC_CHANNEL_ID_LEGACY = "armada_background_service";
    // Channel settings are immutable once created, so new vibration/importance
    // settings need a new id; the old channel is deleted in createChannels().
    static final String MSG_CHANNEL_ID = "armada_notifications_v2";
    private static final String MSG_CHANNEL_ID_LEGACY = "armada_notifications";
    // A firm, attention-grabbing buzz for messages: wait, buzz, gap, buzz again.
    private static final long[] MSG_VIBRATION_PATTERN = { 0L, 400L, 200L, 400L };
    private static final int FOREGROUND_ID = 1;
    // Room notification ids are hashed into [2, ROOM_ID_MODULUS+1]. The band
    // just above is reserved for the retired summary ids that
    // cancelStaleSummaries clears.
    private static final int ROOM_ID_MODULUS = 2_000_000_000;
    /** Leave headroom below Android/OEM per-package notification limits. */
    private static final int MAX_ACTIVE_ROOM_NOTIFICATIONS = 40;
    private static final int CONTENT_CAP = 140;
    // ── Per-channel conversation notifications ────────────────────────────────
    // Each CHANNEL (a Concord channel, a NIP-29 group) and each DM peer
    // gets ONE standalone conversation notification that accumulates its recent
    // messages via MessagingStyle — the community image (sender avatar for DMs)
    // on the left, "Community / #channel" (peer name) as the title. A busy
    // channel grows one thread; other channels get their own notification, each
    // with its own tap target and Mark read.
    //
    // There is deliberately NO per-community group summary: Android 7+ IGNORES
    // a group summary's custom title/large-icon and renders a collapsed stack
    // with the APP name + APP icon, repeating each child's conversation avatar
    // per line — so a summary can never carry the community's branding. And
    // merging a community's channels into ONE notification makes a tap
    // or Mark read act on every channel at once. Standalone per-channel
    // conversations are the only shape with both the branding and per-channel
    // actions.
    //
    // Every notification gets its OWN unique group key so Android's
    // auto-bundling (4+ ungrouped notifications) can't sweep separate
    // conversations into one system pile under the app icon.
    private static final String GROUP_PREFIX = "armada:";
    // The retired summary-id band ([SUMMARY_ID_BASE, +SUMMARY_ID_MODULUS)):
    // older builds posted per-community InboxStyle summaries here. Cleared on
    // startup so an upgrade doesn't leave orphaned summaries in the tray.
    private static final int SUMMARY_ID_BASE = 2_000_000_002;
    private static final int SUMMARY_ID_MODULUS = 140_000_000;
    // "Mark read" notification action: dismisses the notification AND enqueues a
    // durable read-marker the WebView applies (advancing the in-app read state)
    // on its next open/resume. Delivered to the running service as a start intent
    // (handled in onStartCommand WITHOUT tearing down relay connections).
    static final String ACTION_MARK_READ = "buzz.armada.app.action.MARK_READ";
    static final String EXTRA_ROOM_KEY = "armada_room_key";
    // Per-channel read-marker payload carried on the Mark read intent
    // (parallel arrays: channel roomKey ↔ last message ts in ms), so the
    // marker survives a service cold start with the right timestamp.
    static final String EXTRA_CHANNEL_KEYS = "armada_channel_keys";
    static final String EXTRA_CHANNEL_TS = "armada_channel_ts";
    // "Reply" notification action: a RemoteInput whose text the service sends
    // back into the conversation ITSELF — a NIP-29 kind 9, a NIP-17
    // gift-wrapped DM, or a Concord sealed message — with the shared
    // signer credential, so a reply typed on the lockscreen goes out with the
    // app dead. Delivered as a start intent, exactly like Mark read. Rooms
    // with no native send path don't get the action at all.
    static final String ACTION_REPLY = "buzz.armada.app.action.REPLY";
    static final String KEY_TEXT_REPLY = "armada_text_reply";
    // How long a reply publish waits for any relay's OK before failing.
    private static final long PUBLISH_TIMEOUT_MS = 20_000;
    // How long the one-shot kind-10050 inbox lookup gathers answers.
    private static final long DM_INBOX_TIMEOUT_MS = 4_000;
    // NIP-59: outgoing seal/wrap timestamps are tweaked into the past, ≤ 2 days.
    private static final long MAX_WRAP_BACKDATE_SECS = 2 * 24 * 3600;
    // Most recent messages kept per room for the MessagingStyle expansion.
    private static final int MAX_MESSAGES_PER_ROOM = 8;

    /**
     * Alerting posts one room may fire inside {@link #ALERT_BURST_WINDOW_MS}
     * before further messages post SILENTLY.
     *
     * A public Concord channel's write access is key possession (CORD-04 §1),
     * so anyone holding an invite link can fill it — and a measured campaign
     * ran 368 messages through one channel in half an hour, one every 3.4
     * seconds. Every one of them reached here and alerted, which is a phone
     * buzzing all night no matter what the timeline does about it: the fold in
     * `floodCluster.ts` is a render-layer rule that this service, a second
     * writer in another language, never sees.
     *
     * So the limit here is deliberately NOT a spam judgement. It is a ceiling
     * on interruptions, and it holds whatever the messages say — no content is
     * examined, nothing is classified, and a generator that writes better
     * sentences gains nothing. Past the budget the room's notification is still
     * POSTED and still accumulates its lines, so the tray shows what arrived
     * and the count keeps climbing; it just stops making noise.
     *
     * Every attempt is recorded, not just the ones that alert, so a sustained
     * flood keeps its own window full and stays quiet until it genuinely stops
     * — otherwise the budget would refill mid-flood and buzz once per window
     * for as long as the flood ran.
     */
    private static final int ALERT_BURST_MAX = 5;
    /**
     * Mentions get their own, smaller budget rather than breaking through.
     *
     * An @-ping is worth waking someone for, but `p` tags are attacker-chosen
     * — a flood that tags every recipient would walk straight through an
     * unconditional mention exemption, which is the one bypass that would make
     * the rest of this pointless. A separate budget keeps a real mention
     * audible while an ordinary flood exhausts only the message budget.
     */
    private static final int ALERT_BURST_MAX_MENTION = 3;
    private static final long ALERT_BURST_WINDOW_MS = 120_000L;
    /** Bound per room; entries older than the window are pruned on every check. */
    private static final int ALERT_BURST_MAX_TRACKED = 256;
    /** Room count past which quiet rooms' keys are swept out of a budget map. */
    private static final int ALERT_BURST_SWEEP_AT = 64;
    private final java.util.Map<String, java.util.ArrayDeque<Long>> alertBurst = new java.util.HashMap<>();
    private final AlertPolicy alertPolicy = new AlertPolicy();
    // Messages waiting out activity on another device (AlertPolicy), oldest
    // first. Decrypted text: cleared with the account.
    private final List<HeldMessage> heldMessages = new ArrayList<>();
    private static final int MAX_HELD_MESSAGES = 64;
    private boolean heldFlushPosted = false;
    // Newest read stamp (unix s) per read-state key seen from another device,
    // so a held message read there is dropped instead of posted.
    private final Map<String, Long> lastReadByKey = new HashMap<>();
    private final Runnable flushHeldRunnable = this::flushHeldMessages;
    private final java.util.Map<String, java.util.ArrayDeque<Long>> mentionBurst = new java.util.HashMap<>();

    // ── Incoming DM calls ─────────────────────────────────────────────────────
    // Voice-call signal rumor kind (Armada extension — see src/lib/dmCall.ts:
    // content is the phase "offer"/"answer"/"decline"/"end", tags carry the
    // `call` binding). Never stored (not a Dm17 kind); acted on here.
    private static final int KIND_DM_CALL = 23314;
    // Ring only while the offer is at most this old (the rumor's REAL
    // created_at); an older — but NIP-40-unexpired — offer surfaces as a
    // "Missed call" line in the conversation's notification instead.
    static final long CALL_RING_WINDOW_MS = 60_000;
    // Dedicated channel: IMPORTANCE_HIGH with the device RINGTONE, not the
    // message blip, so an incoming call sounds like a call.
    static final String CALL_CHANNEL_ID = "armada_calls";
    // Outside the room-id band ([2, 2e9+1]) and the retired summary band.
    private static final int INCOMING_CALL_NOTIF_ID = 2_146_000_000;
    static final String ACTION_DECLINE_CALL = "buzz.armada.app.action.DECLINE_CALL";
    static final String EXTRA_CALL_ID = "armada_call_id";
    static final String EXTRA_CALL_PEER = "armada_call_peer";
    // The call currently ringing in the tray (handler-thread confined, like
    // roomNotifs). Null when none.
    private String ringingCallId;
    private String ringingPeer;
    // Calls the WebView took over (dismissCallRing), newest last; handler thread only.
    private final java.util.ArrayDeque<String> dismissedRingCallIds = new java.util.ArrayDeque<>();
    private static final int DISMISSED_RING_MEMORY = 32;
    // One "ringing" receipt per call id and per peer per interval, as on the web.
    private final CallReceiptGate callReceiptGate = new CallReceiptGate();

    // Backoff for relay-initiated CLOSED resubscribes (see subRetryBackoffMs).
    // SOCKET reconnects are timed by fleetPolicy (relayfleet/), which lets the
    // fleet reach a quiet state instead of retrying a dead relay forever.
    private static final long INITIAL_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 5 * 60 * 1_000;

    // The keepalive probe: a REQ no event can match, which the relay answers
    // with EOSE. One fixed sub id, so a repeat replaces it rather than piling up.
    static final String KEEPALIVE_SUB = "ak-keepalive";
    static final String KEEPALIVE_PROBE = "[\"REQ\",\"" + KEEPALIVE_SUB
            + "\",{\"ids\":[\"0000000000000000000000000000000000000000000000000000000000000000\"],\"limit\":1}]";
    private static final String KEEPALIVE_CLOSE = "[\"CLOSE\",\"" + KEEPALIVE_SUB + "\"]";
    // Per relay, how long its sockets may stay quiet before a probe (see
    // Keepalive.learn). Outlives the connection, which a config change rebuilds.
    private final Map<String, Long> quietLimitByUrl = new HashMap<>();
    // Persisted, or every launch re-learns each relay's timeout by being dropped once.
    private static final String KEEPALIVE_PREFS = "armada_keepalive";
    private boolean quietLimitsLoaded = false;

    private long quietLimitFor(String relayUrl) {
        if (!quietLimitsLoaded) {
            quietLimitsLoaded = true;
            for (Map.Entry<String, ?> e : getSharedPreferences(KEEPALIVE_PREFS, Context.MODE_PRIVATE).getAll().entrySet()) {
                if (e.getValue() instanceof Long) quietLimitByUrl.put(e.getKey(), Math.max(Keepalive.MIN_QUIET_MS, (Long) e.getValue()));
            }
        }
        return quietLimitByUrl.getOrDefault(relayUrl, Keepalive.DEFAULT_QUIET_MS);
    }
    // Awake past the probe timeout long enough to drop a dead socket and redial it.
    private static final long WATCHDOG_RECONNECT_GRACE_MS = 15_000;
    private final Runnable keepaliveCheck = () -> {
        long now = SystemClock.elapsedRealtime();
        for (RelayConnection rc : this.connections) rc.checkProbe(now);
    };
    // Quiet is measured in elapsedRealtime, which counts deep sleep: the
    // handler's clock (uptime) stops while the CPU is suspended, so a socket
    // whose NAT mapping expired overnight would otherwise read as just used.
    private final Runnable keepaliveTick = new Runnable() {
        @Override
        public void run() {
            keepaliveSweep();
            handler.postDelayed(this, Keepalive.TICK_MS);
        }
    };

    /** Probe every quiet socket now (handler thread). Whether any probe went out. */
    private boolean keepaliveSweep() {
        long now = SystemClock.elapsedRealtime();
        boolean probed = false;
        for (RelayConnection rc : connections) probed |= rc.keepalive(now);
        if (probed) {
            handler.removeCallbacks(keepaliveCheck);
            handler.postDelayed(keepaliveCheck, Keepalive.PROBE_TIMEOUT_MS);
        }
        return probed;
    }

    /**
     * The watchdog alarm woke a live service: sweep now, since the uptime tick
     * may not come round before the device sleeps again, and stay awake until
     * a dead socket has been dropped and redialed.
     */
    static void onWatchdogWake(Context ctx) {
        NotificationRelayService svc = instance;
        if (svc == null) return;
        android.os.PowerManager.WakeLock wl = svc.watchdogWakeLock(ctx);
        if (wl != null) wl.acquire(Keepalive.PROBE_TIMEOUT_MS + WATCHDOG_RECONNECT_GRACE_MS);
        svc.handler.post(() -> {
            svc.keepaliveSweep();
            svc.handler.removeCallbacks(svc.watchdogSettleCheck);
            svc.handler.post(svc.watchdogSettleCheck);
        });
    }

    // One non-counted lock, so overlapping wakes extend it rather than stack.
    private android.os.PowerManager.WakeLock watchdogWakeLock;

    private synchronized android.os.PowerManager.WakeLock watchdogWakeLock(Context ctx) {
        if (watchdogWakeLock == null) {
            android.os.PowerManager pm = (android.os.PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return null;
            watchdogWakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "armada:keepalive");
            watchdogWakeLock.setReferenceCounted(false);
        }
        return watchdogWakeLock;
    }

    private static final long WATCHDOG_SETTLE_POLL_MS = 1_000;
    // An open socket counts as settled once nothing has arrived for this long,
    // so a replay after a redial is handled before the CPU may sleep again.
    private static final long WATCHDOG_QUIET_MS = 2_000;

    /**
     * Releases the watchdog's lock as soon as the fleet has nothing left to do
     * in this wake; its timeout is only the cap.
     */
    private final Runnable watchdogSettleCheck = new Runnable() {
        @Override
        public void run() {
            android.os.PowerManager.WakeLock wl;
            synchronized (NotificationRelayService.this) { wl = watchdogWakeLock; }
            if (wl == null || !wl.isHeld()) return;
            long now = SystemClock.elapsedRealtime();
            long uptime = SystemClock.uptimeMillis();
            for (RelayConnection rc : connections) {
                if (!rc.watchdogSettled(now, uptime)) {
                    handler.postDelayed(this, WATCHDOG_SETTLE_POLL_MS);
                    return;
                }
            }
            wl.release();
        }
    };

    /**
     * Decides, per relay, whether to hold a background socket at all, when to
     * reconnect after a failure, and when to stop trying (quarantine) until a
     * network/config/foreground change. Transport-free so it is unit-tested and
     * benchmarked in isolation — see {@code RelayFleetPolicyBenchmarkTest}.
     * {@code RelayConnection} is the adapter: it classifies real socket events
     * into the policy's outcomes and executes its decisions.
     */
    private final RelayFleetPolicy fleetPolicy = new CircuitBreakerPolicy();

    private OkHttpClient httpClient;

    /**
     * The confinement thread, and deliberately NOT the main one.
     *
     * Everything {@code handler} guards — {@link #connections}, the config
     * snapshot, {@link #roomNotifs}, the profile cache — is single-threaded on
     * this looper, which is what lets it all be plain fields.
     *
     * The service shares a process with the Activity and the WebView (no
     * {@code android:process} in the manifest), so on the main looper every
     * relay message — Schnorr verifies, Concord opens, {@link ServiceStore}
     * writes contending for the {@code SqliteArmadaDb} lock the WebView's reads
     * hold — would block frames, up to an ANR on a catch-up burst.
     *
     * The service lifecycle callbacks arrive on the main thread, so they post.
     */
    private final HandlerThread handlerThread = startHandlerThread();
    private final Handler handler = new Handler(handlerThread.getLooper());

    private static HandlerThread startHandlerThread() {
        HandlerThread thread = new HandlerThread("ArmadaNotifSvc");
        thread.start();
        return thread;
    }

    private ConnectivityManager.NetworkCallback networkCallback;
    // When the network last changed (elapsedRealtime; handler thread): connects
    // wait for NetworkSettle.SETTLE_MS of quiet after it, so a burst of changes
    // costs the fleet one reconnect instead of one per change.
    private long lastNetworkChangeAt = 0;
    // A socket that ends this soon after a network change was dropped by the
    // change, not by its relay's idle timeout.
    private static final long NETWORK_DROP_GRACE_MS = 60_000;
    private boolean sawNetworkLoss = false;
    // When the default network was first seen unvalidated (elapsedRealtime), 0 when validated.
    private long unvalidatedSince = 0;
    private SharedPreferences.OnSharedPreferenceChangeListener configListener;
    private final Runnable configReloadRunnable = this::loadConfigAndReconnect;

    // Active connections, one per relay URL.
    private final List<RelayConnection> connections = new ArrayList<>();
    /** Relay frames posted to the handler and not yet run (profiling builds). */
    private final java.util.concurrent.atomic.AtomicInteger pendingFrames =
            new java.util.concurrent.atomic.AtomicInteger();

    // Current config snapshot.
    private String userPubkey;
    private final List<String> relayUrls = new ArrayList<>();
    private final Set<String> groupIds = new LinkedHashSet<>();
    // relay URL → the NIP-29 group ids hosted on THAT relay. A NIP-29 group is
    // intrinsically tied to a single relay (its `h` id is only meaningful on
    // its host), so each relay's kind-9 REQ is scoped to just its own groups —
    // the same relay→subscription model as Concord's relayToPks2, never a
    // broadcast of every joined id to every relay. Built in loadConfig from the
    // `groupSubs` config; falls back to relayUrls × groupIds for a config
    // written by an older build that shipped only the flat arrays.
    private final Map<String, Set<String>> relayToGroupIds = new HashMap<>();
    // The subset of the above whose notification level is "mentions only",
    // as `relay + '\0' + groupId` keys — relay-scoped for the same reason
    // relayToGroupIds is: an `h` id names a group only together with its host,
    // so a flat id set would mute the same-named group on every other relay.
    // These groups stay SUBSCRIBED (a mention still has to arrive); the
    // suppression happens per event in wantsNotification.
    private final Set<String> mentionOnlyGroupKeys = new LinkedHashSet<>();
    private final Set<String> dmRelays = new LinkedHashSet<>();
    // The subset of dmRelays subscribed on (see DmRelayCover). Publishing
    // still goes to every dmRelay.
    private final Set<String> dmWatchRelays = new LinkedHashSet<>();
    static final int DM_RELAYS_WATCHED = 2;
    // Established DM peers (hex): follows, explicit accepts/1:1 pins and peers
    // recovered from authored encrypted-index rows. The historical config key
    // is `dmFollows`; kind-4 subscriptions use it as an author allow-list.
    private final Set<String> dmFollows = new LinkedHashSet<>();
    // Individually established DM peers (hex). A NIP-17 wrap's author is
    // ephemeral, so its inbox cannot be author-scoped like kind 4; the request
    // decision happens after opening it and also considers the exact group set.
    private final Set<String> dmKnownPeers = new LinkedHashSet<>();
    // Canonical NIP-17 conversation keys the viewer pinned or authored. A
    // group entry trusts only that exact participant set; its members are not
    // copied into dmKnownPeers and therefore gain no unrelated 1:1 trust.
    private final Set<String> dmKnownConversations = new LinkedHashSet<>();
    // Exact canonical conversation key -> all/mentions/nothing. `mentions` is
    // equivalent to `all` for DMs because every message is directed at the
    // recipient. An absent key inherits prefs.directMessages.
    private final Map<String, String> dmLevels = new HashMap<>();
    // A muted participant suppresses their entire NIP-17 conversation, matching
    // the WebView's list semantics (including when another group member spoke).
    private final Set<String> dmMutedPeers = new LinkedHashSet<>();
    // How to notify for an unknown DM conversation: "off" (silent),
    // "generic" (a content-blind request ping) or "full" (name/avatar/preview).
    // A stranger controls the message text, their display name and their avatar,
    // so the default keeps all three off the lock screen. Empty/unknown value ⇒
    // "generic". Only consulted when the `directMessages` pref is on.
    private String dmRequests = "generic";
    // Where a sender's avatar and a community's icon may be fetched FROM — the
    // WebView's media policy (see MediaPolicy), applied to the two fetches this
    // service makes unprompted. Absent means the default: proxying off.
    private MediaPolicy mediaPolicy = MediaPolicy.defaults();
    // Relays carrying the user's OWN replaceable documents (see SelfState) —
    // the client's general pool: app relays + the user's NIP-65 read relays.
    // Kept separate from `relayUrls`, which is derived from the kind-10009 list
    // and therefore holds NIP-29 servers only: a Concord-only user has none, and
    // scoping self-state to them would mean never watching the relays their
    // settings are actually published to.
    private final Set<String> selfRelays = new LinkedHashSet<>();
    // The subset of selfRelays subscribed on: another device publishes each
    // document to all of them, so a couple carry it.
    private final Set<String> selfWatchRelays = new LinkedHashSet<>();
    static final int SELF_RELAYS_WATCHED = 2;
    // The `d` tags of Armada's own NIP-78 settings documents, supplied by the
    // WebView so a fork that changes APP_ID renames them here too. Falls
    // back to the built-in set when the pref is absent — on a cold boot before
    // the app has ever been opened, and for an older WebView that doesn't send
    // it. Empty is never a valid value: it would drop the subscription.
    private Set<String> selfDTags = SelfState.DEFAULT_D_TAGS;
    /**
     * The documents under keys derived from the settings root: author → its one
     * {@code d}. Supplied by the WebView (which holds the root); empty until it has
     * one, and for an older WebView.
     */
    private Map<String, String> selfDocs = java.util.Collections.emptyMap();
    /**
     * Read-state documents' NIP-44 conversation keys, by author: enough to open
     * them for {@link #applyReadStateDismiss}, not to sign anything.
     */
    private Map<String, byte[]> readStateKeys = java.util.Collections.emptyMap();
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    /** Identifies the {@link #selfDocs} set a self-state cursor was taken over. */
    private String selfDocsFingerprint = "";
    private JSONObject prefs = new JSONObject();
    // Concord (CORD-02) channel subscriptions, keyed for fast lookup:
    //   pkToStream2: stream pubkey (the kind-1059 wrap's author, hex) → decrypt
    //                material + display name + deep link for that channel/epoch
    //   relayToPks2: relay url → the stream pubkeys WATCHED there (the cover)
    //   concordPublishRelays: relay url → every stream pubkey its community
    //                lists it for — where a reply is published
    private final java.util.Map<String, ConcordStream> pkToStream2 = new java.util.HashMap<>();
    private final java.util.Map<String, Set<String>> relayToPks2 = new java.util.HashMap<>();
    private final java.util.Map<String, Set<String>> concordPublishRelays = new java.util.HashMap<>();
    // Each community's listed relays and stream pubkeys, the cover's input.
    private final java.util.Map<String, Set<String>> communityRelays = new java.util.HashMap<>();
    private final java.util.Map<String, Set<String>> communityPks = new java.util.HashMap<>();
    // Relays that rejected the stream keys' AUTH on a walled Concord sub this
    // process: the cover picks them only for a community with nothing else.
    private final Set<String> concordRefusedRelays = new HashSet<>();
    // A community is published to every relay it lists, so a couple carry it.
    static final int CONCORD_RELAYS_PER_COMMUNITY = 2;
    // Rebuilds the fleet after a refusal; live sockets are kept (reconfigure).
    private final Runnable recoverConcordRunnable = this::loadConfigAndReconnect;
    // The user's shared signer (nsec key / Amber grant / NIP-46 session),
    // rebuilt on every config load. Opens NIP-17 gift wraps addressed to the
    // user (the DM wrap filter is `{kinds:[1059], "#p":[userPubkey]}` on the DM
    // relays — the sender is hidden, so it can't be authors-scoped) and signs
    // NIP-42 AUTH natively; null when the WebView shipped no credential.
    private volatile NativeSigner nativeSigner;
    /** The sealed signer credential the current {@link #nativeSigner} was built from. */
    private String loadedSealedSigner;
    // Public Git activity is subscribed on announcement activity relays only.
    // The repository -> C2 route mapping never enters a relay filter.
    private final Map<String, GitRepository> gitRepositories = new HashMap<>();
    private final Map<String, Set<String>> gitRepositoriesByRelay = new HashMap<>();
    private static final int GIT_ROOT_FILTER_CHUNK_SIZE = 100;
    // De-dupe notifications across relays/reconnect overlap without retaining
    // every id for a months-long foreground-service lifetime.
    static final int MAX_NOTIFIED_IDS = 8_192;
    private final LinkedHashSet<String> notifiedIds = new LinkedHashSet<>();
    // Per-relay live cursor. A new relay starts at "now" (no cold-start
    // backlog); a reconnect in this service lifetime resumes inclusively from
    // only THAT relay's last accepted timestamp. It is deliberately in-memory:
    // durable history belongs to ArmadaDB/WebView sync, not notification replay.
    private final AccountCursors cursors = new AccountCursors();
    private final Map<String, Long> relaySinceByUrl = cursors.relaySince;
    private final Set<String> relayCursorsWithEvents = cursors.relaysWithEvents;
    // Per-relay self-state cursor: when the self-state subscription last
    // reached EOSE on a relay (minus SELF_SINCE_SLACK_SEC).
    private final Map<String, Long> selfSinceByUrl = cursors.selfSince;
    // When each DM inbox's live NIP-17 sub last dropped (wall ms). Concurrent:
    // sendReqs reads it on the socket thread from onOpen.
    private final Map<String, Long> dm17LiveUntilByUrl = cursors.dm17LiveUntil;
    // Per relay, kept across reconnects so a flood's pause outlives the socket.
    // Concurrent: sendReqs also runs on the socket thread from onOpen.
    private final Map<String, FloodBreaker> selfFloodByUrl = new java.util.concurrent.ConcurrentHashMap<>();

    /** Per-relay positions that belong to the signed-in account. */
    static final class AccountCursors {
        final Map<String, Long> relaySince = new HashMap<>();
        final Set<String> relaysWithEvents = new HashSet<>();
        final Map<String, Long> selfSince = new HashMap<>();
        final Map<String, Long> dm17LiveUntil = new java.util.concurrent.ConcurrentHashMap<>();

        /** An account change: no position may carry into the next account's reads. */
        void clear() {
            relaySince.clear();
            relaysWithEvents.clear();
            selfSince.clear();
            dm17LiveUntil.clear();
        }
    }

    private FloodBreaker selfFlood(String relayUrl) {
        return selfFloodByUrl.computeIfAbsent(relayUrl, k -> new FloodBreaker());
    }
    // Self-state event ids already verified and filed, so the same document
    // arriving from every self relay (and on every re-REQ) is dropped before
    // the Schnorr verify and the store write instead of after.
    private final LinkedHashSet<String> selfSeenIds = new LinkedHashSet<>();
    // Newest created_at filed per self-state coordinate (kind:d). Every self
    // relay holds its OWN version of each replaceable document, so a full read
    // delivers several copies of every coordinate, most of them superseded;
    // one not newer than what was already filed is dropped before the verify
    // and the write (the store would discard it anyway, after both).
    private final Map<String, Long> selfNewestByCoordinate = new HashMap<>();
    // Installation-sharded topic documents (the DM conversation index, GIF
    // favorites) waiting out their window; see SelfTopicWindow. Bounded in
    // distinct coordinates, so a flood of invented pieces cannot grow it.
    static final long SELF_TOPIC_WINDOW_MS = 10_000L;
    // Above an account's real piece count (8 DM-index pieces per installation).
    static final int MAX_PENDING_SELF_TOPIC_DOCS = 512;
    private final SelfTopicWindow selfTopicWindow =
            new SelfTopicWindow(MAX_PENDING_SELF_TOPIC_DOCS, NostrCrypto::verifyEvent);
    private final Runnable flushSelfTopicDocsRunnable = this::flushSelfTopicDocs;
    private boolean selfTopicFlushPosted;
    // Small reconnect overlap tolerates cross-thread/same-second ordering and
    // mildly skewed publishers. It applies only after this service has actually
    // observed an event, so a cold start still asks from now with no backlog.
    static final long RELAY_SINCE_OVERLAP_SEC = 30L;
    /** Relays each Git repository is watched on beyond those held anyway. */
    static final int GIT_RELAYS_PER_REPOSITORY = 2;
    /** CORD-02 §8 community-list fragment (addressable, `d` = index). */
    static final int KIND_COMMUNITY_LIST_FRAG = 33302;
    // Self-state documents are written by OTHER devices, whose clocks we don't
    // control; a new version stamped up to this far behind our last EOSE is
    // still asked for.
    static final long SELF_SINCE_SLACK_SEC = 600L;
    static final int MAX_SELF_SEEN_IDS = 4_096;

    // Non-secret health counters exposed through ArmadaNotification.getHealth.
    // Fields are volatile because Capacitor may read the snapshot off the
    // service's handler thread. Never put relay URLs, event JSON or credentials
    // in these values.
    private volatile long healthLastConfigAtMs;
    private volatile long healthLoadedConfigRevision;
    private volatile long healthLastAuthAtMs;
    private volatile long healthLastSignAtMs;
    private volatile long healthLastEventAtMs;
    private volatile long healthLastPresentedAtMs;
    private volatile long healthLastErrorAtMs;
    private volatile String healthLastError;
    private volatile String healthSignerStatus = "missing";
    private volatile String healthAuthStatus = "idle";
    private volatile int healthRelayWatchCount;
    // Relays the fleet policy has quarantined (no retry until an edge), and
    // relays curated out at build (read-pool only: no standing subscription).
    private volatile int healthRelayQuarantinedCount;
    private volatile int healthRelayCuratedOutCount;
    private volatile int healthGroupWatchCount;
    private volatile int healthDmPeerWatchCount;
    private volatile int healthConcordStreamWatchCount;
    private volatile int healthSocketOpenCount;
    private volatile int healthSocketTotalCount;

    // NIP-59 backdates a gift wrap's `created_at` by up to 2 days, and relays
    // apply `since` to LIVE streamed events too — so a `since` anywhere near
    // `now` filters out virtually every live NIP-17 DM wrap (only a backdate
    // that randomly lands inside the window would pass). The DM wrap filter
    // therefore rewinds `since` by the full backdate window (+ 1h slack) and
    // asks for NO stored replay (`limit: 0` — live-only; history is the
    // WebView's DM inbox sync to handle). For relays that ignore `limit: 0`,
    // notifiedIds dedupes within the service lifetime and the shared-DB
    // `storedBefore` check suppresses wraps either side already stored.
    private static final long DM17_SINCE_REWIND_SEC = 2 * 24 * 3600 + 3600;
    /** A gap shorter than this is not replayed: reconnects are frequent and a page costs ~300 KB. */
    static final long DM17_CATCHUP_MIN_GAP_MS = 2 * 60_000L;
    static final int DM17_CATCHUP_LIMIT = 200;
    private static final long DM17_CATCHUP_SLACK_SEC = 60;

    // roomKey → the accumulating per-room notification (Signal/Discord style).
    // The roomKey is a stable identifier for the conversation (NIP-29 groupId,
    // Concord channel id, or "dm:<peer>"), so successive
    // messages UPDATE the same notification instead of stacking a new one per
    // event.
    private final Map<String, RoomNotif> roomNotifs = new HashMap<>();

    // Resolved (decoded, circle-cropped) community icons, keyed by
    // CommunityRef.imageCacheKey(). Populated async; used as the conversation
    // shortcut's avatar (the left icon on Android 11+). Kept separate from
    // avatarCache (sender avatars).
    private final LruCache<String, Bitmap> groupImageCache = bitmapCache(4 * 1024 * 1024);
    // In-flight community-icon fetches (by imageCacheKey) so a burst of messages
    // in one community doesn't kick off the same fetch repeatedly.
    private final Set<String> groupImageInFlight = new HashSet<>();

    /**
     * The roomKey(s) the WebView is currently showing on screen (set via
     * {@code ArmadaNotification.setActiveRooms}), or empty when the app is
     * backgrounded / on a non-chat screen. Held in process only and trusted for
     * one short heartbeat window, so an Activity/WebView kill that skips its
     * cleanup cannot suppress a room forever while this service survives. When
     * a message arrives for an active room we
     * suppress the notification (it's redundant: the live timeline already
     * shows it). Mentions are still surfaced, since a mention is a deliberate
     * @-ping even on the visible channel.
     */
    private static volatile Set<String> activeRoomKeys =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
    static final long ACTIVE_ROOMS_TTL_MS = 25_000L;
    private static volatile long activeRoomsUpdatedAtElapsedMs;


    // pubkey → resolved profile (kind 0), DURABLE: persisted to its own
    // SharedPreferences file so a service restart (Doze, OEM kills, reboots,
    // START_STICKY relaunches) doesn't re-broadcast a one-shot kind-0 REQ to
    // every relay for every author. Also holds NEGATIVE entries (fetched,
    // nothing found) so a profile-less author doesn't re-broadcast on every
    // message. Loaded in onCreate; writes are debounced (markProfilesDirty).
    private ProfileStore profileStore = new ProfileStore();
    // Whether a debounced profile-store persist is already scheduled.
    private boolean profilePersistScheduled = false;
    // pubkey → waiters for an in-flight kind-0 fetch, so concurrent events for
    // the same author share a single REQ.
    private final Map<String, List<ProfileCallback>> pendingProfiles = new HashMap<>();
    // pubkey → best (newest) kind-0 seen so far for an in-flight fetch, across
    // all relays it was broadcast to. A profile from one relay can be staler
    // than another's, so we keep the highest created_at rather than first-wins.
    private final Map<String, Profile> bestProfile = new HashMap<>();
    // pubkey → newest verified kind-10050 gathered by an in-flight DM-inbox
    // lookup (reply addressing), across relays. Read + cleared by the lookup's
    // timeout in resolveDmInbox.
    private final Map<String, JSONObject> bestInbox = new HashMap<>();
    // The user's OWN kind-0 + avatar, for the MessagingStyle self person a
    // sent quick reply renders as. Resolved once per config load through the
    // ordinary profile path (memory store → shared DB → relays), so the
    // notification build stays synchronous; a late arrival re-posts the rooms
    // that already show a reply (see warmSelfProfile).
    private Profile selfProfile;
    private Bitmap selfAvatar;
    private boolean selfProfilePending;
    // avatar URL → circle-cropped bitmap, decoded once and reused. Backed by a
    // persistent disk cache (avatarDir) so a warm avatar survives service
    // restarts and lands in the FIRST, alerting post instead of a later silent
    // re-post.
    // Bounded by decoded bytes; a miss falls back to avatarDir, not the network.
    private final LruCache<String, Bitmap> avatarCache = bitmapCache(6 * 1024 * 1024);

    /** A bitmap LRU bounded by decoded size. LruCache synchronizes internally. */
    private static LruCache<String, Bitmap> bitmapCache(int maxBytes) {
        return new LruCache<String, Bitmap>(maxBytes) {
            @Override
            protected int sizeOf(String key, Bitmap value) {
                return Math.max(1, value.getByteCount());
            }
        };
    }
    // Decoded, circle-cropped avatars persisted across restarts (getCacheDir()).
    private File avatarDir;
    // Avatar/image HTTP client: derived from httpClient (shares the dispatcher +
    // connection pool) but with its OWN read/call timeouts and a disk cache.
    // Kept SEPARATE from httpClient because httpClient drives the long-lived
    // relay WebSockets — a callTimeout there would tear the sockets down.
    private OkHttpClient avatarClient;
    // groupId → resolved group name (kind 39000). Cached for the service lifetime
    // so the room name in a notification doesn't re-fetch on every event.
    private final Map<String, String> groupNameCache = new HashMap<>();
    // groupId → the group's `picture` URL (kind 39000). Populated by the same
    // metadata fetch that resolves the name; used as the NIP-29 conversation's
    // avatar (a plain public URL — no decrypt).
    private final Map<String, String> groupPictureCache = new HashMap<>();
    // groupId → waiters for an in-flight kind-39000 fetch.
    private final Map<String, List<GroupNameCallback>> pendingGroupNames = new HashMap<>();
    // Largest dimension (px) we keep for an avatar large-icon.
    private static final int AVATAR_PX = 128;
    // Max decoded avatars kept on disk; least-recently-used pruned on save.
    private static final int AVATAR_DISK_MAX = 500;
    // On-disk HTTP cache for avatar byte fetches (shared with re-downloads).
    private static final long AVATAR_HTTP_CACHE_BYTES = 8L * 1024 * 1024;
    // How long to wait for a kind-0 profile before firing a name-less fallback.
    private static final long PROFILE_TIMEOUT_MS = 4_000;
    // How long a NEGATIVE profile entry suppresses re-broadcasts (24h).
    private static final long PROFILE_MISS_TTL_MS = 24L * 60 * 60 * 1000;
    // How long a cached profile is served without a background refresh (7d).
    private static final long PROFILE_STALE_MS = 7L * 24 * 60 * 60 * 1000;
    // Cap on persisted profiles; least-recently-fetched evicted on persist.
    private static final int PROFILE_STORE_MAX = 1000;
    // Debounce for writing the profile store to SharedPreferences.
    private static final long PROFILE_PERSIST_DEBOUNCE_MS = 1_000;
    // SharedPreferences file holding the serialized ProfileStore.
    private static final String PROFILES_PREFS = "armada_notif_profiles";
    /**
     * Where each self-state relay's read had reached, kept across process
     * restarts. Without it every new process re-reads every document the
     * account ever published there, and Ditto-family relays keep each edition.
     * Keys are account-scoped; the file is cleared on disable/logout with the
     * rest of the notification state.
     */
    static final String CURSOR_PREFS = "armada_notif_cursors";
    /** An older persisted cursor is dropped for a full read. */
    static final long SELF_SINCE_MAX_AGE_SEC = 30L * 24 * 3600;
    private static final String PROFILES_KEY = "profiles";

    /** Minimal author profile: display name + avatar URL + nip05 (any may be null). */
    private static final class Profile {
        final String name;
        final String picture;
        final String nip05;
        /** kind-0 created_at, so a newer event from another relay wins. */
        final long ts;
        Profile(String name, String picture, String nip05, long ts) {
            this.name = name;
            this.picture = picture;
            this.nip05 = nip05;
            this.ts = ts;
        }
    }

    private interface ProfileCallback {
        void onProfile(Profile profile);
    }

    /**
     * Per-stream Concord decrypt material: the NIP-44 conversation key that
     * opens the stream's kind-1059 wraps (wrap → seal → rumor), the channel id
     * + epoch the rumor must bind to, and the display/deep-link strings for
     * the notification. One entry per (channel, epoch) — each epoch has its
     * own stream pubkey and conversation key.
     */
    private static final class ConcordStream {
        final byte[] convKey;     // raw 32-byte NIP-44 conversation key
        final String communityId; // hex; names the ArmadaDB tenant opened rumors are filed in
        final String channelId;   // hex; the rumor's `channel` tag must match
        final String epoch;       // decimal string; the rumor's `epoch` tag must match
        final String name;        // "Community / #channel" display name
        final String url;         // in-app deep link (/c/<communityId>/<channelId>)
        final CommunityRef community; // the community this stream's channel belongs to
        // CORD-08 disappearing-message timer (seconds, 0 = off) — the quick
        // reply stamps sendTime + timer on its rumor + wrap while set.
        final long timerSecs;
        // Channel set to "mentions only": still subscribed (a mention has to
        // arrive to be seen), but non-mention traffic notifies nothing.
        final boolean mentionOnly;
        // The community's banned authors (CORD-04), hex pubkeys. A banned
        // member's rumor is still stored (the timeline folds it away on read)
        // but must never notify, so handleEvent drops it after decrypt.
        // Community-wide, so every channel's stream carries the same set.
        final Set<String> banned;
        // Authors currently authorized to issue a literal @everyone, server-wide
        // (Vector `is_authorized`), and whether @everyone itself holds the bit.
        final Set<String> mentionEveryoneAuthors;
        final boolean mentionEveryoneAnyone;
        // The Roles the viewer holds, and who may ping any Role (CORD-04 §8).
        final List<RoleMentions.Held> roleMentions;
        final Set<String> roleMentionAuthors;
        // The relays' clock minus this device's (CORD-03 §3), from the WebView's sync.
        final long clockOffsetMs;
        // Posts readers collapse ring nobody (CORD-04 §8): authors without SEND here, and
        // the running Timeouts as {from, until} unix seconds by author.
        final Set<String> sendDenied;
        // In a restricted Channel, the only authors whose posts ring; null elsewhere (CORD-03 §1).
        final Set<String> postAuthors;
        final Map<String, long[]> timeouts;
        // The Nicknames members go by in this Community (CORD-04 §10), which name the sender.
        final Map<String, String> nicknames;
        // When this membership began (ms, the vault entry's `added_at`; 0 =
        // unknown). Nothing sent earlier notifies: the viewer wasn't there.
        final long joinedAtMs;
        ConcordStream(byte[] convKey, String communityId, String channelId, String epoch,
                       String name, String url, CommunityRef community, long timerSecs,
                       boolean mentionOnly, Set<String> banned, Set<String> mentionEveryoneAuthors,
                       boolean mentionEveryoneAnyone, List<RoleMentions.Held> roleMentions, Set<String> roleMentionAuthors,
                       long clockOffsetMs, Set<String> sendDenied, Set<String> postAuthors, Map<String, long[]> timeouts,
                       Map<String, String> nicknames, long joinedAtMs) {
            this.convKey = convKey;
            this.communityId = communityId;
            this.channelId = channelId;
            this.epoch = epoch;
            this.name = name;
            this.url = url;
            this.community = community;
            this.timerSecs = timerSecs;
            this.mentionOnly = mentionOnly;
            this.banned = banned;
            this.mentionEveryoneAuthors = mentionEveryoneAuthors;
            this.mentionEveryoneAnyone = mentionEveryoneAnyone;
            this.roleMentions = roleMentions;
            this.roleMentionAuthors = roleMentionAuthors;
            this.clockOffsetMs = clockOffsetMs;
            this.sendDenied = sendDenied;
            this.postAuthors = postAuthors;
            this.timeouts = timeouts;
            this.nicknames = nicknames;
            this.joinedAtMs = joinedAtMs;
        }
    }

    private static final class GitAttachment {
        final String communityId, channelId; final long attachedAt, detachedAt;
        GitAttachment(String communityId, String channelId, long attachedAt, long detachedAt) {
            this.communityId = communityId; this.channelId = channelId;
            this.attachedAt = attachedAt; this.detachedAt = detachedAt;
        }
        boolean activeAt(long timestamp) { return timestamp >= attachedAt && (detachedAt < 0 || timestamp < detachedAt); }
        boolean live() { return detachedAt < 0; }
    }
    private static final class GitRoot {
        final String id, author; final int kind;
        GitRoot(String id, String author, int kind) { this.id = id; this.author = author; this.kind = kind; }
    }
    private static final class GitRepository {
        final String address, owner; final Set<String> maintainers = new HashSet<>();
        final List<GitAttachment> attachments = new ArrayList<>();
        final Map<String, GitRoot> roots = new HashMap<>();
        GitRepository(String address, String owner) { this.address = address; this.owner = owner; }
        boolean live() { for (GitAttachment a : attachments) if (a.live()) return true; return false; }
    }

    private interface GroupNameCallback {
        /** Receives the group's display name, or null if unresolved. */
        void onName(String name);
    }

    /**
     * The COMMUNITY a room belongs to: its stable key, display name, and the
     * conversation avatar source (the channel notification's left icon). The
     * icon is either a plain https URL (a NIP-29 kind-39000 `picture`) or an
     * encrypted-blob pointer the service fetches and AES-GCM decrypts itself
     * (Concord community icons — key/nonce/hash are shipped from the
     * WebView, the same trust model as the channel decrypt keys). A null/empty
     * image url ⇒ the notification shows the app icon only.
     */
    private static final class CommunityRef {
        final String groupKey;   // stable community key
        final String title;      // community/server display name
        final String url;        // community-level deep link (fallback tap target)
        final String imageUrl;   // https URL to fetch, or null
        final byte[] imgKey;     // AES-256-GCM key for an encrypted icon, or null
        final byte[] imgNonce;   // GCM nonce, or null
        final String imgHash;    // plaintext sha256 hex (cache key + integrity), or null

        CommunityRef(String groupKey, String title, String url,
                     String imageUrl, byte[] imgKey, byte[] imgNonce, String imgHash) {
            this.groupKey = groupKey;
            this.title = title;
            this.url = url;
            this.imageUrl = imageUrl;
            this.imgKey = imgKey;
            this.imgNonce = imgNonce;
            this.imgHash = imgHash;
        }

        boolean hasImage() {
            return imageUrl != null && !imageUrl.isEmpty();
        }

        /** Stable cache key for the resolved (decoded) icon bitmap. */
        String imageCacheKey() {
            return imgHash != null && !imgHash.isEmpty() ? "ci:h:" + imgHash : "ci:u:" + imageUrl;
        }
    }

    /** The arguments of an {@link #enqueueRoomMessage} call held by {@link AlertPolicy}. */
    private static final class HeldMessage {
        final CommunityRef community;
        final String roomKey, roomTitle, url, senderPubkey, senderName, senderPicture, text;
        final long timestampMs;
        final boolean mention;

        HeldMessage(CommunityRef community, String roomKey, String roomTitle, String url,
                    String senderPubkey, String senderName, String senderPicture,
                    String text, long timestampMs, boolean mention) {
            this.community = community;
            this.roomKey = roomKey;
            this.roomTitle = roomTitle;
            this.url = url;
            this.senderPubkey = senderPubkey;
            this.senderName = senderName;
            this.senderPicture = senderPicture;
            this.text = text;
            this.timestampMs = timestampMs;
            this.mention = mention;
        }
    }

    /**
     * One message line held in a room's notification. Raw data, not a built
     * MessagingStyle.Message: a sender avatar resolves late (network fetch),
     * so the line is matched by identity (sender + timestamp + text) and its
     * Message rebuilt at notify time (see {@link #buildRoomNotification}).
     */
    private static final class MsgEntry {
        final String senderKey;      // author pubkey (or a fallback key)
        final String senderName;
        Bitmap avatar;               // sender avatar; resolves late (may stay null)
        String text;                 // mutable: a failed reply rewrites its line in place
        final long tsMs;
        // True for a line the user sent from the Reply action — rendered as an
        // outgoing message (the MessagingStyle self person, no sender bubble).
        final boolean fromSelf;

        MsgEntry(String senderKey, String senderName, Bitmap avatar, String text, long tsMs,
                 boolean fromSelf) {
            this.senderKey = senderKey;
            this.senderName = senderName;
            this.avatar = avatar;
            this.text = text;
            this.tsMs = tsMs;
            this.fromSelf = fromSelf;
        }
    }

    /**
     * One conversation's accumulating notification: a single channel (NIP-29
     * group / Concord channel) or a single DM peer. Holds the room's display
     * title + deep-link, a bounded history of recent messages (for the
     * MessagingStyle expansion), and the stable notification id derived from
     * the roomKey. New messages append here and re-post the SAME id so a busy
     * room shows as a single, growing thread — not a flat stack of per-event
     * notifs.
     */
    private static final class RoomNotif {
        final String roomKey;
        final int notifId;
        String title;                // conversation/room name shown as the notif title
        String url;                  // deep-link of the LATEST message (tap target)
        // The community this room belongs to — its image/name brand the
        // notification. Null for DMs, which also makes it the room's
        // group-vs-1:1 discriminator (null ⇒ 1:1).
        CommunityRef community;
        final List<MsgEntry> messages = new ArrayList<>();
        long lastTimestampMs;
        // Most recent sender avatar seen for this room, used as the collapsed
        // notification's large icon (MessagingStyle Person icons only render in
        // the expanded view on many devices — the large icon is the fallback).
        Bitmap lastAvatar;

        RoomNotif(String roomKey, int notifId) {
            this.roomKey = roomKey;
            this.notifId = notifId;
        }
    }

    // Live instance so the plugin can route a signed AUTH event back to us.
    private static volatile NotificationRelayService instance;
    private static volatile long processLastErrorAtMs;
    private static volatile String processLastError;

    /**
     * Per DM relay, since when (wall ms) the NIP-17 inbox subscription has been
     * continuously live: every wrap published there since then was received,
     * stored and queued for the WebView's drain, whether or not it could be
     * opened here. A relay whose socket or subscription is down is absent.
     * Lets the WebView skip re-reading the backdate window from relays the
     * service already watched. Answers on the handler thread.
     */
    static void dmCoverage(java.util.function.Consumer<JSONObject> cb) {
        NotificationRelayService svc = instance;
        if (svc == null) {
            cb.accept(new JSONObject());
            return;
        }
        svc.handler.post(() -> {
            JSONObject out = new JSONObject();
            if (svc.shouldWatchDm()) {
                for (RelayConnection rc : svc.connections) {
                    if (rc.closed || !rc.socketOpen || !rc.dm17Live || rc.dm17ReqAtMs <= 0) continue;
                    if (!svc.dmWatchRelays.contains(rc.relayUrl)) continue;
                    try {
                        out.put(rc.relayUrl, rc.dm17ReqAtMs);
                    } catch (JSONException ignored) {
                        // A relay URL is always a valid key.
                    }
                }
            }
            cb.accept(out);
        });
    }

    /** Build a non-secret diagnostic snapshot for the Capacitor bridge. */
    static JSONObject healthSnapshot(Context context) {
        JSONObject out = new JSONObject();
        SharedPreferences sp = context.getSharedPreferences(
                ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        NotificationRelayService svc = instance;
        boolean configEnabled = sp.getBoolean("enabled", false)
                && sp.getString("userPubkey", null) != null;
        long revision = sp.getLong("rev", 0L);
        try {
            out.put("serviceRunning", svc != null);
            out.put("configEnabled", configEnabled);
            out.put("configRevision", revision);
            if (svc != null) {
                out.put("lastConfigAt", svc.healthLastConfigAtMs);
                out.put("loadedConfigRevision", svc.healthLoadedConfigRevision);
                out.put("relayWatchCount", svc.healthRelayWatchCount);
                out.put("relayQuarantinedCount", svc.healthRelayQuarantinedCount);
                out.put("relayCuratedOutCount", svc.healthRelayCuratedOutCount);
                out.put("groupWatchCount", svc.healthGroupWatchCount);
                out.put("dmPeerWatchCount", svc.healthDmPeerWatchCount);
                out.put("concordStreamWatchCount", svc.healthConcordStreamWatchCount);
                out.put("socketOpenCount", svc.healthSocketOpenCount);
                out.put("socketTotalCount", svc.healthSocketTotalCount);
                out.put("signerStatus", svc.healthSignerStatus);
                out.put("authStatus", svc.healthAuthStatus);
                out.put("lastAuthAt", svc.healthLastAuthAtMs);
                out.put("lastSignAt", svc.healthLastSignAtMs);
                out.put("lastEventAt", svc.healthLastEventAtMs);
                out.put("lastPresentedAt", svc.healthLastPresentedAtMs);
                out.put("lastErrorAt", svc.healthLastErrorAtMs);
                if (svc.healthLastError != null) out.put("lastError", svc.healthLastError);
            } else {
                ConfigCounts counts = persistedConfigCounts(sp);
                out.put("lastConfigAt", revision);
                out.put("loadedConfigRevision", 0L);
                out.put("relayWatchCount", counts.relays);
                out.put("relayQuarantinedCount", 0);
                out.put("relayCuratedOutCount", 0);
                out.put("groupWatchCount", counts.groups);
                out.put("dmPeerWatchCount", counts.dmPeers);
                out.put("concordStreamWatchCount", counts.concordStreams);
                out.put("socketOpenCount", 0);
                out.put("socketTotalCount", 0);
                out.put("signerStatus", sp.contains("signerSealed") ? "unavailable" : "missing");
                out.put("authStatus", "idle");
                out.put("lastAuthAt", 0L);
                out.put("lastSignAt", 0L);
                out.put("lastEventAt", 0L);
                out.put("lastPresentedAt", 0L);
                out.put("lastErrorAt", processLastErrorAtMs);
                if (processLastError != null) out.put("lastError", processLastError);
            }
            if (ServiceProfiler.ON) out.put("profile", profileSnapshot());
        } catch (JSONException ignored) {
            // Every value above is a primitive/string; this is defensive only.
        }
        return out;
    }

    private static final class ConfigCounts {
        int relays;
        int groups;
        int dmPeers;
        int concordStreams;
    }

    /** Counts persisted watches without copying any URLs, pubkeys or keys out. */
    private static ConfigCounts persistedConfigCounts(SharedPreferences sp) {
        ConfigCounts counts = new ConfigCounts();
        Set<String> relays = new HashSet<>();
        relays.addAll(parseStringArray(sp.getString("relayUrls", null)));
        relays.addAll(parseStringArray(sp.getString("dmRelays", null)));
        relays.addAll(parseStringArray(sp.getString("selfRelays", null)));
        counts.dmPeers = parseStringArray(sp.getString("dmKnownPeers", null)).size();
        try {
            if (!sp.contains("groupSubs")) throw new JSONException("legacy config");
            JSONArray groupSubs = new JSONArray(sp.getString("groupSubs", "[]"));
            counts.groups = groupSubs.length();
            for (int i = 0; i < groupSubs.length(); i++) {
                JSONObject sub = groupSubs.optJSONObject(i);
                if (sub != null) relays.add(sub.optString("relay"));
            }
        } catch (JSONException ignored) {
            counts.groups = parseStringArray(sp.getString("groupIds", null)).size();
        }
        try {
            JSONArray concord = new JSONArray(sp.getString("concord2Subs", "[]"));
            for (int i = 0; i < concord.length(); i++) {
                JSONObject sub = concord.optJSONObject(i);
                if (sub == null) continue;
                JSONArray subRelays = sub.optJSONArray("relays");
                if (subRelays != null) {
                    for (int j = 0; j < subRelays.length(); j++) {
                        String relay = subRelays.optString(j);
                        if (!relay.isEmpty()) relays.add(relay);
                    }
                }
                JSONArray streams = sub.optJSONArray("streams");
                if (streams != null) counts.concordStreams += streams.length();
            }
        } catch (JSONException ignored) {}
        relays.remove("");
        counts.relays = relays.size();
        return counts;
    }

    private void recordHealthError(String category) {
        healthLastError = category;
        healthLastErrorAtMs = System.currentTimeMillis();
        processLastError = category;
        processLastErrorAtMs = healthLastErrorAtMs;
    }

    private static void recordProcessHealthError(String category) {
        processLastError = category;
        processLastErrorAtMs = System.currentTimeMillis();
    }

    /** Recompute socket totals on the handler thread after any state change. */
    private void updateSocketHealth() {
        int open = 0;
        int quarantined = 0;
        for (RelayConnection connection : connections) {
            if (connection.socketOpen) open++;
            if (connection.quarantined) quarantined++;
        }
        healthSocketOpenCount = open;
        healthSocketTotalCount = connections.size();
        healthRelayQuarantinedCount = quarantined;
    }

    /** A socket failure with no HTTP handshake response (see the overload). */
    static Outcome classifyFailure(Throwable t) {
        return classifyFailure(t, 0);
    }

    /**
     * Map a socket failure to the fleet policy's outcome. Deliberately
     * conservative: only a host that does not resolve, and a connection that
     * is refused or fails TLS, are permanent. Everything else — timeouts,
     * protocol errors, a mid-session drop — stays TRANSIENT, so an unfamiliar
     * failure is retried on the bounded backoff rather than quarantined.
     *
     * <p>{@code httpCode} is the status of a FAILED WebSocket upgrade — the
     * relay answered the handshake with an HTTP response instead of 101, which
     * okhttp surfaces as {@code onFailure}'s {@code Response} argument — or 0
     * when no HTTP response reached us (a genuine socket-level failure). A
     * relay whose proxy is up in front of a dead backend returns a persistent
     * 5xx; with only the throwable that is a bare {@code ProtocolException},
     * indistinguishable from a transient blip, and gets retried forever. So an
     * upgrade that came back with a status — any 4xx/5xx except the two that
     * mean "retry later", {@code 408 Request Timeout} and {@code 429 Too Many
     * Requests} — is CONNECT_REFUSED: the
     * relay is not serving WebSocket here now. The circuit breaker's
     * three-consecutive-failure gate means a relay merely restarting (a brief
     * 503) still recovers before it is quarantined.
     */
    static Outcome classifyFailure(Throwable t, int httpCode) {
        if (httpCode >= 400 && httpCode != 408 && httpCode != 429) {
            return Outcome.CONNECT_REFUSED;
        }
        int hops = 0;
        for (Throwable c = t; c != null && hops < 8; c = c.getCause(), hops++) {
            if (c instanceof UnknownHostException) return Outcome.DNS_FAILURE;
            if (c instanceof ConnectException
                    || c instanceof SSLHandshakeException
                    || c instanceof SSLPeerUnverifiedException) {
                return Outcome.CONNECT_REFUSED;
            }
        }
        return Outcome.TRANSIENT_DROP;
    }

    /**
     * A finished session delivered nothing and every standing subscription it
     * sent was still closed auth-required at the end — the whole-session
     * definition of {@link Outcome#AUTH_UNSATISFIABLE}. A relay with even one
     * accepted subscription, or one delivered event, is not this, and the
     * policy may never quarantine it on auth grounds.
     */
    static boolean sessionAuthUnsatisfiable(Set<String> standingSubs, Set<String> walledSubs,
                                            boolean deliveredAnything) {
        return !standingSubs.isEmpty() && !deliveredAnything && walledSubs.containsAll(standingSubs);
    }

    /**
     * Whether the fleet would send {@code relayUrl} at least one standing
     * subscription — the fleet-curation gate. Mirrors the gates in
     * {@code RelayConnection.sendReqs} and must be kept in step with them. A
     * relay that fails this is in the general read pool only, and the
     * background fleet holds no socket to it (replies still reach it through
     * publishOneShot).
     */
    static boolean relayDeliverable(String relayUrl,
                                    Map<String, Set<String>> relayToGroupIds,
                                    Set<String> dmRelays, boolean dmWatchable,
                                    Map<String, Set<String>> relayToPks2,
                                    Map<String, Set<String>> gitRepositoriesByRelay,
                                    Set<String> selfRelays, String userPubkey) {
        Set<String> groups = relayToGroupIds.get(relayUrl);
        if (groups != null && !groups.isEmpty()) return true;
        if (dmRelays.contains(relayUrl) && dmWatchable) return true;
        Set<String> pks = relayToPks2.get(relayUrl);
        if (pks != null && !pks.isEmpty()) return true;
        Set<String> repos = gitRepositoriesByRelay.get(relayUrl);
        if (repos != null && !repos.isEmpty()) return true;
        return userPubkey != null && !userPubkey.isEmpty()
                && shouldSyncSelfStateFromRelay(relayUrl, selfRelays);
    }

    /**
     * Called by the plugin once the WebView has signed a NIP-42 challenge.
     * Routes the kind-22242 event to the matching relay connection.
     */
    static void submitAuth(String relayUrl, String eventJson) {
        NotificationRelayService svc = instance;
        if (svc == null) return;
        svc.handler.post(() -> svc.deliverAuth(relayUrl, eventJson));
    }

    /**
     * Record the roomKey(s) the WebView is currently showing (empty = not on a
     * chat screen / app backgrounded). Called from the plugin's
     * {@code setActiveRooms} bridge method. Suppresses redundant notifications
     * for the rooms the user is already looking at.
     */
    static void setActiveRooms(Set<String> roomKeys) {
        Set<String> next = roomKeys != null ? roomKeys : new HashSet<>();
        // Copy into a ConcurrentHashMap-backed set so reads from the WebSocket
        // thread (handleEvent → isActivelyViewed) never race a concurrent
        // write from the Capacitor bridge thread. A plain HashSet can lose
        // visibility of puts across threads even with a volatile reference.
        Set<String> concurrent = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
        concurrent.addAll(next);
        boolean cameForward = freshActiveRoomKeys().isEmpty() && !concurrent.isEmpty();
        activeRoomKeys = concurrent;
        activeRoomsUpdatedAtElapsedMs = android.os.SystemClock.elapsedRealtime();
        if (BuildConfig.DEBUG) Log.d(TAG, "setActiveRooms: " + concurrent);
        // Empty → non-empty is the WebView arriving on a chat screen: the app
        // came forward. That is an edge for the fleet (a signer may be awake
        // now, a quarantined relay is worth one fresh look), fired on the
        // TRANSITION only — re-arming on every room switch would defeat
        // quarantine for as long as the app is open.
        if (cameForward) {
            NotificationRelayService svc = instance;
            if (svc != null) {
                svc.handler.post(() -> {
                    for (RelayConnection rc : svc.connections) rc.onFleetEdge(FleetEdge.APP_FOREGROUNDED);
                });
            }
        }
    }

    /**
     * The peer the WebView is dialing or in a DM call with (see
     * {@code ArmadaNotification.setCallPeer}), or null. Like the active rooms
     * it is in-process only and trusted for a heartbeat window, so a WebView
     * killed mid-call cannot silence that peer's calls for longer than that.
     */
    private static volatile String callPeer;
    private static volatile long callPeerUpdatedAtElapsedMs;
    static final long CALL_PEER_TTL_MS = 60_000L;

    /**
     * An offer another device of OURS placed (its self copy), by peer: that
     * device owns any collision with the same peer, so this one must not ring
     * for the peer's offer — or post a missed call when it is withdrawn.
     * Handler thread only.
     */
    private String siblingDialPeer;
    private String siblingDialCallId;
    private long siblingDialAtMs;

    static void setCallPeer(String peer) {
        callPeer = peer != null && peer.length() == 64 ? peer : null;
        callPeerUpdatedAtElapsedMs = android.os.SystemClock.elapsedRealtime();
        // The WebView owns a call with this peer, so a ring of theirs is over.
        // Locally: the self-copy "answer" that also cancels it is relay-borne.
        NotificationRelayService svc = instance;
        String owned = callPeer;
        if (svc != null && owned != null) svc.handler.post(() -> svc.cancelRingFrom(owned));
    }

    /**
     * The WebView answered, declined or is ringing {@code callId} itself: stop
     * this device's ring for it, silently, and don't post one if the offer
     * reaches the service after the WebView.
     */
    static void dismissCallRing(String callId) {
        NotificationRelayService svc = instance;
        if (svc == null || !validHex(callId)) return;
        svc.handler.post(() -> {
            svc.dismissedRingCallIds.remove(callId);
            svc.dismissedRingCallIds.addLast(callId);
            while (svc.dismissedRingCallIds.size() > DISMISSED_RING_MEMORY) {
                svc.dismissedRingCallIds.removeFirst();
            }
            svc.cancelIncomingCall(callId, /*missed=*/false);
        });
    }

    private void cancelRingFrom(String peer) {
        if (peer.equals(ringingPeer) && ringingCallId != null) {
            cancelIncomingCall(ringingCallId, /*missed=*/false);
        }
    }

    /**
     * Whether an offer (or missed call) from {@code peer} belongs to a call the
     * WebView already owns with them: the reported peer, reported within
     * {@link #CALL_PEER_TTL_MS}. Pure, so it is unit-testable.
     */
    static boolean isOwnCallPeer(String peer, String reportedPeer, long updatedAtMs, long nowMs) {
        return peer != null && peer.equals(reportedPeer)
                && updatedAtMs > 0L && nowMs >= updatedAtMs
                && nowMs - updatedAtMs <= CALL_PEER_TTL_MS;
    }

    /** Whether a sibling device's offer to {@code peer}, placed at {@code dialAtMs}, still owns it. */
    static boolean isSiblingDialFresh(String peer, String dialPeer, long dialAtMs, long nowMs) {
        return peer != null && peer.equals(dialPeer)
                && Math.abs(nowMs - dialAtMs) <= CALL_RING_WINDOW_MS;
    }

    /** Whether this device should stay silent about {@code peer}'s call (see above). */
    private boolean callOwnedElsewhere(String peer) {
        return isOwnCallPeer(peer, callPeer, callPeerUpdatedAtElapsedMs,
                        android.os.SystemClock.elapsedRealtime())
                || isSiblingDialFresh(peer, siblingDialPeer, siblingDialAtMs,
                        System.currentTimeMillis());
    }

    static boolean isActiveRoomStateFresh(long updatedAtMs, long nowMs) {
        return updatedAtMs > 0L && nowMs >= updatedAtMs
                && nowMs - updatedAtMs <= ACTIVE_ROOMS_TTL_MS;
    }

    private static Set<String> freshActiveRoomKeys() {
        return isActiveRoomStateFresh(
                activeRoomsUpdatedAtElapsedMs,
                android.os.SystemClock.elapsedRealtime())
                ? activeRoomKeys
                : java.util.Collections.emptySet();
    }

    /**
     * Cancel the tray notifications for conversations the WebView reports as
     * read (the in-app read state advanced — the user read them here, or it
     * synced from another device). Called from the plugin's {@code dismissRead}
     * bridge method. The reverse of a "Mark read" action tap: read state → tray,
     * instead of a tray tap → read state.
     *
     * @param readByKey WebView read-state key → last-read unix seconds
     *                  ({@code dm:<pk>}, {@code c2:<id>},
     *                  {@code <relayUrl>::<groupId>}).
     */
    static void dismissRead(java.util.Map<String, Long> readByKey) {
        NotificationRelayService svc = instance;
        if (svc == null || readByKey == null || readByKey.isEmpty()) return;
        // roomNotifs is confined to the handler thread (onRelayMessage
        // posts there), so mutate it there too — never from the bridge thread.
        svc.handler.post(() -> svc.applyDismissRead(readByKey));
    }

    /**
     * Cancel each posted room whose newest notified message is at/older than
     * the read timestamp the WebView reports for that conversation, and drop its
     * accumulated history so a later message starts fresh rather than
     * resurrecting read lines. A room with a newer unread message is left up.
     */
    private void applyDismissRead(java.util.Map<String, Long> readByKey) {
        for (Map.Entry<String, Long> e : readByKey.entrySet()) {
            Long prev = lastReadByKey.get(e.getKey());
            if (prev == null || e.getValue() > prev) lastReadByKey.put(e.getKey(), e.getValue());
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        java.util.Iterator<Map.Entry<String, RoomNotif>> it = roomNotifs.entrySet().iterator();
        while (it.hasNext()) {
            RoomNotif r = it.next().getValue();
            String readKey = readKeyForRoom(r.roomKey);
            if (readKey == null) continue;
            Long readTsSec = readByKey.get(readKey);
            if (readTsSec == null) continue;
            if (readTsSec * 1000L >= r.lastTimestampMs) {
                manager.cancel(r.notifId);
                it.remove();
                if (BuildConfig.DEBUG) Log.d(TAG, "DISMISS (read): " + r.roomKey);
            }
        }
    }

    /**
     * The WebView read-state key for a notification room, or null when the room
     * can't be attributed to a conversation (an opaque NIP-17 wrap the service
     * couldn't unwrap). Inverse of {@code NativeReadMarkerSync}'s mapping:
     *   {@code dm:<pk>}            → {@code dm:<pk>}            (unchanged)
     *   {@code c2:<channelId>}     → {@code c2:<channelId>}    (unchanged)
     *   {@code h:<relayUrl>|<gid>} → {@code <relayUrl>::<gid>}
     */
    private String readKeyForRoom(String roomKey) {
        if (roomKey == null) return null;
        if (roomKey.startsWith("dm:") || roomKey.startsWith("c2:")) return roomKey;
        if (roomKey.startsWith("h:")) {
            String rest = roomKey.substring(2);
            int i = rest.lastIndexOf('|');
            return i > 0 ? rest.substring(0, i) + "::" + rest.substring(i + 1) : null;
        }
        return null;
    }

    /**
     * Whether {@code event} is one of the user's read-state settings documents:
     * the full map or the small recent-entries delta a read publishes. Both
     * carry {@code readState} and dismiss the same way, since the WebView merges
     * them max-per-key. Matched by the {@code d}-tag suffix rather than a
     * compiled-in constant: the tag is structurally {@code ${APP_ID}/read-state},
     * so a fork that renames {@code APP_ID} is covered without threading
     * another config value through the plugin. Caller has already checked the
     * kind is 30078.
     */
    static boolean isReadStateDoc(JSONObject event) {
        String d = tagValue(event, "d");
        return d != null && (d.endsWith("/read-state") || d.endsWith("/read-state-recent"));
    }

    /**
     * Decrypt the self-encrypted read-state blob (NIP-44 to the user's own key)
     * and dismiss every conversation whose newest notified message is now at or
     * older than the last-read stamp it carries — the reverse of a tray tap,
     * driven by read state that advanced elsewhere and synced in over the
     * standing kind-30078 subscription.
     *
     * <p>Best-effort on every axis: no signer, an unopenable payload, or a
     * malformed document just leaves the tray as it is (the WebView still
     * dismisses on next resume). The decrypted map's keys are already the
     * {@code dm:<pk>} / {@code c2:<id>} / {@code <relayUrl>::<gid>} shape
     * {@link #applyDismissRead} consumes; {@code c2m:}/{@code c2t:} sub-keys
     * match no posted room and fall through harmlessly.
     */
    private void applyReadStateDismiss(JSONObject event) {
        NativeSigner signer = nativeSigner;
        if (signer == null || userPubkey == null) return;
        signer.decrypt44(userPubkey, event.optString("content"), (plain, unavailable) ->
                applyReadStateDismiss(plain));
    }

    /**
     * The same for a decrypted read-state plaintext. A document under a derived
     * key is opened with the conversation key the WebView configured, so it needs
     * no signer at all.
     */
    private void applyReadStateDismiss(String plain) {
        if (plain == null) return;
        try {
            JSONObject readState = new JSONObject(plain).optJSONObject("readState");
            if (readState == null) return;
            java.util.HashMap<String, Long> map = new java.util.HashMap<>();
            for (java.util.Iterator<String> it = readState.keys(); it.hasNext(); ) {
                String key = it.next();
                long ts = readState.optLong(key, 0);
                if (ts > 0) map.put(key, ts);
            }
            // Hops to the handler thread, where roomNotifs is confined.
            dismissRead(map);
        } catch (JSONException e) {
            if (BuildConfig.DEBUG) Log.d(TAG, "read-state parse failed: " + e.getMessage());
        }
    }

    private void deliverAuth(String relayUrl, String eventJson) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.sendAuth(eventJson);
                return;
            }
        }
    }

    // ── Lifecycle helpers (boot, watchdog, Application eager start) ────────────

    /** True when background notifications are enabled and a user is logged in. */
    static boolean isConfigured(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(
                ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        return sp.getBoolean("enabled", false) && sp.getString("userPubkey", null) != null;
    }

    static void startIfConfigured(Context ctx) {
        startIfConfigured(ctx, true);
    }

    /** Clear tray state that belongs to the outgoing account on disable/logout. */
    static void clearAccountNotifications(Context ctx) {
        NotificationManager manager =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            try {
                // cancelAll() also removes Armada's unrelated voice-call and
                // Bluetooth-mesh foreground-service rows. Target only message
                // conversations/summaries (all carry our group prefix) and the
                // account-scoped incoming-call ring.
                for (android.service.notification.StatusBarNotification sbn
                        : activeNotifications(manager)) {
                    String group = sbn.getNotification().getGroup();
                    if (isAccountNotification(sbn.getId(), group)) {
                        manager.cancel(sbn.getTag(), sbn.getId());
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not clear account notifications", e);
            }
        }
        NotificationRelayService svc = instance;
        if (svc != null) {
            svc.handler.post(() -> svc.roomNotifs.clear());
        }
    }

    /** Pure classification used by logout cleanup and JVM tests. */
    static boolean isAccountNotification(int id, String group) {
        return id == INCOMING_CALL_NOTIF_ID
                || (group != null && group.startsWith(GROUP_PREFIX));
    }

    private static boolean isRoomNotification(String group) {
        return group != null && group.startsWith(GROUP_PREFIX + "room:");
    }

    /**
     * Start the service iff it's configured and not already running.
     *
     * The running check matters: every caller here (boot, retry alarm,
     * watchdog, ArmadaApplication) only wants "ensure the service is up".
     * Delivering a redundant start to a live service would run
     * onStartCommand → loadConfigAndReconnect, which tears down and rebuilds
     * every relay socket — so a 15-min watchdog would churn healthy
     * connections (re-handshake, re-AUTH, rebuild the signer) and open a
     * recurring miss window for the live-only NIP-17 DM subscription. All
     * parties touch {@code instance} on the main thread, so the check is
     * race-free.
     *
     * specialUse can be started from boot, but a background FGS start can
     * still be refused in some states (throwing
     * ForegroundServiceStartNotAllowedException). When {@code allowRetry} is
     * set we schedule a short one-shot retry alarm, which succeeds once the
     * app is exempt from battery optimizations; the retry/watchdog alarms
     * pass {@code false} so they don't stack retries.
     */
    static void startIfConfigured(Context ctx, boolean allowRetry) {
        if (instance != null) return;
        if (!isConfigured(ctx)) return;
        Intent i = new Intent(ctx, NotificationRelayService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    // startService() creates no startForeground() deadline but
                    // is refused (IllegalStateException) from a background
                    // state on API 26+. Prefer it so a foreground start — an
                    // app launch, where the service's onCreate queues behind
                    // the Activity/WebView cold start — can never miss the
                    // 10-second deadline; only the background paths (boot,
                    // alarms), whose near-empty queue meets it comfortably,
                    // fall back to startForegroundService().
                    ctx.startService(i);
                } catch (IllegalStateException notForeground) {
                    ctx.startForegroundService(i);
                }
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            if (allowRetry && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && e instanceof ForegroundServiceStartNotAllowedException) {
                BootReceiver.scheduleRetry(ctx);
            } else {
                Log.w(TAG, "startIfConfigured failed", e);
            }
            recordProcessHealthError("service_start");
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannels(this);
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    : 0;
            ServiceCompat.startForeground(this, FOREGROUND_ID, buildForegroundNotification(), type);
        } catch (Exception e) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && e instanceof ForegroundServiceStartNotAllowedException) {
                Log.w(TAG, "Foreground start not allowed, stopping.");
                recordProcessHealthError("foreground_start");
                stopSelf();
                return;
            }
            // A bad/blocked OEM channel or malformed foreground notification
            // must not become a process-crash loop reproduced from persisted
            // config on every watchdog/boot restart. Surface a stable category
            // through health and stop cleanly; Settings can deep-link the user
            // to the service channel.
            Log.w(TAG, "Foreground notification post failed, stopping.", e);
            recordProcessHealthError("post_service");
            stopSelf();
            return;
        }

        httpClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                // No per-socket pings: each runs its own timer, waking the radio
                // once per relay per interval. The fleet keeps sockets alive on
                // one shared clock instead (keepaliveTick).
                .pingInterval(0, TimeUnit.SECONDS)
                .build();

        // Avatar/image fetches: bounded timeouts (so a slow host can't stall the
        // silent re-post forever) + a disk HTTP cache. Derived from httpClient so
        // it reuses the same dispatcher/connection pool, but its callTimeout must
        // NOT leak onto the WebSocket client above.
        avatarDir = new File(getCacheDir(), "avatars");
        avatarClient = httpClient.newBuilder()
                .readTimeout(15, TimeUnit.SECONDS)
                .callTimeout(30, TimeUnit.SECONDS)
                .pingInterval(0, TimeUnit.SECONDS) // no pings on one-shot image GETs
                .cache(new Cache(new File(getCacheDir(), "avatar-http"), AVATAR_HTTP_CACHE_BYTES))
                .build();

        // Both registrations only arm listeners that post, so they stay here
        // and are live before onStartCommand can run. The rest is confined
        // state (profileStore) or a getActiveNotifications() round trip, and
        // goes to the handler thread — where it is also ordered ahead of the
        // config load onStartCommand posts next.
        registerNetworkCallback();
        registerConfigListener();
        handler.post(() -> {
            profileStore = ProfileStore.deserialize(
                    getSharedPreferences(PROFILES_PREFS, Context.MODE_PRIVATE)
                            .getString(PROFILES_KEY, null));
            cancelStaleSummaries();
            reconcileActiveRoomNotifications();
        });
        handler.postDelayed(keepaliveTick, Keepalive.TICK_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Re-arm the self-healing watchdog on every start so it survives a
        // START_STICKY relaunch. It's cancelled when the user turns
        // notifications off (loadConfigAndReconnect's disabled branch). An
        // AlarmManager call is thread-free and cheap, so it stays here rather
        // than riding the queue behind whatever the handler thread is doing.
        BootReceiver.scheduleWatchdog(this);
        final String action = intent != null ? intent.getAction() : null;
        // Everything below reads or rebuilds the confined state, so it runs on
        // the handler thread. The intent is ours once delivered — nothing
        // recycles it — so it's safe to carry across the hop.
        handler.post(() -> {
            // A "Mark read" action tap arrives as a start intent. Handle it WITHOUT
            // running loadConfigAndReconnect (which tears down + rebuilds every relay
            // socket) so acknowledging a notification doesn't churn live connections.
            if (ACTION_MARK_READ.equals(action)) {
                // Cold-started just for this action (process was dead): load the
                // config first so the relay subscriptions come up AND the z→channel
                // map the read-marker needs is populated before handleMarkRead reads it.
                if (connections.isEmpty()) loadConfigAndReconnect();
                handleMarkRead(intent);
                return;
            }
            // A "Reply" action tap arrives the same way, and likewise must not
            // rebuild the relay sockets — the publish rides the live ones (or the
            // per-connection outbox, when cold-started and still connecting).
            if (ACTION_REPLY.equals(action)) {
                if (connections.isEmpty()) loadConfigAndReconnect();
                handleReply(intent);
                return;
            }
            // The incoming-call notification's "Decline" — dismiss the ring and
            // send the peer a gift-wrapped decline over the same live sockets.
            if (ACTION_DECLINE_CALL.equals(action)) {
                if (connections.isEmpty()) loadConfigAndReconnect();
                handleDeclineCall(intent);
                return;
            }
            loadConfigAndReconnect();
        });
        return START_STICKY;
    }

    /**
     * Defensive: the service runs as a specialUse foreground service, which is
     * NOT subject to Android 15's dataSync/mediaProcessing runtime cap, so this
     * shouldn't fire. It's kept as a safety net in case the type ever changes:
     * onTimeout requires stopping within seconds (or the app is killed for
     * "foreground service did not stop"), after which the watchdog alarm / the
     * next app launch (ArmadaApplication) brings the service back.
     */
    @Override
    public void onTimeout(int startId) {
        handleTimeout();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        handleTimeout();
    }

    private void handleTimeout() {
        Log.w(TAG, "Foreground service timed out; stopping, watchdog will retry.");
        BootReceiver.scheduleWatchdog(this);
        stopSelf();
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        // Both caches re-fill from avatarDir, so dropping them costs a disk
        // decode, never a refetch. RUNNING_LOW and every background level.
        if (level >= TRIM_MEMORY_RUNNING_LOW) {
            avatarCache.evictAll();
            groupImageCache.evictAll();
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        // `instance` is read by startIfConfigured on the main thread, so it is
        // cleared here rather than on the handler thread — a teardown queued
        // behind a burst must not leave a dying service answering "running".
        if (instance == this) instance = null;
        unregisterNetworkCallback();
        unregisterConfigListener();
        // Drop queued work first (from here, so the queue is cut immediately
        // rather than after the burst it may be holding), then post the
        // teardown itself: it touches the confined state, so it belongs on the
        // handler thread like every other reader of it. quitSafely lets that
        // one message run and stops the looper after it.
        handler.removeCallbacksAndMessages(null);
        handler.post(() -> {
            NativeSigner signer = nativeSigner;
            nativeSigner = null;
            if (signer != null) signer.close();
            closeAllConnections();
            // Flush any debounced profile writes so the next service instance
            // starts with the warm cache (apply() is async but safe here).
            if (profilePersistScheduled) {
                profilePersistScheduled = false;
                persistProfiles();
            }
            if (avatarClient != null && avatarClient.cache() != null) {
                try {
                    avatarClient.cache().close(); // flush the HTTP disk cache
                } catch (Exception ignored) {
                    // Best-effort flush; the process is going away regardless.
                }
            }
            if (httpClient != null) {
                // avatarClient shares this dispatcher (derived via newBuilder), so
                // one shutdown drains both clients' worker threads.
                httpClient.dispatcher().executorService().shutdownNow();
            }
        });
        handlerThread.quitSafely();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── Config ────────────────────────────────────────────────────────────────

    private void loadConfigAndReconnect() {
        if (ServiceProfiler.ON) ServiceProfiler.count("config.reload");
        // Each relay's Concord stream keys BEFORE this reload: a live session
        // AUTHed exactly those, so a relay whose set changed needs a fresh
        // session (and challenge) rather than a re-sent REQ it would wall.
        Map<String, Set<String>> previousStreams = new HashMap<>();
        for (Map.Entry<String, Set<String>> e : relayToPks2.entrySet()) {
            previousStreams.put(e.getKey(), new HashSet<>(e.getValue()));
        }
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        healthLastConfigAtMs = System.currentTimeMillis();
        healthLoadedConfigRevision = sp.getLong("rev", 0L);
        if (!sp.getBoolean("enabled", false)) {
            Log.d(TAG, "Disabled in config; stopping.");
            BootReceiver.cancelWatchdog(this);
            stopSelf();
            return;
        }
        String nextUserPubkey = sp.getString("userPubkey", null);
        boolean accountChanged = userPubkey == null ? nextUserPubkey != null : !userPubkey.equals(nextUserPubkey);
        if (accountChanged) {
            // Cursor continuity is account-scoped just like the config itself.
            // A hot account replacement must not inherit the outgoing user's
            // relay position (or any other native last-good state).
            cursors.clear();
            concordRefusedRelays.clear();
            selfFloodByUrl.clear();
            selfSeenIds.clear();
            selfNewestByCoordinate.clear();
            selfTopicWindow.clear();
            handler.removeCallbacks(flushSelfTopicDocsRunnable);
            selfTopicFlushPosted = false;
            // Decoded images of the outgoing account's contacts and communities.
            avatarCache.evictAll();
            groupImageCache.evictAll();
            heldMessages.clear();
            lastReadByKey.clear();
        }
        userPubkey = nextUserPubkey;
        relayUrls.clear();
        relayUrls.addAll(parseStringArray(sp.getString("relayUrls", null)));
        groupIds.clear();
        groupIds.addAll(parseStringArray(sp.getString("groupIds", null)));
        parseGroupSubs(sp.getString("groupSubs", null),
                parseStringArray(sp.getString("mentionOnlyGroupIds", null)));
        dmRelays.clear();
        dmRelays.addAll(parseStringArray(sp.getString("dmRelays", null)));
        dmFollows.clear();
        dmFollows.addAll(parseStringArray(sp.getString("dmFollows", null)));
        dmKnownPeers.clear();
        dmKnownPeers.addAll(parseStringArray(sp.getString("dmKnownPeers", null)));
        dmKnownConversations.clear();
        dmKnownConversations.addAll(parseStringArray(sp.getString("dmKnownConversations", null)));
        parseDmLevels(sp.getString("dmLevels", null));
        dmMutedPeers.clear();
        dmMutedPeers.addAll(parseStringArray(sp.getString("dmMutedPeers", null)));
        dmRequests = sp.getString("dmRequests", "generic");
        mediaPolicy = MediaPolicy.parse(sp.getString("mediaPolicy", null));
        selfRelays.clear();
        selfRelays.addAll(parseStringArray(sp.getString("selfRelays", null)));
        List<String> configuredDTags = parseStringArray(sp.getString("selfDTags", null));
        selfDTags = configuredDTags.isEmpty()
                ? SelfState.DEFAULT_D_TAGS
                : new LinkedHashSet<>(configuredDTags);
        parseSelfDocs(sp.getString("selfDocs", null));
        try {
            String p = sp.getString("prefs", null);
            prefs = p != null ? new JSONObject(p) : new JSONObject();
        } catch (JSONException e) {
            prefs = new JSONObject();
        }
        parseConcordSubs(sp.getString("concord2Subs", null));
        parseGitSubs(sp.getString("gitSubs", null));

        // The user's shared signer credential (Keystore-sealed by the plugin):
        // lets the service open ANY gift wrap addressed to the user and answer
        // NIP-42 AUTH itself — see NativeSigner. Absent/undecryptable ⇒ null,
        // and DM wraps degrade to the generic notification.
        String sealedSigner = sp.getString("signerSealed", null);
        // Rebuilt only when the sealed credential changed (or the last attempt
        // came up empty, e.g. the Keystore wasn't ready): a rebuild re-unseals
        // from the Keystore and, for NIP-46, redials the bunker's sockets.
        boolean signerChanged = accountChanged
                || !java.util.Objects.equals(sealedSigner, loadedSealedSigner)
                || (sealedSigner != null && nativeSigner == null);
        if (signerChanged) {
            loadedSealedSigner = sealedSigner;
            NativeSigner oldSigner = nativeSigner;
            nativeSigner = null;
            if (oldSigner != null) oldSigner.close();
            if (sealedSigner != null) {
                String signerJson = SealedStore.open(sealedSigner);
                if (signerJson != null) {
                    try {
                        nativeSigner = NativeSigner.from(this, httpClient, userPubkey, new JSONObject(signerJson));
                    } catch (JSONException e) {
                        Log.w(TAG, "signer config unreadable");
                        recordHealthError("signer_config");
                    }
                }
                if (nativeSigner == null) {
                    Log.w(TAG, "shared signer credential unavailable");
                    recordHealthError("signer_unavailable");
                }
            }
        } else if (ServiceProfiler.ON) {
            ServiceProfiler.count("config.reload signer kept");
        }
        healthSignerStatus = nativeSigner != null
                ? "ready" : (sealedSigner != null ? "unavailable" : "missing");

        coverSelfRelays();
        coverDmRelays();
        coverConcordRelays();
        pruneGitRelays();

        // The relays to connect to: NIP-29 group relays ∪ DM relays ∪ Concord
        // relays ∪ the general relays carrying the user's own documents.
        Set<String> allRelays = new LinkedHashSet<>(relayUrls);
        allRelays.addAll(relayToGroupIds.keySet());
        allRelays.addAll(dmWatchRelays);
        allRelays.addAll(selfWatchRelays);
        allRelays.addAll(relayToPks2.keySet());
        allRelays.addAll(gitRepositoriesByRelay.keySet());

        healthRelayWatchCount = allRelays.size();
        healthGroupWatchCount = 0;
        for (Set<String> ids : relayToGroupIds.values()) healthGroupWatchCount += ids.size();
        healthDmPeerWatchCount = dmKnownPeers.size();
        healthConcordStreamWatchCount = pkToStream2.size();

        if (userPubkey == null || allRelays.isEmpty()) {
            Log.d(TAG, "No pubkey/relays; not connecting.");
            closeAllConnections();
            updateSocketHealth();
            return;
        }

        // Reconcile the connections with the new config. A changed account or
        // signer rebuilds everything (AUTH state is bound to both). Otherwise a
        // relay that is still wanted and CONNECTED keeps its socket and only
        // re-sends the subscriptions whose filters changed (reconfigure); one
        // that is wanted but not connected is replaced by a fresh connection —
        // with fresh fleet-policy state, so a config change still re-arms
        // anything the policy had quarantined. The app sends several configures
        // per launch, and a teardown costs a TLS handshake, a NIP-42 round and a
        // full re-subscription per relay.
        Map<String, RelayConnection> keep = new HashMap<>();
        // Connections waiting out a retry delay. A fresh connection would dial
        // at once, redialing a relay that is simply DOWN on every configure.
        // They keep their wait (and pick the new config up when it ends); a
        // quarantined one is still rebuilt, which is how a config change
        // re-arms it.
        Map<String, RelayConnection> waiting = new HashMap<>();
        if (accountChanged || signerChanged) {
            if (ServiceProfiler.ON) ServiceProfiler.count(accountChanged ? "config.reload full (account)" : "config.reload full (signer)");
            closeAllConnections();
        } else {
            for (RelayConnection rc : connections) {
                if (rc.ws != null && rc.socketOpen && !rc.closed) keep.put(rc.relayUrl, rc);
                else if (rc.ws == null && !rc.closed && !rc.quarantined
                        && rc.retryPending) waiting.put(rc.relayUrl, rc);
                else rc.close();
            }
            connections.clear();
        }
        int curatedOut = 0;
        boolean dmWatchable = !dmFollows.isEmpty() || shouldWatchDm();
        for (String url : allRelays) {
            // A malformed config entry (blank, "null", schemeless) must never
            // reach okhttp: url() throws and an uncaught throw here kills the
            // service process, which the persisted config then reproduces on
            // every restart.
            if (!isValidRelayUrl(url)) {
                Log.w(TAG, "Skipping invalid relay url in config");
                continue;
            }
            // Fleet curation: a relay with no standing subscription to send —
            // in the general read pool and nothing else — would be a 24/7
            // socket that can never deliver a notification. It gets no
            // connection at all (rather than an idle one the policy refuses),
            // so it never appears in health totals or catches a queued reply.
            if (!relayDeliverable(url, relayToGroupIds, dmWatchRelays, dmWatchable,
                    relayToPks2, gitRepositoriesByRelay, selfWatchRelays, userPubkey)) {
                curatedOut++;
                continue;
            }
            RelayConnection kept = keep.remove(url);
            if (kept != null && !java.util.Objects.equals(previousStreams.get(url), relayToPks2.get(url))) {
                if (ServiceProfiler.ON) ServiceProfiler.count("config.reload socket renewed (stream keys)");
                kept.close();
                kept = null;
            }
            if (kept != null) {
                connections.add(kept);
                if (ServiceProfiler.ON) ServiceProfiler.count("config.reload socket kept");
                kept.reconfigure();
                continue;
            }
            RelayConnection backingOff = waiting.remove(url);
            if (backingOff != null) {
                connections.add(backingOff);
                if (ServiceProfiler.ON) ServiceProfiler.count("config.reload retry wait kept");
                continue;
            }
            RelayConnection rc = new RelayConnection(url, true);
            connections.add(rc);
            rc.connect();
        }
        // Relays the new config no longer wants.
        for (RelayConnection gone : keep.values()) gone.close();
        for (RelayConnection gone : waiting.values()) gone.close();
        healthRelayCuratedOutCount = curatedOut;
        updateSocketHealth();

        // Warm the user's own profile for the quick-reply self person, now
        // that a relay fetch has somewhere to go if the store misses.
        warmSelfProfile();
    }

    /** Parse exact canonical DM conversation levels; malformed entries fail closed. */
    private void parseDmLevels(String raw) {
        dmLevels.clear();
        if (raw == null) return;
        try {
            JSONObject levels = new JSONObject(raw);
            java.util.Iterator<String> keys = levels.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String level = levels.optString(key, "");
                if (!isDmConvKey(key)) continue;
                if ("all".equals(level) || "mentions".equals(level) || "nothing".equals(level)) {
                    dmLevels.put(key, level);
                }
            }
        } catch (JSONException e) {
            recordHealthError("dm_levels_config");
        }
    }

    /**
     * Build a {@link CommunityRef} from a subscription's community fields. The
     * optional {@code communityImage} object is the conversation's avatar: either
     * a plain https URL ({@code {url}} only) or an encrypted-blob pointer
     * ({@code {url,key,nonce,hash}} hex) the service fetches and AES-GCM
     * decrypts itself. Key/nonce present but malformed ⇒ treated as no image.
     */
    private static CommunityRef communityRefFromSub(
            JSONObject sub, String groupKey, String title, String url) {
        String imageUrl = null;
        byte[] imgKey = null;
        byte[] imgNonce = null;
        String imgHash = null;
        JSONObject img = sub.optJSONObject("communityImage");
        if (img != null) {
            String u = img.optString("url", "");
            if (!u.isEmpty()) {
                imageUrl = u;
                byte[] k = ConcordCrypto.hexToBytes(img.optString("key", null));
                byte[] n = ConcordCrypto.hexToBytes(img.optString("nonce", null));
                // An encrypted pointer needs BOTH key and nonce; a plain URL has
                // neither. A half-present pair is unusable — fall back to plain.
                if (k != null && n != null) {
                    imgKey = k;
                    imgNonce = n;
                }
                String h = img.optString("hash", "");
                imgHash = h.isEmpty() ? null : h;
            }
        }
        return new CommunityRef(groupKey, title, url, imageUrl, imgKey, imgNonce, imgHash);
    }

    /**
     * Parse the NIP-29 group subscriptions JSON ([{relay,id}, …]) into
     * {@link #relayToGroupIds}: each joined group mapped to its single host
     * relay, so the kind-9/7/1111 REQ on a relay carries only the groups that
     * relay actually hosts. Falls back — when the config carries no
     * {@code groupSubs} (written by an older build) — to the legacy flat model:
     * every {@code groupId} on every {@code relayUrl}.
     *
     * <p>Also fills {@link #mentionOnlyGroupKeys} from each sub's
     * {@code mentionOnly} flag. {@code flatMentionOnly} is the older flat
     * {@code mentionOnlyGroupIds} list and is used ONLY on the legacy fallback
     * path, where every id is already paired with every relay anyway.
     */
    private void parseGroupSubs(String json, List<String> flatMentionOnly) {
        relayToGroupIds.clear();
        mentionOnlyGroupKeys.clear();
        if (json != null) {
            try {
                JSONArray arr = new JSONArray(json);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject sub = arr.optJSONObject(i);
                    if (sub == null) continue;
                    String relay = sub.optString("relay", "");
                    String id = sub.optString("id", "");
                    if (!isValidRelayUrl(relay) || id.isEmpty()) continue;
                    Set<String> set = relayToGroupIds.get(relay);
                    if (set == null) {
                        set = new LinkedHashSet<>();
                        relayToGroupIds.put(relay, set);
                    }
                    set.add(id);
                    if (sub.optBoolean("mentionOnly", false)) {
                        mentionOnlyGroupKeys.add(groupKey(relay, id));
                    }
                }
                return;
            } catch (JSONException e) {
                Log.w(TAG, "Failed to parse groupSubs", e);
                relayToGroupIds.clear();
                mentionOnlyGroupKeys.clear();
            }
        }
        // Legacy fallback: no per-relay mapping shipped — subscribe every
        // joined group on every group relay (imprecise, but keeps an older
        // config working until the WebView reconfigures with groupSubs).
        if (groupIds.isEmpty()) return;
        for (String relay : relayUrls) {
            relayToGroupIds.put(relay, new LinkedHashSet<>(groupIds));
            for (String id : flatMentionOnly) {
                if (groupIds.contains(id)) mentionOnlyGroupKeys.add(groupKey(relay, id));
            }
        }
    }

    private static String groupKey(String relayUrl, String groupId) {
        return relayUrl + "\u0000" + groupId;
    }

    /**
     * Is this NIP-29 group set to "mentions only"? A group we can't identify
     * (no `h` tag) is not — the per-kind prefs still decide.
     */
    private boolean isMentionOnlyGroup(String relayUrl, String groupId) {
        if (relayUrl == null || groupId == null) return false;
        return mentionOnlyGroupKeys.contains(groupKey(relayUrl, groupId));
    }

    /**
     * Parse the Concord subscriptions JSON
     * ([{relays:[],communityId,communityName,channelId,channelName,
     *    streams:[{pk,convKey,epoch}]}, …])
     * into the lookup maps: stream-pubkey→decrypt-material and relay→{pk…}.
     * V2 traffic is kind-1059 wraps AUTHORED BY the derived stream keys (no
     * routing tag); the per-stream conversation key opens wrap → seal → rumor
     * for a rich "<sender>: <preview>" body.
     */
    private void parseConcordSubs(String json) {
        pkToStream2.clear();
        relayToPks2.clear();
        concordPublishRelays.clear();
        communityRelays.clear();
        communityPks.clear();
        if (json == null) return;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject sub = arr.optJSONObject(i);
                if (sub == null) continue;
                String community = sub.optString("communityName", str(R.string.notif_community));
                String channel = sub.optString("channelName", str(R.string.notif_channel));
                String communityId = sub.optString("communityId", "");
                String channelId = sub.optString("channelId", "");
                if (communityId.isEmpty() || channelId.isEmpty()) continue;
                boolean mentionOnly = sub.optBoolean("mentionOnly", false);
                String name = str(R.string.notif_room_title, community, channel);
                String url = "/c/" + uriEncode(communityId) + "/" + uriEncode(channelId);
                JSONArray streams = sub.optJSONArray("streams");
                JSONArray relays = sub.optJSONArray("relays");
                if (streams == null || relays == null) continue;

                // The community's banned authors (CORD-04) — every channel's
                // sub carries the same set. A banned member's rumor is stored
                // like any other (the timeline folds it away on read) but never
                // notifies.
                Set<String> banned = new HashSet<>();
                JSONArray bannedArr = sub.optJSONArray("banned");
                if (bannedArr != null) {
                    for (int j = 0; j < bannedArr.length(); j++) {
                        String pk = bannedArr.optString(j, null);
                        if (pk != null && !pk.isEmpty()) banned.add(pk);
                    }
                }
                Set<String> mentionEveryoneAuthors = new HashSet<>();
                JSONArray mentionEveryoneArr = sub.optJSONArray("mentionEveryoneAuthors");
                if (mentionEveryoneArr != null) {
                    for (int j = 0; j < mentionEveryoneArr.length(); j++) {
                        String pk = mentionEveryoneArr.optString(j, null);
                        if (pk != null && !pk.isEmpty()) mentionEveryoneAuthors.add(pk);
                    }
                }
                List<RoleMentions.Held> roleMentions = RoleMentions.parse(sub.optJSONArray("roleMentions"));
                Set<String> sendDenied = new HashSet<>();
                JSONArray deniedArr = sub.optJSONArray("sendDenied");
                if (deniedArr != null) {
                    for (int j = 0; j < deniedArr.length(); j++) {
                        String pk = deniedArr.optString(j, null);
                        if (pk != null && !pk.isEmpty()) sendDenied.add(pk);
                    }
                }
                Set<String> postAuthors = null;
                JSONArray postersArr = sub.optJSONArray("postAuthors");
                if (postersArr != null) {
                    postAuthors = new HashSet<>();
                    for (int j = 0; j < postersArr.length(); j++) {
                        String pk = postersArr.optString(j, null);
                        if (pk != null && !pk.isEmpty()) postAuthors.add(pk);
                    }
                }
                Map<String, String> nicknames = new HashMap<>();
                JSONObject nicksObj = sub.optJSONObject("nicknames");
                if (nicksObj != null) {
                    for (java.util.Iterator<String> it = nicksObj.keys(); it.hasNext(); ) {
                        String pk = it.next();
                        String nick = nicksObj.optString(pk, "");
                        if (!nick.isEmpty()) nicknames.put(pk, nick);
                    }
                }
                Map<String, long[]> timeouts = new HashMap<>();
                JSONArray timeoutsArr = sub.optJSONArray("timeouts");
                if (timeoutsArr != null) {
                    for (int j = 0; j < timeoutsArr.length(); j++) {
                        JSONObject t = timeoutsArr.optJSONObject(j);
                        if (t == null || t.optString("pk", "").isEmpty()) continue;
                        timeouts.put(t.optString("pk"), new long[] { t.optLong("fromSecs", 0), t.optLong("until", 0) });
                    }
                }
                Set<String> roleMentionAuthors = new HashSet<>();
                JSONArray roleAuthorsArr = sub.optJSONArray("roleMentionAuthors");
                if (roleAuthorsArr != null) {
                    for (int j = 0; j < roleAuthorsArr.length(); j++) {
                        String pk = roleAuthorsArr.optString(j, null);
                        if (pk != null && !pk.isEmpty()) roleMentionAuthors.add(pk);
                    }
                }

                // The community this channel belongs to — its image/name
                // brand the channel's notification. The community ref
                // deep-links to the community; the notification itself links
                // to the channel.
                CommunityRef ref = communityRefFromSub(
                        sub, GROUP_PREFIX + "c2:" + communityId, community,
                        "/c/" + uriEncode(communityId));

                List<String> pkList = new ArrayList<>();
                for (int j = 0; j < streams.length(); j++) {
                    JSONObject s = streams.optJSONObject(j);
                    if (s == null) continue;
                    String pk = s.optString("pk", null);
                    byte[] convKey = ConcordCrypto.hexToBytes(s.optString("convKey", null));
                    if (pk == null || pk.isEmpty() || convKey == null || convKey.length != 32) continue;
                    pkList.add(pk);
                    pkToStream2.put(pk, new ConcordStream(
                            convKey, communityId, channelId, s.optString("epoch", ""),
                            name, url, ref, Math.max(0, sub.optLong("timerSecs", 0)),
                            mentionOnly, banned, mentionEveryoneAuthors, sub.optBoolean("mentionEveryoneAnyone", false),
                            roleMentions, roleMentionAuthors, sub.optLong("clockOffsetMs", 0), sendDenied, postAuthors, timeouts, nicknames,
                            Math.max(0, sub.optLong("joinedAtMs", 0))));
                }
                Set<String> listed = communityRelays.computeIfAbsent(communityId, k -> new LinkedHashSet<>());
                communityPks.computeIfAbsent(communityId, k -> new LinkedHashSet<>()).addAll(pkList);
                for (int j = 0; j < relays.length(); j++) {
                    String relay = relays.optString(j);
                    if (!isValidRelayUrl(relay)) continue;
                    listed.add(relay);
                    concordPublishRelays.computeIfAbsent(relay, k -> new LinkedHashSet<>()).addAll(pkList);
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "Failed to parse concordSubs", e);
        }
    }

    /** Parse additive schema-v2 Git configuration. Bad/old records are ignored,
     * preserving the original notification planes. */
    private void parseGitSubs(String json) {
        gitRepositories.clear(); gitRepositoriesByRelay.clear();
        if (json == null) return;
        try {
            JSONArray all = new JSONArray(json);
            for (int i = 0; i < all.length(); i++) {
                JSONObject value = all.optJSONObject(i); if (value == null) continue;
                String address = value.optString("address", "");
                String owner = value.optString("owner", "");
                if (!validRepositoryAddress(address) || !validHex(owner) || !owner.equals(address.split(":", 3)[1])) continue;
                GitRepository repository = new GitRepository(address, owner);
                JSONArray maintainers = value.optJSONArray("maintainers");
                if (maintainers != null) for (int j = 0; j < maintainers.length(); j++) {
                    String pk = maintainers.optString(j); if (validHex(pk)) repository.maintainers.add(pk);
                }
                JSONArray attachments = value.optJSONArray("attachments");
                if (attachments != null) for (int j = 0; j < attachments.length(); j++) {
                    JSONObject a = attachments.optJSONObject(j); if (a == null) continue;
                    String community = a.optString("communityId", ""), channel = a.optString("channelId", "");
                    long attached = a.optLong("attachedAt", -1), detached = a.has("detachedAt") ? a.optLong("detachedAt", -1) : -1;
                    if (!community.isEmpty() && !channel.isEmpty() && attached >= 0 && (detached < 0 || detached >= attached)) repository.attachments.add(new GitAttachment(community, channel, attached, detached));
                }
                JSONArray roots = value.optJSONArray("ticketRoots");
                if (roots != null) for (int j = 0; j < roots.length(); j++) {
                    JSONObject root = roots.optJSONObject(j); if (root == null) continue;
                    String id = root.optString("id", ""), author = root.optString("author", ""); int kind = root.optInt("kind", 0);
                    if (validHex(id) && validHex(author) && (kind == 1618 || kind == 1621)) repository.roots.put(id, new GitRoot(id, author, kind));
                }
                if (repository.attachments.isEmpty()) continue;
                gitRepositories.put(address, repository);
                JSONArray relays = value.optJSONArray("relays");
                if (relays != null && repository.live()) for (int j = 0; j < relays.length(); j++) {
                    String relay = relays.optString(j, "");
                    // The client resolves which relay is the discovery index and
                    // drops it before writing gitSubs, so these are activity
                    // relays only; the service holds no host of its own.
                    if (!isValidRelayUrl(relay)) continue;
                    Set<String> addresses = gitRepositoriesByRelay.get(relay);
                    if (addresses == null) gitRepositoriesByRelay.put(relay, addresses = new LinkedHashSet<>());
                    addresses.add(address);
                }
            }
        } catch (JSONException e) { Log.w(TAG, "Failed to parse gitSubs", e); }
    }

    /**
     * Subscribe on {@link #SELF_RELAYS_WATCHED} of the self-state relays,
     * preferring DM inbox relays so the DM cover can reuse them.
     */
    private void coverSelfRelays() {
        Set<String> held = new HashSet<>(relayToGroupIds.keySet());
        Set<String> preferred = new HashSet<>(dmRelays);
        selfWatchRelays.clear();
        selfWatchRelays.addAll(DmRelayCover.choose(selfRelays, held, preferred, SELF_RELAYS_WATCHED));
    }

    /**
     * Subscribe on {@link #DM_RELAYS_WATCHED} of the inbox relays (see
     * {@link DmRelayCover}). Runs before the Concord cover, preferring relays
     * a community lists so that cover can reuse them.
     */
    private void coverDmRelays() {
        Set<String> held = new HashSet<>(relayToGroupIds.keySet());
        held.addAll(selfWatchRelays);
        Set<String> preferred = new HashSet<>();
        for (Set<String> relays : communityRelays.values()) preferred.addAll(relays);
        dmWatchRelays.clear();
        dmWatchRelays.addAll(DmRelayCover.choose(dmRelays, held, preferred, DM_RELAYS_WATCHED));
    }

    /**
     * Watch each Concord community on {@link #CONCORD_RELAYS_PER_COMMUNITY} of
     * its relays (see {@link RelayCover}) rather than all of them. Runs after
     * the NIP-29, DM and self-state planes are parsed, since their relays are free.
     */
    private void coverConcordRelays() {
        relayToPks2.clear();
        Set<String> held = new HashSet<>(relayToGroupIds.keySet());
        held.addAll(dmWatchRelays);
        held.addAll(selfWatchRelays);
        Map<String, Set<String>> assignment = RelayCover.assign(
                communityRelays, held, CONCORD_RELAYS_PER_COMMUNITY, concordRefusedRelays);
        for (Map.Entry<String, Set<String>> e : assignment.entrySet()) {
            Set<String> pks = communityPks.get(e.getKey());
            if (pks == null || pks.isEmpty()) continue;
            for (String relay : e.getValue()) {
                relayToPks2.computeIfAbsent(relay, k -> new LinkedHashSet<>()).addAll(pks);
            }
        }
    }

    /**
     * Watch each Git repository on a covering subset of its relays rather than
     * all of them (see {@link GitRelayCover}). Runs after every other plane is
     * parsed, since relays already held for those are free.
     */
    private void pruneGitRelays() {
        Set<String> held = new HashSet<>(relayToGroupIds.keySet());
        held.addAll(dmWatchRelays);
        held.addAll(selfWatchRelays);
        held.addAll(relayToPks2.keySet());
        Map<String, List<String>> byRepository = new HashMap<>();
        for (Map.Entry<String, Set<String>> e : gitRepositoriesByRelay.entrySet()) {
            for (String address : e.getValue()) {
                byRepository.computeIfAbsent(address, k -> new ArrayList<>()).add(e.getKey());
            }
        }
        Set<String> extra = GitRelayCover.choose(byRepository, held, GIT_RELAYS_PER_REPOSITORY);
        gitRepositoriesByRelay.keySet().removeIf(relay -> !held.contains(relay) && !extra.contains(relay));
    }

    private static boolean validHex(String value) { return value != null && value.matches("[0-9a-f]{64}"); }
    private static boolean validRepositoryAddress(String value) {
        return value != null && value.matches("30617:[0-9a-f]{64}:.+");
    }

    // ── Per-relay connection ────────────────────────────────────────────────

    private class RelayConnection {
        final String relayUrl;
        /** Inclusive NIP-01 `since` for this relay only. */
        volatile long sinceSec;
        volatile boolean cursorHasEvent;
        WebSocket ws;
        boolean closed = false;
        boolean socketOpen = false;
        // Set when fleetPolicy said Quarantine: no reconnect is scheduled until
        // an edge (network/config/foreground) re-arms it. Mirrored here for
        // health reporting; the policy's own state is authoritative.
        boolean quarantined = false;

        // The fleet policy's per-relay state, and the relay as the policy sees
        // it. Deliverability is decided once at fleet build (a relay that is
        // not deliverable never becomes a RelayConnection at all).
        final RelayInfo fleetInfo;
        final Object fleetState = fleetPolicy.newRelayState();

        // When the current connection attempt started (handler thread only);
        // the session's uptime is what the policy uses to tell "a stable
        // connection finally died" from "the relay drops us right away".
        long connectAttemptAt = 0;

        // Per-SESSION facts that classify how the session ended (reset in
        // connect()). A session whose every standing subscription was closed
        // auth-required, with nothing delivered, ended AUTH_UNSATISFIABLE —
        // the one outcome the policy may quarantine that a live-but-flaky
        // relay can never produce. Concurrent because sendReqs runs on the
        // socket thread from onOpen while the rest is handler-confined.
        final Set<String> standingSubs = java.util.concurrent.ConcurrentHashMap.newKeySet();
        final Set<String> walledSubs = java.util.concurrent.ConcurrentHashMap.newKeySet();
        volatile boolean deliveredAnything = false;
        // Holds this relay's `since` cursor while the session's REQs replay
        // (newest first), so a drop mid-replay can't skip the older half.
        final CursorGate cursorGate = new CursorGate();

        // Keepalive (see Keepalive): when a frame last arrived, and when the
        // outstanding liveness probe went out (0 if none). Written from the
        // socket thread, read on the handler's tick.
        volatile long lastInboundAt = 0;
        volatile long probeSentAt = 0;
        // This session was ended by our own keepalive, not by the relay.
        boolean killedByKeepalive = false;
        // This session ended with the relay closing it (a close frame or EOF),
        // the only ending that can be its idle timeout: an abort or DNS failure
        // is the network changing under the socket.
        boolean closedByPeer = false;

        // Single pending reconnect, cancellable — prevents a queued reconnect
        // and the network callback from racing to open duplicate sockets.
        final Runnable reconnectRunnable = this::connect;
        /** A reconnect is scheduled after a retry delay (see loadConfigAndReconnect). */
        boolean retryPending = false;
        /** When the pending reconnect fires, on the handler's uptime clock. */
        long retryAt = 0;

        private void scheduleReconnect(long delayMs) {
            handler.removeCallbacks(reconnectRunnable);
            handler.postDelayed(reconnectRunnable, delayMs);
            retryPending = true;
            retryAt = SystemClock.uptimeMillis() + delayMs;
        }

        final String subGroups = "ag-" + Long.toHexString(System.nanoTime());
        final String subDirect = "ad-" + Long.toHexString(System.nanoTime() + 1);
        final String subDm = "am-" + Long.toHexString(System.nanoTime() + 3);
        // Prefix for one-shot kind-0 profile lookups. The sub id embeds only a
        // TRUNCATED key (see shortKey) so it stays within NIP-01's customary
        // 64-char subscription-id cap — strfry-family relays reject longer ids
        // with "invalid subscription id length" (#50). The full pubkey/groupId
        // is recovered through the lookup maps below, not the sub id.
        final String profilePrefix = "ap-" + Long.toHexString(System.nanoTime() + 4) + "-";
        // Prefix for one-shot kind-39000 group-metadata lookups.
        final String groupPrefix = "ah-" + Long.toHexString(System.nanoTime() + 5) + "-";
        final String subConcord = "a2-" + Long.toHexString(System.nanoTime() + 6);
        final String subDm17 = "a7-" + Long.toHexString(System.nanoTime() + 7);
        final String subDmEph = "a8-" + Long.toHexString(System.nanoTime() + 8);
        final String subGitRoots = "ag-" + Long.toHexString(System.nanoTime() + 8);
        final String subGitChildren = "ai-" + Long.toHexString(System.nanoTime() + 9);
        final String subSelf = "as-" + Long.toHexString(System.nanoTime() + 11);
        // Prefix for one-shot kind-10050 DM-inbox lookups (reply addressing).
        final String inboxPrefix = "ax-" + Long.toHexString(System.nanoTime() + 10) + "-";
        // One-shot lookup sub id → the full pubkey / group id it was issued
        // for. Entries are removed when the lookup resolves; capped clears
        // protect against relays that never answer.
        final Map<String, String> profileLookups = new HashMap<>();
        final Map<String, String> groupLookups = new HashMap<>();
        final Map<String, String> inboxLookups = new HashMap<>();
        // In-flight reply publishes (event id → waiter) awaiting this relay's
        // OK, and frames queued while the socket is down (flushed on the next
        // open) — how a reply typed on a cold-started service survives the
        // connect. Handler-thread confined, like everything else here.
        final Map<String, PendingPublish> pendingPublishes = new HashMap<>();
        final List<PendingPublish> outbox = new ArrayList<>();
        // ids of the kind-22242s we sent and haven't seen an OK for. NIP-42
        // allows several AUTHs per connection (the user + every Concord
        // stream key), so this is a set; a relay's OK for some other event
        // can't trigger a REQ re-send.
        final Set<String> pendingAuthIds = new HashSet<>();
        // `pubkey|challenge` pairs this SESSION has already answered, and the
        // challenges already handed to the WebView to sign. A relay repeats
        // the same challenge whenever it walls a REQ; answering it again with
        // the same keys cannot change the outcome, and each round was a
        // Schnorr sign per Concord stream key here plus the same again in JS.
        final Set<String> answeredAuth = new HashSet<>();
        // This session's latest NIP-42 challenge, and whether the relay walled
        // the Concord sub — the only case that needs the stream keys' AUTHs.
        String lastChallenge;
        boolean concordWalled = false;
        // The self-state sub has replayed (EOSE) and is streaming live, so a new
        // edition counts toward the flood breaker.
        volatile boolean selfLive = false;
        // NIP-17: the sub reached EOSE (live), and whether this session's REQ
        // is a catch-up replay whose rumors notify only from the gap onward.
        volatile boolean dm17Live = false;
        // When this session's NIP-17 REQ went out (wall ms): once it is live,
        // every wrap published here since then reached the service.
        volatile long dm17ReqAtMs = 0;
        volatile boolean dm17CatchingUp = false;
        volatile long dm17NotifyFloorSec = 0;
        final Set<String> bridgedChallenges = new HashSet<>();
        // Backoff for relay-initiated CLOSED resubscribes (#49): a relay that
        // drops a standing sub (restart, transient error, rate limit) earns a
        // DELAYED re-REQ with a growing gap, never an instant retry loop.
        // Reset when a fresh socket session opens.
        long subRetryBackoffMs = INITIAL_BACKOFF_MS;
        final Runnable resubscribeRunnable = () -> {
            if (!closed && ws != null) sendReqs(ws);
        };
        // Coalesces the REQ re-send that follows AUTH acks (#49): the user +
        // every Concord stream key each get their own OK, so one re-send after
        // the burst settles instead of a full sendReqs PER OK.
        boolean authResendPending = false;
        // Set while an AUTH-driven re-send is building its REQs: only the subs
        // the relay actually walled go out again. Re-sending a sub that is
        // still streaming restarts it, so e.g. the self-state read would never
        // reach EOSE and set its `since` cursor.
        boolean walledOnly = false;
        // Each standing sub's filters as last sent (minus `since`, which moves
        // on its own), and — during reconfigure() — the subs this pass sent.
        // Concurrent: sendReqs also runs on the socket thread from onOpen.
        final Map<String, String> sentFilters = new java.util.concurrent.ConcurrentHashMap<>();
        Set<String> reconfigurePass = null;

        /**
         * Apply a new config to a LIVE socket: re-send only the standing subs
         * whose filters changed, and CLOSE the ones the config no longer
         * builds. Handler thread.
         */
        void reconfigure() {
            if (closed || ws == null) return;
            reconfigurePass = new HashSet<>();
            try {
                sendReqs(ws);
                for (String sub : new ArrayList<>(sentFilters.keySet())) {
                    if (reconfigurePass.contains(sub)) continue;
                    sentFilters.remove(sub);
                    standingSubs.remove(sub);
                    walledSubs.remove(sub);
                    endBackfill(sub);
                    try {
                        ws.send(new JSONArray().put("CLOSE").put(sub).toString());
                    } catch (Exception ignored) {
                        // A failed CLOSE is a stale sub; the next session drops it.
                    }
                    if (ServiceProfiler.ON) ServiceProfiler.count("config.reload sub closed");
                }
            } finally {
                reconfigurePass = null;
            }
        }
        final Runnable authResendRunnable = () -> {
            authResendPending = false;
            if (closed || ws == null) return;
            if (walledSubs.isEmpty()) {
                if (ServiceProfiler.ON) ServiceProfiler.count("auth.resend skipped (nothing walled)");
                return;
            }
            walledOnly = true;
            try {
                sendReqs(ws);
            } finally {
                walledOnly = false;
            }
        };

        /** A standing sub stopped replaying (EOSE, CLOSED, or closed by us). */
        void endBackfill(String sub) {
            long commit = cursorGate.onBackfillEnded(sub);
            if (commit >= 0) commitRelaySince(relayUrl, commit);
        }

        /** Re-send REQs shortly, collapsing a burst of AUTH OKs into one round. */
        void scheduleAuthResend() {
            if (authResendPending) return;
            authResendPending = true;
            handler.postDelayed(authResendRunnable, 300);
        }

        RelayConnection(String relayUrl, boolean deliverable) {
            this.relayUrl = relayUrl;
            this.fleetInfo = new RelayInfo(relayUrl, deliverable);
            Long previous = relaySinceByUrl.get(relayUrl);
            this.sinceSec = previous != null
                    ? previous
                    : System.currentTimeMillis() / 1000;
            this.cursorHasEvent = relayCursorsWithEvents.contains(relayUrl);
            relaySinceByUrl.put(relayUrl, this.sinceSec);
        }

        void connect() {
            retryPending = false;
            // ws != null guard: a socket is already open (or opening). Without
            // it, a stale queued reconnect firing after the network callback
            // already reconnected would open a second socket and orphan the
            // first — leaked sockets keep pinging and re-failing forever.
            if (closed || ws != null || !isNetworkAvailable()) return;
            // A DM inbox reconnects at once: its NIP-17 and call subscriptions
            // are live-only, so time spent settling there is lost, not delayed.
            // Every other plane resumes from its cursor.
            boolean liveOnly = dmWatchRelays.contains(relayUrl) && shouldWatchDm();
            long settle = liveOnly ? 0 : NetworkSettle.delayMs(
                    SystemClock.elapsedRealtime(), lastNetworkChangeAt, NetworkSettle.SETTLE_MS);
            settle = Math.max(settle, unvalidatedDelayMs());
            if (settle > 0) {
                scheduleReconnect(settle);
                return;
            }
            if (!fleetPolicy.shouldConnect(fleetState, fleetInfo, System.currentTimeMillis())) return;
            quarantined = false;
            connectAttemptAt = System.currentTimeMillis();
            if (ServiceProfiler.ON) {
                ServiceProfiler.count("socket.connect");
                ServiceProfiler.count("socket.connect " + ServiceProfiler.host(relayUrl));
            }
            standingSubs.clear();
            walledSubs.clear();
            sentFilters.clear();
            cursorGate.reset();
            answeredAuth.clear();
            // An AUTH whose OK never came belonged to the dropped session.
            pendingAuthIds.clear();
            bridgedChallenges.clear();
            lastChallenge = null;
            concordWalled = false;
            selfLive = false;
            dm17Live = false;
            dm17CatchingUp = false;
            deliveredAnything = false;
            final Request request;
            try {
                // Belt-and-braces: allRelays is pre-filtered by isValidRelayUrl,
                // but a bad relayUrl must drop THIS connection, never crash the
                // whole service process (see isValidRelayUrl).
                request = new Request.Builder().url(relayUrl).build();
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Invalid relay url, dropping connection: " + e.getMessage());
                closed = true;
                recordHealthError("relay_config");
                updateSocketHealth();
                return;
            }
            ws = httpClient.newWebSocket(request, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "WS open: " + relayUrl);
                    if (ServiceProfiler.ON) ServiceProfiler.count("socket.open");
                    lastInboundAt = SystemClock.elapsedRealtime();
                    probeSentAt = 0;
                    // A fresh socket session: CLOSED-resubscribe backoff starts
                    // over, and a pending auth re-send belongs to the old session.
                    handler.post(() -> {
                        socketOpen = true;
                        updateSocketHealth();
                        subRetryBackoffMs = INITIAL_BACKOFF_MS;
                        handler.removeCallbacks(resubscribeRunnable);
                        authResendPending = false;
                        handler.removeCallbacks(authResendRunnable);
                        flushOutbox(webSocket);
                    });
                    sendReqs(webSocket);
                }

                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    lastInboundAt = SystemClock.elapsedRealtime();
                    if (ServiceProfiler.ON) {
                        // Frames by subscription family, bytes, and how deep the
                        // handler queue gets behind them (every frame is a post).
                        String family = ServiceProfiler.frameFamily(text);
                        ServiceProfiler.units("frame.in " + family, text.length());
                        ServiceProfiler.units("frame.in " + family + " " + ServiceProfiler.host(relayUrl), text.length());
                        ServiceProfiler.units("frame.in bytes", text.length());
                        ServiceProfiler.peak("handler.queue", pendingFrames.incrementAndGet());
                        handler.post(() -> {
                            pendingFrames.decrementAndGet();
                            long t = ServiceProfiler.begin("frame.handle");
                            try {
                                onRelayMessage(text, relayUrl);
                            } finally {
                                ServiceProfiler.end("frame.handle", t);
                            }
                        });
                        return;
                    }
                    handler.post(() -> onRelayMessage(text, relayUrl));
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    // A non-101 upgrade carries its HTTP status in `response`; a
                    // real socket failure has none (code 0). classifyFailure
                    // needs the status so a persistent proxy 5xx counts toward
                    // the breaker instead of being retried as a transient blip.
                    int httpCode = response != null ? response.code() : 0;
                    if (ServiceProfiler.ON) ServiceProfiler.count("socket.failure");
                    Log.w(TAG, "WS failure (" + relayUrl + "): " + t.getMessage()
                            + (httpCode != 0 ? " [HTTP " + httpCode + "]" : ""));
                    handler.post(() -> {
                        recordHealthError("socket");
                        closedByPeer = Keepalive.isPeerClose(t);
                        endSession(classifyFailure(t, httpCode));
                    });
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    if (ServiceProfiler.ON) ServiceProfiler.count("socket.closed");
                    handler.post(() -> {
                        closedByPeer = true;
                        if (!closed) endSession(null);
                    });
                }
            });
        }

        /** Send a standing REQ, recording its id as part of this session. */
        void sendReq(WebSocket webSocket, String subId, JSONObject... filters) throws JSONException {
            if (walledOnly && !walledSubs.contains(subId)) return;
            String signature = filtersWithoutSince(filters);
            Set<String> pass = reconfigurePass;
            if (pass != null) {
                pass.add(subId);
                if (signature.equals(sentFilters.get(subId))) {
                    if (ServiceProfiler.ON) ServiceProfiler.count("config.reload sub unchanged");
                    return;
                }
            }
            sentFilters.put(subId, signature);
            standingSubs.add(subId);
            // Coverage restarts only when the inbox REQ actually goes out again;
            // a reconfigure that leaves it unchanged keeps it (dmCoverage).
            if (subId.equals(subDm17)) {
                dm17ReqAtMs = System.currentTimeMillis();
                dm17Live = false;
            }
            cursorGate.onReqSent(subId);
            if (ServiceProfiler.ON) ServiceProfiler.count("frame.out REQ " + subId.substring(0, Math.min(2, subId.length())));
            if (ServiceProfiler.ON) ServiceProfiler.count("frame.out REQ " + subId.substring(0, Math.min(2, subId.length())) + " " + ServiceProfiler.host(relayUrl) + (filters.length > 0 && filters[0].has("since") ? " since" : " full"));
            webSocket.send(reqMessage(subId, filters));
        }

        void sendReqs(WebSocket webSocket) {
            try {
                long requestSince = subscriptionSince(sinceSec, cursorHasEvent);
                // NIP-29 groups hosted on THIS relay (a group lives on exactly
                // one relay, so we only ask each relay for its own groups).
                Set<String> myGroups = relayToGroupIds.get(relayUrl);
                if (myGroups != null && !myGroups.isEmpty()) {
                    JSONArray h = new JSONArray();
                    for (String id : myGroups) h.put(id);

                    // Group messages: kind 9 in the groups this relay hosts.
                    JSONObject f = new JSONObject();
                    f.put("kinds", new JSONArray().put(9));
                    f.put("#h", h);
                    f.put("since", requestSince);
                    sendReq(webSocket, subGroups, f);

                    // Reactions/replies to me, scoped to those groups so the
                    // query is a valid NIP-29 request (relays reject a #p-only
                    // filter with "must have 'h','e' or 'a' tag").
                    JSONObject f2 = new JSONObject();
                    f2.put("kinds", new JSONArray().put(7).put(1111));
                    f2.put("#h", h);
                    f2.put("#p", new JSONArray().put(userPubkey));
                    f2.put("since", requestSince);
                    sendReq(webSocket, subDirect, f2);
                }
                // Direct messages (kind 4) addressed to me, on the DM/app relays
                // (NOT the NIP-29 group relays — DMs don't live there). Scoped to
                // `authors:[...dmFollows]` so only DMs from established peers notify.
                // No established peers ⇒ no DM subscription.
                if (dmWatchRelays.contains(relayUrl) && !dmFollows.isEmpty()) {
                    JSONArray dmAuthors = new JSONArray();
                    for (String pk : dmFollows) {
                        if (dmNotificationEnabled(pk)) dmAuthors.put(pk);
                    }
                    // Exact `nothing` entries are omitted at the relay filter;
                    // global-off peers with an exact `all`/`mentions` override
                    // remain present.
                    if (dmAuthors.length() > 0) {
                        JSONObject f4 = new JSONObject();
                        f4.put("kinds", new JSONArray().put(4));
                        f4.put("authors", dmAuthors);
                        f4.put("#p", new JSONArray().put(userPubkey));
                        f4.put("since", requestSince);
                        sendReq(webSocket, subDm, f4);
                    }
                }
                // NIP-17 gift-wrapped DMs (kind 1059) addressed to me, on the
                // DM/app relays. The wrap AUTHOR hides the sender, so this can't
                // be authors-scoped — it's a broad `#p` inbox filter. Each wrap
                // is opened with the shared signer credential (NativeSigner) for
                // a rich "<sender>: <preview>" notification in handleDm17Wrap.
                // `since` rewinds the NIP-59 backdate window (a wrap's outer
                // created_at is up to 2 days in the past, so `since = sinceSec`
                // never matches a live wrap) and `limit: 0` skips the stored
                // replay that rewind would otherwise pull in (live-only).
                if (dmWatchRelays.contains(relayUrl) && shouldWatchDm()) {
                    JSONObject f6 = new JSONObject();
                    f6.put("kinds", new JSONArray().put(1059));
                    f6.put("#p", new JSONArray().put(userPubkey));
                    f6.put("since", Math.max(0, requestSince - DM17_SINCE_REWIND_SEC));
                    // After a real gap, replay a bounded page instead: wraps sent
                    // while the socket was down would otherwise never notify.
                    // Only rumors dated after the gap notify (see handleDm17Wrap);
                    // the store's dedupe absorbs the rest.
                    long floor = dm17CatchUpFloorSec(
                            dm17LiveUntilByUrl.get(relayUrl), System.currentTimeMillis());
                    dm17CatchingUp = floor > 0;
                    dm17NotifyFloorSec = floor;
                    f6.put("limit", floor > 0 ? DM17_CATCHUP_LIMIT : 0);
                    sendReq(webSocket, subDm17, f6);

                    // Ephemeral gift wraps (kind 21059) addressed to me: the
                    // DM plane's live signals — the service acts on voice-call
                    // rumors (kind 23314) and discards the rest (typing) after
                    // decrypt. Broadcast-only: relays store nothing and the
                    // wrap's timestamp is real, so a plain `since` is right
                    // and there is no replay to skip.
                    JSONObject f7 = new JSONObject();
                    f7.put("kinds", new JSONArray().put(21059));
                    f7.put("#p", new JSONArray().put(userPubkey));
                    f7.put("since", requestSince);
                    sendReq(webSocket, subDmEph, f7);
                }
                // Concord channel wraps on this relay: kind-1059 events
                // AUTHORED BY the derived stream keys (no routing tag at all).
                Set<String> pks = relayToPks2.get(relayUrl);
                if (pks != null && !pks.isEmpty()) {
                    JSONObject f5 = new JSONObject();
                    f5.put("kinds", new JSONArray().put(1059));
                    JSONArray authors = new JSONArray();
                    for (String pk : pks) authors.put(pk);
                    f5.put("authors", authors);
                    f5.put("since", requestSince);
                    sendReq(webSocket, subConcord, f5);
                }
                Set<String> repositories = gitRepositoriesByRelay.get(relayUrl);
                if (repositories != null && !repositories.isEmpty()) {
                    JSONObject roots = new JSONObject(); roots.put("kinds", new JSONArray().put(1618).put(1621));
                    JSONArray addresses = new JSONArray(); for (String address : repositories) addresses.put(address);
                    roots.put("#a", addresses); roots.put("since", requestSince);
                    sendReq(webSocket, subGitRoots, roots);
                    // Root children are bounded like the TS wire (100 ids/filter), with
                    // NIP-22's uppercase E and NIP-34 status's lowercase e kept separate.
                    List<String> ids = new ArrayList<>();
                    for (String address : repositories) { GitRepository repo = gitRepositories.get(address); if (repo != null) ids.addAll(repo.roots.keySet()); }
                    java.util.Collections.sort(ids);
                    for (int offset = 0; offset < ids.size(); offset += GIT_ROOT_FILTER_CHUNK_SIZE) {
                        JSONArray chunk = new JSONArray(); for (String root : ids.subList(offset, Math.min(ids.size(), offset + GIT_ROOT_FILTER_CHUNK_SIZE))) chunk.put(root);
                        JSONObject comments = new JSONObject(); comments.put("kinds", new JSONArray().put(1111)); comments.put("#E", chunk); comments.put("since", requestSince);
                        sendReq(webSocket, subGitChildren + "c" + offset, comments);
                        JSONObject statuses = new JSONObject(); statuses.put("kinds", new JSONArray().put(1630).put(1631).put(1632).put(1633)); statuses.put("#e", chunk); statuses.put("since", requestSince);
                        sendReq(webSocket, subGitChildren + "s" + offset, statuses);
                    }
                }
                // The user's OWN replaceable documents (SelfState): follow and
                // mute lists, the NIP-29 server/channel list, the Concord
                // vaults, DM/Blossom/emoji lists, the NIP-78 settings documents,
                // and installation-sharded private app state.
                //
                // Watched only on the account's self-state relays. Joined
                // NIP-29 servers carry conversation traffic, not private
                // account documents; asking them for encrypted settings/topic
                // shards leaks feature usage and can hydrate stale copies from
                // a destination current writers do not maintain.
                //
                // The FIRST read of this account on a relay has no `since`: a
                // change made while this device was off must still be seen,
                // which is the whole failure this subscription exists to fix.
                // After a read completes (EOSE), every later one — reconnects,
                // re-REQs and new processes (CURSOR_PREFS) — asks only from
                // shortly before it (selfSinceByUrl): the installation-sharded
                // topic documents accumulate per install, and each one replayed
                // is a Schnorr verify and a write.
                if (!selfFlood(relayUrl).paused(SystemClock.elapsedRealtime())) sendSelfReq(webSocket, false);
            } catch (JSONException e) {
                Log.w(TAG, "Failed to build REQ", e);
            }
        }

        /**
         * The self-state REQ. {@code resuming}: re-opened after a flood pause,
         * so each filter is capped (newest first) instead of replaying every
         * edition published in between.
         */
        void sendSelfReq(WebSocket webSocket, boolean resuming) throws JSONException {
            if (userPubkey != null && !userPubkey.isEmpty()
                    && shouldSyncSelfStateFromRelay(relayUrl, selfWatchRelays)) {
                JSONArray me = new JSONArray().put(userPubkey);

                JSONArray selfKinds = new JSONArray();
                for (int kind : SelfState.KINDS) selfKinds.put(kind);
                JSONObject bare = new JSONObject();
                bare.put("kinds", selfKinds);
                bare.put("authors", me);

                // Kind 30078 is shared with every other NIP-78 client on
                // this identity, so it is asked for by `d` rather than
                // wholesale.
                JSONArray dTags = new JSONArray();
                for (String d : selfDTags) dTags.put(d);
                JSONObject documents = new JSONObject();
                documents.put("kinds", new JSONArray().put(SelfState.KIND_APP_SPECIFIC));
                documents.put("authors", me);
                documents.put("#d", dTags);

                // Installation-sharded private documents are named by topic,
                // not by `d` (GIF favorites and the DM conversation index).
                JSONArray topics = new JSONArray();
                for (String topic : SelfState.TOPICS) topics.put(topic);
                JSONObject topicDocuments = new JSONObject();
                topicDocuments.put("kinds", new JSONArray().put(SelfState.KIND_APP_SPECIFIC));
                topicDocuments.put("authors", me);
                topicDocuments.put("#t", topics);

                // The documents under derived keys: every 30078 such a key signs is
                // ours (SelfState.storable still pins each to its one `d`).
                JSONObject derivedDocuments = null;
                if (!selfDocs.isEmpty()) {
                    JSONArray authors = new JSONArray();
                    for (String pk : selfDocs.keySet()) authors.put(pk);
                    derivedDocuments = new JSONObject();
                    derivedDocuments.put("kinds", new JSONArray().put(SelfState.KIND_APP_SPECIFIC));
                    derivedDocuments.put("authors", authors);
                }

                SharedPreferences cursorPrefs = getSharedPreferences(CURSOR_PREFS, Context.MODE_PRIVATE);
                long nowSec = System.currentTimeMillis() / 1000;
                Long selfSince = selfSinceByUrl.get(relayUrl);
                if (selfSince == null) {
                    selfSince = persistedSelfSince(
                            cursorPrefs.getLong(selfCursorKey(userPubkey, relayUrl), 0L), nowSec);
                }
                if (selfSince != null) {
                    bare.put("since", selfSince);
                    documents.put("since", selfSince);
                    topicDocuments.put("since", selfSince);
                }
                // Its own cursor: a newly configured set of authors has never been
                // read in full, whatever the account's cursor says.
                if (derivedDocuments != null) {
                    Long derivedSince = persistedSelfSince(
                            cursorPrefs.getLong(selfCursorKey(derivedCursorOwner(), relayUrl), 0L), nowSec);
                    if (derivedSince != null) derivedDocuments.put("since", derivedSince);
                }
                if (resuming) {
                    bare.put("limit", FloodBreaker.RESUME_LIMIT);
                    documents.put("limit", FloodBreaker.RESUME_LIMIT);
                    topicDocuments.put("limit", FloodBreaker.RESUME_LIMIT);
                    if (derivedDocuments != null) derivedDocuments.put("limit", FloodBreaker.RESUME_LIMIT);
                }
                selfLive = false;
                if (derivedDocuments != null) {
                    sendReq(webSocket, subSelf, bare, documents, topicDocuments, derivedDocuments);
                } else {
                    sendReq(webSocket, subSelf, bare, documents, topicDocuments);
                }
            }
        }

        /** Close the self-state sub for a flood pause; it re-opens when the pause ends. */
        void pauseSelf(long pauseMs) {
            if (closed || ws == null || !standingSubs.contains(subSelf)) return;
            Log.w(TAG, "Self-document flood on " + relayUrl + "; pausing that subscription for "
                    + (pauseMs / 60_000) + " min");
            if (ServiceProfiler.ON) ServiceProfiler.count("self.flood pause " + ServiceProfiler.host(relayUrl));
            try {
                ws.send(new JSONArray().put("CLOSE").put(subSelf).toString());
            } catch (Exception ignored) {
                // A failed CLOSE leaves a stale sub; the next session drops it.
            }
            sentFilters.remove(subSelf);
            standingSubs.remove(subSelf);
            walledSubs.remove(subSelf);
            endBackfill(subSelf);
            selfLive = false;
            long pausedUntil = selfFlood(relayUrl).pausedUntil();
            handler.postDelayed(() -> {
                RelayConnection now = connectionFor(relayUrl);
                if (!resumesSelfAfterPause(now != null && now.ws != null,
                        now != null && now.standingSubs.contains(now.subSelf),
                        pausedUntil, selfFlood(relayUrl).pausedUntil())) return;
                if (ServiceProfiler.ON) ServiceProfiler.count("self.flood resume " + ServiceProfiler.host(relayUrl));
                try {
                    now.sendSelfReq(now.ws, true);
                } catch (JSONException e) {
                    Log.w(TAG, "Failed to build REQ", e);
                }
            }, pauseMs);
        }

        /**
         * Send (or queue, while the socket is down) an EVENT frame, resolving
         * the callback on this relay's OK — or on the publisher's timeout.
         */
        void publish(JSONObject event, PublishCallback cb) {
            String eventId = event.optString("id", "");
            PendingPublish p = new PendingPublish(eventId,
                    new JSONArray().put("EVENT").put(event).toString(), cb);
            if (ws != null) {
                pendingPublishes.put(eventId, p);
                ws.send(p.frame);
            } else {
                outbox.add(p);
            }
        }

        /** Flush publishes queued while the socket was down (handler thread). */
        void flushOutbox(WebSocket webSocket) {
            if (closed || outbox.isEmpty()) return;
            for (PendingPublish p : outbox) {
                pendingPublishes.put(p.eventId, p);
                webSocket.send(p.frame);
            }
            outbox.clear();
        }

        void sendAuth(String eventJson) {
            if (ws == null) return;
            try {
                JSONObject event = new JSONObject(eventJson);
                // Native and WebView both sign for the same challenge; the
                // first answer per key wins and the rest are dropped here.
                String pair = authPairOf(event);
                if (pair != null && !answeredAuth.add(pair)) {
                    if (ServiceProfiler.ON) ServiceProfiler.count("auth.skip answered");
                    return;
                }
                String eid = event.optString("id", null);
                if (eid != null && !eid.isEmpty()) pendingAuthIds.add(eid);
                JSONArray auth = new JSONArray();
                auth.put("AUTH");
                auth.put(event);
                if (ServiceProfiler.ON) ServiceProfiler.count("frame.out AUTH");
                ws.send(auth.toString());
                healthLastSignAtMs = System.currentTimeMillis();
                healthAuthStatus = "signed";
                if (BuildConfig.DEBUG) Log.d(TAG, "Sent AUTH to " + relayUrl);
            } catch (JSONException e) {
                Log.w(TAG, "Failed to send AUTH", e);
                healthAuthStatus = "failed";
                recordHealthError("auth_send");
            }
        }

        /**
         * Fire a one-shot kind-0 REQ for {@code pubkey}. The matching EVENT is
         * picked up in {@link #onRelayMessage} (sub id starts with
         * {@link #profilePrefix}); the relay's EOSE / our timeout closes it.
         */
        void fetchProfile(String pubkey) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(0));
                f.put("authors", new JSONArray().put(pubkey));
                f.put("limit", 1);
                if (ServiceProfiler.ON) ServiceProfiler.count("frame.out REQ lookup kind0");
                ws.send(reqMessage(profileSubId(pubkey), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build profile REQ", e);
            }
        }

        /**
         * Fire a one-shot kind-39000 (NIP-29 group metadata) REQ for
         * {@code groupId}, scoped with a `#d` filter. The EVENT is picked up in
         * {@link #onRelayMessage} (sub id starts with {@link #groupPrefix}).
         */
        void fetchGroupName(String groupId) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(39000));
                f.put("#d", new JSONArray().put(groupId));
                f.put("limit", 1);
                if (ServiceProfiler.ON) ServiceProfiler.count("frame.out REQ lookup kind39000");
                ws.send(reqMessage(groupSubId(groupId), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build group-name REQ", e);
            }
        }

        /**
         * The sub id for a one-shot profile lookup, registered in
         * {@link #profileLookups} so the full pubkey can be recovered. Embeds
         * only a truncated key: relays commonly cap subscription ids at 64
         * chars and reject longer ones outright, so `prefix + full 64-hex
         * pubkey` (~84 chars) meant those relays' notifications never fired (#50).
         */
        String profileSubId(String pubkey) {
            String subId = profilePrefix + shortKey(pubkey);
            if (profileLookups.size() > 512) profileLookups.clear();
            profileLookups.put(subId, pubkey);
            return subId;
        }

        /** Group-metadata analogue of {@link #profileSubId}. */
        String groupSubId(String groupId) {
            String subId = groupPrefix + shortKey(groupId);
            if (groupLookups.size() > 512) groupLookups.clear();
            groupLookups.put(subId, groupId);
            return subId;
        }

        /**
         * Fire a one-shot kind-10050 REQ for {@code pubkey}'s published NIP-17
         * inbox — where a DM reply's peer copy must be delivered. The matching
         * EVENT is gathered in {@link #onRelayMessage}; the reply's own timeout
         * resolves with the newest list seen across relays.
         */
        void fetchDmInbox(String pubkey) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(10050));
                f.put("authors", new JSONArray().put(pubkey));
                f.put("limit", 1);
                if (ServiceProfiler.ON) ServiceProfiler.count("frame.out REQ lookup kind10050");
                ws.send(reqMessage(inboxSubId(pubkey), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build inbox REQ", e);
            }
        }

        /** DM-inbox analogue of {@link #profileSubId}. */
        String inboxSubId(String pubkey) {
            String subId = inboxPrefix + shortKey(pubkey);
            if (inboxLookups.size() > 512) inboxLookups.clear();
            inboxLookups.put(subId, pubkey);
            return subId;
        }

        void closeSub(String subId) {
            if (ws == null) return;
            try {
                JSONArray close = new JSONArray();
                close.put("CLOSE");
                close.put(subId);
                ws.send(close.toString());
            } catch (Exception ignored) {}
        }

        /**
         * The socket is gone (failed to open, or opened then died). Classify
         * the session and let the fleet policy decide: retry after a delay,
         * or quarantine until an edge. {@code failureOutcome} is the
         * transport's classification of an onFailure, or null for a clean
         * onClosed. An opened session that ended with every standing
         * subscription auth-walled and nothing delivered is
         * AUTH_UNSATISFIABLE whatever the transport said.
         */
        void endSession(Outcome failureOutcome) {
            if (closed) return;
            if (dm17Live) dm17LiveUntilByUrl.put(relayUrl, System.currentTimeMillis());
            dm17Live = false;
            boolean wasOpen = socketOpen;
            socketOpen = false;
            ws = null;
            learnIdleDrop(wasOpen);
            long now = System.currentTimeMillis();
            long uptime = (wasOpen && connectAttemptAt > 0) ? Math.max(0, now - connectAttemptAt) : 0;
            Outcome outcome;
            if (wasOpen && sessionAuthUnsatisfiable(standingSubs, walledSubs, deliveredAnything)) {
                outcome = Outcome.AUTH_UNSATISFIABLE;
            } else if (failureOutcome != null) {
                outcome = failureOutcome;
            } else {
                outcome = Outcome.TRANSIENT_DROP;
            }
            FleetDecision decision = fleetPolicy.onConnectionEnded(
                    fleetState, fleetInfo, new ConnectionResult(wasOpen, uptime, outcome), now);
            handler.removeCallbacks(reconnectRunnable);
            retryPending = false;
            if (decision instanceof FleetDecision.RetryAfter retry) {
                scheduleReconnect(retry.delayMs());
            } else {
                quarantined = true;
                Log.w(TAG, "Quarantined " + relayUrl + " (" + outcome
                        + "); no retry until a network/config/foreground change");
                recordHealthError("relay_quarantined");
                // Move the communities this carried onto their other relays.
                if (relayToPks2.containsKey(relayUrl) && concordRefusedRelays.add(relayUrl)) {
                    handler.removeCallbacks(recoverConcordRunnable);
                    handler.postDelayed(recoverConcordRunnable, 1_000);
                }
            }
            updateSocketHealth();
        }

        /**
         * Re-send this connection's standing REQs after a relay-initiated
         * CLOSED (#49), with an exponential per-connection delay (1s → 5min)
         * so a relay that keeps dropping the sub can never be hammered in a
         * tight loop. Never used for `auth-required` CLOSEDs — those re-send
         * through the AUTH → OK path instead.
         */
        void scheduleResubscribe() {
            if (closed || ws == null) return;
            handler.removeCallbacks(resubscribeRunnable);
            handler.postDelayed(resubscribeRunnable, subRetryBackoffMs);
            subRetryBackoffMs = Math.min(subRetryBackoffMs * 2, MAX_BACKOFF_MS);
        }

        /**
         * A relay that dropped an open socket while it was quiet has an idle
         * timeout: probe its sockets inside it from now on. Not when we killed
         * the socket ourselves, or the network just changed under it.
         */
        private void learnIdleDrop(boolean wasOpen) {
            boolean ours = killedByKeepalive;
            boolean byPeer = closedByPeer;
            killedByKeepalive = false;
            closedByPeer = false;
            if (!wasOpen || ours || !byPeer || lastInboundAt == 0) return;
            if (SystemClock.elapsedRealtime() - lastNetworkChangeAt < NETWORK_DROP_GRACE_MS) return;
            long current = quietLimitFor(relayUrl);
            long learned = Keepalive.learn(current, SystemClock.elapsedRealtime() - lastInboundAt);
            if (learned < current) {
                quietLimitByUrl.put(relayUrl, learned);
                getSharedPreferences(KEEPALIVE_PREFS, Context.MODE_PRIVATE).edit().putLong(relayUrl, learned).apply();
                if (ServiceProfiler.ON) ServiceProfiler.count("keepalive.learned " + ServiceProfiler.host(relayUrl) + " " + learned / 1000 + "s");
            }
        }

        /** One keepalive tick (handler thread): probe a quiet socket, drop a dead one. Whether it probed. */
        boolean keepalive(long now) {
            WebSocket socket = ws;
            if (closed || socket == null || !socketOpen) return false;
            long limit = quietLimitFor(relayUrl);
            switch (Keepalive.onTick(lastInboundAt, probeSentAt, limit, now)) {
                case PROBE:
                    probeSentAt = now;
                    if (ServiceProfiler.ON) ServiceProfiler.count("keepalive.probe");
                    socket.send(KEEPALIVE_PROBE);
                    return true;
                case KILL:
                    killUnanswered(socket);
                    return false;
                default:
                    return false;
            }
        }

        /** After a tick's probes had time to answer: a silent socket is dead. */
        void checkProbe(long now) {
            WebSocket socket = ws;
            if (closed || socket == null) return;
            if (Keepalive.probeExpired(lastInboundAt, probeSentAt, now)) killUnanswered(socket);
        }

        private void killUnanswered(WebSocket socket) {
            probeSentAt = 0;
            killedByKeepalive = true;
            if (ServiceProfiler.ON) ServiceProfiler.count("keepalive.dead " + ServiceProfiler.host(relayUrl));
            Log.w(TAG, "Keepalive unanswered, dropping " + relayUrl);
            // cancel() fails the socket, so onFailure → endSession reconnects it.
            socket.cancel();
        }

        void close() {
            closed = true;
            retryPending = false;
            socketOpen = false;
            handler.removeCallbacks(reconnectRunnable);
            handler.removeCallbacks(resubscribeRunnable);
            // Fail any in-flight/queued reply publish rather than strand its
            // waiter until the timeout (the tally treats it as this relay's no).
            for (PendingPublish p : pendingPublishes.values()) p.cb.done(false);
            pendingPublishes.clear();
            for (PendingPublish p : outbox) p.cb.done(false);
            outbox.clear();
            if (ws != null) {
                try { ws.close(1000, "service reconfigured"); } catch (Exception ignored) {}
                ws = null;
            }
            updateSocketHealth();
        }

        /**
         * An external change that could alter the outcome: connectivity
         * returned, or the app came forward (which can wake a signer). The
         * policy clears any quarantine and backoff, and an idle relay
         * reconnects now — or, for a quarantined relay on a flapping network,
         * once the policy's re-arm spacing ends. A config change needs no
         * edge — it rebuilds every connection with fresh policy state.
         */
        void onFleetEdge(FleetEdge edge) {
            if (closed) return;
            long delayMs = fleetPolicy.onEdge(fleetState, fleetInfo, edge, System.currentTimeMillis());
            if (ws != null) return;
            handler.removeCallbacks(reconnectRunnable);
            retryPending = false;
            if (delayMs <= 0) {
                connect();
            } else {
                scheduleReconnect(delayMs);
            }
        }

        /**
         * Whether a watchdog wake may end as far as this relay is concerned: no
         * dial in flight, no probe or keepalive kill unresolved, inbound quiet,
         * and no reconnect due before the wake's grace would run out anyway.
         */
        boolean watchdogSettled(long now, long uptime) {
            if (closed || quarantined) return true;
            if (ws != null && !socketOpen) return false;
            if (socketOpen) {
                return probeSentAt == 0 && !killedByKeepalive && now - lastInboundAt >= WATCHDOG_QUIET_MS;
            }
            return !retryPending || retryAt - uptime > WATCHDOG_RECONNECT_GRACE_MS;
        }
    }

    /** Callback for a native EVENT publish (per relay, and for the overall tally). */
    private interface PublishCallback {
        void done(boolean ok);
    }

    /** One EVENT frame awaiting a relay's OK (or queued for the next open). */
    private static final class PendingPublish {
        final String eventId;
        final String frame;
        final PublishCallback cb;
        // One delayed re-send is allowed after an `auth-required:` OK — the
        // service AUTHs on challenge, so the retry usually lands authenticated.
        boolean authRetried;

        PendingPublish(String eventId, String frame, PublishCallback cb) {
            this.eventId = eventId;
            this.frame = frame;
            this.cb = cb;
        }
    }

    /** `["REQ", <sub>, <filter>, …]` — NIP-01 allows several filters per REQ. */
    private String reqMessage(String subId, JSONObject... filters) throws JSONException {
        JSONArray req = new JSONArray();
        req.put("REQ");
        req.put(subId);
        for (JSONObject filter : filters) req.put(filter);
        return req.toString();
    }

    /**
     * Truncate a hex pubkey / group id for embedding in a subscription id.
     * 24 hex chars keep concurrent lookups distinct for all practical
     * purposes while the whole sub id stays well under the 64-char cap many
     * relays enforce (#50); the full value is recovered via the per-connection
     * lookup maps, never parsed back out of the sub id.
     */
    private static String shortKey(String value) {
        return value.length() <= 24 ? value : value.substring(0, 24);
    }

    /**
     * A standing sub re-delivering an event this process already handled is
     * dropped before its frame is parsed. Relays re-send the account's own
     * documents on every reconnect and re-publish, and a 38 KB community-list
     * fragment cost more to parse than everything else done with it. The
     * session bookkeeping a delivery implies still happens.
     */
    private boolean dropSeenEventFrame(String text, String relayUrl) {
        String[] head = eventFrameHead(text);
        if (head == null) return false;
        String sub = head[0], id = head[1];
        if (!selfSeenIds.contains(id) && !notifiedIds.contains(id)) return false;
        RelayConnection delivering = connectionFor(relayUrl);
        if (delivering == null || !delivering.standingSubs.contains(sub)) return false;
        delivering.walledSubs.remove(sub);
        delivering.deliveredAnything = true;
        if (ServiceProfiler.ON) ServiceProfiler.count("event.drop seen before parse");
        return true;
    }

    /**
     * The subscription id and event id of an {@code ["EVENT", sub, {…}]} frame,
     * read without parsing it; null for any other frame or anything unexpected.
     * The event's own {@code "id":"} is the first occurrence of that sequence:
     * a quote inside any JSON string is escaped, so none can spell it.
     */
    static String[] eventFrameHead(String text) {
        if (!text.startsWith("[\"EVENT\"")) return null;
        int s0 = text.indexOf('"', 8);
        if (s0 < 0) return null;
        int s1 = text.indexOf('"', s0 + 1);
        if (s1 < 0) return null;
        int at = text.indexOf("\"id\":\"", s1 + 1);
        if (at < 0 || at + 70 >= text.length()) return null;
        String id = text.substring(at + 6, at + 70);
        if (text.charAt(at + 70) != '"' || !id.matches("[0-9a-f]{64}")) return null;
        return new String[] { text.substring(s0 + 1, s1), id };
    }

    /**
     * Hand a challenge to the WebView for the signatures it should add: the
     * user's ({@code user}) and/or the stream keys' ({@code streams}). Returns
     * whether the WebView is there to answer (or already was).
     */
    private boolean bridgeAuth(String relayUrl, String challenge, RelayConnection session,
                               boolean user, boolean streams) {
        if (!user && !streams) return false;
        String key = challenge + (streams ? "|s" : "") + (user ? "|u" : "");
        if (session != null && session.bridgedChallenges.contains(key)) {
            if (ServiceProfiler.ON) ServiceProfiler.count("auth.skip bridge repeat");
            return true;
        }
        boolean bridged = ArmadaNotificationPlugin.emitAuthChallenge(relayUrl, challenge, user, streams);
        if (bridged && session != null) session.bridgedChallenges.add(key);
        return bridged;
    }

    /**
     * The Concord STREAM auths, signed natively from the same group-key memo
     * the quick reply signs wraps with — so an auth-gating relay's kind-1059
     * subscription survives a reconnect with the WebView asleep, instead of
     * waiting for it to wake and answer the bridge (which still signs too; a
     * duplicate AUTH just re-authenticates).
     */
    private void signStreamAuths(String relayUrl, String challenge, RelayConnection session) {
        Set<String> streamPks = relayToPks2.get(relayUrl);
        if (streamPks == null || streamPks.isEmpty()) return;
        Map<String, String> secrets = ServiceStore.streamSecrets(this, new ArrayList<>(streamPks));
        long nowSecs = System.currentTimeMillis() / 1000;
        for (Map.Entry<String, String> entry : secrets.entrySet()) {
            if (session != null && session.answeredAuth.contains(entry.getKey() + "|" + challenge)) {
                if (ServiceProfiler.ON) ServiceProfiler.count("auth.skip stream repeat");
                continue;
            }
            byte[] sk = ConcordCrypto.hexToBytes(entry.getValue());
            if (sk == null || sk.length != 32) continue;
            try {
                if (!entry.getKey().equals(NostrCrypto.pubkeyOf(sk))) continue;
                JSONArray streamTags = new JSONArray()
                        .put(new JSONArray().put("relay").put(relayUrl))
                        .put(new JSONArray().put("challenge").put(challenge));
                long t = ServiceProfiler.begin("auth.stream.sign");
                try {
                    deliverAuth(relayUrl, NostrCrypto.finalizeEvent(
                            22242, "", streamTags, nowSecs, sk).toString());
                } finally {
                    ServiceProfiler.end("auth.stream.sign", t);
                }
            } catch (Exception ignored) {
                // A stream that can't sign simply isn't authed.
            }
        }
    }

    private void onRelayMessage(String text, String relayUrl) {
        if (dropSeenEventFrame(text, relayUrl)) return;
        try {
            JSONArray msg = new JSONArray(text);
            String type = msg.optString(0);
            // A keepalive answer did its job by arriving (onMessage stamped it).
            // A CLOSED one (auth wall, rate limit) must not reach the standing
            // sub's resubscribe path.
            if (("EOSE".equals(type) || "CLOSED".equals(type)) && KEEPALIVE_SUB.equals(msg.optString(1))) {
                RelayConnection probed = connectionFor(relayUrl);
                if (probed != null) {
                    probed.probeSentAt = 0;
                    WebSocket socket = probed.ws;
                    if ("EOSE".equals(type) && socket != null) socket.send(KEEPALIVE_CLOSE);
                }
                return;
            }
            if ("AUTH".equals(type)) {
                // NIP-42 challenge. The bridge is still emitted when the
                // WebView is up (it signs the Concord STREAM auths, whose
                // derived keys live JS-side), but the user's own kind-22242 is
                // signed natively whenever a shared signer credential exists —
                // so auth-gated subscriptions (the classic #p DM inbox wall)
                // survive with the app killed. A duplicate user AUTH from the
                // bridge is harmless; a relay just re-authenticates.
                String challenge = msg.optString(1);
                if (ServiceProfiler.ON) ServiceProfiler.count("auth.challenge");
                healthLastAuthAtMs = System.currentTimeMillis();
                healthAuthStatus = "challenged";
                if (BuildConfig.DEBUG) Log.d(TAG, "AUTH challenge from " + relayUrl);
                RelayConnection session = connectionFor(relayUrl);
                NativeSigner signer = nativeSigner;
                if (session != null) session.lastChallenge = challenge;
                // The WebView signs the user's AUTH when this process has no
                // signer, and the stream keys' (it may hold keys the memo here
                // lacks) only where the Concord sub was walled. Once per
                // session per purpose, not on every repeat.
                boolean needStreams = session == null || session.concordWalled;
                boolean bridged = bridgeAuth(relayUrl, challenge, session, signer == null, needStreams);
                if (signer != null && userPubkey != null && session != null
                        && session.answeredAuth.contains(userPubkey + "|" + challenge)) {
                    if (ServiceProfiler.ON) ServiceProfiler.count("auth.skip user repeat");
                } else if (signer != null) {
                    JSONArray authTags = new JSONArray()
                            .put(new JSONArray().put("relay").put(relayUrl))
                            .put(new JSONArray().put("challenge").put(challenge));
                    signer.signEvent(22242, "", authTags, System.currentTimeMillis() / 1000, ev -> {
                        if (ev != null) {
                            // The callback lands on the signer's own executor
                            // (Amber/bunker are RPC), so the walk over
                            // `connections` hops back to the handler thread
                            // rather than reading it from there.
                            String signed = ev.toString();
                            handler.post(() -> deliverAuth(relayUrl, signed));
                        } else {
                            healthAuthStatus = "failed";
                            recordHealthError("signer_sign");
                        }
                    });
                } else if (!bridged) {
                    Log.w(TAG, "No bridge (WebView down) and no shared signer — can't AUTH " + relayUrl);
                }
                // Stream keys authenticate only where the Concord subscription was
                // actually walled: most relays serve it unauthenticated and
                // challenge for the DM or self-state subs, and answering every
                // challenge with every stream key is hundreds of signatures per
                // reconnect. The wall may arrive before or after the challenge.
                if (needStreams) signStreamAuths(relayUrl, challenge, session);
                return;
            }
            if ("EOSE".equals(type)) {
                String sub = msg.optString(1);
                if (BuildConfig.DEBUG) Log.d(TAG, "EOSE from " + relayUrl + " sub=" + sub);
                // A profile lookup that returned no kind-0: resolve waiters with
                // null so the notification fires name-less rather than hanging —
                // and negative-cache it so this author isn't re-broadcast on
                // every subsequent message.
                String pk = profilePubkeyForSub(sub);
                if (pk != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveProfileMiss(pk);
                    return;
                }
                // A group-name lookup with no kind-39000: resolve waiters null.
                String gid = groupIdForSub(sub);
                if (gid != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveGroupName(gid, null);
                    return;
                }
                // A DM-inbox lookup with no kind-10050 here: just close it —
                // the reply's own timeout resolves with the best across relays.
                if (inboxPubkeyForSub(sub) != null) {
                    closeInboxSub(relayUrl, sub);
                    return;
                }
                // A standing sub reached EOSE: the relay accepted it, so it is
                // no longer auth-walled for this session.
                RelayConnection accepted = connectionFor(relayUrl);
                if (accepted != null) {
                    accepted.walledSubs.remove(sub);
                    accepted.endBackfill(sub);
                    if (sub.equals(accepted.subDm17)) {
                        accepted.dm17Live = true;
                        accepted.dm17CatchingUp = false;
                        dm17LiveUntilByUrl.remove(relayUrl);
                    }
                    // The self-state read is complete on this relay: later
                    // REQs ask only for what changed since (see selfSinceByUrl).
                    if (sub.equals(accepted.subSelf)) {
                        accepted.selfLive = true;
                        long since = System.currentTimeMillis() / 1000 - SELF_SINCE_SLACK_SEC;
                        selfSinceByUrl.put(relayUrl, since);
                        if (userPubkey != null) {
                            SharedPreferences.Editor editor =
                                    getSharedPreferences(CURSOR_PREFS, Context.MODE_PRIVATE).edit()
                                            .putLong(selfCursorKey(userPubkey, relayUrl), since);
                            if (!selfDocs.isEmpty()) {
                                editor.putLong(selfCursorKey(derivedCursorOwner(), relayUrl), since);
                            }
                            editor.apply();
                        }
                    }
                }
                return;
            }
            if ("CLOSED".equals(type)) {
                String sub = msg.optString(1);
                String reason = msg.optString(2);
                Log.w(TAG, "CLOSED from " + relayUrl + " sub=" + sub + " reason=" + reason);
                // A one-shot profile/group lookup the relay rejected (bad sub
                // id, auth wall, filter policy): resolve its waiters like an
                // empty EOSE so the notification fires name-less instead of
                // hanging on the timeout.
                String pk = profilePubkeyForSub(sub);
                if (pk != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveProfile(pk, bestProfile.get(pk));
                    return;
                }
                String gid = groupIdForSub(sub);
                if (gid != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveGroupName(gid, (String) null);
                    return;
                }
                if (inboxPubkeyForSub(sub) != null) {
                    closeInboxSub(relayUrl, sub);
                    return;
                }
                // A standing subscription the relay dropped. `auth-required`
                // is NOT retried from here — the AUTH → OK path re-sends every
                // REQ once authentication lands, and without an auth path a
                // blind re-REQ is an unwinnable retry storm (#49). Everything
                // else (relay restart, transient error, rate limit) earns a
                // DELAYED resubscribe with per-connection exponential backoff.
                // A dropped inbox sub no longer vouches for what the relay received (dmCoverage).
                RelayConnection dropped = connectionFor(relayUrl);
                if (dropped != null && sub.equals(dropped.subDm17)) dropped.dm17Live = false;
                if (isAuthRequired(reason)) {
                    // Remember the wall for this session; an EOSE or EVENT on
                    // the same sub (after an AUTH lands) clears it. A session
                    // that ends with every standing sub still walled is
                    // classified AUTH_UNSATISFIABLE in endSession.
                    RelayConnection walled = connectionFor(relayUrl);
                    if (walled != null) {
                        walled.walledSubs.add(sub);
                        walled.endBackfill(sub);
                        if (sub.equals(walled.subConcord) && !walled.concordWalled) {
                            walled.concordWalled = true;
                            if (walled.lastChallenge != null) {
                                signStreamAuths(relayUrl, walled.lastChallenge, walled);
                                bridgeAuth(relayUrl, walled.lastChallenge, walled, false, true);
                            }
                        }
                    }
                    return;
                }
                recordHealthError("subscription_closed");
                for (RelayConnection rc : connections) {
                    if (rc.relayUrl.equals(relayUrl)) {
                        rc.endBackfill(sub);
                        rc.scheduleResubscribe();
                        break;
                    }
                }
                return;
            }
            if ("OK".equals(type)) {
                // AUTH ack (["OK", <event-id>, true/false, msg]). On success,
                // and only when the id matches a kind-22242 we sent (the user's
                // or a Concord stream key's), the matching connection
                // re-sends its REQs — coalesced into one round after the OK
                // burst settles (see scheduleAuthResend).
                String okId = msg.optString(1);
                boolean ok = msg.optBoolean(2, false);
                if (BuildConfig.DEBUG) Log.d(TAG, "OK from " + relayUrl + " ok=" + ok + " " + msg.optString(3));
                for (RelayConnection rc : connections) {
                    if (!rc.relayUrl.equals(relayUrl) || rc.ws == null) continue;
                    if (rc.pendingAuthIds.remove(okId)) {
                        healthAuthStatus = ok ? "accepted" : "rejected";
                        if (ok) rc.scheduleAuthResend();
                        else {
                            recordHealthError("auth_rejected");
                            // A walled Concord sub whose AUTH is refused can't be
                            // served here: re-cover its communities elsewhere.
                            if (rc.concordWalled && concordRefusedRelays.add(relayUrl)) {
                                if (ServiceProfiler.ON) ServiceProfiler.count("concord.refused " + ServiceProfiler.host(relayUrl));
                                handler.removeCallbacks(recoverConcordRunnable);
                                handler.postDelayed(recoverConcordRunnable, 1_000);
                            }
                        }
                        continue;
                    }
                    // A reply publish's OK. `auth-required` earns ONE delayed
                    // re-send (the AUTH this service signs on challenge usually
                    // completes in the gap); anything else resolves the waiter.
                    PendingPublish p = rc.pendingPublishes.get(okId);
                    if (p == null) continue;
                    if (!ok && isAuthRequired(msg.optString(3, "")) && !p.authRetried) {
                        p.authRetried = true;
                        handler.postDelayed(() -> {
                            if (rc.ws != null && rc.pendingPublishes.containsKey(okId)) {
                                rc.ws.send(p.frame);
                            }
                        }, 3_000);
                        continue;
                    }
                    rc.pendingPublishes.remove(okId);
                    p.cb.done(ok);
                }
                return;
            }
            if (!"EVENT".equals(type)) return;
            String sub = msg.optString(1);
            JSONObject event = msg.optJSONObject(2);
            if (event == null) return;
            // A kind-0 from a profile lookup: keep the newest across relays and
            // resolve waiters with the best we have.
            String pk = profilePubkeyForSub(sub);
            if (pk != null) {
                closeProfileSub(relayUrl, sub);
                // The relay could answer our one-shot kind-0 lookup with a
                // forged or unrelated profile (poisoning a sender's name/avatar
                // and the shared store). Require the reply to actually match the
                // filter — kind 0 authored by the pubkey we asked for — and to
                // carry a valid signature; otherwise resolve name-less.
                if (event.optInt("kind", -1) != 0
                        || !pk.equals(event.optString("pubkey"))
                        || !NostrCrypto.verifyEvent(event)) {
                    resolveProfile(pk, bestProfile.get(pk));
                    return;
                }
                // Store the raw kind-0 in ArmadaDB's `main` tenant (supersession
                // keeps the newest), so the WebView's useAuthor reads it from
                // the cache instead of re-fetching what we just fetched. Not
                // queued for ingest: there is nothing to route, only to cache.
                ServiceStore.cache(this, event);
                Profile parsed = parseProfile(event);
                Profile prev = bestProfile.get(pk);
                if (prev == null || parsed.ts >= prev.ts) {
                    bestProfile.put(pk, parsed);
                }
                resolveProfile(pk, bestProfile.get(pk));
                return;
            }
            // A kind-39000 from a group-name lookup: cache the name + resolve.
            String gid = groupIdForSub(sub);
            if (gid != null) {
                closeProfileSub(relayUrl, sub);
                // Same untrusted-relay gate as profiles: the reply must be the
                // kind-39000 metadata for the group id we asked for, with a
                // valid signature, or we resolve name-less rather than trust a
                // forged room title.
                if (event.optInt("kind", -1) != 39000
                        || !gid.equals(tagValue(event, "d"))
                        || !NostrCrypto.verifyEvent(event)) {
                    resolveGroupName(gid, (String) null);
                    return;
                }
                // Cache the group's picture (kind-39000 `picture` tag) alongside
                // its name — the NIP-29 conversation's avatar. Plain public
                // URL, no decrypt.
                String pic = tagValue(event, "picture");
                if (pic != null && !pic.isEmpty()) {
                    groupPictureCache.put(gid, pic);
                }
                // Cached so the WebView reads the group's metadata rather than
                // refetching what we just fetched — in THIS relay's tenant,
                // which is where the channel list looks for it (a group id names
                // nothing without its relay, and relay identities can be shared
                // between servers, so metadata is stored per relay).
                ServiceStore.cache(this, event, relayUrl);
                resolveGroupName(gid, parseGroupName(event));
                return;
            }
            // A kind-10050 from a DM-inbox lookup: keep the newest VERIFIED
            // list seen across relays; the reply's timeout reads it out. The
            // same untrusted-relay gate as profiles — a forged inbox would
            // redirect the reply's ciphertext to relays the peer never reads.
            String inboxPk = inboxPubkeyForSub(sub);
            if (inboxPk != null) {
                closeInboxSub(relayUrl, sub);
                if (event.optInt("kind", -1) == 10050
                        && inboxPk.equals(event.optString("pubkey"))
                        && NostrCrypto.verifyEvent(event)) {
                    JSONObject prev = bestInbox.get(inboxPk);
                    if (prev == null
                            || event.optLong("created_at", 0) >= prev.optLong("created_at", 0)) {
                        bestInbox.put(inboxPk, event);
                    }
                }
                return;
            }
            // A standing sub delivered: this session is productive, and the
            // sub is not auth-walled (whatever an earlier CLOSED said).
            RelayConnection delivering = connectionFor(relayUrl);
            if (delivering != null) {
                delivering.walledSubs.remove(sub);
                delivering.deliveredAnything = true;
            }
            handleEvent(event, relayUrl);
        } catch (Exception e) {
            // Ignore non-JSON / unexpected frames.
        }
    }

    // ── Profile (kind 0) resolution ───────────────────────────────────────────

    /**
     * If {@code sub} is one of our one-shot profile lookups, return the pubkey
     * it was issued for; otherwise null. Recovered from each connection's
     * lookup map (the sub id itself only carries a truncated key, #50).
     */
    private String profilePubkeyForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String pk = rc.profileLookups.get(sub);
            if (pk != null) return pk;
        }
        return null;
    }

    private void closeProfileSub(String relayUrl, String sub) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.profileLookups.remove(sub);
                rc.groupLookups.remove(sub);
                rc.closeSub(sub);
                return;
            }
        }
    }

    /**
     * Resolve {@code pubkey} to a profile, then invoke {@code cb} (always on the
     * handler thread). Serves from the DURABLE store when present (refreshing in
     * the background once stale), and serves a recent NEGATIVE entry without
     * touching the network. On a genuine miss, issues a kind-0 REQ on EVERY
     * open relay (a user's kind-0 usually lives on their general / outbox
     * relays, not the NIP-29 group relay the message came from, so a
     * single-relay lookup misses it). Waits up to {@link #PROFILE_TIMEOUT_MS},
     * keeping the newest kind-0 seen across relays.
     */
    private void resolveAuthor(String pubkey, String relayUrl, ProfileCallback cb) {
        long now = System.currentTimeMillis();
        ProfileStore.Entry held = profileStore.get(pubkey);
        if (held != null) {
            cb.onProfile(new Profile(held.name, held.picture, held.nip05, held.ts));
            // Stale-while-revalidate: refresh in the background so names stay
            // current without delaying this notification — but only when no
            // fetch is in flight, since piggybacking would hold the
            // notification behind the in-flight timeout for no benefit.
            if (profileStore.isStale(pubkey, now, PROFILE_STALE_MS)
                    && !pendingProfiles.containsKey(pubkey)) {
                startProfileFetch(pubkey, profile -> { /* silent refresh */ });
            }
            return;
        }
        // The shared database next: the WebView may already hold this author's
        // kind-0 (its own fetches land in the same store). Checked BEFORE the
        // negative cache so a profile the webview fetched after our miss still
        // resolves. A hit seeds
        // the profile store, so subsequent lookups (and stale-while-revalidate
        // bookkeeping) work as usual.
        try {
            String raw = ServiceStore.profileRaw(this, pubkey);
            if (raw != null) {
                Profile fromDb = parseProfile(new JSONObject(raw));
                profileStore.put(pubkey, fromDb.name, fromDb.picture, fromDb.nip05,
                        fromDb.ts, now);
                markProfilesDirty();
                cb.onProfile(fromDb);
                return;
            }
        } catch (Exception e) {
            // Unreadable row — fall through to the network path.
        }
        if (profileStore.isFreshMiss(pubkey, now, PROFILE_MISS_TTL_MS)) {
            // A recent fetch found no kind-0 for this author — fire name-less
            // instead of re-broadcasting to every relay on every message.
            cb.onProfile(null);
            return;
        }
        startProfileFetch(pubkey, cb);
    }

    /**
     * Broadcast a one-shot kind-0 fetch for {@code pubkey} to every open relay
     * (originating relay first), coalescing concurrent callers onto one in-
     * flight fetch, with a {@link #PROFILE_TIMEOUT_MS} fallback resolution.
     */
    private void startProfileFetch(String pubkey, ProfileCallback cb) {
        List<ProfileCallback> waiters = pendingProfiles.get(pubkey);
        if (waiters != null) {
            waiters.add(cb); // a fetch is already in flight; piggyback on it
            return;
        }
        waiters = new ArrayList<>();
        waiters.add(cb);
        pendingProfiles.put(pubkey, waiters);

        // Broadcast to every connected relay (originating relay first), not just
        // the one the message arrived on.
        boolean sentAny = false;
        for (RelayConnection rc : connections) {
            if (rc.ws != null && !rc.closed) {
                rc.fetchProfile(pubkey);
                sentAny = true;
            }
        }
        if (!sentAny) {
            // Nothing was actually asked (no connections) — NOT a genuine
            // miss, so don't negative-cache it; just fire name-less.
            resolveProfile(pubkey, null);
            return;
        }
        // Fallback if no relay answers in time (no kind-0 / slow): resolve with
        // the best profile gathered so far. A genuine nothing-found is
        // negative-cached so this author's next message doesn't re-broadcast.
        handler.postDelayed(() -> {
            if (pendingProfiles.containsKey(pubkey)) {
                Profile best = bestProfile.get(pubkey);
                if (best == null) resolveProfileMiss(pubkey);
                else resolveProfile(pubkey, best);
            }
        }, PROFILE_TIMEOUT_MS);
    }

    /** Cache the result (if any) and flush all pending waiters for this pubkey. */
    private void resolveProfile(String pubkey, Profile profile) {
        if (profile != null) {
            profileStore.put(pubkey, profile.name, profile.picture, profile.nip05,
                    profile.ts, System.currentTimeMillis());
            markProfilesDirty();
        }
        bestProfile.remove(pubkey);
        // Close any profile subs still open for this pubkey on the other relays
        // we broadcast to, so they don't linger.
        for (RelayConnection rc : connections) {
            String subId = rc.profilePrefix + shortKey(pubkey);
            rc.profileLookups.remove(subId);
            rc.closeSub(subId);
        }
        List<ProfileCallback> waiters = pendingProfiles.remove(pubkey);
        if (waiters == null) return;
        for (ProfileCallback cb : waiters) {
            cb.onProfile(profile);
        }
    }

    /**
     * A fetch that genuinely found no kind-0 (an empty EOSE, or the timeout
     * with nothing gathered): negative-cache it so this author's messages
     * don't re-broadcast to every relay for {@link #PROFILE_MISS_TTL_MS}.
     */
    private void resolveProfileMiss(String pubkey) {
        profileStore.putMiss(pubkey, System.currentTimeMillis());
        markProfilesDirty();
        resolveProfile(pubkey, null);
    }

    /** Schedule a debounced persist of the profile store (bursts write once). */
    private void markProfilesDirty() {
        if (profilePersistScheduled) return;
        profilePersistScheduled = true;
        handler.postDelayed(() -> {
            profilePersistScheduled = false;
            persistProfiles();
        }, PROFILE_PERSIST_DEBOUNCE_MS);
    }

    private void persistProfiles() {
        profileStore.evictOldest(PROFILE_STORE_MAX);
        getSharedPreferences(PROFILES_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(PROFILES_KEY, profileStore.serialize())
                .apply();
    }

    /**
     * If {@code sub} is one of our one-shot DM-inbox lookups, return the
     * pubkey it was issued for; otherwise null.
     */
    private String inboxPubkeyForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String pk = rc.inboxLookups.get(sub);
            if (pk != null) return pk;
        }
        return null;
    }

    private void closeInboxSub(String relayUrl, String sub) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.inboxLookups.remove(sub);
                rc.closeSub(sub);
                return;
            }
        }
    }

    private interface InboxCallback {
        void onRelays(List<String> relays);
    }

    /**
     * Resolve {@code pubkey}'s published NIP-17 inbox relays (kind-10050
     * `relay` tags): the shared store first (the WebView caches peers' lists
     * there), else a one-shot broadcast REQ to every open relay, gathering the
     * newest list for {@link #DM_INBOX_TIMEOUT_MS}. Resolves with an EMPTY
     * list when the peer has published none, which is not by itself a failure:
     * {@link #sendDmReply} unions our own DM relays in, as the WebView's
     * `publishRumor` does, so a peer who never published a 10050 is still
     * reachable wherever we both read.
     */
    private void resolveDmInbox(String pubkey, InboxCallback cb) {
        List<String> cached = ServiceStore.dmInboxRelays(this, pubkey);
        if (cached != null && !cached.isEmpty()) {
            cb.onRelays(cached);
            return;
        }
        boolean sentAny = false;
        for (RelayConnection rc : connections) {
            if (rc.ws != null && !rc.closed) {
                rc.fetchDmInbox(pubkey);
                sentAny = true;
            }
        }
        if (!sentAny) {
            cb.onRelays(new ArrayList<>());
            return;
        }
        handler.postDelayed(() -> {
            JSONObject best = bestInbox.remove(pubkey);
            List<String> relays = new ArrayList<>();
            if (best != null) {
                // Cache the list (main tenant, replaceable) so the next reply
                // to this peer skips the wait.
                ServiceStore.cache(this, best);
                JSONArray tags = best.optJSONArray("tags");
                if (tags != null) {
                    for (int i = 0; i < tags.length(); i++) {
                        JSONArray tag = tags.optJSONArray(i);
                        if (tag != null && "relay".equals(tag.optString(0)) && tag.length() > 1) {
                            String u = tag.optString(1);
                            if (!u.isEmpty() && !relays.contains(u)) relays.add(u);
                        }
                    }
                }
            }
            cb.onRelays(relays);
        }, DM_INBOX_TIMEOUT_MS);
    }

    private RelayConnection connectionFor(String relayUrl) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl) && rc.ws != null) return rc;
        }
        return null;
    }

    /**
     * Advance one relay's live cursor without letting another relay — or a
     * validly signed event with a far-future timestamp — move it. `since` is
     * inclusive, so retaining the maximum observed second (not +1) preserves
     * later same-second and out-of-order delivery; notifiedIds absorbs overlap.
     */
    private void advanceRelaySince(String relayUrl, long eventCreatedAtSec) {
        RelayConnection rc = connectionFor(relayUrl);
        long commit = rc != null ? rc.cursorGate.onEvent(eventCreatedAtSec) : eventCreatedAtSec;
        if (commit >= 0) commitRelaySince(relayUrl, commit);
    }

    private void commitRelaySince(String relayUrl, long eventCreatedAtSec) {
        long nowSec = System.currentTimeMillis() / 1000;
        Long saved = relaySinceByUrl.get(relayUrl);
        long current = saved != null ? saved : nowSec;
        long next = advanceInclusiveSince(current, eventCreatedAtSec, nowSec);
        relaySinceByUrl.put(relayUrl, next);
        relayCursorsWithEvents.add(relayUrl);
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.sinceSec = next;
                rc.cursorHasEvent = true;
            }
        }
    }

    /**
     * The NIP-17 notify floor for a reconnect: the second the live sub dropped
     * (less slack) when the gap was long enough to replay, else 0 (live-only).
     */
    static long dm17CatchUpFloorSec(Long liveUntilMs, long nowMs) {
        if (liveUntilMs == null || nowMs - liveUntilMs <= DM17_CATCHUP_MIN_GAP_MS) return 0;
        return Math.max(1, liveUntilMs / 1000 - DM17_CATCHUP_SLACK_SEC);
    }

    /**
     * Whether an arriving self document counts toward its relay's flood breaker.
     * One the window replays ({@code windowClosed}) was counted when staged.
     */
    static boolean countsTowardSelfFlood(boolean selfLive, boolean windowClosed) {
        return selfLive && !windowClosed;
    }

    /**
     * Whether a flood pause's resume timer, firing now, re-opens the self sub.
     * {@code scheduledUntil} is the breaker's pause end when the timer was set;
     * a different one now means an account switch reset the breaker or a later
     * pause owns the resume. An open sub was already re-sent by a reconnect.
     */
    static boolean resumesSelfAfterPause(
            boolean socketUp, boolean selfSubOpen, long scheduledUntil, long breakerPausedUntil) {
        return socketUp && !selfSubOpen && scheduledUntil == breakerPausedUntil;
    }

    /** Whether a network callback concerns the default network. */
    static boolean isDefaultNetwork(Object network, Object defaultNetwork) {
        return network != null && network.equals(defaultNetwork);
    }

    static String selfCursorKey(String pubkey, String relayUrl) {
        return "self|" + pubkey + "|" + relayUrl;
    }

    /** The cursor owner of the derived-document filter: the account plus its author set. */
    private String derivedCursorOwner() {
        return userPubkey + "#" + selfDocsFingerprint;
    }

    /** A persisted self-state cursor to resume from, or null for a full read. */
    static Long persistedSelfSince(long savedSec, long nowSec) {
        if (savedSec <= 0 || savedSec > nowSec || nowSec - savedSec > SELF_SINCE_MAX_AGE_SEC) return null;
        return savedSec;
    }

    /** Disable/logout: no cursor may carry into another account's reads. */
    static void clearPersistedCursors(Context ctx) {
        ctx.getSharedPreferences(CURSOR_PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    /** Pure cursor transition for JVM regression coverage. */
    static long advanceInclusiveSince(
            long currentSinceSec, long eventCreatedAtSec, long nowSec) {
        if (nowSec < 0L) return currentSinceSec;
        // Recover as well if the wall clock moved backwards after a prior
        // sample. Replaying a little is safe; a cursor in the future is not.
        long safeCurrent = Math.min(currentSinceSec, nowSec);
        if (eventCreatedAtSec < 0L) return safeCurrent;
        long safeEvent = Math.min(eventCreatedAtSec, nowSec);
        return Math.max(safeCurrent, safeEvent);
    }

    /** REQ cursor: no cold-start rewind; bounded overlap after first event. */
    static long subscriptionSince(long cursorSec, boolean cursorHasEvent) {
        return cursorHasEvent
                ? Math.max(0L, cursorSec - RELAY_SINCE_OVERLAP_SEC)
                : Math.max(0L, cursorSec);
    }

    private void rememberNotificationId(String id) {
        rememberBoundedId(notifiedIds, id, MAX_NOTIFIED_IDS);
    }

    /**
     * A REQ's filters as a comparable string, with `since` left out — it moves
     * with every event received, and a changed cursor alone is no reason to
     * re-send a live subscription.
     */
    static String filtersWithoutSince(JSONObject... filters) {
        StringBuilder out = new StringBuilder();
        for (JSONObject f : filters) {
            JSONObject copy = new JSONObject();
            java.util.Iterator<String> keys = f.keys();
            List<String> sorted = new ArrayList<>();
            while (keys.hasNext()) sorted.add(keys.next());
            java.util.Collections.sort(sorted);
            for (String k : sorted) {
                if (k.equals("since")) continue;
                try {
                    copy.put(k, f.get(k));
                } catch (JSONException ignored) {
                    // Keys came from the object itself.
                }
            }
            out.append(copy).append('\u0000');
        }
        return out.toString();
    }

    /**
     * Whether a CLOSED / OK message is NIP-42's `auth-required:`. Relays put
     * the machine-readable prefix first, but some wrap it (strfry-family and
     * damus send `ERROR: auth-required: …`); missing the wrapped form would
     * retry an auth wall on a backoff forever, each retry a full AUTH round.
     */
    static boolean isAuthRequired(String reason) {
        if (reason == null) return false;
        String r = reason.trim();
        if (r.regionMatches(true, 0, "error:", 0, 6)) r = r.substring(6).trim();
        return r.startsWith("auth-required:");
    }

    /**
     * The replaceable coordinate of one of the user's own documents: the kind,
     * plus author and `d` for an addressable kind. The author matters there: a
     * settings document may be signed by a key derived from the settings root.
     */
    static String selfCoordinateOf(JSONObject event, int kind) {
        if (kind < 30000 || kind >= 40000) return Integer.toString(kind);
        String prefix = kind + ":" + event.optString("pubkey") + ":";
        JSONArray tags = event.optJSONArray("tags");
        if (tags != null) {
            for (int i = 0; i < tags.length(); i++) {
                JSONArray t = tags.optJSONArray(i);
                if (t != null && "d".equals(t.optString(0))) return prefix + t.optString(1);
            }
        }
        return prefix;
    }

    /** `pubkey|challenge` of a kind-22242, or null when it has neither. */
    static String authPairOf(JSONObject event) {
        String pubkey = event.optString("pubkey", "");
        JSONArray tags = event.optJSONArray("tags");
        if (pubkey.isEmpty() || tags == null) return null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray t = tags.optJSONArray(i);
            if (t != null && "challenge".equals(t.optString(0))) return pubkey + "|" + t.optString(1);
        }
        return null;
    }

    /** Pure bounded insertion-order set update for JVM regression coverage. */
    static void rememberBoundedId(
            LinkedHashSet<String> ids, String id, int maximum) {
        if (ids == null || id == null || id.isEmpty() || maximum <= 0) return;
        // Refresh an explicitly re-added id to the newest end. Ordinary relay
        // duplicates are rejected by contains() before here and stay cheap.
        ids.remove(id);
        ids.add(id);
        while (ids.size() > maximum) {
            java.util.Iterator<String> iterator = ids.iterator();
            if (!iterator.hasNext()) break;
            iterator.next();
            iterator.remove();
        }
    }

    /** Parse a kind-0 event's content into a {@link Profile}. */
    private static Profile parseProfile(JSONObject event) {
        long ts = event.optLong("created_at", 0);
        try {
            JSONObject meta = new JSONObject(event.optString("content", "{}"));
            String name = meta.optString("display_name", null);
            if (name == null || name.isEmpty()) {
                name = meta.optString("name", null);
            }
            if (name != null && name.isEmpty()) name = null;
            String picture = meta.optString("picture", null);
            if (picture != null && picture.isEmpty()) picture = null;
            String nip05 = meta.optString("nip05", null);
            if (nip05 != null && nip05.isEmpty()) nip05 = null;
            return new Profile(name, picture, nip05, ts);
        } catch (JSONException e) {
            return new Profile(null, null, null, ts);
        }
    }

    // ── Group name (kind 39000) resolution ────────────────────────────────────

    /**
     * If {@code sub} is one of our one-shot group-name lookups, return the group
     * id it was issued for; otherwise null. Recovered from each connection's
     * lookup map (the sub id itself only carries a truncated id, #50).
     */
    private String groupIdForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String gid = rc.groupLookups.get(sub);
            if (gid != null) return gid;
        }
        return null;
    }

    /** Parse a kind-39000 group-metadata event's name (the `name` tag). */
    private static String parseGroupName(JSONObject event) {
        return tagValue(event, "name");
    }

    /**
     * Resolve {@code groupId} to a display name, then invoke {@code cb} (always
     * on the handler thread). Serves from cache, else issues a kind-39000 REQ on
     * {@code relayUrl} and waits up to {@link #PROFILE_TIMEOUT_MS}.
     */
    private void resolveGroupName(String groupId, String relayUrl, GroupNameCallback cb) {
        String cached = groupNameCache.get(groupId);
        if (cached != null) {
            cb.onName(cached);
            return;
        }
        List<GroupNameCallback> waiters = pendingGroupNames.get(groupId);
        if (waiters != null) {
            waiters.add(cb);
            return;
        }
        waiters = new ArrayList<>();
        waiters.add(cb);
        pendingGroupNames.put(groupId, waiters);

        RelayConnection rc = connectionFor(relayUrl);
        if (rc == null) {
            resolveGroupName(groupId, (String) null);
            return;
        }
        rc.fetchGroupName(groupId);
        handler.postDelayed(() -> {
            if (pendingGroupNames.containsKey(groupId)) {
                resolveGroupName(groupId, (String) null);
            }
        }, PROFILE_TIMEOUT_MS);
    }

    /** Cache the name (if any) and flush all pending waiters for this group. */
    private void resolveGroupName(String groupId, String name) {
        if (name != null && !name.isEmpty()) {
            groupNameCache.put(groupId, name);
        }
        List<GroupNameCallback> waiters = pendingGroupNames.remove(groupId);
        if (waiters == null) return;
        for (GroupNameCallback cb : waiters) {
            cb.onName(name);
        }
    }

    // ── Event → notification ──────────────────────────────────────────────────

    /**
     * Open a Concord stream wrap with the supplied conversation key:
     * NIP-44-decrypt the wrap's {@code content} → the seal (kind 20013
     * encrypted / 20014 plaintext), recover the rumor (decrypting again for
     * 20013), and return it ({@code pubkey} = real author, {@code content} =
     * message). Best-effort: returns {@code null} on decrypt/parse failure or
     * if the seal signature is bad or the rumor's author/channel/epoch binding
     * doesn't match (a spliced/foreign payload).
     */
    private static ConcordOpen openConcord(JSONObject wrap, ConcordStream st) {
        try {
            String payload = wrap.optString("content", "");
            if (payload.isEmpty()) return null;
            String sealJson = ConcordCrypto.decrypt(st.convKey, payload);
            if (sealJson == null) return null;
            JSONObject seal = new JSONObject(sealJson);
            int sealKind = seal.optInt("kind", -1);
            // Chat seals MUST be encrypted (CORD-02 §5); the WebView and the
            // store refuse a plaintext one, so it must not notify either.
            if (sealKind != 20013) return null;
            // The seal is a signed event authored by the sender (the rumor
            // inside is unsigned and bound to it by pubkey equality below);
            // verify the seal's Schnorr signature, mirroring the WebView's
            // openWrap. The kind-1059 wrap's outer signature is a group-derived
            // stream key and proves no individual identity.
            if (!NostrCrypto.verifyEvent(seal)) return null;
            String rumorJson = ConcordCrypto.decrypt(st.convKey, seal.optString("content", ""));
            if (rumorJson == null) return null;
            JSONObject rumor = new JSONObject(rumorJson);
            // The rumor's author must equal the seal's signer (or a keyholder
            // could re-seal another member's rumor under their own name), and
            // the channel/epoch binding must match the stream that decrypted
            // the wrap (a spliced/foreign payload).
            String author = rumor.optString("pubkey");
            if (author.isEmpty() || !author.equals(seal.optString("pubkey"))) return null;
            // The id is the store key and what edits, replies and deletes name,
            // so a member choosing it could squat another member's message
            // (the WebView's openWrapToSeal refuses the same rumor).
            if (!NostrCrypto.rumorIdMatches(rumor)) return null;
            // Absent binding fails CLOSED, matching the WebView's
            // checkChannelBinding: every chat rumor it will accept carries both
            // tags, so requiring them here can only drop what it drops too —
            // and keeps the notification from naming a channel the payload
            // never committed to.
            // Exactly one of each, as the WebView's uniqueTag requires.
            String ch = uniqueTagValue(rumor, "channel");
            String ep = uniqueTagValue(rumor, "epoch");
            if (ch == null || !st.channelId.equals(ch)) return null;
            if (ep == null || st.epoch.isEmpty() || !st.epoch.equals(ep)) return null;
            return new ConcordOpen(rumor, sealKind);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * A recovered Concord rumor and the kind of the seal it arrived in. The
     * seal form is not stored, so it has to survive the open for the store's
     * encrypted-seal rule ({@code Concord.storable}) to check it at ingest.
     */
    private static final class ConcordOpen {
        final JSONObject rumor;
        final int sealKind;
        ConcordOpen(JSONObject rumor, int sealKind) {
            this.rumor = rumor;
            this.sealKind = sealKind;
        }
    }

    /**
     * Notify for a NIP-17 gift wrap (kind 1059) addressed to the user. With a
     * shared signer credential (NativeSigner: nsec key, Amber grant, or NIP-46
     * session) the wrap is opened wrap → seal → rumor exactly like the
     * WebView's openDmWrap, for a full "<sender>: <preview>" notification;
     * non-DM rumor kinds (Concord invites, reactions, deletes) and our own
     * sent copies stay silent. Only when the signer is absent or UNREACHABLE
     * (Amber grant missing, bunker offline) does it degrade to a generic
     * "New direct message".
     *
     * Dedupe is {@code storedBefore} (the shared event DB): a wrap either
     * side EVER stored — a previous service incarnation, the WebView's inbox
     * sync, or our own just-published self-copy — never re-notifies. That
     * floor survives service restarts, unlike notifiedIds, and covers relays
     * that ignore the filter's {@code limit: 0} and replay the rewound
     * `since` window on reconnect.
     */
    private void handleDm17Wrap(JSONObject wrap, String id, String relayUrl, boolean storedBefore) {
        RelayConnection via = connectionFor(relayUrl);
        final long notifyFloorSec = via != null && via.dm17CatchingUp ? via.dm17NotifyFloorSec : 0;
        // Only wraps addressed to me are DMs — the Concord authors-scoped
        // subscription also delivers kind 1059, with no `p` tag at us.
        if (!isMentioned(wrap, userPubkey)) return;
        rememberNotificationId(id);
        if (storedBefore) return;
        // NIP-40: a disappearing message whose deadline has already passed is
        // not delivered at all — neither notified nor stored. Mirrors
        // openDmWrap, which refuses an expired envelope before it decrypts
        // anything.
        if (ServiceStore.isExpired(wrap)) return;

        NativeSigner signer = nativeSigner;
        if (signer == null) {
            // An opaque wrap cannot be attributed to an exact override. Only
            // the global fallback may authorize an unattributed lock-screen ping.
            if (notifyFloorSec == 0 && prefBool("directMessages", true)) notifyOpaqueDm17();
            return;
        }
        // Open the wrap with the user's signer (async — Amber/bunker are RPC).
        // Mirrors openDmWrap's checks: seal kind 13, rumor author == seal
        // signer (NIP-59 anti-spoof; the NIP-44 AEAD already authenticated the
        // seal against us).
        signer.decrypt44(wrap.optString("pubkey"), wrap.optString("content"), (sealJson, unavailable) -> {
            if (sealJson == null) {
                // Crypto says no → not a readable DM (foreign protocol,
                // garbage): silent. Signer unreachable → still tell the user
                // SOMETHING arrived.
                if (unavailable && notifyFloorSec == 0 && prefBool("directMessages", true)) notifyOpaqueDm17();
                return;
            }
            try {
                JSONObject seal = new JSONObject(sealJson);
                if (seal.optInt("kind", -1) != 13) return;
                // The seal is signed by the sender's identity key (NIP-17);
                // verify it so a relay-supplied forgery can't misattribute a DM.
                if (!NostrCrypto.verifyEvent(seal)) return;
                // The seal carries the rumor's deadline too, so a reader learns
                // it without having to trust the relay-visible wrap.
                if (ServiceStore.isExpired(seal)) return;
                final String peer = seal.optString("pubkey", "");
                if (peer.length() != 64) return;
                if (peer.equals(userPubkey)) { // our own sent copy
                    handler.post(this::noteOtherDeviceActivity);
                    return;
                }
                signer.decrypt44(peer, seal.optString("content", ""), (rumorJson, unavailable2) -> {
                    if (rumorJson == null) {
                        if (unavailable2 && notifyFloorSec == 0 && prefBool("directMessages", true)) notifyOpaqueDm17();
                        return;
                    }
                    try {
                        JSONObject rumor = new JSONObject(rumorJson);
                        if (!peer.equals(rumor.optString("pubkey"))) return;
                        // Recompute the id before anything is filed under it:
                        // it is what the store keys the rumor by and what a
                        // NIP-09 delete matches, so a sender-chosen one is
                        // never taken on trust.
                        if (!stampRumorId(rumor)) return;
                        // Store EVERY DM-plane kind, not just the ones that
                        // notify: reactions, deletes and timer changes are part
                        // of the conversation the app reads back. The store
                        // applies the rest of the rules (kind, expiry, peer).
                        ServiceStore.storeDm17Rumor(this, userPubkey, rumor);
                        // Everything above is the STORE's business and happens
                        // whatever the notification prefs say — the wrap was
                        // subscribed for, received and opened, and dropping the
                        // plaintext would only make the app decrypt it again.
                        // Chat/file messages only — reactions (7), deletes (5)
                        // and foreign rumor kinds (Concord invites) stay
                        // silent, matching the WebView's DM rumor kinds.
                        final int rumorKind = rumor.optInt("kind", -1);
                        if (rumorKind != 14 && rumorKind != 15) return;
                        // A NIP-17 conversation is its PARTICIPANT SET, not its
                        // sender (nip17/conversation.ts). Derive that identity
                        // before the trust/request boundary: an authored group
                        // trusts that exact group without making each member a
                        // trusted sender in unrelated 1:1 conversations.
                        //
                        // The key is built out of `p` values the sender chose,
                        // and it decides the room key, the read marker and the
                        // path a tap navigates to — an unchecked one splices
                        // whatever it likes, `?` included, into "/dm/" + room,
                        // and the router hands everything after it to
                        // location.search. So it is CHECKED rather than assumed,
                        // the same way isDmConvKey already gates the reply
                        // action. The seal author is 64-hex by construction (its
                        // signature was verified above), so the `peer` fallback
                        // is always a well-formed key.
                        final String convKey = ServiceStore.dm17ConvKey(userPubkey, rumor);
                        final String room = convKey != null && isDmConvKey(convKey) ? convKey : peer;
                        final List<String> convPeers = ServiceStore.dm17ConvPeers(room);
                        // Existing DM semantics hide a whole group if ANY
                        // participant is muted. Checking only the current author
                        // would let a different member notify for a hidden room.
                        if (dmConversationMuted(convPeers, dmMutedPeers)) return;
                        // Exact conversation policy outranks the account-global
                        // toggle in both directions. `mentions` equals `all` for
                        // a DM; every message is directed at the recipient.
                        if (!dmNotificationEnabled(room)) return;
                        // A catch-up replay notifies only what the gap hid.
                        if (notifyFloorSec > 0 && rumor.optLong("created_at", 0) < notifyFloorSec) return;

                        // Unknown conversation — neither this exact participant
                        // set nor every one of its peers is established. A
                        // stranger picks the message text, display name and avatar
                        // that a full notification would put on the lock screen.
                        // `dmRequests` decides how much reaches it; the rumor is
                        // already stored, so the request remains in-app on open.
                        if (!dmConversationKnown(room, convPeers,
                                dmKnownPeers, dmKnownConversations)) {
                            if ("off".equals(dmRequests)) return;
                            if (!"full".equals(dmRequests)) { // "generic" / unset
                                long reqTs = rumor.optLong("created_at", 0);
                                notifyDmRequest(reqTs > 0 ? reqTs * 1000L
                                        : System.currentTimeMillis());
                                return;
                            }
                            // "full" falls through and notifies like a friend.
                        }
                        final boolean group = convPeers.size() > 1;
                        final String preview =
                                rumorKind == 15 ? str(R.string.notif_sent_file) : messagePreview(rumor);
                        final long rts = rumor.optLong("created_at", 0);
                        final long fTs = (rts > 0 ? rts * 1000L : System.currentTimeMillis());
                        resolveAuthor(peer, relayUrl, profile -> {
                            String name = authorName(profile);
                            String picture = profile != null ? profile.picture : null;
                            String line = preview.isEmpty() ? str(R.string.notif_sent_direct_message) : preview;
                            if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm17 (signer) from=" + name);
                            // A group's title is the room, not the last speaker
                            // — MessagingStyle already names the sender on the
                            // line itself. A 1:1 keeps the peer's name as the
                            // title, which is what makes it render as a 1:1.
                            String title = group ? dmGroupTitle(convPeers) : name;
                            // mention=false: a DM is suppressed while its own
                            // thread is on screen (the peer isn't known until
                            // decrypt, so enqueueRoomMessage's active-room gate
                            // does it here rather than a synchronous pre-check).
                            enqueueRoomMessage(/*community=*/null, "dm:" + room, title,
                                    appendMessageSegment(dmRoute(room), rumor.optString("id", "")),
                                    peer, name, picture, line, fTs, /*mention=*/false);
                        });
                    } catch (Exception ignored) {
                        // Malformed rumor JSON — silent.
                    }
                });
            } catch (Exception ignored) {
                // Malformed seal JSON — silent.
            }
        });
    }

    /** Reject rumors claiming to be from further in the future than this. */
    private static final long MAX_FUTURE_SKEW_SECS = 3600;

    /**
     * How far ahead of the local clock a chat rumor may be dated before it is
     * HELD — stored, but not announced — until its time passes. Mirrors the
     * web/desktop fold's FUTURE_HOLD_MS (src/concord/lib/stream.ts): a message
     * the timeline hides for being "in the future" must not buzz here either,
     * or the reader gets a notification (stamped "in 5m" from its future
     * created_at) about a message they can't yet see. A small grace, so
     * ordinary sub-second clock jitter between honest clients doesn't flap —
     * NOT the hour of ingest skew NIP-17 tolerates (MAX_FUTURE_SKEW_SECS).
     */
    private static final long FUTURE_HOLD_MS = 5_000;

    /**
     * Verify a decrypted rumor's NIP-01 id — filling it in when the payload
     * omitted one — and reject a rumor dated too far ahead. Mirrors the checks
     * openDmWrap makes before it hands a rumor to the store.
     *
     * The id matters more here than it looks: it is the key the store holds the
     * rumor under and the thing a NIP-09 delete names, so a sender who could
     * choose it could make their message collide with — or delete — something
     * else in the conversation.
     */
    private static boolean stampRumorId(JSONObject rumor) {
        String pubkey = rumor.optString("pubkey", "");
        JSONArray tags = rumor.optJSONArray("tags");
        if (pubkey.isEmpty() || tags == null) return false;
        if (!(rumor.opt("kind") instanceof Number)) return false;
        if (!(rumor.opt("created_at") instanceof Number)) return false;
        if (!(rumor.opt("content") instanceof String)) return false;

        int kind = rumor.optInt("kind", -1);
        long createdAt = rumor.optLong("created_at", -1);
        if (kind < 0 || createdAt < 0) return false;
        if (createdAt > System.currentTimeMillis() / 1000 + MAX_FUTURE_SKEW_SECS) return false;

        String computed = NostrCrypto.eventId(pubkey, createdAt, kind, tags, rumor.optString("content"));
        String claimed = rumor.optString("id", "");
        if (!claimed.isEmpty() && !claimed.equals(computed)) return false;

        try {
            rumor.put("id", computed);
        } catch (JSONException e) {
            return false;
        }
        return true;
    }

    /**
     * An ephemeral (kind 21059) DM wrap: the envelope voice-call signals ride
     * (src/lib/dmCall.ts) — sealed and wrapped exactly like a durable NIP-17
     * message, but broadcast-only, so no record that a call happened ever
     * rests on a relay. Opened with the shared signer; anything that isn't a
     * call rumor (typing indicators share the filter) is discarded after
     * decrypt. Our OWN signals arrive here too via the self copy, which is
     * how ringing stops on this device when the call was answered or
     * declined on another.
     */
    private void handleDmEphemeralWrap(JSONObject wrap, String relayUrl) {
        NativeSigner signer = nativeSigner;
        if (signer == null) return;
        signer.decrypt44(wrap.optString("pubkey"), wrap.optString("content"), (sealJson, unavailable) -> {
            if (sealJson == null) return;
            try {
                JSONObject seal = new JSONObject(sealJson);
                if (seal.optInt("kind", -1) != 13) return;
                // The seal is the sender's real signature (NIP-17); verify so
                // a relay-supplied forgery can't ring the phone as a friend.
                if (!NostrCrypto.verifyEvent(seal)) return;
                final String author = seal.optString("pubkey", "");
                if (author.length() != 64) return;
                signer.decrypt44(author, seal.optString("content", ""), (rumorJson, unavailable2) -> {
                    if (rumorJson == null) return;
                    try {
                        JSONObject rumor = new JSONObject(rumorJson);
                        if (!author.equals(rumor.optString("pubkey"))) return;
                        if (!stampRumorId(rumor)) return;
                        if (rumor.optInt("kind", -1) != KIND_DM_CALL) return;
                        if (author.equals(userPubkey)) {
                            // Our own signal from another device: an answer or
                            // decline elsewhere stops this device's ring. An
                            // offer means that device is dialing the `p` peer
                            // and owns any collision with them.
                            String phase = rumor.optString("content", "");
                            if ("offer".equals(phase) || "end".equals(phase)) {
                                final String dialed = tagValue(rumor, "p");
                                final String dialCallId = tagValue(rumor, "call");
                                final long dialAtMs = rumor.optLong("created_at", 0) * 1000L;
                                handler.post(() -> noteSiblingDial(phase, dialed, dialCallId, dialAtMs));
                                return;
                            }
                            if (!"answer".equals(phase) && !"decline".equals(phase)) return;
                            final String ownCallId = tagValue(rumor, "call");
                            if (ownCallId != null) {
                                handler.post(() -> cancelIncomingCall(ownCallId, /*missed=*/false));
                            }
                            return;
                        }
                        handler.post(() -> handleDmCallRumor(author, rumor, relayUrl));
                    } catch (Exception ignored) {
                        // Malformed rumor JSON — silent.
                    }
                });
            } catch (Exception ignored) {
                // Malformed seal JSON — silent.
            }
        });
    }

    /**
     * Whether {@code peer} may ring this device: the same "known DM peer" set
     * the inbox/request split uses (follows ∪ messaged/accepted ∪ pinned),
     * muted peers excluded — the mirror of the WebView's {@code useKnownDmPeers}
     * gate, so a call rings in exactly the conversations that land in the inbox
     * rather than the request tier. A cold stranger is refused: they control the
     * name and picture a full-screen ring would put on the lock screen. For a
     * 1:1 the conversation key IS the peer pubkey, so a pinned/authored 1:1 is
     * caught by {@code dmKnownConversations}; {@code dmFollows} is kept in the OR
     * so a populated follow set still rings even before the broader set syncs.
     */
    private boolean dmCallAllowed(String peer) {
        if (peer == null || dmMutedPeers.contains(peer)) return false;
        return dmFollows.contains(peer)
                || dmKnownPeers.contains(peer)
                || dmKnownConversations.contains(peer);
    }

    /**
     * A sibling device's own offer ("offer") or its withdrawal ("end"). A fresh
     * offer marks its peer as owned elsewhere and stops a ring this device may
     * already have up for that peer — silently, since it is the same call
     * attempt seen from the other side, not a missed one. Handler thread only.
     */
    private void noteSiblingDial(String phase, String peer, String callId, long atMs) {
        if (peer == null || peer.length() != 64 || callId == null) return;
        if ("end".equals(phase)) {
            if (callId.equals(siblingDialCallId)) {
                siblingDialPeer = null;
                siblingDialCallId = null;
            }
            return;
        }
        long age = System.currentTimeMillis() - atMs;
        if (age > CALL_RING_WINDOW_MS || age < -CALL_RING_WINDOW_MS) return;
        siblingDialPeer = peer;
        siblingDialCallId = callId;
        siblingDialAtMs = atMs;
        if (peer.equals(ringingPeer) && ringingCallId != null) {
            cancelIncomingCall(ringingCallId, /*missed=*/false);
        }
    }

    /**
     * Fold one opened voice-call rumor (kind 23314, from the peer) into the
     * ring state. Handler thread only (callers post here).
     *
     * An "offer" RINGS — full-screen CallStyle notification with the device
     * ringtone — but only when it is FRESH (its real created_at inside
     * {@link #CALL_RING_WINDOW_MS}; an ephemeral event only ever arrives
     * moments after send, so anything outside the window is clock skew or
     * forgery) and its author is an established DM peer: the caller
     * controls the name a ring would put on the lock screen, so a stranger
     * must not be able to make the phone ring on demand. A fresh offer for a
     * thread the WebView is showing is left to the in-app ring.
     * "answer"/"decline" dismiss the ring; "end" while ringing is the caller
     * giving up — a missed call.
     */
    private void handleDmCallRumor(String peer, JSONObject rumor, String relayUrl) {
        final String phase = rumor.optString("content", "");
        final String callId = tagValue(rumor, "call");
        if (!validHex(callId)) return;
        final long tsMs = rumor.optLong("created_at", 0) * 1000L;
        if ("offer".equals(phase)) {
            if (!dmNotificationEnabled(peer)) return;
            if (!dmCallAllowed(peer)) return;
            long age = System.currentTimeMillis() - tsMs;
            if (age > CALL_RING_WINDOW_MS || age < -CALL_RING_WINDOW_MS) return;
            // The Answer action must hand the WebView everything it needs to
            // join: the offer is ephemeral, so a cold-started app can never
            // re-fetch it. No secret/broker ⇒ nothing to answer with.
            final String secret = tagValue(rumor, "secret");
            final String broker = tagValue(rumor, "broker");
            if (secret == null || secret.length() != 64) return;
            if (broker == null || !broker.startsWith("https://")) return;
            if (freshActiveRoomKeys().contains("dm:" + peer)) return;
            if (dismissedRingCallIds.contains(callId)) return;
            // The WebView (or another device of ours) is already dialing or in
            // a call with this peer: their offer is the other half of it — two
            // people dialing each other — which the WebView settles. Ringing
            // here would end in a false "Missed call" when it is withdrawn.
            if (callOwnedElsewhere(peer)) return;
            postIncomingCall(peer, callId, secret, broker, relayUrl, tsMs);
        } else if ("answer".equals(phase) || "decline".equals(phase)) {
            cancelIncomingCall(callId, /*missed=*/false);
        } else if ("end".equals(phase)) {
            cancelIncomingCall(callId, /*missed=*/true);
        }
    }

    /** Post the full-screen incoming-call notification for a fresh offer. */
    private void postIncomingCall(String peer, String callId, String secret, String broker,
                                  String relayUrl, long tsMs) {
        ringingCallId = callId;
        ringingPeer = peer;
        // Everything the WebView needs to join, recorded where only this app
        // can read it. It is NOT put in the Answer action's URL: a URL is a
        // hint that a call was answered, never the proof, because every surface
        // the router is reachable on can produce one. The vetting that makes
        // this an authorization already happened above — fresh, a known peer, with
        // a well-formed secret and an https broker.
        final String answerToken =
                ArmadaNotificationPlugin.setCallAnswer(this, callId, peer, secret, broker, tsMs);
        resolveAuthor(peer, relayUrl, profile -> {
            // Cancelled (or replaced) while the profile resolved.
            if (!callId.equals(ringingCallId)) return;
            String name = authorName(profile);
            Person caller = new Person.Builder().setKey(peer).setName(name).build();

            // Answer: deep-link into the conversation naming the call, and
            // NOTHING ELSE. The offer rode an ephemeral wrap, so a cold-started
            // WebView can never re-fetch it — but the secret and broker travel
            // through ArmadaNotificationPlugin#consumeCallAnswer, which only
            // this app can read, rather than in the URL. A tap is then a
            // request to answer a specific call; whether that call is one the
            // service actually rang is answered by the ticket, not by the link.
            // Only this action carries the answer token.
            String ringPath = dmRoute(peer) + "?call=" + uriEncode(callId);
            Intent answer = deepLinkIntent(answerToken != null
                    ? ringPath + "&answer=" + uriEncode(answerToken)
                    : ringPath);
            answer.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent answerPi = PendingIntent.getActivity(
                    this, INCOMING_CALL_NOTIF_ID, answer,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            // Body tap: rings in-app, no token.
            Intent open = deepLinkIntent(ringPath);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent openPi = PendingIntent.getActivity(
                    this, INCOMING_CALL_NOTIF_ID + 2, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            // Decline: handled by the service itself (no WebView needed) —
            // dismisses the ring and publishes the decline rumor.
            Intent decline = new Intent(this, NotificationRelayService.class);
            decline.setAction(ACTION_DECLINE_CALL);
            decline.setData(Uri.parse("armada-call-decline:" + callId));
            decline.putExtra(EXTRA_CALL_ID, callId);
            decline.putExtra(EXTRA_CALL_PEER, peer);
            PendingIntent declinePi = PendingIntent.getService(
                    this, INCOMING_CALL_NOTIF_ID + 1, decline,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            // Ring only as long as the offer stays fresh; the caller's own
            // give-up ("end") usually lands first and cancels explicitly.
            long timeout = Math.max(5_000, tsMs + CALL_RING_WINDOW_MS - System.currentTimeMillis());

            // Full-screen fires untapped: the lock-screen ringer, not MainActivity.
            Intent ringer = new Intent(this, IncomingCallActivity.class);
            ringer.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
            ringer.putExtra(EXTRA_CALL_ID, callId);
            ringer.putExtra(IncomingCallActivity.EXTRA_NAME, name);
            ringer.putExtra(IncomingCallActivity.EXTRA_RING_UNTIL_MS, System.currentTimeMillis() + timeout);
            ringer.putExtra(IncomingCallActivity.EXTRA_ANSWER, answer);
            ringer.putExtra(IncomingCallActivity.EXTRA_DECLINE, decline);
            PendingIntent ringerPi = PendingIntent.getActivity(
                    this, INCOMING_CALL_NOTIF_ID + 3, ringer,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CALL_CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_armada)
                    .setContentTitle(name)
                    .setContentText(str(R.string.notif_incoming_call))
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setWhen(tsMs)
                    .setTimeoutAfter(timeout)
                    .setContentIntent(openPi)
                    // The full phone-call surface: on a locked/idle device the
                    // activity launches full screen; unlocked it heads-up.
                    .setFullScreenIntent(ringerPi, true)
                    .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, answerPi));
            NotificationManager m = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            try {
                if (m != null) {
                    Notification ring = b.build();
                    // Loop the ringtone and vibration until the ring is cancelled.
                    ring.flags |= Notification.FLAG_INSISTENT;
                    m.notify(INCOMING_CALL_NOTIF_ID, ring);
                    healthLastPresentedAtMs = System.currentTimeMillis();
                    // The caller's "it rang" receipt — what turns their
                    // timeout into "No answer" rather than "Couldn't reach".
                    // Only reached for a peer dmCallAllowed admitted, and
                    // only sent when it can be signed without a prompt.
                    if (maySendCallReceipt(nativeSigner)
                            && callReceiptGate.admit(peer, callId, System.currentTimeMillis())) {
                        publishCallSignal(peer, callId, "ringing", /*selfCopy=*/false);
                    }
                }
            } catch (Exception e) {
                // CallStyle validation differs across OEM/API levels; a ring
                // that cannot post must still surface as a missed call.
                Log.w(TAG, "incoming-call notification failed", e);
                recordHealthError("post_call");
                notifyMissedCall(peer, relayUrl, tsMs);
            }
        });
    }

    /**
     * Whether an unsolicited call receipt may be signed with {@code signer}:
     * a local key only, as on the web — an Amber or bunker signature may
     * prompt, and a receipt is signed on the caller's say-so, not the user's.
     */
    static boolean maySendCallReceipt(NativeSigner signer) {
        return signer != null && signer.signsUnattended();
    }

    /** Dismiss the ringing notification for {@code callId}, if it is up. */
    private void cancelIncomingCall(String callId, boolean missed) {
        if (ringingCallId == null || !ringingCallId.equals(callId)) return;
        String peer = ringingPeer;
        ringingCallId = null;
        ringingPeer = null;
        // A call that is no longer ringing is not one an Answer tap may still
        // join — the ticket goes with the ring.
        ArmadaNotificationPlugin.clearCallAnswer(this, callId);
        NotificationManager m = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (m != null) m.cancel(INCOMING_CALL_NOTIF_ID);
        if (missed && peer != null) notifyMissedCall(peer, null, System.currentTimeMillis());
    }

    /** A call that ended un-answered: an ordinary line in the DM's thread notification. */
    private void notifyMissedCall(String peer, String relayUrl, long tsMs) {
        if (!dmNotificationEnabled(peer)) return;
        if (!dmCallAllowed(peer)) return;
        if (freshActiveRoomKeys().contains("dm:" + peer)) return;
        if (callOwnedElsewhere(peer)) return;
        resolveAuthor(peer, relayUrl, profile -> {
            String name = authorName(profile);
            String picture = profile != null ? profile.picture : null;
            enqueueRoomMessage(/*community=*/null, "dm:" + peer, name, dmRoute(peer),
                    peer, name, picture, str(R.string.notif_missed_call), tsMs, /*mention=*/true);
        });
    }

    /**
     * The incoming-call notification's Decline: dismiss the ring, then publish
     * a "decline" call rumor through the same NIP-17 envelope the quick reply
     * uses — peer copy to their inbox, self copy to our own DM relays so our
     * other (also ringing) devices stop too.
     */
    private void handleDeclineCall(Intent intent) {
        final String callId = intent.getStringExtra(EXTRA_CALL_ID);
        final String peer = intent.getStringExtra(EXTRA_CALL_PEER);
        if (callId != null) handler.post(() -> cancelIncomingCall(callId, /*missed=*/false));
        publishCallSignal(peer, callId, "decline", /*selfCopy=*/true);
    }

    /**
     * Publish one call rumor (kind 23314) through the ephemeral NIP-17
     * envelope: the peer's copy to their inbox ∪ our DM relays, and — for a
     * signal our other devices must fold, like a decline — a self copy to our
     * own DM relays. A "ringing" receipt is for the caller alone and skips it.
     */
    private void publishCallSignal(String peer, String callId, String phase, boolean selfCopy) {
        NativeSigner signer = nativeSigner;
        if (signer == null || peer == null || peer.length() != 64
                || callId == null || callId.length() != 64 || userPubkey == null) {
            return;
        }
        final long nowSecs = System.currentTimeMillis() / 1000;
        JSONArray tags = new JSONArray()
                .put(new JSONArray().put("p").put(peer))
                .put(new JSONArray().put("call").put(callId));
        final JSONObject rumor = new JSONObject();
        try {
            rumor.put("id", NostrCrypto.eventId(userPubkey, nowSecs, KIND_DM_CALL, tags, phase));
            rumor.put("pubkey", userPubkey);
            rumor.put("created_at", nowSecs);
            rumor.put("kind", KIND_DM_CALL);
            rumor.put("tags", tags);
            rumor.put("content", phase);
        } catch (JSONException e) {
            return;
        }
        final String rumorJson = rumor.toString();
        resolveDmInbox(peer, inboxRelays -> {
            // Unlike a message reply, a call signal is not gated on a published
            // inbox: the offer reached us, so the caller reads our shared DM
            // relays at minimum.
            List<String> targets = new ArrayList<>(inboxRelays);
            for (String r : dmRelays) if (!targets.contains(r)) targets.add(r);
            if (targets.isEmpty()) return;
            buildDmEphemeralEnvelope(signer, rumorJson, peer, wrap -> {
                if (wrap != null) publishEvent(wrap, targets, ok -> { });
            });
            if (!selfCopy) return;
            buildDmEphemeralEnvelope(signer, rumorJson, userPubkey, selfWrap -> {
                if (selfWrap != null && !dmRelays.isEmpty()) {
                    publishEvent(selfWrap, new ArrayList<>(dmRelays), ok -> { });
                }
            });
        });
    }

    /**
     * Seal + wrap a DM rumor into an EPHEMERAL (kind 21059) envelope — the
     * same crypto as {@link #buildDmEnvelope}, but a REAL (un-backdated) wrap
     * timestamp and no expiration: the envelope is broadcast-only, so there
     * is nothing at rest to blur or to expire (mirrors wrapDmSealEphemeral in
     * nip17/protocol.ts; the seal inside stays backdated like every seal).
     */
    private void buildDmEphemeralEnvelope(NativeSigner signer, String rumorJson, String recipient,
                                          EnvelopeCallback cb) {
        signer.encrypt44(recipient, rumorJson, (sealContent, unavailable) -> {
            if (sealContent == null) {
                handler.post(() -> cb.onWrap(null));
                return;
            }
            signer.signEvent(13, sealContent, new JSONArray(), tweakedPast(), seal ->
                    handler.post(() -> {
                        JSONObject wrap = null;
                        if (seal != null) {
                            try {
                                byte[] wrapSk = randomSecretKey();
                                byte[] convKey = NostrCrypto.conversationKey(wrapSk, recipient);
                                String ct = convKey != null
                                        ? ConcordCrypto.encrypt(convKey, seal.toString()) : null;
                                if (ct != null) {
                                    JSONArray tags = new JSONArray()
                                            .put(new JSONArray().put("p").put(recipient));
                                    wrap = NostrCrypto.finalizeEvent(
                                            21059, ct, tags,
                                            System.currentTimeMillis() / 1000, wrapSk);
                                }
                            } catch (Exception ignored) {
                                // Resolves null below.
                            }
                        }
                        cb.onWrap(wrap);
                    }));
        });
    }

    /**
     * The unattributed fallback: an inbox wrap we could not open (no signer, or
     * the signer was unreachable). Better a generic ping than silence — the
     * WebView attributes it on open.
     */
    private void notifyOpaqueDm17() {
        // Viewing ANY DM thread suppresses: the live feed already paints the
        // message there (or it's our own just-sent copy echoing back), and
        // the wrap hides which peer it belongs to, so per-thread suppression
        // is impossible.
        for (String roomKey : freshActiveRoomKeys()) {
            if (roomKey.startsWith("dm:")) return;
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm17 (opaque)");
        enqueueRoomMessage(/*community=*/null, "dm17:opaque", str(R.string.notif_direct_messages), "/dm",
                /*senderPubkey=*/null, str(R.string.notif_someone), /*picture=*/null,
                str(R.string.notif_new_direct_message), System.currentTimeMillis(), /*mention=*/true);
    }

    /**
     * The content-blind ping for a DM from an unknown sender when `dmRequests`
     * is "generic". Deliberately carries NOTHING the sender controls — no
     * display name, no avatar, no message preview — so a stranger can't push
     * slurs (in the text OR their profile) onto the lock screen. All pending
     * requests collapse into one "Message requests" conversation; the WebView's
     * DM requests tier shows who they actually are on open.
     */
    private void notifyDmRequest(long timestampMs) {
        // Viewing any DM thread suppresses, as for the opaque ping: the request
        // tier is a DM surface, and the peer isn't tied to a single thread here.
        for (String roomKey : freshActiveRoomKeys()) {
            if (roomKey.startsWith("dm:")) return;
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm17 (request)");
        String requests = str(R.string.notif_message_requests);
        enqueueRoomMessage(/*community=*/null, "dm:requests", requests, "/dm",
                /*senderPubkey=*/null, requests, /*picture=*/null,
                str(R.string.notif_new_message_request), timestampMs, /*mention=*/true);
    }

    /**
     * Per-room cache key for the plugin's rolling event cache (see
     * ArmadaNotificationPlugin.getRoomEvents): NIP-29 events key by their group
     * (`h` tag), Concord wraps by the channel their stream author maps to,
     * DMs share one bucket (the WebView splits threads by counterparty
     * itself). Null when the event carries no usable room scope.
     */
    private String roomKeyFor(JSONObject event, int kind) {
        if (kind == 4) return "dm";
        if (kind == 1059) {
            ConcordStream st = pkToStream2.get(event.optString("pubkey"));
            if (st != null) return "c2:" + st.channelId;
            // A NIP-17 DM wrap — any wrap p-tagged at the user (the WebView
            // holds the identity key and splits threads by counterparty itself,
            // like kind-4). One shared "dm" cache bucket.
            if (isMentioned(event, userPubkey)) return "dm";
            return null;
        }
        String h = tagValue(event, "h");
        return h != null ? "h:" + h : null;
    }

    /** Validate and route public NIP-34/NIP-22 activity without ever leaking
     * private C2 metadata to a relay. Accepted raw events use the same bridge as
     * normal plaintext wire events, where IndexedDB de-dupes by event id. */
    private void handleGitActivity(JSONObject event, String relayUrl, String id, int kind) {
        String address = null, ticketId = null, title = null;
        int action;
        GitRoot root = null;
        if (kind == 1618 || kind == 1621) {
            address = tagValue(event, "a");
            GitRepository repository = gitRepositories.get(address);
            if (repository == null || !validTicketRoot(event, repository, kind)) return;
            root = new GitRoot(id, event.optString("pubkey"), kind);
            if (!repository.roots.containsKey(id)) {
                repository.roots.put(id, root);
                // Persisting the root reconnects through the config listener,
                // the same path every other subscription change takes, so the
                // new root's child filters go live without a WebView.
                persistGitRoot(address, root);
            }
            title = tagValue(event, "subject"); action = kind == 1618 ? R.string.notif_git_pr : R.string.notif_git_issue;
            ticketId = id;
        } else {
            ticketId = kind == 1111 ? rootTag(event, "E") : rootTag(event, "e");
            if (!validHex(ticketId)) return;
            for (GitRepository candidate : gitRepositories.values()) {
                root = candidate.roots.get(ticketId);
                if (root != null) { address = candidate.address; break; }
            }
            if (root == null || address == null) return;
            if (kind == 1111) {
                if (!validNip22Root(event, root)) return;
                action = R.string.notif_git_comment;
            } else {
                GitRepository repository = gitRepositories.get(address);
                String author = event.optString("pubkey", "");
                if (repository == null || !(author.equals(root.author) || author.equals(repository.owner) || repository.maintainers.contains(author))) return;
                action = R.string.notif_git_status;
            }
        }
        GitRepository repository = gitRepositories.get(address);
        if (repository == null || !repository.live()) return;
        long timestamp = event.optLong("created_at", 0);
        if (timestamp <= 0 || notifiedIds.contains(id)) return;
        rememberNotificationId(id);
        ArmadaNotificationPlugin.feedRelayEvent("git:" + address, event.toString(), relayUrl);
        // The repository as the web names it: the coordinate's identifier.
        String[] coordinate = address.split(":", 3);
        final String repoName = coordinate.length == 3 ? coordinate[2] : address;
        final String author = event.optString("pubkey");
        final String fTicketId = ticketId, fTitle = title;
        final int fAction = action;
        final GitRepository fRepository = repository;
        resolveAuthor(author, relayUrl, profile -> {
            String name = authorName(profile);
            // One sentence per action, as `notification.gitActivity`; the ticket title follows it.
            String activity = str(fAction, name, repoName);
            String line = fTitle != null && !fTitle.trim().isEmpty()
                    ? str(R.string.notif_attributed, activity, truncate(fTitle)) : activity;
            for (GitAttachment attachment : fRepository.attachments) {
                if (!attachment.activeAt(timestamp)) continue;
                String url = "/c/" + uriEncode(attachment.communityId) + "/" + uriEncode(attachment.channelId)
                        + "?ticket=" + uriEncode(fTicketId);
                // Share the channel's own room, community and title with chat, so
                // git activity appends to that conversation instead of opening a
                // second notification with a conflicting name.
                ConcordStream stream = streamForChannel(attachment.channelId);
                String gitLabel = str(R.string.notif_git_activity);
                enqueueRoomMessage(
                        stream != null ? stream.community : null, "c2:" + attachment.channelId,
                        stream != null ? stream.name : gitLabel, url,
                        author, gitLabel, /*picture=*/null,
                        line, timestamp * 1000L, /*mention=*/false);
            }
        });
    }

    /** The subscribed stream for a channel, if any; git activity borrows its
     * community and display name. Streams are per (channel, epoch), so the
     * first match is enough — every epoch carries the same two. */
    private ConcordStream streamForChannel(String channelId) {
        for (ConcordStream stream : pkToStream2.values()) if (stream.channelId.equals(channelId)) return stream;
        return null;
    }

    /** NIP-22 encodes the root in uppercase tags, where — unlike NIP-10's
     * lowercase `e` — the fourth value is the root author's pubkey rather than a
     * "root" marker. Mirrors the TypeScript parser: an uppercase root counts
     * only when it is unambiguous. */
    private static String rootTag(JSONObject event, String name) {
        boolean nip22 = "E".equals(name);
        String found = null;
        try { JSONArray tags = event.optJSONArray("tags"); if (tags == null) return null;
            for (int i = 0; i < tags.length(); i++) { JSONArray tag = tags.optJSONArray(i);
                if (tag == null || !name.equals(tag.optString(0))) continue;
                if (!nip22) { if ("root".equals(tag.optString(3))) return tag.optString(1); continue; }
                if (found != null) return null;
                found = tag.optString(1);
            }
        } catch (Exception ignored) {} return found;
    }
    private static boolean validTicketRoot(JSONObject event, GitRepository repository, int kind) {
        return validHex(event.optString("id", "")) && validHex(event.optString("pubkey", ""))
                && repository.address.equals(tagValue(event, "a")) && (kind == 1618 || kind == 1621);
    }
    private static boolean validNip22Root(JSONObject event, GitRoot root) {
        String kind = tagValue(event, "K");
        return root.id.equals(rootTag(event, "E")) && Integer.toString(root.kind).equals(kind);
    }
    private void persistGitRoot(String address, GitRoot root) {
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        try {
            JSONArray repositories = new JSONArray(sp.getString("gitSubs", "[]"));
            for (int i = 0; i < repositories.length(); i++) { JSONObject repository = repositories.optJSONObject(i);
                if (repository == null || !address.equals(repository.optString("address"))) continue;
                JSONArray roots = repository.optJSONArray("ticketRoots"); if (roots == null) repository.put("ticketRoots", roots = new JSONArray());
                boolean exists = false; for (int j = 0; j < roots.length(); j++) if (root.id.equals(roots.optJSONObject(j).optString("id"))) exists = true;
                // Already persisted: bumping `rev` would reload the whole
                // config (every relay reconfigured) for nothing.
                if (exists) return;
                roots.put(new JSONObject().put("id", root.id).put("author", root.author).put("kind", root.kind));
                if (ServiceProfiler.ON) ServiceProfiler.count("config.rev git root");
                long revision = ArmadaNotificationPlugin.nextConfigRevision(sp);
                sp.edit().putString("gitSubs", repositories.toString())
                        .putLong("rev", revision).apply();
                return;
            }
        } catch (JSONException e) { Log.w(TAG, "Failed to persist Git root", e); }
    }

    private void handleEvent(JSONObject event, String relayUrl) {
        handleEvent(event, relayUrl, false, false);
    }

    /**
     * {@code windowClosed} marks a self topic document replayed by
     * {@link #flushSelfTopicDocs}, which is filed now instead of staged again;
     * {@code verified} that the window already checked its signature.
     */
    private void handleEvent(JSONObject event, String relayUrl, boolean windowClosed, boolean verified) {
        if (!ServiceProfiler.ON) {
            handleEventInner(event, relayUrl, windowClosed, verified);
            return;
        }
        String label = "event k" + event.optInt("kind");
        long t = ServiceProfiler.begin(label);
        try {
            handleEventInner(event, relayUrl, windowClosed, verified);
        } finally {
            ServiceProfiler.end(label, t);
        }
    }

    /**
     * Self documents that wait out {@link SelfTopicWindow} so only the newest
     * version is verified and filed: the installation-sharded topic documents,
     * and the Concord community-list fragments (38 KB each), which a client
     * stuck republishing can send many times a minute.
     */
    static boolean coalescesSelfDoc(JSONObject event, int kind) {
        return kind == KIND_COMMUNITY_LIST_FRAG || isSelfTopicDoc(event, kind);
    }

    /** A kind-30078 document carrying one of {@link SelfState#TOPICS}. */
    static boolean isSelfTopicDoc(JSONObject event, int kind) {
        if (kind != SelfState.KIND_APP_SPECIFIC) return false;
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return false;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray t = tags.optJSONArray(i);
            if (t != null && t.length() > 1 && "t".equals(t.optString(0))
                    && SelfState.TOPICS.contains(t.optString(1))) {
                return true;
            }
        }
        return false;
    }

    private void stageSelfTopicDoc(JSONObject event, String relayUrl, String coordinate) {
        SelfTopicWindow.Outcome outcome = selfTopicWindow.stage(coordinate, event, relayUrl);
        if (outcome != SelfTopicWindow.Outcome.STAGED) {
            if (ServiceProfiler.ON) {
                ServiceProfiler.count("event.drop self-topic " + outcome.name().toLowerCase(java.util.Locale.ROOT));
            }
            return;
        }
        if (!selfTopicFlushPosted) {
            selfTopicFlushPosted = true;
            handler.postDelayed(flushSelfTopicDocsRunnable, SELF_TOPIC_WINDOW_MS);
        }
    }

    private void flushSelfTopicDocs() {
        selfTopicFlushPosted = false;
        for (SelfTopicWindow.Pending pending : selfTopicWindow.drain()) {
            handleEvent(pending.event, pending.relayUrl, true, pending.verified);
        }
    }

    private void handleEventInner(JSONObject event, String relayUrl, boolean windowClosed, boolean verified) {
        String id = event.optString("id");
        if (id.isEmpty() || notifiedIds.contains(id)) {
            if (ServiceProfiler.ON) ServiceProfiler.count("event.drop duplicate");
            return;
        }

        int kind = event.optInt("kind");

        // Security gate — the relay is untrusted. (1) Drop anything that
        // doesn't satisfy a filter we actually sent, so a relay can't inject
        // notifications or poison the shared store with a group we never
        // joined, a DM from a non-follow, or a wrap not addressed to us.
        // (2) Require a valid author signature on every non-wrap event. Gift
        // wraps (kind 1059/21059) carry only an ephemeral / group-derived
        // outer key whose signature proves no sender identity (matching the
        // WebView's verifyEventSkippingWraps), so the outer sig is skipped
        // here and the INNER seal is Schnorr-verified at decrypt time instead
        // (see openConcord/handleDm17Wrap). Everything else — NIP-29
        // chat/reactions/replies and kind-4 DMs — must be verified before it
        // is stored, fed to the WebView, or turned into a notification.
        if (!passesFilter(event, kind, relayUrl)) {
            if (ServiceProfiler.ON) ServiceProfiler.count("event.drop filter");
            return;
        }
        // Before the seen check: a copy another relay already delivered was
        // still downloaded from this one, and the breaker budgets bytes.
        if (SelfState.isSelfKind(kind)) {
            RelayConnection live = connectionFor(relayUrl);
            if (live != null && countsTowardSelfFlood(live.selfLive, windowClosed)) {
                long pause = selfFlood(relayUrl).onEdition(
                        SystemClock.elapsedRealtime(), event.optString("content").length());
                if (pause > 0) live.pauseSelf(pause);
            }
        }
        // A self-state document already verified and filed (another self
        // relay, or a re-REQ) is a no-op for the store; skip the verify too.
        if (SelfState.isSelfKind(kind) && selfSeenIds.contains(id)) {
            if (ServiceProfiler.ON) ServiceProfiler.count("event.drop self-state seen");
            return;
        }
        String selfCoordinate = SelfState.isSelfKind(kind) ? selfCoordinateOf(event, kind) : null;
        if (selfCoordinate != null) {
            Long newest = selfNewestByCoordinate.get(selfCoordinate);
            // Strictly older only: an equal timestamp is settled by id (NIP-01), which
            // the store decides.
            if (newest != null && event.optLong("created_at") < newest) {
                if (ServiceProfiler.ON) ServiceProfiler.count("event.drop self-state superseded");
                return;
            }
            // Topic documents and community-list fragments wait out a window, and only
            // the newest version of each is verified and filed.
            if (!windowClosed && userPubkey != null
                    && userPubkey.equals(event.optString("pubkey"))
                    && coalescesSelfDoc(event, kind)) {
                stageSelfTopicDoc(event, relayUrl, selfCoordinate);
                return;
            }
        }
        if (kind != 1059 && kind != 21059 && !verified && !NostrCrypto.verifyEvent(event)) {
            if (ServiceProfiler.ON) ServiceProfiler.count("event.drop signature");
            if (BuildConfig.DEBUG) Log.d(TAG, "DROP bad signature kind=" + kind + " id=" + id);
            return;
        }
        healthLastEventAtMs = System.currentTimeMillis();

        // Git-exclusive NIP-34 kinds stop here; the switch below has no case
        // for them. 1111 is deliberately excluded: it doubles as an ordinary
        // NIP-22 reply, and handleGitActivity drops non-git comments silently.
        // After the security gate, so a git event is filter-checked and
        // signature-verified before it is acted on.
        if (kind == 1618 || kind == 1621 || (kind >= 1630 && kind <= 1633)) {
            // Cached like any other relay event so the repository views read it
            // from the store rather than refetching it; the service handles the
            // notification itself, so there is nothing for wire ingest to route.
            ServiceStore.cache(this, event);
            advanceRelaySince(relayUrl, event.optLong("created_at", 0));
            handleGitActivity(event, relayUrl, id, kind);
            return;
        }

        // The user's own replaceable documents. Signature-verified above, so
        // what lands in `main` is the same bytes the WebView would have stored
        // had it fetched this itself — and the rail, mutes and settings are
        // simply current the next time the app opens, with no relay read in the
        // critical path. Nothing here notifies: none of it is a message.
        if (SelfState.isSelfKind(kind)) {
            // The SAME set the REQ above was built from: subscribing to one and
            // authorizing against another either stores documents we never
            // asked for or discards ones we did.
            boolean filed = userPubkey != null
                    && ServiceStore.cacheSelfState(this, event, userPubkey, selfDTags, selfDocs);
            rememberBoundedId(selfSeenIds, id, MAX_SELF_SEEN_IDS);
            // Only a version the store actually took raises the floor: one it
            // refused (not ours, not a synced kind) must not shadow a later one.
            if (filed && selfCoordinate != null) {
                Long prev = selfNewestByCoordinate.get(selfCoordinate);
                long at = event.optLong("created_at");
                if (prev == null || at > prev) selfNewestByCoordinate.put(selfCoordinate, at);
            }
            // The one self-document the service acts on rather than merely
            // filing: a read advanced on another device dismisses the matching
            // tray notification while the app is dead — the background half of
            // NativeReadDismiss, which otherwise runs only on the next WebView
            // resume. Everything else here stays verbatim ciphertext for the
            // WebView to open.
            if (kind == SelfState.KIND_APP_SPECIFIC && userPubkey != null) {
                byte[] key = readStateKeys.get(event.optString("pubkey"));
                // A fresh read-state edition: the user is reading somewhere.
                if ((key != null || isReadStateDoc(event))
                        && System.currentTimeMillis() / 1000 - event.optLong("created_at") < 120) {
                    noteOtherDeviceActivity();
                }
                if (key != null) applyReadStateDismiss(ConcordCrypto.decrypt(key, event.optString("content")));
                else if (userPubkey.equals(event.optString("pubkey")) && isReadStateDoc(event)) {
                    applyReadStateDismiss(event);
                }
            }
            return;
        }

        // Write the raw outer event into ArmadaDB — the SAME database the
        // WebView reads, not a mirror of it — and queue it for wire ingest, so
        // the WebView still gets to route it (park undecryptable wraps, ring the
        // scopes that repaint a timeline, raise unread counts) on open/resume.
        // Also feed it live over the bridge when the WebView is up, so a message
        // the service already received renders with no relay round-trip and no
        // "wait for the chat to catch up".
        //
        // Covers the timeline kinds the WebView renders: NIP-29 chat/polls/
        // reactions/replies/deletes, Concord wraps (kind 1059, decrypted
        // below or in the WebView) and DMs
        // (kind 4 — ciphertext; the WebView holds the NIP-04 keys). Each is also
        // recorded in the plugin's per-room rolling cache (see getRoomEvents) so
        // opening a room can pull its natively-received history directly.
        //
        // Whether the store held a kind-1059 wrap BEFORE this write is the
        // durable dedupe floor for DM wraps (their outer timestamps are
        // backdated, so time-based gating can't apply): a wrap either side ever
        // stored (a previous service incarnation, the WebView, or our own
        // published self-copy) must not re-notify.
        boolean storedBefore = false;
        switch (kind) {
            case 9: case 1068: case 7: case 1111: case 5: case 1059: case 4:
                // The relay is passed through because it decides the tenant for
                // NIP-29 kinds (see RelayScope) and which handoff queue carries
                // the event, so the WebView's ingest can route it to the same
                // place. Without it a group-scoped event would have nowhere
                // honest to go and would be dropped.
                storedBefore = ServiceStore.ingest(this, event, relayUrl);
                ArmadaNotificationPlugin.feedRelayEvent(roomKeyFor(event, kind), event.toString(), relayUrl);
                break;
            default:
                break;
        }

        // Ephemeral DM signal wraps (voice calls): never stored, never fed to
        // the WebView's ingest — opened for the one thing the service acts on
        // while the app is dead, ringing the phone. notifiedIds still dedupes
        // the same broadcast off several relays.
        if (kind == 21059) {
            rememberNotificationId(id);
            handleDmEphemeralWrap(event, relayUrl);
            return;
        }

        // Concord (E2E): the outer event is a kind-1059 wrap SIGNED BY a
        // derived stream key with NIP-44-encrypted content. Open wrap → seal →
        // rumor with the stream's conversation key (derived in the WebView,
        // where membership lives) to recover the real author + plaintext, then
        // notify just like a group message. If decryption fails (e.g. a rekey
        // epoch we don't hold yet) fall back to a keyless room notification.
        if (kind == 1059) {
            ConcordStream st = pkToStream2.get(event.optString("pubkey"));
            if (st == null) {
                // Not a Concord wrap — a NIP-17 DM wrap. Handle + return.
                handleDm17Wrap(event, id, relayUrl, storedBefore);
                return;
            }
            long cts = event.optLong("created_at", 0);
            advanceRelaySince(relayUrl, cts);
            rememberNotificationId(id);

            // CORD-08: a disappearing message's wrap carries the rumor's NIP-40
            // deadline, so an already-expired one is refused before anything is
            // decrypted — not stored, not parked, not notified (the DM path
            // above applies the same rule to its envelope).
            if (ServiceStore.isExpired(event)) return;

            ConcordOpen opened = openConcord(event, st);
            if (opened == null) {
                // Couldn't decrypt — a rekey epoch whose key we don't hold, or
                // a foreign payload. PARK the wrap for the WebView, which holds
                // the community's full key history: peek+ack there means a
                // notified message is never locally destroyed, and this is the
                // one path by which a wrap we can't read still reaches its
                // channel. Then still tell the user something arrived, and
                // where. (Generic body, but a real room title.)
                ServiceStore.parkConcordWrap(this, event);
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord (opaque): " + st.name);
                // A mention lives on the rumor we just failed to open, so a
                // "mentions only" channel has no signal to notify on and stays
                // silent — the wrap is parked either way, so the WebView (which
                // holds the full key history) still surfaces it on open.
                if (!wantsOpaqueResolvedGroupMessage(st.mentionOnly)) return;
                enqueueRoomMessage(
                        st.community, "c2:" + st.channelId, st.name, st.url,
                        /*senderPubkey=*/null, str(R.string.notif_someone), /*picture=*/null,
                        str(R.string.notif_new_message), System.currentTimeMillis(), /*mention=*/false);
                return;
            }

            JSONObject rumor = opened.rumor;
            // A malformed `ms` tag refuses the rumor, as the WebView's open does (CORD-02 §4).
            Long rumorMsBoxed = ServiceStore.concordRumorMs(rumor);
            if (rumorMsBoxed == null) return;
            final long rumorMs = rumorMsBoxed;

            // File the decrypted rumor in its community's opened-event tenant —
            // the same row, byte for byte, that the WebView writes (the rumor
            // as its author wrote it, nothing added). This is what makes a
            // notified Concord message
            // present in the channel on open rather than something the WebView
            // has to decrypt again from a parked wrap. openConcord has already
            // proved the seal's signature, that the rumor's author IS the seal's
            // signer, and that the channel/epoch binding matches the stream key
            // that opened the wrap — the checks the WebView's write path makes
            // before it will file a rumor under a channel.
            ServiceStore.storeConcordRumor(this, st.communityId, opened.sealKind, rumor);

            // Every chat-plane kind rides an identical wrap. Messages (kind 9),
            // thread replies (kind 1111), and reactions (kind 7) to YOUR own
            // message notify — a reaction only when its `p` tag names you
            // (NIP-25, carried on the encrypted rumor). Edits (5/3302), deletes
            // (5), reactions to others' messages, and other chat-plane kinds
            // stay silent — the subscription covers ALL kind-1059 wraps,
            // including non-message chat-plane traffic the WebView handles
            // silently.
            int rumorKind = rumor.optInt("kind", -1);
            final String author2 = rumor.optString("pubkey");
            if (author2.equals(userPubkey)) {
                noteOtherDeviceActivity();
                return; // our own message / reaction echoed back
            }

            // A banned member (CORD-04): the rumor is stored above like every
            // other message (the timeline folds it away on read), but it must
            // never notify. The author lives on the encrypted rumor, so this is
            // the first point the ban set can be applied.
            if (st.banned.contains(author2)) {
                return;
            }
            // A post its readers collapse rings nobody (CORD-04 §8): no SEND in this
            // open Channel, or inside a running Timeout's window.
            if (st.sendDenied.contains(author2)) return;
            // At a restricted Channel's read address a post stands only from those who manage it (CORD-03 §1).
            if (st.postAuthors != null && rumorKind != 7 && !st.postAuthors.contains(author2)) return;
            long[] timeout = st.timeouts.get(author2);
            if (timeout != null) {
                long nowMs = System.currentTimeMillis() + st.clockOffsetMs;
                if (timeout[1] * 1000L > nowMs && rumorMs >= timeout[0] * 1000L && rumorMs < timeout[1] * 1000L) return;
            }

            // A rumor dated ahead of the local clock is HELD: stored above like
            // every other message (the timeline hides it until its time comes,
            // FUTURE_HOLD_MS), but never announced. Announcing it now would buzz
            // for a message the reader can't yet see, and the OS would stamp the
            // notification "in 5m" from the future created_at.
            final long rumorCreatedAt = rumor.optLong("created_at", 0);
            if (rumorCreatedAt > 0
                    && rumorMs > System.currentTimeMillis() + st.clockOffsetMs + FUTURE_HOLD_MS) {
                return;
            }
            // Sent before this membership began: stored, never announced.
            if (!sentDuringMembership(rumorCreatedAt, st.joinedAtMs)) return;

            // Reaction to your own message: mirror the NIP-29 path with a
            // "Reacted 👍 to your message" line, gated on the reactions pref.
            if (rumorKind == 7) {
                if (!isMentioned(rumor, userPubkey)) {
                    return; // a reaction to someone else's message — silent
                }
                // One no row could render rings nobody, as the timeline drops it.
                if (!ReactionContent.renderable(rumor.optString("content", ""))) return;
                if (!prefBool("reactions", true)) {
                    return;
                }
                final ConcordStream fStR = st;
                final String reactionLine = str(R.string.notif_reacted, reactionEmoji(rumor));
                final long rtsR = rumor.optLong("created_at", 0);
                final long fTsR = (rtsR > 0 ? rtsR * 1000L : System.currentTimeMillis());
                // Land on YOUR message the reaction points at (its `e` tag).
                final String reactTarget = tagValue(rumor, "e");
                // A reaction is always directed at you (mention=true), so it
                // breaks through active-room suppression like a mention.
                if (isActivelyViewed("c2:" + fStR.channelId, null, /*mention=*/true)) {
                    return;
                }
                resolveAuthor(author2, relayUrl, profile -> {
                    String nick = fStR.nicknames.get(author2);
                    String name = nick != null ? nick : authorName(profile);
                    String picture = communityAvatarShown(author2) && profile != null ? profile.picture : null;
                    if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord reaction: " + fStR.name + " / " + name);
                    enqueueRoomMessage(
                            fStR.community, "c2:" + fStR.channelId, fStR.name,
                            appendMessageSegment(fStR.url, reactTarget),
                            author2, name, picture, reactionLine, fTsR, /*mention=*/true);
                });
                return;
            }

            if (rumorKind != 9 && rumorKind != 1111) {
                return;
            }
            boolean mentionsMe2 = isMentioned(rumor, userPubkey)
                    || ((st.mentionEveryoneAnyone || st.mentionEveryoneAuthors.contains(author2))
                        && hasEveryoneMention(rumor.optString("content", "")))
                    || RoleMentions.pings(rumor.optString("content", ""), rumor.optJSONArray("tags"),
                        st.roleMentions, st.roleMentionAuthors, author2);
            // The WebView already resolved channel -> community -> global into
            // this subscription: omitted means nothing, mentionOnly means only
            // a real mention, and an included non-mentionOnly stream means all.
            // Re-applying the global prefs here would incorrectly suppress an
            // explicit per-room override (for example room=all, global=off).
            if (!wantsResolvedGroupMessage(st.mentionOnly, mentionsMe2)) return;
            final ConcordStream fSt = st;
            final boolean fMention2 = mentionsMe2;
            final String preview2 = messagePreview(rumor);
            final long rts = rumor.optLong("created_at", 0);
            final long fTs2 = (rts > 0 ? rts * 1000L : System.currentTimeMillis());
            // A kind-1111 comment (threaded reply) carries its thread root in the
            // uppercase `E` tag. Append it to the deep-link so the WebView can
            // open the thread panel on tap instead of just the channel.
            final String threadRoot2 = innerKindCommentRoot(rumor);
            // Top-level messages deep-link to the message row itself; thread
            // replies keep the thread param (the panel is the destination —
            // the reply isn't a timeline row the permalink jump can land on).
            final String msgId2 = threadRoot2 == null ? rumor.optString("id", "") : null;
            // SYNCHRONOUS active-room suppression: check before the async profile
            // fetch so the decision is immediate (no race with the Capacitor
            // bridge). A mention always breaks through.
            if (isActivelyViewed("c2:" + fSt.channelId, threadRoot2, fMention2)) {
                return;
            }
            resolveAuthor(author2, relayUrl, profile -> {
                String nick = fSt.nicknames.get(author2);
                String name = nick != null ? nick : authorName(profile);
                String picture = communityAvatarShown(author2) && profile != null ? profile.picture : null;
                String text = NotificationContent.messageText(labels(), preview2, threadRoot2 != null);
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord: " + fSt.name + " / " + name);
                enqueueRoomMessage(
                        fSt.community, "c2:" + fSt.channelId, fSt.name,
                        appendMessageSegment(appendThreadSegment(fSt.url, threadRoot2), msgId2),
                        author2, name, picture, text, fTs2, fMention2);
            });
            return;
        }

        // Every verified event the relay delivered moves its cursor, whether or
        // not it notifies: otherwise a reconnect replays a busy room's silent
        // traffic back to the last notified message, verified and stored again.
        long ts = event.optLong("created_at", 0);
        advanceRelaySince(relayUrl, ts);

        String author = event.optString("pubkey");
        if (author.equals(userPubkey)) {
            noteOtherDeviceActivity();
            return;
        }

        boolean mentionsMe = pTags(event).contains(userPubkey);

        // The group this event belongs to, needed before the gate below so a
        // "mentions only" room can drop it. Recomputed into nip29GroupId after
        // the claim for the deep link.
        boolean wanted = kind == 4
                ? dmNotificationEnabled(author)
                : wantsNotification(kind, mentionsMe,
                        isMentionOnlyGroup(relayUrl, tagValue(event, "h")));
        if (!wanted) {
            return;
        }

        // Claim the event now so the async profile fetch can't double-fire.
        rememberNotificationId(id);

        final boolean mention = mentionsMe;
        final long fTs = (ts > 0 ? ts * 1000L : System.currentTimeMillis());
        // A NIP-29 thread reply's root (nip29Threads.ts): a kind 9's marked
        // `e` tags, or a legacy kind-1111's uppercase `E`. We append it to the
        // deep-link so the WebView can auto-open the thread panel on tap.
        final String nip29ThreadRoot = kind == 1111 ? tagValue(event, "E")
                : kind == 9 ? markedThreadRoot(event) : null;
        // Pre-compute the NIP-29 room key for the synchronous active-room check
        // below (so we don't need to re-extract the group id inside the callback).
        final String nip29GroupId = tagValue(event, "h");
        final String nip29RoomKey = nip29GroupId != null
                ? "h:" + relayUrl + "|" + nip29GroupId : null;
        // SYNCHRONOUS active-room suppression: check before the async profile
        // fetch so the decision is immediate (no race with the Capacitor
        // bridge). A mention always breaks through.
        if (isActivelyViewed(nip29RoomKey, nip29ThreadRoot, mention)) {
            return;
        }
        // Resolve the author's name + avatar, then feed a per-room message line.
        // MessagingStyle shows WHO via the sender Person, so the line is just the
        // message/verb; the room name is the conversation title.
        resolveAuthor(author, relayUrl, profile -> {
            String name = authorName(profile);
            final String picture = profile != null ? profile.picture : null;
            String line;
            String url;
            switch (kind) {
                case 9: {
                    if (nip29ThreadRoot != null) {
                        line = NotificationContent.messageText(labels(), messagePreview(event), true);
                    } else {
                        line = messagePreview(event);
                        if (line.isEmpty()) line = str(R.string.notif_sent_message);
                        if (mention) line = str(R.string.notif_mentioned_you, line);
                    }
                    url = nip29GroupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId)
                            : "/";
                    // Land on the message itself, inside its thread when it is a reply.
                    url = appendMessageSegment(appendThreadSegment(url, nip29ThreadRoot), id);
                    break;
                }
                case 7: {
                    line = str(R.string.notif_reacted, reactionEmoji(event));
                    url = nip29GroupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId)
                            : "/";
                    // Land on YOUR message the reaction points at (its `e` tag).
                    url = appendMessageSegment(url, tagValue(event, "e"));
                    break;
                }
                case 1111: {
                    line = NotificationContent.messageText(labels(), messagePreview(event), true);
                    url = nip29GroupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId)
                            : "/";
                    // Deep-link to the reply inside its thread (uppercase `E`
                    // root id): a tap opens the thread panel and lands on the
                    // reply. The id is only appended alongside the thread —
                    // a reply is never in the channel timeline, so `/m/` on
                    // its own would name a message the timeline can't find.
                    if (nip29ThreadRoot != null && !nip29ThreadRoot.isEmpty()) {
                        url = appendMessageSegment(appendThreadSegment(url, nip29ThreadRoot), id);
                    }
                    break;
                }
                case 4:
                    // kind-4 DMs are NIP-04 encrypted; the service has no key.
                    line = str(R.string.notif_sent_direct_message);
                    url = appendMessageSegment(dmRoute(author), id);
                    break;
                default:
                    return;
            }
            final String fName = name;
            final String fLine = line;
            final String fUrl = url;
            if (nip29GroupId == null) {
                // DM: the conversation is 1:1 with the sender, so the sender's
                // name is the room title and it's not a "group" conversation.
                // mention=false so it's suppressed while this peer's thread is on
                // screen — a DM's `p` tag naming us isn't a break-through @-ping.
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm from=" + fName);
                // DM: null community ⇒ a per-peer notification with no
                // conversation title.
                enqueueRoomMessage(
                        /*community=*/null, "dm:" + author, fName, fUrl,
                        author, fName, picture, fLine, fTs, /*mention=*/false);
                return;
            }
            // Resolve the group's display name; it becomes the conversation
            // title. The picture — cached by the same kind-39000 fetch — is the
            // conversation's avatar. A NIP-29 group is its own community (one
            // channel), so no per-message channel label is needed.
            resolveGroupName(nip29GroupId, relayUrl, groupName -> {
                String roomTitle = (groupName != null && !groupName.isEmpty()) ? groupName : str(R.string.notif_group);
                CommunityRef community = new CommunityRef(
                        GROUP_PREFIX + "h:" + relayUrl + "|" + nip29GroupId,
                        roomTitle,
                        "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId),
                        groupPictureCache.get(nip29GroupId), null, null, null);
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY kind=" + kind + " room=" + roomTitle);
                enqueueRoomMessage(
                        community, nip29RoomKey, roomTitle, fUrl,
                        author, fName, picture, fLine, fTs, mention);
            });
        });
    }

    /**
     * Synchronous active-room check: returns true if the user is currently
     * viewing this room (channel-level suppression) or this specific thread
     * (thread-level suppression), so the caller can skip the notification
     * before any async work (profile fetch, group-name resolve). A mention
     * always returns false — a deliberate @-ping deserves attention even on
     * the visible channel.
     *
     * @param roomKey    the channel-level roomKey (e.g. "c2:<id>", "z:<z>", "h:<relay>|<group>")
     * @param threadRoot the thread root id (uppercase `E` tag), or null for a top-level message
     * @param mention    whether this message @-mentions the user
     */
    private boolean isActivelyViewed(String roomKey, String threadRoot, boolean mention) {
        if (mention) return false;
        if (roomKey == null) return false;
        Set<String> active = freshActiveRoomKeys();
        if (active.contains(roomKey)) {
            if (BuildConfig.DEBUG) Log.d(TAG, "SUPPRESS (channel active): " + roomKey);
            return true;
        }
        if (threadRoot != null) {
            String threadKey = roomKey + ":t:" + threadRoot;
            if (active.contains(threadKey)) {
                if (BuildConfig.DEBUG) Log.d(TAG, "SUPPRESS (thread active): " + threadKey);
                return true;
            }
        }
        return false;
    }

    /** A string resource in the app's language (see {@link AppLocale}). */
    private String str(int id, Object... args) {
        return AppLocale.string(this, id, args);
    }

    /** The words {@link NotificationContent} builds lines from, in the app's language. */
    private NotificationContent.Labels labels() {
        String tag = AppLocale.get(this);
        NotificationContent.Labels cached = labels;
        if (cached != null && java.util.Objects.equals(tag, labelsLocale)) return cached;
        cached = new NotificationContent.Labels(
                str(R.string.notif_sent_gif), str(R.string.notif_sent_image),
                str(R.string.notif_sent_video), str(R.string.notif_sent_voice),
                str(R.string.notif_sent_game), str(R.string.notif_sent_message),
                str(R.string.notif_replied_in_thread), str(R.string.notif_replied_in_thread_with));
        labels = cached;
        labelsLocale = tag;
        return cached;
    }

    private volatile NotificationContent.Labels labels;
    private volatile String labelsLocale;

    /**
     * Prepare an event's content for a notification body, mirroring the web
     * client's on-screen preview: resolve NIP-27 {@code nostr:} mentions to
     * {@code @name} and strip inline media URLs (images/video/audio) that would
     * otherwise show as a raw blob URL. See {@link NotificationContent}.
     */
    private String cleanContent(String content) {
        return NotificationContent.clean(content, this::mentionName);
    }

    /**
     * Notification body for a message event/rumor: the cleaned content, or —
     * when stripping media URLs left nothing — a "Sent an image"-style line
     * naming the media kind. The kind comes from the imeta {@code m} MIME
     * first (an encrypted attachment's blob URL has no media extension, and
     * the URL of a Concord/DM attachment lives ONLY in the imeta), falling
     * back to the first media URL's extension. Empty only when the message
     * has neither text nor recognizable media.
     */
    private String messagePreview(JSONObject event) {
        String content = event.optString("content");
        String preview = truncate(cleanContent(content));
        if (!preview.isEmpty()) return preview;
        String sent = labels().sentMedia(NotificationContent.mediaKind(firstImetaMime(event), content));
        return sent != null ? sent : "";
    }

    /** The {@code m <mime>} field of the event's first imeta tag carrying one, or null. */
    private static String firstImetaMime(JSONObject event) {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag == null || tag.length() < 2 || !"imeta".equals(tag.optString(0))) continue;
            for (int j = 1; j < tag.length(); j++) {
                String field = tag.optString(j, "");
                if (field.startsWith("m ")) {
                    String mime = field.substring(2).trim();
                    if (!mime.isEmpty()) return mime;
                }
            }
        }
        return null;
    }

    /**
     * Display name for a MENTIONED pubkey, resolved best-effort from what we
     * already hold (memory store, then the shared DB) — never the network, so a
     * mention can't delay or block the notification. Null for an unknown one,
     * which keeps its raw token: "@Anonymous" would name nobody.
     */
    private String mentionName(String pubkeyHex) {
        return displayName(cachedProfile(pubkeyHex));
    }

    /** Synchronous profile lookup from cache/DB only; null when not held. */
    private Profile cachedProfile(String pubkey) {
        ProfileStore.Entry held = profileStore.get(pubkey);
        if (held != null) return new Profile(held.name, held.picture, held.nip05, held.ts);
        try {
            String raw = ServiceStore.profileRaw(this, pubkey);
            if (raw != null) return parseProfile(new JSONObject(raw));
        } catch (Exception ignored) {
            // Unreadable row — treat as unknown.
        }
        return null;
    }

    /**
     * The conversation title for a group DM: its members' names, in the
     * canonical (sorted-pubkey) order of the conversation key, so the title is
     * stable rather than reordering with whoever spoke last.
     *
     * Resolved from what is already held — never the network. A group of five
     * would otherwise put five relay round-trips in front of one notification,
     * and the one name that genuinely matters, the sender's, is resolved
     * properly through {@link #resolveAuthor} for the message line's Person.
     * Past {@link #TITLE_NAMES_MAX} the rest become a "+N", which is what keeps
     * a large room's title from filling the lock screen.
     */
    private String dmGroupTitle(List<String> peers) {
        StringBuilder sb = new StringBuilder();
        String joiner = str(R.string.notif_name_joiner);
        int shown = Math.min(peers.size(), TITLE_NAMES_MAX);
        for (int i = 0; i < shown; i++) {
            if (i > 0) sb.append(joiner);
            String name = mentionName(peers.get(i));
            sb.append(name != null ? name : str(R.string.notif_anonymous));
        }
        int rest = peers.size() - shown;
        return rest > 0 ? str(R.string.notif_names_more, sb.toString(), rest) : sb.toString();
    }

    /** How many members a group DM's title names before it says "+N". */
    private static final int TITLE_NAMES_MAX = 3;

    /**
     * Whether a string is a well-formed conversation key: one or more 64-char
     * hex pubkeys joined by `,` (see `dmConvKey`). Checked rather than assumed
     * because the key decides the `p` tags of an event we are about to seal,
     * wrap and publish.
     */
    private static boolean isDmConvKey(String convKey) {
        List<String> peers = ServiceStore.dm17ConvPeers(convKey);
        if (peers.isEmpty()) return false;
        for (String peer : peers) {
            if (peer.length() != 64) return false;
            for (int i = 0; i < 64; i++) {
                char c = peer.charAt(i);
                boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                if (!hex) return false;
            }
        }
        return true;
    }

    /**
     * Whether a Concord sender's avatar may appear on a notification. Anyone with
     * the key can post (CORD-04 §1), so unless the reader loads everyone's media
     * only a known peer's face reaches the lock screen; mirrors
     * {@code communityAvatarShown} in {@code pushRuntime.ts}.
     */
    private boolean communityAvatarShown(String author) {
        return communityAvatarShown(author, dmFollows, dmKnownPeers, mediaPolicy.allCommunityAvatars);
    }

    static boolean communityAvatarShown(String author, Set<String> follows, Set<String> knownPeers) {
        return communityAvatarShown(author, follows, knownPeers, false);
    }

    static boolean communityAvatarShown(String author, Set<String> follows, Set<String> knownPeers,
                                        boolean all) {
        return author != null && (all || follows.contains(author) || knownPeers.contains(author));
    }

    /**
     * Whether a NIP-17 conversation belongs to the established inbox.
     *
     * An exact roster entry is sufficient for a group, but deliberately does
     * not widen {@code knownPeers}: the same member's unrelated 1:1 message is
     * still a request. A conversation whose every participant is independently
     * established is also known, preserving the pre-group peer policy.
     */
    static boolean dmConversationKnown(String convKey, List<String> peers,
                                       Set<String> knownPeers,
                                       Set<String> knownConversations) {
        if (convKey != null && knownConversations.contains(convKey)) return true;
        if (peers == null || peers.isEmpty()) return false;
        for (String peer : peers) {
            if (!knownPeers.contains(peer)) return false;
        }
        return true;
    }

    /** Whole-conversation mute rule shared with the WebView DM list. */
    static boolean dmConversationMuted(List<String> peers, Set<String> mutedPeers) {
        if (peers == null || peers.isEmpty() || mutedPeers.isEmpty()) return false;
        for (String peer : peers) {
            if (mutedPeers.contains(peer)) return true;
        }
        return false;
    }

    /**
     * Whether a room key names a DM conversation with more than one other
     * participant. Derived from the KEY rather than remembered on the
     * {@link RoomNotif}, so a room rebuilt from nothing after a cold start (see
     * {@link #appendOutgoing}) still renders — and replies — as the group it is.
     */
    private static boolean isDmGroupKey(String roomKey) {
        return roomKey != null && roomKey.startsWith("dm:")
                && ServiceStore.dm17ConvPeers(roomKey.substring(3)).size() > 1;
    }

    /** Display name from a resolved profile; null when it names nobody. */
    private static String displayName(Profile profile) {
        if (profile != null && profile.name != null && !profile.name.isEmpty()) {
            return profile.name;
        }
        // Fall back to the NIP-05 identifier (its local-part, dropping a leading
        // "_@" which conventionally means "the domain itself") before giving up,
        // so a user with only a nip05 still gets a readable name.
        if (profile != null && profile.nip05 != null && !profile.nip05.isEmpty()) {
            String n = profile.nip05;
            int at = n.indexOf('@');
            if (at == 0) {
                n = n.substring(1);
            } else if (at > 0) {
                String local = n.substring(0, at);
                n = local.equals("_") ? n.substring(at + 1) : local;
            }
            if (!n.isEmpty()) return n;
        }
        return null;
    }

    /** A sender's display name, or the localized "Anonymous". */
    private String authorName(Profile profile) {
        String name = displayName(profile);
        return name != null ? name : str(R.string.notif_anonymous);
    }

    /**
     * Map a kind-7 reaction's content to a display emoji, mirroring the web
     * client (useReactions.ts): "+"/empty → 👍, "-" → 👎, ":shortcode:" → the
     * bare shortcode, otherwise the content verbatim.
     */
    private static String reactionEmoji(JSONObject event) {
        String c = event.optString("content", "").trim();
        if (c.isEmpty() || c.equals("+")) return "👍";
        if (c.equals("-")) return "👎";
        if (c.length() >= 2 && c.startsWith(":") && c.endsWith(":")) {
            return c.substring(1, c.length() - 1);
        }
        return c;
    }

    /**
     * Filter-match gate: an event the relay streams us is only acted on if it
     * actually satisfies one of the REQ filters this connection sent (see
     * {@link RelayConnection#sendReqs}). Mirrors those filters' exact
     * kind/author/tag predicates — scoped to the same relay role — so a
     * malicious or buggy relay can't smuggle in traffic we never asked for
     * (a kind-9 for a group we haven't joined, a DM from a non-follow, a
     * Concord wrap for a channel/stream we hold no key for, a gift wrap not
     * addressed to us). {@code since} gating is handled separately
     * (notifiedIds + the per-relay inclusive cursor). Any kind no filter
     * requests (e.g. 5 deletes, 1068 polls) is dropped.
     */
    private boolean passesFilter(JSONObject event, int kind, String relayUrl) {
        switch (kind) {
            case 9: {
                // {kinds:[9], "#h":ids} — only the groups THIS relay hosts.
                Set<String> gids = relayToGroupIds.get(relayUrl);
                return gids != null && gids.contains(tagValue(event, "h"));
            }
            case 7:
            case 1111: {
                // {kinds:[7,1111], "#h":ids, "#p":[me]} on the group's host relay.
                Set<String> gids = relayToGroupIds.get(relayUrl);
                return gids != null
                        && gids.contains(tagValue(event, "h"))
                        && pTags(event).contains(userPubkey);
            }
            case 4:
                // {kinds:[4], authors:dmFollows, "#p":[me]} on the DM relays.
                return dmRelays.contains(relayUrl)
                        && dmFollows.contains(event.optString("pubkey"))
                        && dmNotificationEnabled(event.optString("pubkey"))
                        && pTags(event).contains(userPubkey);
            case 1059: {
                // Two filters carry kind 1059: the Concord wrap sub is
                // authors-scoped to this relay's stream keys; the NIP-17 DM
                // wrap sub is the broad "#p":[me] inbox on the DM relays.
                Set<String> pks = relayToPks2.get(relayUrl);
                if (pks != null && pks.contains(event.optString("pubkey"))) return true;
                return dmRelays.contains(relayUrl) && pTags(event).contains(userPubkey);
            }
            case 21059:
                // {kinds:[21059], "#p":[me]} — ephemeral DM signals (calls),
                // on the DM relays only.
                return dmRelays.contains(relayUrl) && pTags(event).contains(userPubkey);
            default:
                // The user's own replaceable documents: authored by us, and
                // only on the relays we actually asked. SelfState.storable
                // re-checks authorship against the parsed rumor at write time;
                // this is the same refusal at the filter boundary, so a relay
                // volunteering somebody else's 10009 is dropped before it is
                // verified, stored, or counted.
                if (SelfState.isSelfKind(kind)
                        && userPubkey != null
                        && (userPubkey.equals(event.optString("pubkey"))
                            || (kind == SelfState.KIND_APP_SPECIFIC
                                && selfDocs.containsKey(event.optString("pubkey"))))) {
                    return shouldSyncSelfStateFromRelay(relayUrl, selfRelays);
                }
                return false;
        }
    }

    /** Account documents never use joined conversation relays as a fallback. */
    static boolean shouldSyncSelfStateFromRelay(String relayUrl, Set<String> selfRelays) {
        return selfRelays.contains(relayUrl);
    }

    /**
     * The WebView resolves the room's channel/community/global message level
     * before it sends groupSubs/concordSubs. Therefore kind-9 is authorized by
     * membership in that resolved subscription itself: non-mentionOnly means
     * all messages, mentionOnly requires a real mention. Reaction and reply
     * switches remain independent per-kind prefs.
     */
    private boolean wantsNotification(int kind, boolean mentionsMe, boolean mentionOnly) {
        return wantsNotification(kind, mentionsMe, mentionOnly, prefs);
    }

    /** Static so the decision is unit-testable without an Android runtime. */
    static boolean wantsNotification(int kind, boolean mentionsMe, boolean mentionOnly, JSONObject prefs) {
        if (mentionOnly && !mentionsMe) return false;
        switch (kind) {
            case 9:
                return wantsResolvedGroupMessage(mentionOnly, mentionsMe);
            case 7:
                return prefs.optBoolean("reactions", true);
            case 1111:
                return prefs.optBoolean("replies", true);
            case 4:
                return prefs.optBoolean("directMessages", true);
        }
        return false;
    }

    /** Resolved plaintext room policy shared by NIP-29 and decrypted Concord. */
    static boolean wantsResolvedGroupMessage(boolean mentionOnly, boolean mentionsMe) {
        return !mentionOnly || mentionsMe;
    }

    /** An opaque Concord wrap cannot prove a mention, so only resolved-all survives. */
    static boolean wantsOpaqueResolvedGroupMessage(boolean mentionOnly) {
        return !mentionOnly;
    }

    private boolean prefBool(String key, boolean dflt) {
        return prefs.optBoolean(key, dflt);
    }

    /** Exact DM level first, then the account-global directMessages fallback. */
    private boolean dmNotificationEnabled(String conversationKey) {
        return dmNotificationEnabled(conversationKey, prefs, dmLevels);
    }

    /** Static overload keeps the precedence rule covered by plain JVM tests. */
    static boolean dmNotificationEnabled(String conversationKey, JSONObject prefs,
                                         Map<String, String> exactLevels) {
        String exact = conversationKey != null ? exactLevels.get(conversationKey) : null;
        if ("nothing".equals(exact)) return false;
        if ("all".equals(exact) || "mentions".equals(exact)) return true;
        return prefs.optBoolean("directMessages", true);
    }

    /** Broad NIP-17/call inbox is needed if global DMs OR any exact room is on. */
    private boolean shouldWatchDm() {
        return shouldWatchDm(prefs, dmLevels);
    }

    /** Static overload covers the subscription half of exact-level precedence. */
    static boolean shouldWatchDm(JSONObject prefs, Map<String, String> exactLevels) {
        if (prefs.optBoolean("directMessages", true)) return true;
        for (String level : exactLevels.values()) {
            if ("all".equals(level) || "mentions".equals(level)) return true;
        }
        return false;
    }

    // ── Notifications ───────────────────────────────────────────────────────

    /**
     * Append a message to its room's accumulating MessagingStyle notification
     * and (re)post it. This is the single entry point for all message-like
     * notifications (groups, Concord channels, DMs). Each channel and each DM
     * peer gets its own standalone conversation notification, so a tap and the
     * Mark read action act on that one conversation only.
     *
     * @param community the community this room belongs to — its image/name
     *                  brand the notification. {@code null} for 1:1 DMs, which
     *                  render without a conversation title.
     * @param roomKey   stable conversation id (groupId / Concord channel / "dm:<peer>"),
     *                  used for active-room suppression and Mark-read markers
     * @param roomTitle conversation display name ("Community / #channel", or
     *                  peer name for DMs)
     * @param url       in-app deep-link opened on tap
     * @param senderPubkey  message author (for the MessagingStyle Person key)
     * @param senderName    author display name
     * @param senderPicture author avatar URL (resolved async; optional)
     * @param text          the message line (already truncated/verb-substituted)
     * @param timestampMs   message time in ms (for ordering in the expansion)
     * @param mention       true if this message @-mentioned the user (bypasses
     *                      the active-room suppression — a mention is a deliberate
     *                      ping even on the channel the user is currently viewing)
     */
    private void enqueueRoomMessage(
            CommunityRef community, String roomKey, String roomTitle, String url,
            String senderPubkey, String senderName, String senderPicture,
            String text, long timestampMs, boolean mention) {
        // The NIP-17 path arrives here on the signer's executor; the room,
        // budget and hold state are handler-confined.
        if (android.os.Looper.myLooper() != handler.getLooper()) {
            handler.post(() -> enqueueRoomMessage(community, roomKey, roomTitle, url,
                    senderPubkey, senderName, senderPicture, text, timestampMs, mention));
            return;
        }
        // Suppress the notification entirely when the user is already looking at
        // this room — the live `relayEvent` feed already
        // painted the message in the timeline, so a tray entry would be
        // redundant. A mention still fires: it's an explicit @-ping that
        // deserves attention even on the visible channel. The active-room keys
        // are heartbeat-bound, so a dead WebView cannot leave one suppressed.
        if (!mention && roomKey != null && freshActiveRoomKeys().contains(roomKey)) {
            return;
        }
        if (alertPolicy.holding(SystemClock.elapsedRealtime())) {
            if (heldMessages.size() >= MAX_HELD_MESSAGES) heldMessages.remove(0);
            heldMessages.add(new HeldMessage(community, roomKey, roomTitle, url, senderPubkey,
                    senderName, senderPicture, text, timestampMs, mention));
            if (BuildConfig.DEBUG) Log.d(TAG, "HOLD (other device active): " + roomKey);
            if (!heldFlushPosted) {
                heldFlushPosted = true;
                handler.postDelayed(flushHeldRunnable, AlertPolicy.HOLD_RECHECK_MS);
            }
            return;
        }
        // Past the room's alert budget the notification is still posted and
        // still accumulates — it just stops making noise. See ALERT_BURST_MAX.
        //
        // A message from an established DM peer is never throttled to silence,
        // and never draws on the budget. The ceiling defends against untrusted
        // floods — a public Concord channel is writable by anyone holding the
        // invite (CORD-04 §1) — whereas this roster comes from the reader's own
        // follow/accept/pin/send actions. `dmFollows` is the historical config
        // key for the established peer set; an empty set or an unknown sender
        // just falls through to the ceiling, so the hint only ever relaxes it.
        boolean trusted = senderPubkey != null && dmFollows.contains(senderPubkey);
        if (!trusted && roomKey != null && roomKey.startsWith("dm:")) {
            // A rostered group is trusted only as this exact room. Do not add
            // its current author to the global peer set to relax unrelated 1:1s.
            trusted = dmKnownConversations.contains(roomKey.substring(3));
        }
        boolean direct = mention || (roomKey != null && roomKey.startsWith("dm"));
        // Channels share their community's throttle; DMs and mentions keep their own.
        String throttleKey = !direct && community != null ? community.groupKey : roomKey;
        boolean alert = (trusted || alertAllowed(roomKey, mention))
                && alertPolicy.shouldAlert(throttleKey, direct, SystemClock.elapsedRealtime());
        // Post immediately without the avatar, then re-post with it once loaded
        // so image I/O never delays the notification.
        Bitmap cachedAvatar = senderPicture != null ? avatarCache.get(senderPicture) : null;
        postRoomMessage(community, roomKey, roomTitle, url, senderPubkey, senderName,
                cachedAvatar, text, timestampMs, /*avatarRefresh=*/false, alert);

        if (senderPicture != null && !senderPicture.isEmpty() && cachedAvatar == null) {
            fetchAvatar(senderPicture, bmp -> {
                if (bmp != null) {
                    // Attach the avatar to the just-added message line, then
                    // re-post the same room id. This is a silent refresh — the
                    // initial post already alerted, so don't vibrate/sound again
                    // just because the avatar finished loading.
                    postRoomMessage(community, roomKey, roomTitle, url, senderPubkey, senderName,
                            bmp, text, timestampMs, /*avatarRefresh=*/true, /*alert=*/false);
                }
            });
        }
    }

    /** Post what {@link AlertPolicy} held, once the other device has gone quiet. */
    private void flushHeldMessages() {
        heldFlushPosted = false;
        if (heldMessages.isEmpty()) return;
        if (alertPolicy.holding(SystemClock.elapsedRealtime())) {
            heldFlushPosted = true;
            handler.postDelayed(flushHeldRunnable, AlertPolicy.HOLD_RECHECK_MS);
            return;
        }
        List<HeldMessage> due = new ArrayList<>(heldMessages);
        heldMessages.clear();
        for (HeldMessage m : due) {
            String readKey = readKeyForRoom(m.roomKey);
            Long readSec = readKey != null ? lastReadByKey.get(readKey) : null;
            if (readSec != null && readSec * 1000L >= m.timestampMs) {
                if (BuildConfig.DEBUG) Log.d(TAG, "HELD read elsewhere: " + m.roomKey);
                continue;
            }
            enqueueRoomMessage(m.community, m.roomKey, m.roomTitle, m.url, m.senderPubkey,
                    m.senderName, m.senderPicture, m.text, m.timestampMs, m.mention);
        }
    }

    /**
     * The user acted on another device. Only counted while this phone is not
     * in use: an echo of its own read or send then can't hold its alerts, and
     * with the screen already on an alert costs no wake.
     */
    private void noteOtherDeviceActivity() {
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isInteractive()) return;
        alertPolicy.noteOtherDeviceActivity(SystemClock.elapsedRealtime());
    }

    /**
     * Whether this room may make NOISE for one more message, spending from the
     * per-room budget described at {@link #ALERT_BURST_MAX}. Messages and
     * mentions draw on separate budgets.
     *
     * Called once per notified message on the relay thread (the same thread
     * that owns every other field here), so the maps need no synchronization.
     */
    private boolean alertAllowed(String roomKey, boolean mention) {
        if (roomKey == null) return true;
        java.util.Map<String, java.util.ArrayDeque<Long>> budget = mention ? mentionBurst : alertBurst;
        java.util.ArrayDeque<Long> times = budget.get(roomKey);
        if (times == null) {
            times = new java.util.ArrayDeque<>();
            budget.put(roomKey, times);
        }
        long now = System.currentTimeMillis();
        while (!times.isEmpty() && now - times.peekFirst() > ALERT_BURST_WINDOW_MS) {
            times.pollFirst();
        }
        boolean allow = times.size() < (mention ? ALERT_BURST_MAX_MENTION : ALERT_BURST_MAX);
        // Recorded whether or not it alerted — that is what keeps a sustained
        // flood's window full, and quiet, until the flood actually stops.
        times.addLast(now);
        while (times.size() > ALERT_BURST_MAX_TRACKED) times.pollFirst();
        if (budget.size() > ALERT_BURST_SWEEP_AT) sweepAlertBurst(budget, now);
        return allow;
    }

    /**
     * Drop rooms whose newest attempt is outside the window — their budget is
     * full again, exactly as if the key were absent. Only runs past
     * {@link #ALERT_BURST_SWEEP_AT} rooms, so a normal session never scans.
     */
    private static void sweepAlertBurst(java.util.Map<String, java.util.ArrayDeque<Long>> budget, long now) {
        java.util.Iterator<java.util.ArrayDeque<Long>> it = budget.values().iterator();
        while (it.hasNext()) {
            java.util.ArrayDeque<Long> t = it.next();
            if (t.isEmpty() || now - t.peekLast() > ALERT_BURST_WINDOW_MS) it.remove();
        }
    }

    /**
     * Core builder: accumulate a message into its {@link RoomNotif} and post
     * the room's MessagingStyle notification. When {@code avatarRefresh} is
     * set, no new line is added; instead the matching already-added line gets
     * its sender avatar attached (used to re-post once the avatar resolves).
     * {@code alert} false posts silently (no vibration/sound) for such
     * in-place refreshes.
     */
    private void postRoomMessage(
            CommunityRef community, String roomKey, String roomTitle, String url,
            String senderPubkey, String senderName, Bitmap avatar,
            String text, long timestampMs, boolean avatarRefresh, boolean alert) {
        long t = ServiceProfiler.begin("notify.post");
        try {
            postRoomMessageInner(community, roomKey, roomTitle, url, senderPubkey, senderName,
                    avatar, text, timestampMs, avatarRefresh, alert);
        } finally {
            ServiceProfiler.end("notify.post", t);
        }
    }

    private void postRoomMessageInner(
            CommunityRef community, String roomKey, String roomTitle, String url,
            String senderPubkey, String senderName, Bitmap avatar,
            String text, long timestampMs, boolean avatarRefresh, boolean alert) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        RoomNotif room = roomNotifs.get(roomKey);
        if (room == null) {
            room = new RoomNotif(roomKey, hashId(roomKey));
            roomNotifs.put(roomKey, room);
        }
        room.community = community;
        // If the room's notification was dismissed (swiped / tapped away) since
        // its last message, start a FRESH notification rather than appending to
        // the dismissed message history — otherwise a new message in a room the
        // user already cleared would resurrect the old lines they dismissed.
        // Only checked on a genuine new line; an in-place avatar refresh
        // re-uses the just-added line.
        if (!avatarRefresh && !room.messages.isEmpty() && !isNotifActive(manager, room.notifId)) {
            room.messages.clear();
            room.lastTimestampMs = timestampMs;
        }

        String sKey = senderPubkey != null ? senderPubkey : roomKey;
        String sName = senderName != null ? senderName : str(R.string.notif_someone);
        if (avatarRefresh) {
            // Attach the avatar to the line this refresh belongs to. Matched by
            // sender + timestamp + text (not "the last line") so a message that
            // arrived meanwhile can't get the wrong face.
            boolean found = false;
            for (int i = room.messages.size() - 1; i >= 0; i--) {
                MsgEntry e = room.messages.get(i);
                if (e.tsMs == timestampMs && e.senderKey.equals(sKey) && e.text.equals(text != null ? text : "")) {
                    e.avatar = avatar;
                    found = true;
                    break;
                }
            }
            if (!found) return; // line already rotated out / dismissed
        } else {
            room.messages.add(new MsgEntry(sKey, sName, avatar,
                    text != null ? text : "", timestampMs, /*fromSelf=*/false));
            // Bound the retained history so a chatty room can't grow unbounded.
            while (room.messages.size() > MAX_MESSAGES_PER_ROOM) {
                room.messages.remove(0);
            }
            room.title = roomTitle;
            room.url = url;
        }
        room.lastTimestampMs = Math.max(room.lastTimestampMs, timestampMs);
        if (avatar != null) {
            // Remember it for the collapsed-view large icon fallback.
            room.lastAvatar = avatar;
        }

        // Conversation shortcut (the key to the Signal-style left avatar on
        // Android 11+, see pushConversationShortcut): every room gets one. A DM
        // uses the sender's avatar; a community room uses the COMMUNITY image
        // (like a Signal group chat's group avatar) — if it isn't cached yet,
        // the shortcut goes up icon-less and the async fetch below re-pushes it
        // (and silently re-posts the room) once resolved.
        // The shortcut names the CONVERSATION, so its person is the last
        // INCOMING sender — a reply we sent must not repoint a DM's shortcut
        // (and its avatar) at ourselves.
        MsgEntry lastEntry = room.messages.get(room.messages.size() - 1);
        for (int i = room.messages.size() - 1; i >= 0; i--) {
            if (!room.messages.get(i).fromSelf) {
                lastEntry = room.messages.get(i);
                break;
            }
        }
        Person lastSender = personFor(lastEntry);
        Bitmap communityIcon = community != null ? groupImageCache.get(community.imageCacheKey()) : null;
        if (community == null) {
            pushConversationShortcut(room, lastSender,
                    avatar != null ? avatar : room.lastAvatar);
        } else {
            pushConversationShortcut(room, lastSender, communityIcon);
        }

        // Drop rooms the user already dismissed from the tray so a later message
        // starts a fresh notification instead of resurrecting cleared lines.
        pruneDismissedRooms(manager, room.notifId);

        postRoomNotification(manager, room, alert);

        // Kick off the community-icon fetch if we don't have it yet; once
        // resolved, re-push the shortcut and silently re-post so the left
        // avatar updates from the app icon to the community image.
        if (community != null && communityIcon == null && community.hasImage()) {
            fetchCommunityImage(community, bmp -> {
                if (bmp == null) return;
                groupImageCache.put(community.imageCacheKey(), bmp);
                RoomNotif r = roomNotifs.get(roomKey);
                if (r == null || r.messages.isEmpty()) return;
                NotificationManager m2 =
                        (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (m2 == null || !isNotifActive(m2, r.notifId)) return;
                MsgEntry le = r.messages.get(r.messages.size() - 1);
                pushConversationShortcut(r, personFor(le), bmp);
                postRoomNotification(m2, r, /*alert=*/false);
            });
        }
    }

    /**
     * Remove from {@link #roomNotifs} any room whose notification is no longer in
     * the status bar (the user tapped/swiped it away), except {@code keepNotifId}
     * (the one we're about to (re)post). API 23+; a no-op on older devices.
     */
    private void pruneDismissedRooms(NotificationManager manager, int keepNotifId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            Set<Integer> active = new HashSet<>();
            for (android.service.notification.StatusBarNotification sbn : activeNotifications(manager)) {
                active.add(sbn.getId());
            }
            java.util.Iterator<Map.Entry<String, RoomNotif>> it = roomNotifs.entrySet().iterator();
            while (it.hasNext()) {
                RoomNotif r = it.next().getValue();
                if (r.notifId != keepNotifId && !active.contains(r.notifId)) {
                    it.remove();
                }
            }
        } catch (Exception ignored) {
            // getActiveNotifications can throw on some OEM builds — best-effort.
        }
    }

    /** Catch platform/OEM posting failures so one bad tray state cannot kill the service. */
    private boolean postRoomNotification(NotificationManager manager, RoomNotif room,
                                         boolean alert) {
        capActiveRoomNotifications(manager, room.notifId);
        try {
            manager.notify(room.notifId, buildRoomNotification(room, alert));
            healthLastPresentedAtMs = System.currentTimeMillis();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "room notification post failed", e);
            recordHealthError("post_message");
            return false;
        }
    }

    /** Trim orphaned room posts left by a previous process before accepting more. */
    private void reconcileActiveRoomNotifications() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) capActiveRoomNotifications(manager, -1);
    }

    /**
     * Keep at most {@link #MAX_ACTIVE_ROOM_NOTIFICATIONS} room notifications,
     * oldest first. `keepNotifId` reserves a slot for the room being posted; -1
     * is the startup reconciliation where every existing room competes equally.
     */
    private void capActiveRoomNotifications(NotificationManager manager, int keepNotifId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            List<android.service.notification.StatusBarNotification> rooms = new ArrayList<>();
            for (android.service.notification.StatusBarNotification sbn : activeNotifications(manager)) {
                int id = sbn.getId();
                if (id != keepNotifId
                        && isRoomNotification(sbn.getNotification().getGroup())) {
                    rooms.add(sbn);
                }
            }
            int allowed = keepNotifId >= 0
                    ? MAX_ACTIVE_ROOM_NOTIFICATIONS - 1
                    : MAX_ACTIVE_ROOM_NOTIFICATIONS;
            if (rooms.size() <= allowed) return;
            rooms.sort(java.util.Comparator.comparingLong(
                    android.service.notification.StatusBarNotification::getPostTime));
            Set<Integer> cancelled = new HashSet<>();
            for (int i = 0; i < rooms.size() - allowed; i++) {
                int id = rooms.get(i).getId();
                manager.cancel(id);
                cancelled.add(id);
            }
            if (!cancelled.isEmpty()) {
                java.util.Iterator<Map.Entry<String, RoomNotif>> it = roomNotifs.entrySet().iterator();
                while (it.hasNext()) {
                    if (cancelled.contains(it.next().getValue().notifId)) it.remove();
                }
                Log.i(TAG, "Trimmed " + cancelled.size() + " stale room notifications");
            }
        } catch (Exception e) {
            Log.w(TAG, "active notification reconciliation failed", e);
            recordHealthError("active_reconcile");
        }
    }

    /**
     * Whether the notification id is still in the status bar (i.e. has NOT been
     * dismissed by the user). API 23+; returns true (assume active) on older
     * devices or when getActiveNotifications throws on an OEM build, so we never
     * spuriously clear a room's history on a device that can't actually tell us.
     */
    private boolean isNotifActive(NotificationManager manager, int notifId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            for (android.service.notification.StatusBarNotification sbn : activeNotifications(manager)) {
                if (sbn.getId() == notifId) return true;
            }
            return false;
        } catch (Exception ignored) {
            return true;
        }
    }

    /** Build a room's MessagingStyle notification from its accumulated messages. */
    private Notification buildRoomNotification(RoomNotif room, boolean alert) {
        // Every room is a conversation notification: paired with the
        // conversation shortcut pushed in postRoomMessage (setShortcutId
        // below), Android 11+ renders the shortcut's avatar as the LEFT icon
        // in place of the app icon — the peer's avatar for a 1:1 DM, the
        // community image for a channel (like a Signal group chat).
        boolean isDm = room.community == null;
        // A group DM is a DM — no community brands it — that nonetheless has
        // several people speaking in it, so it takes a conversation title like
        // a channel does. Without one the system titles the notification with
        // whichever member spoke last, which reads as a 1:1 with them.
        boolean titled = !isDm || isDmGroupKey(room.roomKey);

        // The local user, who a sent quick reply is attributed to: their own
        // kind-0 name + avatar when we hold one, "You" when we don't.
        Person self = selfPerson();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(self);
        if (!titled) {
            // 1:1: no conversation title — the system titles it with the
            // sender Person's name (a title would make it render as a group).
            style.setGroupConversation(false);
        } else {
            style.setConversationTitle(conversationTitle(room));
            style.setGroupConversation(true);
        }
        for (MsgEntry e : room.messages) {
            // A null sender means "the current user" (the style's self person)
            // — how a line sent from the Reply action renders as outgoing.
            style.addMessage(new NotificationCompat.MessagingStyle.Message(
                    e.text, e.tsMs, e.fromSelf ? null : personFor(e)));
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
                .setStyle(style)
                .setSmallIcon(R.drawable.ic_stat_armada)
                // Sender avatar fallback for surfaces that don't do the
                // conversation layout (pre-Android-11, some OEM skins). On the
                // conversation layout the system ignores this and uses the
                // shortcut/Person avatar on the left instead.
                .setLargeIcon(room.lastAvatar)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(roomPendingIntent(room))
                .setAutoCancel(true)
                .setWhen(room.lastTimestampMs)
                // A silent refresh (e.g. late avatar) must not re-buzz; only a
                // genuine new message alerts.
                .setOnlyAlertOnce(!alert)
                // onlyAlertOnce covers updates only; a first post needs this to stay quiet.
                .setSilent(!alert)
                // Ties the notification to the conversation shortcut pushed in
                // postRoomMessage — the key that promotes it into the
                // conversation space where the shortcut's avatar (sender for
                // DMs, community image for channels) replaces the app icon.
                .setShortcutId(shortcutIdFor(room));
        // Each conversation gets its OWN unique group key: it shows
        // standalone (a group of one, no summary), but the explicit key opts
        // it out of Android's auto-bundling — which otherwise sweeps 4+
        // group-less notifications into one system pile under the app icon,
        // collapsing separate conversations together. Deliberately NOT the
        // community's shared key: a per-community group summary can't carry
        // the community's branding (Android renders the app name/icon), so
        // channels stand alone instead of stacking.
        b.setGroup(GROUP_PREFIX + "room:" + room.roomKey);
        // "Reply": a RemoteInput the service publishes back into the
        // conversation natively (see handleReply). Only on rooms with a real
        // send path — no shared signer, or a room the config can't route a
        // send for, leaves Mark read alone.
        if (canReply(room)) {
            RemoteInput input = new RemoteInput.Builder(KEY_TEXT_REPLY)
                    .setLabel(str(R.string.notif_reply))
                    .build();
            b.addAction(new NotificationCompat.Action.Builder(
                    R.drawable.ic_stat_armada, str(R.string.notif_reply), replyIntent(room))
                    .addRemoteInput(input)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setShowsUserInterface(false)
                    .setAllowGeneratedReplies(true)
                    .build());
        }
        // "Mark read": dismiss this notification and advance the in-app read
        // state (applied by the WebView on its next open). Shown on every room.
        b.addAction(new NotificationCompat.Action.Builder(
                R.drawable.ic_stat_armada, str(R.string.notif_mark_read), markReadIntent(room)).build());
        if (alert) {
            b.setVibrate(MSG_VIBRATION_PATTERN)
                    .setDefaults(NotificationCompat.DEFAULT_LIGHTS | NotificationCompat.DEFAULT_SOUND);
        }
        return b.build();
    }

    /** The conversation title shown for a room (and its shortcut label). */
    private String conversationTitle(RoomNotif room) {
        return room.title != null && !room.title.isEmpty() ? room.title : str(R.string.notif_chat);
    }

    /**
     * The MessagingStyle self Person — who a sent quick reply shows as. Uses
     * the user's own kind-0 (name + avatar) once {@link #warmSelfProfile} has
     * resolved it, falling back to a bare "You". Synchronous by construction:
     * it reads only the warmed fields, so building a notification never waits
     * on a profile fetch or an avatar decode.
     *
     * The fallback is "You", not "Anonymous" — an unnamed profile should read
     * as the user, not as a stranger.
     */
    private Person selfPerson() {
        String resolved = displayName(selfProfile);
        String name = resolved != null ? resolved : str(R.string.notif_you);
        Person.Builder pb = new Person.Builder()
                .setName(name)
                .setKey(userPubkey != null ? userPubkey : "self");
        if (selfAvatar != null) pb.setIcon(IconCompat.createWithBitmap(selfAvatar));
        return pb.build();
    }

    /**
     * Resolve the user's own profile + avatar for {@link #selfPerson}, through
     * the same path every other author takes (memory store → shared DB →
     * one-shot relay fetch). Usually a synchronous hit: the WebView writes
     * every kind-0 it reads into the shared store, the user's own included.
     * A late resolve re-posts the rooms already showing a reply, so the line
     * gains its name/avatar in place rather than only on the next message.
     */
    private void warmSelfProfile() {
        if (userPubkey == null || selfProfilePending) return;
        boolean haveName = selfProfile != null;
        boolean needAvatar = selfAvatar == null && selfProfile != null
                && selfProfile.picture != null && !selfProfile.picture.isEmpty();
        if (haveName && !needAvatar) return;
        selfProfilePending = true;
        resolveAuthor(userPubkey, null, profile -> {
            selfProfilePending = false;
            if (profile != null) {
                boolean gainedName = selfProfile == null;
                selfProfile = profile;
                if (gainedName) repostRoomsWithReplies();
            }
            String picture = selfProfile != null ? selfProfile.picture : null;
            if (picture == null || picture.isEmpty() || selfAvatar != null) return;
            Bitmap cached = avatarCache.get(picture);
            if (cached != null) {
                selfAvatar = cached;
                repostRoomsWithReplies();
                return;
            }
            fetchAvatar(picture, bmp -> {
                if (bmp == null) return;
                selfAvatar = bmp;
                repostRoomsWithReplies();
            });
        });
    }

    /**
     * Silently re-post every still-posted room that shows a sent reply, so a
     * self name/avatar that resolved after the fact lands on the line already
     * in the tray.
     */
    private void repostRoomsWithReplies() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        for (RoomNotif room : roomNotifs.values()) {
            boolean hasReply = false;
            for (MsgEntry e : room.messages) {
                if (e.fromSelf) {
                    hasReply = true;
                    break;
                }
            }
            if (hasReply && isNotifActive(manager, room.notifId)) {
                postRoomNotification(manager, room, /*alert=*/false);
            }
        }
    }

    /** Build a message line's sender Person (avatar attached once resolved). */
    private static Person personFor(MsgEntry e) {
        Person.Builder pb = new Person.Builder()
                .setName(e.senderName)
                .setKey(e.senderKey);
        if (e.avatar != null) {
            pb.setIcon(IconCompat.createWithBitmap(e.avatar));
        }
        return pb.build();
    }

    /**
     * PendingIntent for a room's "Mark read" action — delivered to the service
     * with {@link #ACTION_MARK_READ} + the room key and its latest message
     * timestamp (carried as one-element arrays so the marker survives a
     * service cold start with the right ts). A per-room data URI keeps each
     * room's PendingIntent distinct (extras alone don't affect PendingIntent
     * identity, so without it two rooms could share one cached intent);
     * FLAG_UPDATE_CURRENT refreshes the extras on every re-post so the
     * timestamp tracks the latest message.
     */
    private PendingIntent markReadIntent(RoomNotif room) {
        Intent intent = new Intent(this, NotificationRelayService.class);
        intent.setAction(ACTION_MARK_READ);
        intent.setData(Uri.parse("armada-markread:" + room.notifId));
        intent.putExtra(EXTRA_ROOM_KEY, room.roomKey);
        intent.putExtra(EXTRA_CHANNEL_KEYS, new String[] { room.roomKey });
        intent.putExtra(EXTRA_CHANNEL_TS, new long[] { room.lastTimestampMs });
        return PendingIntent.getService(
                this, room.notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Handle a "Mark read" tap: cancel the room's notification, drop its
     * accumulated history, and enqueue a durable read-marker the WebView
     * applies on its next open/resume to advance the in-app read state.
     * Robust to a cold start (no in-memory room): the room key + timestamp
     * ride on the intent and the notif id is re-derivable from the room key.
     */
    private void handleMarkRead(Intent intent) {
        String roomKey = intent.getStringExtra(EXTRA_ROOM_KEY);
        if (roomKey == null || roomKey.isEmpty()) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        RoomNotif room = roomNotifs.remove(roomKey);
        int notifId = room != null ? room.notifId : hashId(roomKey);
        if (manager != null) {
            manager.cancel(notifId);
        }
        String[] channelKeys = intent.getStringArrayExtra(EXTRA_CHANNEL_KEYS);
        long[] channelTs = intent.getLongArrayExtra(EXTRA_CHANNEL_TS);
        if (channelKeys == null || channelTs == null || channelKeys.length != channelTs.length) {
            // Fallback: treat the room key itself as the one conversation.
            channelKeys = new String[] { roomKey };
            channelTs = new long[] { room != null && room.lastTimestampMs > 0
                    ? room.lastTimestampMs : System.currentTimeMillis() };
        }
        for (int i = 0; i < channelKeys.length; i++) {
            String key = channelKeys[i];
            if (key == null || key.isEmpty()) continue;
            long tsMs = channelTs[i] > 0 ? channelTs[i] : System.currentTimeMillis();
            ArmadaNotificationPlugin.enqueueReadMarker(this, key, tsMs / 1000L);
            if (BuildConfig.DEBUG) Log.d(TAG, "MARK READ " + key);
        }
    }

    // ── Quick reply ──────────────────────────────────────────────────────────

    /**
     * Whether a native send path exists for this room: a shared signer, plus a
     * protocol the service can build end-to-end. DMs go out as NIP-17 (rumor →
     * seal → wrap; the signer covers the seal's encrypt + sign for every login
     * type), NIP-29 rooms as a plain kind 9 to the group's host relay, and
     * Concord rooms as a CORD-02 rumor → seal →
     * wrap — the seal signed through the shared signer, the wrap by the stream
     * secret read from the group-key memo the WebView persists in the shared
     * ArmadaDB (no key crosses the plugin bridge; see streamSecretFor).
     */
    private boolean canReply(RoomNotif room) {
        if (nativeSigner == null || userPubkey == null || room.roomKey == null) return false;
        String key = room.roomKey;
        if (key.startsWith("dm:")) return isDmConvKey(key.substring(3));
        if (key.startsWith("h:")) return key.substring(2).lastIndexOf('|') > 0;
        // Config-only check (no DB read on every post); the stream secret is
        // resolved from the store at send time and fails the reply visibly if
        // the memo lacks it (possible only if the WebView never derived it —
        // which would also mean it could never have configured the stream).
        if (key.startsWith("c2:")) return c2ReplyStream(key.substring(3)) != null;
        return false;
    }

    /**
     * PendingIntent for a room's "Reply" action. MUTABLE — unlike every other
     * PendingIntent here — because the system must attach the RemoteInput
     * results bundle to it; an immutable one delivers a null reply on
     * Android 12+.
     */
    private PendingIntent replyIntent(RoomNotif room) {
        Intent intent = new Intent(this, NotificationRelayService.class);
        intent.setAction(ACTION_REPLY);
        intent.setData(Uri.parse("armada-reply:" + room.notifId));
        intent.putExtra(EXTRA_ROOM_KEY, room.roomKey);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        return PendingIntent.getService(this, room.notifId, intent, flags);
    }

    /**
     * Handle a "Reply" action tap: append the text to the room's notification
     * as an outgoing line at once (which is also what clears the action's
     * spinner), enqueue a read marker (replying implies the room was read),
     * then build and publish the reply natively. On failure the line is
     * rewritten in place and the notification re-alerts, so a reply typed on
     * the lockscreen never silently vanishes.
     */
    private void handleReply(Intent intent) {
        String roomKey = intent.getStringExtra(EXTRA_ROOM_KEY);
        if (roomKey == null || roomKey.isEmpty()) return;
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence raw = results != null ? results.getCharSequence(KEY_TEXT_REPLY) : null;
        String text = raw != null ? raw.toString().trim() : "";
        if (text.isEmpty()) {
            // Nothing to send; re-post as-is so the action's spinner clears.
            RoomNotif existing = roomNotifs.get(roomKey);
            if (existing != null) repostRoom(existing, false);
            return;
        }

        MsgEntry sent = appendOutgoing(roomKey, text);
        markRepliedRead(roomKey);
        // The reply renders as the user: resolve their own kind-0 if this is
        // the first one since the service started (usually a store hit, and a
        // late one re-posts the line in place).
        warmSelfProfile();

        NativeSigner signer = nativeSigner;
        if (signer == null) {
            finishReply(roomKey, sent, false);
        } else if (roomKey.startsWith("dm:")) {
            sendDmReply(signer, roomKey.substring(3), text, roomKey, sent);
        } else if (roomKey.startsWith("h:")) {
            sendNip29Reply(signer, roomKey, text, sent);
        } else if (roomKey.startsWith("c2:")) {
            sendConcordReply(signer, roomKey, text, sent);
        } else {
            finishReply(roomKey, sent, false);
        }
    }

    /**
     * Append the reply as an outgoing line and re-post the room silently.
     * Survives a service cold start (the in-memory room is gone but the
     * notification is still in the tray): a minimal room is rebuilt so the
     * post lands on the same stable id and the spinner still clears — with a
     * generic title, since the accumulated history died with the process.
     */
    private MsgEntry appendOutgoing(String roomKey, String text) {
        RoomNotif room = roomNotifs.get(roomKey);
        if (room == null) {
            room = new RoomNotif(roomKey, hashId(roomKey));
            roomNotifs.put(roomKey, room);
        }
        MsgEntry entry = new MsgEntry(userPubkey != null ? userPubkey : "self", str(R.string.notif_you),
                /*avatar=*/null, text, System.currentTimeMillis(), /*fromSelf=*/true);
        room.messages.add(entry);
        while (room.messages.size() > MAX_MESSAGES_PER_ROOM) room.messages.remove(0);
        room.lastTimestampMs = Math.max(room.lastTimestampMs, entry.tsMs);
        repostRoom(room, false);
        return entry;
    }

    /** Re-post a room's notification ({@code alert} false ⇒ silent refresh). */
    private void repostRoom(RoomNotif room, boolean alert) {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) postRoomNotification(manager, room, alert);
    }

    /**
     * Replying implies the user read the room: enqueue the same durable marker
     * a "Mark read" tap would, WITHOUT cancelling the notification (the thread
     * stays up, now showing their reply).
     */
    private void markRepliedRead(String roomKey) {
        RoomNotif room = roomNotifs.get(roomKey);
        long tsMs = room != null && room.lastTimestampMs > 0
                ? room.lastTimestampMs : System.currentTimeMillis();
        ArmadaNotificationPlugin.enqueueReadMarker(this, roomKey, tsMs / 1000L);
    }

    /**
     * Resolve a reply: on success the optimistic line already reads right; on
     * failure rewrite it in place and re-alert, so the user knows to open the
     * app and send again.
     */
    private void finishReply(String roomKey, MsgEntry sent, boolean ok) {
        if (ok || sent == null) return;
        sent.text = str(R.string.notif_not_sent, sent.text);
        RoomNotif room = roomNotifs.get(roomKey);
        if (room != null && room.messages.contains(sent)) repostRoom(room, true);
    }

    /** NIP-29: a plain kind 9 with the group's `h` tag, sent to its host relay. */
    private void sendNip29Reply(NativeSigner signer, String roomKey, String text, MsgEntry sent) {
        String rest = roomKey.substring(2);
        int i = rest.lastIndexOf('|');
        if (i <= 0) {
            finishReply(roomKey, sent, false);
            return;
        }
        final String relayUrl = rest.substring(0, i);
        final String groupId = rest.substring(i + 1);
        JSONArray tags = new JSONArray().put(new JSONArray().put("h").put(groupId));
        signer.signEvent(9, text, tags, System.currentTimeMillis() / 1000, ev ->
                handler.post(() -> {
                    if (ev == null) {
                        finishReply(roomKey, sent, false);
                        return;
                    }
                    publishEvent(ev, java.util.Collections.singletonList(relayUrl), ok -> {
                        if (ok) {
                            // The same write path a received kind 9 takes, so
                            // the message is in the group's tenant on next open.
                            rememberNotificationId(ev.optString("id"));
                            ServiceStore.ingest(this, ev, relayUrl);
                        }
                        finishReply(roomKey, sent, ok);
                    });
                }));
    }

    private static long parseEpoch(String epoch) {
        try {
            return Long.parseLong(epoch);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * Concord (CORD-02): rumor (kind 9, channel/epoch/ms binding tags,
     * mirroring useChannel2's send) → seal (kind 20013, the rumor NIP-44'd
     * under the STREAM conversation key, signed by the user through the shared
     * signer) → wrap (kind 1059, random ephemeral `p`, real timestamp, signed
     * by the stream key — NIP-59 reversed, CORD-01). Both encrypt layers ride
     * the stream conversation key the config already ships; the wrap's
     * signature needs the stream SECRET, which is resolved from the group-key
     * memo in the shared store. Replies target the newest epoch held for the
     * channel. While the community's CORD-08 timer is set (shipped as the
     * sub's `timerSecs`), the rumor commits its NIP-40 deadline and the wrap
     * repeats it, exactly like a WebView send — kind 9 is never an exempt
     * kind, so the reply disappears like any other message.
     */
    private void sendConcordReply(NativeSigner signer, String roomKey, String text, MsgEntry sent) {
        final C2Stream target = c2ReplyStream(roomKey.substring(3));
        final byte[] streamSk = target != null ? streamSecretFor(target.pk) : null;
        if (target == null || streamSk == null) {
            finishReply(roomKey, sent, false);
            return;
        }
        final long nowMs = System.currentTimeMillis();
        final long createdAt = nowMs / 1000;
        final long expiresAt =
                target.stream.timerSecs > 0 ? createdAt + target.stream.timerSecs : 0;
        JSONArray rumorTags = new JSONArray()
                .put(new JSONArray().put("channel").put(target.stream.channelId))
                .put(new JSONArray().put("epoch").put(target.stream.epoch))
                .put(new JSONArray().put("ms").put(String.valueOf(nowMs % 1000)));
        if (expiresAt > 0) {
            rumorTags.put(new JSONArray().put("expiration").put(String.valueOf(expiresAt)));
        }
        final JSONObject rumor = new JSONObject();
        try {
            rumor.put("id", NostrCrypto.eventId(userPubkey, createdAt, 9, rumorTags, text));
            rumor.put("pubkey", userPubkey);
            rumor.put("created_at", createdAt);
            rumor.put("kind", 9);
            rumor.put("tags", rumorTags);
            rumor.put("content", text);
        } catch (JSONException e) {
            finishReply(roomKey, sent, false);
            return;
        }
        String sealContent = ConcordCrypto.encrypt(target.stream.convKey, rumor.toString());
        if (sealContent == null) {
            finishReply(roomKey, sent, false);
            return;
        }
        // The seal is what the author signs; its created_at matches the
        // rumor's (stream.ts sealRumor), and it carries no tags.
        signer.signEvent(20013, sealContent, new JSONArray(), createdAt, seal ->
                handler.post(() -> {
                    JSONObject built = null;
                    if (seal != null) {
                        String wrapContent =
                                ConcordCrypto.encrypt(target.stream.convKey, seal.toString());
                        if (wrapContent != null) {
                            try {
                                JSONArray wrapTags = new JSONArray().put(new JSONArray()
                                        .put("p").put(NostrCrypto.pubkeyOf(randomSecretKey())));
                                // CORD-08 §2: the wrap repeats the rumor's own
                                // deadline so relays purge the ciphertext too.
                                if (expiresAt > 0) {
                                    wrapTags.put(new JSONArray()
                                            .put("expiration").put(String.valueOf(expiresAt)));
                                }
                                built = NostrCrypto.finalizeEvent(
                                        1059, wrapContent, wrapTags,
                                        System.currentTimeMillis() / 1000, streamSk);
                            } catch (Exception ignored) {
                                // Falls through to the failure resolve below.
                            }
                        }
                    }
                    if (built == null) {
                        finishReply(roomKey, sent, false);
                        return;
                    }
                    final JSONObject wrap = built;
                    publishEvent(wrap, target.relays, ok -> {
                        if (ok) {
                            rememberNotificationId(wrap.optString("id"));
                            // The same write path a received wrap's rumor takes
                            // (kind + seal-form rules enforced there), so the
                            // reply is in the channel on next open.
                            ServiceStore.storeConcordRumor(
                                    this, target.stream.communityId, 20013, rumor);
                        }
                        finishReply(roomKey, sent, ok);
                    });
                }));
    }

    /** A Concord reply's destination: the newest-epoch stream, its address,
     * and the relays that host it. */
    private static final class C2Stream {
        final String pk;
        final ConcordStream stream;
        final List<String> relays;

        C2Stream(String pk, ConcordStream stream, List<String> relays) {
            this.pk = pk;
            this.stream = stream;
            this.relays = relays;
        }
    }

    /**
     * The V2 send target for a channel: the newest epoch the config holds a
     * stream for (a room can be notified on an old epoch's stream after a
     * rekey, but members read the current one). Null when no epoch binding or
     * no relay hosts the stream — no Reply action then.
     */
    private C2Stream c2ReplyStream(String channelId) {
        if (channelId.isEmpty()) return null;
        String bestPk = null;
        ConcordStream best = null;
        for (Map.Entry<String, ConcordStream> e : pkToStream2.entrySet()) {
            ConcordStream cand = e.getValue();
            if (!cand.channelId.equals(channelId) || cand.epoch.isEmpty()) continue;
            if (best == null || parseEpoch(cand.epoch) > parseEpoch(best.epoch)) {
                best = cand;
                bestPk = e.getKey();
            }
        }
        if (best == null) return null;
        List<String> relays = new ArrayList<>();
        for (Map.Entry<String, Set<String>> e : concordPublishRelays.entrySet()) {
            if (e.getValue().contains(bestPk)) relays.add(e.getKey());
        }
        return relays.isEmpty() ? null : new C2Stream(bestPk, best, relays);
    }

    /**
     * The stream SECRET for a stream address, from the group-key memo the
     * WebView persists in the shared ArmadaDB (KV `c2gkmemo`, see
     * groupKeyPersist.ts) — the derived keys are already at rest in this same
     * database, so reading them here grants the service nothing the device
     * didn't hold, and no key crosses the plugin bridge. Verified sk → pk so a
     * corrupted or foreign row can never sign as the wrong stream.
     */
    private byte[] streamSecretFor(String pk) {
        byte[] sk = ConcordCrypto.hexToBytes(ServiceStore.streamSecret(this, pk));
        if (sk == null || sk.length != 32) return null;
        try {
            return pk.equals(NostrCrypto.pubkeyOf(sk)) ? sk : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * NIP-17: rumor (kind 14) → seal (kind 13, nip44 to the recipient, signed
     * by the user, backdated) → wrap (kind 1059, single-use key, backdated) —
     * mirroring nip17/protocol.ts. Two envelopes: the peer's copy to their
     * published kind-10050 inbox (sends are GATED on one existing, like the
     * WebView's), and the self copy to the user's own DM relays. Success is
     * the peer's copy landing; the self copy and the store write ride along.
     */
    private void sendDmReply(NativeSigner signer, String convKey, String text, String roomKey,
                             MsgEntry sent) {
        final List<String> peers = ServiceStore.dm17ConvPeers(convKey);
        if (userPubkey == null || peers.isEmpty()) {
            finishReply(roomKey, sent, false);
            return;
        }
        for (String p : peers) {
            if (p.length() != 64) {
                finishReply(roomKey, sent, false);
                return;
            }
        }
        // NIP-17 mints one seal + wrap PER RECIPIENT — there is no group event
        // (nip17/protocol.ts). Everyone but us is a recipient; Note to Self has
        // none, and its self copy IS the send.
        final List<String> recipients = new ArrayList<>();
        for (String p : peers) {
            if (!p.equals(userPubkey)) recipients.add(p);
        }
        resolveDmInboxes(recipients, inboxes -> {
            long nowSecs = System.currentTimeMillis() / 1000;
            // Disappearing messages: while the conversation's timer is set
            // (the newest kind-1740 in the stored thread), the rumor commits
            // its NIP-40 deadline; the seal and both wraps repeat it below —
            // all three levels, matching nip17/protocol.ts.
            long timerSecs = ServiceStore.dm17TimerSecs(this, userPubkey, convKey);
            final long expiresAt = timerSecs > 0 ? nowSecs + timerSecs : 0;
            // Every participant is p-tagged, which is what makes the reply land
            // in the conversation being replied to: the `p` set IS the room, so
            // a reply tagging only the last speaker would silently open a 1:1
            // with them instead of answering the group.
            JSONArray rumorTags = new JSONArray();
            for (String p : peers) {
                rumorTags.put(new JSONArray().put("p").put(p));
            }
            if (expiresAt > 0) {
                rumorTags.put(new JSONArray().put("expiration").put(String.valueOf(expiresAt)));
            }
            final JSONObject rumor = new JSONObject();
            try {
                rumor.put("id", NostrCrypto.eventId(userPubkey, nowSecs, 14, rumorTags, text));
                rumor.put("pubkey", userPubkey);
                rumor.put("created_at", nowSecs);
                rumor.put("kind", 14);
                rumor.put("tags", rumorTags);
                rumor.put("content", text);
            } catch (JSONException e) {
                finishReply(roomKey, sent, false);
                return;
            }
            final String rumorJson = rumor.toString();

            // Where each recipient's own wrap goes: their published inbox
            // UNIONED with our own DM relays, exactly as `publishRumor` does.
            // Their 10050 is where a compliant client reads, but writing there
            // also requires us to reach it, and a peer who published none is
            // still reachable on the relays we share — the common Armada case.
            final Map<String, List<String>> targets = new LinkedHashMap<>();
            for (String r : recipients) {
                List<String> published = inboxes.get(r);
                List<String> merged =
                        new ArrayList<>(published != null ? published : new ArrayList<>());
                for (String d : dmRelays) {
                    if (!merged.contains(d)) merged.add(d);
                }
                if (merged.isEmpty()) {
                    // Nowhere at all to put this member's copy. A partial send
                    // reported as success is the one outcome worth refusing.
                    finishReply(roomKey, sent, false);
                    return;
                }
                targets.put(r, merged);
            }

            if (recipients.isEmpty()) {
                // Note to Self: the self copy IS the send, so it decides.
                buildDmEnvelope(signer, rumorJson, userPubkey, expiresAt, selfWrap -> {
                    if (selfWrap == null || dmRelays.isEmpty()) {
                        finishReply(roomKey, sent, false);
                        return;
                    }
                    publishEvent(selfWrap, new ArrayList<>(dmRelays), ok -> {
                        if (ok) ServiceStore.storeDm17Rumor(this, userPubkey, rumor);
                        finishReply(roomKey, sent, ok);
                    });
                });
                return;
            }

            // EVERY recipient's copy must land, matching `publishRumor`'s
            // Promise.all: a group message that reached three of four members
            // is one somebody never got, and reporting it as sent is what would
            // hide that. Tallied on the handler thread so the counter is touched
            // from one thread whether a publish resolved from a relay socket or
            // from its timeout.
            final int[] remaining = { recipients.size() };
            final boolean[] allOk = { true };
            PublishCallback tally = ok -> {
                if (!ok) allOk[0] = false;
                if (--remaining[0] != 0) return;
                if (allOk[0]) {
                    // The thread shows the reply on next open, exactly as if
                    // the WebView had sent it.
                    ServiceStore.storeDm17Rumor(this, userPubkey, rumor);
                }
                finishReply(roomKey, sent, allOk[0]);
            };
            for (Map.Entry<String, List<String>> entry : targets.entrySet()) {
                final List<String> relays = entry.getValue();
                buildDmEnvelope(signer, rumorJson, entry.getKey(), expiresAt, wrap -> {
                    if (wrap == null) {
                        handler.post(() -> tally.done(false));
                        return;
                    }
                    publishEvent(wrap, relays, ok -> handler.post(() -> tally.done(ok)));
                });
            }
            // The self copy, sealed + wrapped to ourselves, to our own DM
            // relays. Best-effort: the recipients' copies decide success, and
            // the store write above is what our own thread reads anyway.
            buildDmEnvelope(signer, rumorJson, userPubkey, expiresAt, selfWrap -> {
                if (selfWrap != null && !dmRelays.isEmpty()) {
                    publishEvent(selfWrap, new ArrayList<>(dmRelays), selfOk -> { });
                }
            });
        });
    }

    private interface InboxesCallback {
        void onInboxes(Map<String, List<String>> inboxes);
    }

    /**
     * Resolve every recipient's NIP-17 inbox relays, joining on the main
     * handler. The lookups run concurrently, so a group costs one
     * {@link #DM_INBOX_TIMEOUT_MS} rather than one per member — which matters
     * because the whole fan-out sits in front of a reply the user has already
     * watched appear in the notification.
     *
     * A member with no published list resolves EMPTY rather than failing the
     * group: the caller unions our own DM relays in, and only a recipient with
     * no reachable relay at all fails the send.
     */
    private void resolveDmInboxes(List<String> peers, InboxesCallback cb) {
        final Map<String, List<String>> out = new LinkedHashMap<>();
        if (peers.isEmpty()) {
            cb.onInboxes(out);
            return;
        }
        final int[] remaining = { peers.size() };
        for (String peer : peers) {
            resolveDmInbox(peer, relays -> handler.post(() -> {
                out.put(peer, relays);
                if (--remaining[0] == 0) cb.onInboxes(out);
            }));
        }
    }

    private interface EnvelopeCallback {
        void onWrap(JSONObject wrap);
    }

    /**
     * Seal + wrap a DM rumor to one recipient (both outer layers backdated).
     * A non-zero {@code expiresAt} is repeated on the seal and the wrap — the
     * outer tag is the only expiry a relay can act on, and the seal's copy is
     * what a reader trusts without the wrap (nip17/protocol.ts).
     */
    private void buildDmEnvelope(NativeSigner signer, String rumorJson, String recipient,
                                 long expiresAt, EnvelopeCallback cb) {
        signer.encrypt44(recipient, rumorJson, (sealContent, unavailable) -> {
            if (sealContent == null) {
                handler.post(() -> cb.onWrap(null));
                return;
            }
            JSONArray sealTags = new JSONArray();
            if (expiresAt > 0) {
                sealTags.put(new JSONArray().put("expiration").put(String.valueOf(expiresAt)));
            }
            signer.signEvent(13, sealContent, sealTags, tweakedPast(), seal ->
                    handler.post(() -> {
                        JSONObject wrap = null;
                        if (seal != null) {
                            try {
                                byte[] wrapSk = randomSecretKey();
                                byte[] convKey = NostrCrypto.conversationKey(wrapSk, recipient);
                                String ct = convKey != null
                                        ? ConcordCrypto.encrypt(convKey, seal.toString()) : null;
                                if (ct != null) {
                                    JSONArray tags = new JSONArray()
                                            .put(new JSONArray().put("p").put(recipient));
                                    if (expiresAt > 0) {
                                        tags.put(new JSONArray()
                                                .put("expiration").put(String.valueOf(expiresAt)));
                                    }
                                    wrap = NostrCrypto.finalizeEvent(
                                            1059, ct, tags, tweakedPast(), wrapSk);
                                }
                            } catch (Exception ignored) {
                                // Resolves null below.
                            }
                        }
                        cb.onWrap(wrap);
                    }));
        });
    }

    /** NIP-59: a random timestamp within the past two days. */
    private static long tweakedPast() {
        return System.currentTimeMillis() / 1000
                - (long) (Math.random() * MAX_WRAP_BACKDATE_SECS);
    }

    /** A fresh valid secp256k1 secret key (rejection-sampled, like generateSecretKey). */
    private static byte[] randomSecretKey() {
        java.security.SecureRandom random = new java.security.SecureRandom();
        while (true) {
            byte[] sk = new byte[32];
            random.nextBytes(sk);
            try {
                NostrCrypto.pubkeyOf(sk);
                return sk;
            } catch (Exception ignored) {
                // Out-of-range scalar (probability ~2⁻¹²⁸) — draw again.
            }
        }
    }

    /**
     * Publish an event to a set of relays: the live connection (or its outbox)
     * for relays the service already holds, a one-shot socket for foreign ones
     * (a DM peer's inbox). Resolves true on the FIRST accepting OK, false when
     * every relay refused or {@link #PUBLISH_TIMEOUT_MS} passes first.
     */
    private void publishEvent(JSONObject event, List<String> relayUrls, PublishCallback cb) {
        final String eventId = event.optString("id", "");
        final List<String> targets = new ArrayList<>(new LinkedHashSet<>(relayUrls));
        if (targets.isEmpty() || eventId.isEmpty()) {
            cb.done(false);
            return;
        }
        final boolean[] resolved = { false };
        final int[] pending = { targets.size() };
        PublishCallback tally = ok -> {
            if (resolved[0]) return;
            if (ok) {
                resolved[0] = true;
                cb.done(true);
            } else if (--pending[0] == 0) {
                resolved[0] = true;
                cb.done(false);
            }
        };
        for (String url : targets) {
            RelayConnection held = null;
            for (RelayConnection rc : connections) {
                if (rc.relayUrl.equals(url)) {
                    held = rc;
                    break;
                }
            }
            if (held != null && !held.closed) {
                held.publish(event, tally);
            } else {
                publishOneShot(url, event, tally);
            }
        }
        handler.postDelayed(() -> {
            if (resolved[0]) return;
            resolved[0] = true;
            for (RelayConnection rc : connections) {
                rc.pendingPublishes.remove(eventId);
                rc.outbox.removeIf(p -> p.eventId.equals(eventId));
            }
            cb.done(false);
        }, PUBLISH_TIMEOUT_MS);
    }

    /**
     * Publish over a socket opened just for this event — for a relay the
     * service holds no connection to (a DM peer's inbox relay). Sends the
     * frame on open, resolves on the matching OK, closes either way. No AUTH
     * handling: an auth-walled foreign relay counts as a refusal, and the
     * publish succeeds through any other target that accepts.
     */
    private void publishOneShot(String url, JSONObject event, PublishCallback cb) {
        final String eventId = event.optString("id", "");
        final boolean[] done = { false };
        if (!isValidRelayUrl(url)) {
            cb.done(false);
            return;
        }
        try {
            Request req = new Request.Builder().url(url).build();
            final WebSocket ws = httpClient.newWebSocket(req, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket socket, Response response) {
                    try {
                        socket.send(new JSONArray().put("EVENT").put(event).toString());
                    } catch (Exception ignored) {
                        // The failure callback fires when the socket dies.
                    }
                }

                @Override
                public void onMessage(WebSocket socket, String text) {
                    try {
                        JSONArray m = new JSONArray(text);
                        if (!"OK".equals(m.optString(0)) || !eventId.equals(m.optString(1))) return;
                        final boolean ok = m.optBoolean(2, false);
                        handler.post(() -> {
                            if (!done[0]) {
                                done[0] = true;
                                cb.done(ok);
                            }
                        });
                        socket.close(1000, "done");
                    } catch (Exception ignored) {
                        // Non-JSON frame — keep waiting for the OK.
                    }
                }

                @Override
                public void onFailure(WebSocket socket, Throwable t, Response response) {
                    handler.post(() -> {
                        if (!done[0]) {
                            done[0] = true;
                            cb.done(false);
                        }
                    });
                }
            });
            handler.postDelayed(() -> {
                if (!done[0]) {
                    done[0] = true;
                    try {
                        ws.close(1000, "timeout");
                    } catch (Exception ignored) {
                    }
                    cb.done(false);
                }
            }, PUBLISH_TIMEOUT_MS - 2_000);
        } catch (Exception e) {
            if (!done[0]) {
                done[0] = true;
                cb.done(false);
            }
        }
    }

    /**
     * Cancel any notification left in the retired per-community summary id
     * band by an older build (which posted InboxStyle group summaries there);
     * without this an upgrade would leave orphaned summaries in the tray with
     * nothing to ever cancel them. API 23+; best-effort.
     */
    private void cancelStaleSummaries() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            for (android.service.notification.StatusBarNotification sbn : activeNotifications(manager)) {
                int id = sbn.getId();
                if (id >= SUMMARY_ID_BASE && id < SUMMARY_ID_BASE + SUMMARY_ID_MODULUS) {
                    manager.cancel(id);
                }
            }
        } catch (Exception ignored) {
            // getActiveNotifications can throw on some OEM builds — best-effort.
        }
    }

    /**
     * Fetch a community's conversation icon and deliver it circle-cropped on the main
     * handler (best-effort: null on any failure). Plain https URLs are fetched
     * directly; an encrypted-blob pointer ({@code imgKey}/{@code imgNonce}) is
     * AES-256-GCM decrypted and the plaintext SHA-256 verified against
     * {@code imgHash} before decode. Reuses the avatar disk cache, keyed by the
     * ref's stable {@link CommunityRef#imageCacheKey()}.
     */
    private void fetchCommunityImage(CommunityRef ref, BitmapCallback cb) {
        if (!ref.hasImage()) {
            cb.onBitmap(null);
            return;
        }
        final String cacheKey = ref.imageCacheKey();
        if (!groupImageInFlight.add(cacheKey)) {
            // Already being fetched — the in-flight call's callback will
            // refresh the shortcut and re-post the notification.
            cb.onBitmap(null);
            return;
        }
        // The icon's host is whoever set it (a relay operator's `picture`, or
        // the Blossom server a Concord admin uploaded to): the same media
        // policy as an avatar. Ciphertext survives a proxy unchanged, and the
        // hash check in decryptGcm is what says so.
        final String fetchUrl = mediaPolicy.resolve(ref.imageUrl);
        avatarClient.dispatcher().executorService().execute(() -> {
            Bitmap disk = loadAvatarFromDisk(cacheKey);
            if (disk != null) {
                handler.post(() -> {
                    groupImageInFlight.remove(cacheKey);
                    cb.onBitmap(disk);
                });
                return;
            }
            if (fetchUrl == null) {
                handler.post(() -> {
                    groupImageInFlight.remove(cacheKey);
                    cb.onBitmap(null);
                });
                return;
            }
            final Request request;
            try {
                request = new Request.Builder().url(fetchUrl).build();
            } catch (Exception e) {
                if (BuildConfig.DEBUG) Log.d(TAG, "community icon url invalid: " + e.getMessage());
                handler.post(() -> {
                    groupImageInFlight.remove(cacheKey);
                    cb.onBitmap(null);
                });
                return;
            }
            avatarClient.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "community icon fetch failed: " + e.getMessage());
                    handler.post(() -> {
                        groupImageInFlight.remove(cacheKey);
                        cb.onBitmap(null);
                    });
                }

                @Override
                public void onResponse(Call call, Response response) {
                    Bitmap circle = null;
                    try {
                        if (response.isSuccessful() && response.body() != null) {
                            byte[] bytes = readCapped(response.body(), MAX_ICON_BODY_BYTES);
                            if (bytes != null && ref.imgKey != null && ref.imgNonce != null) {
                                bytes = decryptGcm(bytes, ref.imgKey, ref.imgNonce, ref.imgHash);
                            }
                            Bitmap raw = decodeSampled(bytes);
                            circle = circleCrop(raw);
                        }
                    } catch (Exception e) {
                        if (BuildConfig.DEBUG) Log.d(TAG, "community icon decode failed: " + e.getMessage());
                    } finally {
                        response.close();
                    }
                    final Bitmap result = circle;
                    if (result != null) saveAvatarToDisk(cacheKey, result);
                    handler.post(() -> {
                        groupImageInFlight.remove(cacheKey);
                        cb.onBitmap(result);
                    });
                }
            });
        });
    }

    /**
     * AES-256-GCM decrypt an encrypted community-image blob and verify its
     * plaintext SHA-256 (128-bit tag, matching the encrypt side in
     * concord/lib/image.ts). Returns
     * null on any crypto failure or a hash mismatch (a swapped blob fails
     * closed), so the icon simply doesn't render rather than showing a forgery.
     */
    private static byte[] decryptGcm(byte[] ciphertext, byte[] key, byte[] nonce, String expectHashHex) {
        if (ciphertext == null || key == null || nonce == null) return null;
        try {
            javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                    javax.crypto.Cipher.DECRYPT_MODE,
                    new javax.crypto.spec.SecretKeySpec(key, "AES"),
                    new javax.crypto.spec.GCMParameterSpec(128, nonce));
            byte[] plaintext = cipher.doFinal(ciphertext);
            if (expectHashHex != null && !expectHashHex.isEmpty()) {
                byte[] h = MessageDigest.getInstance("SHA-256").digest(plaintext);
                if (!NostrCrypto.bytesToHex(h).equalsIgnoreCase(expectHashHex)) return null;
            }
            return plaintext;
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.d(TAG, "community icon decrypt failed: " + e.getMessage());
            return null;
        }
    }

    /**
     * Deep-link intent into {@link MainActivity} for an in-app path (null ⇒ "/").
     * ACTION_VIEW is REQUIRED: Capacitor's @capacitor/app plugin only surfaces
     * the launch URL (getLaunchUrl / appUrlOpen) for an intent whose action is
     * ACTION_VIEW. Without it the data URI is present but ignored, so a
     * notification tap delivers the intent yet the web layer never navigates.
     */
    private Intent deepLinkIntent(String url) {
        Intent intent = new Intent(this, MainActivity.class);
        String path = url != null ? url : "/";
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("armada://open" + path));
        intent.putExtra("armada_path", path);
        return intent;
    }

    /** Deep-link tap intent for a room, keyed by the room's stable notif id. */
    private PendingIntent roomPendingIntent(RoomNotif room) {
        Intent intent = deepLinkIntent(room.url);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, room.notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Publish/refresh the long-lived conversation shortcut a room notification
     * references via {@code setShortcutId}. On Android 11+ a MessagingStyle
     * notification whose shortcutId resolves to a long-lived conversation
     * shortcut is promoted into the conversation space, where the SYSTEM draws
     * the shortcut's icon as the left icon in place of the app icon (the app's
     * small icon becomes a corner badge) — the Signal look. The icon is the
     * sender's avatar for a DM, or the community image for a channel (like a
     * Signal group chat's group avatar). Best-effort: a failed push (rate
     * limit, OEM quirks) just means the notification renders the ordinary way.
     *
     * <p>These are NOT share targets. The category that would make them one is
     * deliberately absent (see ShareTargetPlugin.CATEGORY_SHARE_TARGET): this
     * fires on an incoming message, so it would rank suggestions by who
     * messages the user rather than whom the user messages. They also carry a
     * rank floor, so that when the shortcut list fills, the eviction takes one
     * of these rather than a suggestion.
     */
    private void pushConversationShortcut(RoomNotif room, Person sender, Bitmap avatar) {
        try {
            String label = conversationTitle(room);
            // ShortcutManager rate-limits a BACKGROUNDED app to a handful of
            // pushes per day (reset on foreground), and this runs per
            // notification. Skip a push that would change nothing, and every
            // push once the quota is gone, so the quota goes on real changes.
            String id = shortcutIdFor(room);
            String signature = label + "\u0000" + (avatar != null);
            if (signature.equals(pushedShortcuts.get(id))) return;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N_MR1) {
                android.content.pm.ShortcutManager sm =
                        getSystemService(android.content.pm.ShortcutManager.class);
                if (sm != null && sm.isRateLimitingActive()) return;
            }
            // `id` above is the conversation's stable in-app ROUTE, not the
            // roomKey: it doubles as the Direct Share target id
            // (EXTRA_SHORTCUT_ID on an incoming share), and a route is the one
            // spelling the web layer can navigate without service state. Must
            // match ShareTargetPlugin.publishShortcuts, which pushes the same
            // ids — so a room the user also shares to has ONE shortcut that
            // both writers update in place, rather than two that evict.
            ShortcutInfoCompat.Builder sb = new ShortcutInfoCompat.Builder(this, id)
                    .setShortLabel(label)
                    .setPerson(sender)
                    .setLongLived(true)
                    // The base route, not room.url: a launcher/share tap should
                    // open the room, not scroll to whatever message last
                    // notified.
                    .setIntent(deepLinkIntent(conversationRoute(room.url)))
                    .setRank(ShareTargetPlugin.SERVICE_RANK_FLOOR)
                    .setCategories(new java.util.HashSet<>(java.util.Collections.singletonList(
                            ShareTargetPlugin.CATEGORY_CONVERSATION)));
            // The shortcut icon is what the conversation layout paints on the
            // left; without it (avatar not fetched yet) the app icon shows until
            // the silent avatar re-post refreshes the shortcut.
            if (avatar != null) sb.setIcon(IconCompat.createWithBitmap(avatar));
            ShortcutManagerCompat.pushDynamicShortcut(this, sb.build());
            pushedShortcuts.put(id, signature);
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.w(TAG, "pushConversationShortcut failed", e);
        }
    }

    /**
     * Shortcut id → the label/icon state last pushed for it, so an unchanged
     * push can be skipped. In-memory only: a restarted service re-pushes once
     * per room, which is the correct behaviour anyway (the system may have
     * evicted them meanwhile) and cannot go stale the way a persisted copy of
     * someone else's state could.
     */
    private final java.util.Map<String, String> pushedShortcuts =
            new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * The conversation shortcut id for a room: its stable in-app route when
     * one can be derived from the room's deep link, the roomKey otherwise
     * (never expected, but a shortcut beats no shortcut).
     */
    private static String shortcutIdFor(RoomNotif room) {
        String route = conversationRoute(room.url);
        return route != null && !route.isEmpty() && !route.equals("/") ? route : room.roomKey;
    }

    /**
     * Strip a deep-link url down to its stable conversation route: room.url
     * points at the LATEST message (it may carry /t/<root> and /m/<id> focus
     * segments, see appendFocusSegment), but a shortcut identifies and opens
     * the CONVERSATION. Keeps the fixed segment count of each route shape —
     * /dm/<peer> and /c1/<id> are 2 segments, /c/<community>/<channel> and
     * /s/<relay>/<group> are 3 — rather than scanning for "/t/", which a
     * 1-char route param could fake.
     */
    private static String conversationRoute(String url) {
        if (url == null || url.isEmpty() || url.equals("/")) return url;
        String[] seg = url.split("/"); // leading "/" makes seg[0] empty
        if (seg.length < 2) return url;
        int keep;
        switch (seg[1]) {
            case "c":
            case "s":
                keep = 3;
                break;
            case "dm":
            case "c1":
                keep = 2;
                break;
            default:
                return url;
        }
        keep = Math.min(keep, seg.length - 1);
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= keep; i++) sb.append('/').append(seg[i]);
        return sb.toString();
    }

    private interface BitmapCallback {
        void onBitmap(Bitmap bitmap);
    }

    /**
     * Fetch an avatar URL, downscale + circle-crop it to {@link #AVATAR_PX}, and
     * deliver the bitmap on the handler thread. Best-effort: null on any failure.
     * Results are cached by URL for the service lifetime.
     */
    private void fetchAvatar(String url, BitmapCallback cb) {
        // Where the policy lets this picture be fetched from: the URL itself
        // for a trusted host, the proxied form for a stranger's, or nothing —
        // in which case the notification simply shows without the face. The
        // caches stay keyed by the ORIGINAL url, so a policy change misses
        // once and nothing has to be invalidated.
        final String fetchUrl = mediaPolicy.resolve(url);
        // Disk read + decode off the handler thread (the dispatcher is shared with
        // httpClient; a quick task here is fine). A warm disk hit skips both the
        // network AND the decode, so the "same user messages again" case resolves
        // instantly — the whole point of persisting across restarts.
        avatarClient.dispatcher().executorService().execute(() -> {
            Bitmap disk = loadAvatarFromDisk(url);
            if (ServiceProfiler.ON) ServiceProfiler.count(disk != null ? "avatar.disk hit" : "avatar.disk miss");
            if (disk != null) {
                handler.post(() -> {
                    avatarCache.put(url, disk);
                    cb.onBitmap(disk);
                });
                return;
            }
            if (fetchUrl == null) {
                handler.post(() -> cb.onBitmap(null));
                return;
            }
            final Request request;
            try {
                request = new Request.Builder().url(fetchUrl).build();
            } catch (Exception e) {
                if (BuildConfig.DEBUG) Log.d(TAG, "avatar url invalid: " + e.getMessage());
                handler.post(() -> cb.onBitmap(null));
                return;
            }
            if (ServiceProfiler.ON) ServiceProfiler.count("avatar.fetch");
            avatarClient.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "avatar fetch failed: " + e.getMessage());
                    handler.post(() -> cb.onBitmap(null));
                }

                @Override
                public void onResponse(Call call, Response response) {
                    Bitmap circle = null;
                    try {
                        if (response.isSuccessful() && response.body() != null) {
                            byte[] bytes = readCapped(response.body(), MAX_AVATAR_BODY_BYTES);
                            Bitmap raw = decodeSampled(bytes);
                            circle = circleCrop(raw);
                        }
                    } catch (Exception e) {
                        if (BuildConfig.DEBUG) Log.d(TAG, "avatar decode failed: " + e.getMessage());
                    } finally {
                        response.close();
                    }
                    final Bitmap result = circle;
                    if (result != null) saveAvatarToDisk(url, result); // persist (bg thread)
                    handler.post(() -> {
                        if (result != null) avatarCache.put(url, result);
                        cb.onBitmap(result);
                    });
                }
            });
        });
    }

    // Body ceilings for an image fetch; the bytes are buffered whole before the
    // decode. Avatars cover an un-resized phone photo (a proxy, when set,
    // resizes); icons are encrypted so no proxy can shrink them, and other
    // clients may upload larger than our 512px edge.
    static final long MAX_AVATAR_BODY_BYTES = 2L * 1024 * 1024;
    static final long MAX_ICON_BODY_BYTES = 4L * 1024 * 1024;

    /**
     * The whole body, or null if it is (or declares itself) over {@code cap}.
     * Reads at most cap+1 bytes, so a chunked body of unknown length can't
     * grow the buffer without bound.
     */
    static byte[] readCapped(ResponseBody body, long cap) throws IOException {
        if (body == null || body.contentLength() > cap) return null;
        okio.BufferedSource src = body.source();
        if (src.request(cap + 1)) return null;
        return src.readByteArray();
    }

    /**
     * Decode image bytes downsampled to roughly {@link #AVATAR_PX}. A two-pass
     * decode (bounds first) keeps a large source image from OOM-ing the decode,
     * which fails silently and drops the avatar.
     */
    private static Bitmap decodeSampled(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return null;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
        int sample = 1;
        int halfW = opts.outWidth / 2;
        int halfH = opts.outHeight / 2;
        while (halfW / sample >= AVATAR_PX && halfH / sample >= AVATAR_PX) {
            sample *= 2;
        }
        opts.inSampleSize = sample;
        opts.inJustDecodeBounds = false;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
    }

    /** The on-disk file for an avatar URL (SHA-256 of the URL, PNG). */
    private File avatarFile(String url) {
        return new File(avatarDir, sha256Hex(url) + ".png");
    }

    /** Load a previously-decoded avatar from disk (and LRU-touch it), or null. */
    private Bitmap loadAvatarFromDisk(String url) {
        try {
            File f = avatarFile(url);
            if (!f.exists()) return null;
            Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath());
            if (bmp != null) f.setLastModified(System.currentTimeMillis());
            return bmp;
        } catch (Exception e) {
            return null;
        }
    }

    /** Persist a decoded, circle-cropped avatar; prune the dir if oversized. */
    private void saveAvatarToDisk(String url, Bitmap bmp) {
        try {
            if (!avatarDir.exists() && !avatarDir.mkdirs()) return;
            try (FileOutputStream fos = new FileOutputStream(avatarFile(url))) {
                bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
            }
            pruneAvatarDir();
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.d(TAG, "avatar disk save failed: " + e.getMessage());
        }
    }

    /** Keep the avatar dir under {@link #AVATAR_DISK_MAX}, evicting oldest. */
    private void pruneAvatarDir() {
        File[] files = avatarDir.listFiles();
        if (files == null || files.length <= AVATAR_DISK_MAX) return;
        Arrays.sort(files, (a, c) -> Long.compare(a.lastModified(), c.lastModified()));
        for (int i = 0; i < files.length - AVATAR_DISK_MAX; i++) {
            files[i].delete();
        }
    }

    private static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    /** Center-crop a bitmap to a square, scale to AVATAR_PX, and mask to a circle. */
    private static Bitmap circleCrop(Bitmap src) {
        if (src == null) return null;
        int size = Math.min(src.getWidth(), src.getHeight());
        if (size <= 0) return null;
        int left = (src.getWidth() - size) / 2;
        int top = (src.getHeight() - size) / 2;

        Bitmap output = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        Paint paint = new Paint();
        paint.setAntiAlias(true);
        float r = AVATAR_PX / 2f;
        canvas.drawCircle(r, r, r, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        Rect srcRect = new Rect(left, top, left + size, top + size);
        RectF dstRect = new RectF(0, 0, AVATAR_PX, AVATAR_PX);
        canvas.drawBitmap(src, srcRect, dstRect, paint);
        return output;
    }

    private Notification buildForegroundNotification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, SVC_CHANNEL_ID)
                .setContentTitle(str(R.string.app_name))
                .setContentText(str(R.string.notif_connected))
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    /**
     * The app's language changed: re-word the channels (re-creating one updates
     * its name and description) and the foreground row. Sockets are untouched.
     */
    static void onLocaleChanged(Context ctx) {
        createChannels(ctx);
        NotificationRelayService svc = instance;
        if (svc == null) return;
        svc.handler.post(() -> {
            svc.labels = null;
            NotificationManager m = (NotificationManager) svc.getSystemService(Context.NOTIFICATION_SERVICE);
            if (m != null && instance == svc) m.notify(FOREGROUND_ID, svc.buildForegroundNotification());
        });
    }

    static void createChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager m = ctx.getSystemService(NotificationManager.class);
        if (m == null) return;

        // IMPORTANCE_MIN: no status bar icon, silent — just present enough for
        // Android to honour the foreground service guarantee.  Users who want
        // no visible entry can still disable this channel, but the lower
        // intrusion means fewer do so accidentally.
        NotificationChannel svc = new NotificationChannel(
                SVC_CHANNEL_ID, AppLocale.string(ctx, R.string.channel_service_name), NotificationManager.IMPORTANCE_MIN);
        svc.setDescription(AppLocale.string(ctx, R.string.channel_service_description));
        svc.setShowBadge(false);
        m.createNotificationChannel(svc);

        // Retire old channels whose settings are now superseded by a new id.
        for (String legacy : new String[]{ SVC_CHANNEL_ID_LEGACY, MSG_CHANNEL_ID_LEGACY }) {
            try {
                m.deleteNotificationChannel(legacy);
            } catch (Exception ignored) {
                // Channel may not exist (fresh install) — nothing to retire.
            }
        }

        NotificationChannel msg = new NotificationChannel(
                MSG_CHANNEL_ID, AppLocale.string(ctx, R.string.channel_messages_name), NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription(AppLocale.string(ctx, R.string.channel_messages_description));
        msg.enableVibration(true);
        msg.setVibrationPattern(MSG_VIBRATION_PATTERN);
        m.createNotificationChannel(msg);

        // Incoming calls: the device RINGTONE (audible through the ringer
        // stream, repeats per system behavior for CallStyle) plus a long,
        // insistent vibration — a call has to sound like a call, not a text.
        NotificationChannel calls = new NotificationChannel(
                CALL_CHANNEL_ID, AppLocale.string(ctx, R.string.channel_calls_name), NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription(AppLocale.string(ctx, R.string.channel_calls_description));
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0L, 800L, 400L, 800L, 400L, 800L });
        android.media.AudioAttributes ringAttrs = new android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        calls.setSound(
                android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
                ringAttrs);
        m.createNotificationChannel(calls);
    }

    // ── Network monitoring ────────────────────────────────────────────────────

    private void registerNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        NetworkRequest req = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    // The callbacks registration replays for networks already up
                    // are not a change; one after a loss is.
                    if (sawNetworkLoss) lastNetworkChangeAt = SystemClock.elapsedRealtime();
                    for (RelayConnection rc : connections) rc.onFleetEdge(FleetEdge.CONNECTIVITY_REGAINED);
                });
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return;
                if (!isDefaultNetwork(network, cm.getActiveNetwork())) return;
                handler.post(() -> {
                    // The default network just validated: connects held for it go now.
                    if (unvalidatedSince == 0) return;
                    unvalidatedSince = 0;
                    for (RelayConnection rc : connections) rc.onFleetEdge(FleetEdge.CONNECTIVITY_REGAINED);
                });
            }

            @Override
            public void onLost(Network network) {
                handler.post(() -> {
                    sawNetworkLoss = true;
                    lastNetworkChangeAt = SystemClock.elapsedRealtime();
                });
            }
        };
        try { cm.registerNetworkCallback(req, networkCallback); } catch (Exception ignored) {}
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            try { cm.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
        }
    }

    /** See {@link NetworkSettle#UNVALIDATED_GRACE_MS}; handler thread. */
    private long unvalidatedDelayMs() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return 0;
        NetworkCapabilities c = cm.getNetworkCapabilities(cm.getActiveNetwork());
        boolean validated = c == null || c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        long now = SystemClock.elapsedRealtime();
        if (validated) {
            unvalidatedSince = 0;
            return 0;
        }
        if (unvalidatedSince == 0) unvalidatedSince = now;
        return NetworkSettle.unvalidatedDelayMs(false, now, unvalidatedSince, NetworkSettle.UNVALIDATED_GRACE_MS);
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network n = cm.getActiveNetwork();
        if (n == null) return false;
        NetworkCapabilities c = cm.getNetworkCapabilities(n);
        return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    // ── Config change listener ──────────────────────────────────────────────

    private void registerConfigListener() {
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        configListener = (sharedPreferences, key) -> {
            if (!shouldReloadConfig(key)) return;
            // One editor transaction emits one callback per changed key. The
            // revision is the commit marker, so listening only to it turns a
            // 15-field update into exactly one socket rebuild.
            handler.removeCallbacks(configReloadRunnable);
            handler.post(configReloadRunnable);
        };
        sp.registerOnSharedPreferenceChangeListener(configListener);
    }

    /** Testable definition of the one preference that commits a full config. */
    static boolean shouldReloadConfig(String key) {
        return "rev".equals(key);
    }

    /**
     * Whether an incoming WebView snapshot may replace one durable config
     * plane. Unready planes merge into last-good data only for the same
     * account; a fresh/different account always starts clean and may bootstrap
     * from the useful subset currently available.
     */
    static boolean shouldReplaceConfigPlane(
            boolean sameAccountConfig, boolean planeReady) {
        return !sameAccountConfig || planeReady;
    }

    /** Fresh accounts wait for synced/proven-local notification policy. */
    static boolean hasUsableNotificationPolicy(
            boolean sameAccountConfig, boolean policyPlaneReady) {
        return sameAccountConfig || policyPlaneReady;
    }

    private void unregisterConfigListener() {
        if (configListener == null) return;
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        sp.unregisterOnSharedPreferenceChangeListener(configListener);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * {@code getActiveNotifications()} — a binder round trip into the system
     * server, taken several times per posted notification. One seam so
     * profiling builds can count it.
     */
    static android.service.notification.StatusBarNotification[] activeNotifications(NotificationManager manager) {
        if (ServiceProfiler.ON) ServiceProfiler.count("binder.getActiveNotifications");
        return manager.getActiveNotifications();
    }

    /** Profiling builds: sizes worth watching over a long run (read unlocked; approximate). */
    private Map<String, Long> profileGauges() {
        Map<String, Long> g = new java.util.LinkedHashMap<>();
        int open = 0;
        for (RelayConnection rc : new ArrayList<>(connections)) if (rc.socketOpen) open++;
        g.put("connections", (long) connections.size());
        g.put("socketsOpen", (long) open);
        g.put("notifiedIds", (long) notifiedIds.size());
        // LruCache.size() is in sizeOf units (bytes); the entry count is the snapshot's.
        g.put("avatarCache", (long) avatarCache.snapshot().size());
        g.put("avatarCacheBytes", (long) avatarCache.size());
        g.put("groupImageCache", (long) groupImageCache.snapshot().size());
        g.put("groupImageCacheBytes", (long) groupImageCache.size());
        g.put("roomNotifs", (long) roomNotifs.size());
        g.put("handlerQueue", (long) pendingFrames.get());
        NativeSigner signer = nativeSigner;
        g.put("signerCachedKeys", signer != null ? (long) signer.cachedKeys() : 0L);
        return g;
    }

    /** Profiling builds: the ServiceProfiler window, with this instance's gauges. */
    static JSONObject profileSnapshot() throws JSONException {
        NotificationRelayService svc = instance;
        return ServiceProfiler.snapshot(svc != null ? svc.profileGauges() : null);
    }

    /**
     * Profiling builds answer {@code adb shell dumpsys activity service
     * buzz.armada.app/.NotificationRelayService [reset]} with the profile —
     * readable with the app UI dead, which is the state being measured.
     */
    @Override
    protected void dump(java.io.FileDescriptor fd, java.io.PrintWriter writer, String[] args) {
        if (!ServiceProfiler.ON) {
            super.dump(fd, writer, args);
            return;
        }
        if (args != null && java.util.Arrays.asList(args).contains("reset")) {
            ServiceProfiler.reset();
            writer.println("{\"reset\":true}");
            return;
        }
        try {
            writer.println(profileSnapshot().toString(2));
        } catch (JSONException e) {
            writer.println("{\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    private void closeAllConnections() {
        if (ServiceProfiler.ON) ServiceProfiler.units("socket.closeAll", connections.size());
        for (RelayConnection rc : connections) rc.close();
        connections.clear();
        updateSocketHealth();
    }

    /** `[{pubkey, d, readStateKey?}]` from the plugin config; malformed entries are skipped. */
    private void parseSelfDocs(String json) {
        Map<String, String> docs = new LinkedHashMap<>();
        Map<String, byte[]> keys = new HashMap<>();
        if (json != null) {
            try {
                JSONArray arr = new JSONArray(json);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject entry = arr.optJSONObject(i);
                    if (entry == null) continue;
                    String pubkey = entry.optString("pubkey", "");
                    String d = entry.optString("d", "");
                    if (!HEX64.matcher(pubkey).matches() || d.isEmpty()) continue;
                    docs.put(pubkey, d);
                    String key = entry.optString("readStateKey", "");
                    if (HEX64.matcher(key).matches()) keys.put(pubkey, ConcordCrypto.hexToBytes(key));
                }
            } catch (JSONException e) {
                Log.w(TAG, "selfDocs config unreadable");
            }
        }
        selfDocs = docs;
        readStateKeys = keys;
        selfDocsFingerprint = selfDocsFingerprintOf(docs.keySet());
    }

    static String selfDocsFingerprintOf(java.util.Collection<String> authors) {
        if (authors.isEmpty()) return "";
        java.util.List<String> sorted = new ArrayList<>(authors);
        java.util.Collections.sort(sorted);
        return Integer.toHexString(String.join(",", sorted).hashCode());
    }

    private static List<String> parseStringArray(String json) {
        List<String> out = new ArrayList<>();
        if (json == null) return out;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) out.add(arr.getString(i));
        } catch (JSONException ignored) {}
        return out;
    }

    /**
     * Whether a configured relay URL is safe to dial: a non-blank
     * {@code ws://}/{@code wss://} URL with something after the scheme. Guards
     * the connect path against a blank, {@code "null"} (org.json spells a JSON
     * null as the four-char string "null" through {@code optString}, not Java
     * null) or otherwise schemeless entry a malformed config can carry —
     * okhttp's {@code Request.Builder.url()} throws
     * {@link IllegalArgumentException} on such a value, which on a service
     * worker thread is an uncaught crash of the whole process, re-triggered on
     * every restart from the same persisted config. Relay-URL normalization
     * proper stays JS-side; this is only a floor.
     */
    private static boolean isValidRelayUrl(String url) {
        if (url == null) return false;
        String u = url.trim();
        int scheme;
        if (u.regionMatches(true, 0, "wss://", 0, 6)) scheme = 6;
        else if (u.regionMatches(true, 0, "ws://", 0, 5)) scheme = 5;
        else return false;
        return u.length() > scheme;
    }

    private static Set<String> pTags(JSONObject event) {
        Set<String> out = new HashSet<>();
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return out;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag != null && "p".equals(tag.optString(0)) && tag.length() > 1) {
                out.add(tag.optString(1));
            }
        }
        return out;
    }

    private static final Pattern EVERYONE_MENTION = Pattern.compile(
            "(^|[^\\p{L}\\p{N}_@])@everyone(?![\\p{L}\\p{N}_])");

    /**
     * Mirrors membershipFloor.ts: a rumor from before the join never notifies.
     * Compared at whole seconds; {@code joinedAtMs <= 0} is unknown and admits all.
     */
    static boolean sentDuringMembership(long createdAtSec, long joinedAtMs) {
        return joinedAtMs <= 0 || createdAtSec >= joinedAtMs / 1000L;
    }

    static boolean hasEveryoneMention(String content) {
        return content != null && EVERYONE_MENTION.matcher(content).find();
    }

    /**
     * Whether the user is genuinely @-mentioned in this event. A kind-1111
     * NIP-22 comment carries structural `p` tags for the thread root author
     * and immediate parent author — these are thread pointers, NOT mentions,
     * so a reply in the user's own thread would otherwise always look like a
     * mention. We strip the uppercase `P` (root author) and the lowercase `p`
     * tags that duplicate the `e`/`E` parent author pubkeys before checking.
     */
    private boolean isMentioned(JSONObject event, String userPubkey) {
        if (userPubkey == null) return false;
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return false;

        // For kind-1111 comments, collect the structural pubkeys to exclude.
        Set<String> structural = null;
        if (event.optInt("kind", -1) == 1111) {
            structural = new HashSet<>();
            for (int i = 0; i < tags.length(); i++) {
                JSONArray tag = tags.optJSONArray(i);
                if (tag == null || tag.length() < 2) continue;
                String name = tag.optString(0);
                // Uppercase P = thread root author (structural).
                if ("P".equals(name)) structural.add(tag.optString(1));
                // Lowercase e/E parent pointer: 4th element is the author pubkey.
                if ("e".equals(name) || "E".equals(name)) {
                    if (tag.length() > 3) structural.add(tag.optString(3));
                }
            }
        }

        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag == null || tag.length() < 2) continue;
            if (!"p".equals(tag.optString(0))) continue;
            String pk = tag.optString(1);
            if (!userPubkey.equals(pk)) continue;
            if (structural != null && structural.contains(pk)) continue;
            return true;
        }
        return false;
    }

    /** The value of the ONE `name` tag, or null when there are none or several. */
    private static String uniqueTagValue(JSONObject event, String name) {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return null;
        String found = null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag == null || !name.equals(tag.optString(0))) continue;
            if (found != null || tag.length() < 2) return null;
            found = tag.optString(1);
        }
        return found;
    }

    private static String tagValue(JSONObject event, String name) {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag != null && name.equals(tag.optString(0)) && tag.length() > 1) {
                return tag.optString(1);
            }
        }
        return null;
    }

    /**
     * The thread root of a kind 9 carrying NIP-10 MARKED `e` tags (Buzz's
     * thread shape, mirroring buzzThreadRef in src/buzz/protocol.ts): the
     * `root` marker, else the last `reply` marker; null without a `reply`.
     */
    static String markedThreadRoot(JSONObject event) {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return null;
        String root = null;
        String reply = null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag == null || tag.length() < 4 || !"e".equals(tag.optString(0))) continue;
            String marker = tag.optString(3);
            if ("root".equals(marker) && root == null) root = tag.optString(1);
            else if ("reply".equals(marker)) reply = tag.optString(1);
        }
        if (reply == null) return null;
        String result = root != null ? root : reply;
        return result.isEmpty() ? null : result;
    }

    /**
     * For a decrypted Concord inner, return the thread-root id when
     * the inner is a NIP-22 kind-1111 comment (uppercase `E` tag), else null.
     * Used to deep-link a thread-reply notification to its thread panel.
     */
    private static String innerKindCommentRoot(JSONObject inner) {
        if (inner == null) return null;
        if (inner.optInt("kind", -1) != 1111) return null;
        return tagValue(inner, "E");
    }

    /**
     * Append {@code /t/<rootId>} to a deep-link url when {@code rootId} is
     * non-empty, so the WebView opens the thread panel on tap. No-op (returns
     * the url unchanged) when there's no thread root (a top-level message, an
     * opaque/undecryptable event, or a malformed inner) or no room to hang it
     * on — a focus segment is only meaningful under a room.
     *
     * <p>Must be applied BEFORE {@link #appendMessageSegment}: the route is
     * {@code …/t/<root>/m/<id>}, and the two markers are what tell a reply
     * inside a thread from a message in the timeline.
     */
    private static String appendThreadSegment(String url, String rootId) {
        return appendFocusSegment(url, "t", rootId);
    }

    /**
     * Append {@code /m/<eventId>} — the message the notification is about — to
     * a deep-link url, so a tap lands ON that message: the web client's
     * useMessagePermalink scrolls to it and marks it. No-op when there's no id
     * to point at.
     */
    private static String appendMessageSegment(String url, String eventId) {
        return appendFocusSegment(url, "m", eventId);
    }

    /**
     * Mirror of the web client's route builder (`src/lib/routes.ts`) for the
     * `/t/` + `/m/` suffix. The client also still accepts the pre-path
     * `?thread=`/`?m=` query form, which is what an already-posted tray
     * notification carries — this only governs newly built links.
     */
    private static String appendFocusSegment(String url, String marker, String value) {
        if (url == null) return null;
        if (value == null || value.isEmpty()) return url;
        if (url.isEmpty() || url.equals("/")) return url;
        return url + "/" + marker + "/" + uriEncode(value);
    }

    private static String truncate(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= CONTENT_CAP ? s : s.substring(0, CONTENT_CAP) + "…";
    }

    /**
     * The `/dm/<key>` route for a conversation key — the mirror of the `dm`
     * case of the web client's `chatRoute` (`src/lib/routes.ts`).
     *
     * Each participant is an NPUB, not hex: a route string is an identity (the
     * share stash, Direct Share shortcuts and the sent-rooms ledger key by it),
     * so a hex path would be a second name for the same conversation. Mirrors
     * `dmPathSegment` in `src/lib/routes.ts` and `PushProcessor.dmPath` on iOS.
     *
     * Each participant is encoded ON ITS OWN so the `,` separator survives as a
     * literal. Encoding is the second line of defence behind {@link
     * #isDmConvKey}, since the key derives from sender-chosen `p` values and
     * {@link #appendFocusSegment} does not encode its base. A non-pubkey
     * participant passes through as-is, so the path stays parseable.
     */
    private static String dmRoute(String convKey) {
        StringBuilder sb = new StringBuilder("/dm/");
        List<String> peers = ServiceStore.dm17ConvPeers(convKey);
        for (int i = 0; i < peers.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(uriEncode(npubOrRaw(peers.get(i))));
        }
        return sb.toString();
    }

    /** A hex pubkey as its npub, or the input unchanged when it isn't one. */
    static String npubOrRaw(String pubkey) {
        byte[] raw = pubkey != null && pubkey.length() == 64 ? ConcordCrypto.hexToBytes(pubkey) : null;
        if (raw == null) return pubkey;
        try {
            return Bech32.INSTANCE.encode("npub", raw);
        } catch (RuntimeException e) {
            return pubkey;
        }
    }

    /**
     * Mirror of the web client's relayToRouteParam (platform.ts): drop a wss://
     * scheme, keep ws: as a marker, then URL-encode for the /s/:server segment.
     */
    private static String relayToRouteParam(String relayUrl) {
        String s = relayUrl;
        if (s.regionMatches(true, 0, "wss://", 0, 6)) {
            s = s.substring(6);
        } else if (s.regionMatches(true, 0, "ws://", 0, 5)) {
            s = "ws:" + s.substring(5);
        }
        return uriEncode(s);
    }

    private static String uriEncode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return s;
        }
    }

    /**
     * Stable, collision-resistant notification id for a key (a room key or event
     * id). Hashes the WHOLE string (not a prefix) so distinct rooms sharing a
     * common prefix — e.g. two groups on the same relay ("h:wss://r|a" vs
     * "h:wss://r|b") — never collapse into one notification. Kept below the
     * retired summary-id band.
     */
    private static int hashId(String id) {
        if (id == null) return 2;
        return (Math.abs(stringHash(id)) % ROOM_ID_MODULUS) + 2;
    }

    /** 31x string hash over the WHOLE string (String.hashCode semantics, spelled out for stability). */
    private static int stringHash(String s) {
        int hash = 0;
        for (int i = 0; i < s.length(); i++) {
            hash = ((hash << 5) - hash) + s.charAt(i);
        }
        return hash;
    }
}
