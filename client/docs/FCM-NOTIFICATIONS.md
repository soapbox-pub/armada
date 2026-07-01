# FCM Push Notifications (Android)

Battery-free, OS-delivered push notifications for the Android app via Firebase
Cloud Messaging (FCM), bridged through the shared **nostr-push** server.

Armada offers **two** Android notification delivery styles, selectable in
Settings → Notifications:

- **Persistent (no Google)** — the default. A foreground service holds a
  persistent Nostr relay connection (`NotificationRelayService`) and fires
  notifications instantly. Covers everything: NIP-29 channels, communities
  (Concord) and DMs. Costs a little battery. See `useNativeNotifications`.
- **Push (battery-saving)** — FCM via the shared nostr-push server. The OS holds
  the connection, so it's battery-free, but it only covers what the server can
  match and deliver:
  - **Direct messages** (kind 4, `#p` = you) — NIP-04 encrypted, so a static
    "New direct message".
  - **Concord channel messages** (kind 3300, `#z` = channel pseudonym) — the
    server can't open the sealed message, so a generic "New message" in the real
    channel. One subscription per channel epoch; re-registered on epoch rotation.

  **NIP-29 group/channel messages (`#h`) are NOT covered by Push** — the shared
  server neither matches `#h` nor monitors per-group relays. Use Persistent for
  full NIP-29 coverage.

## Architecture

```
Nostr event ──▶ nostr-push server (watches its RELAYS, matches filters)
                     │  FCM HTTP v1 (deliverFcm)
                     ▼
              Firebase Cloud Messaging
                     │
                     ▼
              Android device ──▶ ArmadaFirebaseMessagingService / OS tray
```

- The app fetches its FCM token via `ArmadaNotification.getFcmToken()`
  (`ArmadaNotificationPlugin.java`).
- `useFcmNotifications` registers nostr-push subscriptions with
  `push_subscription.type: "fcm"`: one for DMs, and one per Concord channel
  keyed by community + channel.
- RPC events are signed with an **ephemeral per-device keypair**
  (`nostrPush.ts`, stored in localStorage) so the user's real signer is never
  prompted.
- `ArmadaFirebaseMessagingService` renders foreground messages and handles token
  refresh, reusing the persistent path's channel (`armada_notifications_v2`),
  icon (`ic_stat_armada`) and `armada://open<path>` deep-link tap contract.
  Backgrounded messages are auto-displayed by the OS from the `notification`
  block the server sends.

## Server requirement: generic `#tag` matching

Concord uses `#z` pseudonyms, which older nostr-push builds did not match
(they only handled `#e`/`#p`/`#t`). The server now matches **any** single-letter
tag generically (`eventMatchesFilter` + `buildFilters` in `worker.ts`), so `#z`
(and `#h` in future) pass through. Deploy a nostr-push build that includes this
change.

Because the server only watches its own `RELAYS`, **DM and Concord traffic must
land on a relay in the server's `RELAYS`** to be delivered. Armada's default
`APP_RELAYS` (`relay.ditto.pub`, `relay.dreamith.to`) overlap with the shared
server's relays.

## Setup

### 1. nostr-push server

Deploy nostr-push (with the generic `#tag` change) and FCM configured:

```
FCM_SERVICE_ACCOUNT_KEY='<entire Firebase service-account JSON, one line, no surrounding quotes in dashboards>'
```

Note the server's `worker_pubkey` from its startup logs.

### 2. Armada build env

Set the nostr-push server pubkey (required — Push style is inactive without it):

```
VITE_NOSTR_PUSH_PUBKEY="<worker_pubkey hex>"
```

### 3. Firebase Android app + google-services.json

1. In the Firebase console, add an **Android app** whose package name matches
   `capacitor.config.ts` `appId` / `android/app/build.gradle` `applicationId`
   (`pub.armada.app`).
2. Download **google-services.json** and place it at:

   ```
   client/android/app/google-services.json
   ```

   The `com.google.gms.google-services` Gradle plugin (classpath already in
   `android/build.gradle`) is applied automatically when this file is present
   (see `android/app/build.gradle`). Without it the app still builds —
   `getFcmToken()` rejects and Push style shows as unavailable. This file is
   gitignored.

### 4. Build & run

```
npm run build
npx cap sync android
npx cap run android   # real device or an emulator with Google Play services
```

FCM requires Google Play Services, so test on a physical device or a
"Google Play" emulator image (not a bare AOSP image).

## Testing

1. Firebase console → Cloud Messaging → "Send test message" to the token logged
   by `getFcmToken()` / the service, to confirm the device receives push at all.
2. In Settings → Notifications, choose **Push** and enable notifications.
3. Send yourself a DM (should deliver "New direct message") and post in a Concord
   channel you're in from another account (should deliver "New message" in that
   channel).

## Notes

- iOS FCM is not wired up yet. The `fcm` transport is platform-neutral on the
  server, so adding iOS later is additive (Firebase iOS SDK + APNs key in
  Firebase + register with `type: "fcm"`).
- Switching to Push tears down the persistent foreground service; switching back
  to Persistent restarts it and deletes the FCM subscriptions.
