# AGENTS.md

Guidance for agents working on the **Armada client** — the web app (repo root),
the Capacitor Android project (`android/`), the Capacitor iOS project (`ios/`),
and the Electron desktop shell (`electron/`).

Armada's focus is [Concord](https://github.com/concord-protocol/concord):
serverless, end-to-end encrypted communities that need no host.

**Concord is the default subject.** An unqualified request — "rooms",
"channels", "invites", "the member list", "voice" — is about Concord. The
client also still supports NIP-29 relay-based "servers" for operators who
self-host, including [Buzz](https://github.com/block/buzz) relays (a
NIP-29-based team-communication relay with custom kinds, rendered through the
shared NIP-29 pages, `src/buzz/`) — but assume that side only when NIP-29,
Buzz, or a relay-hosted server is named explicitly. When a change could
plausibly land on either, ask rather than guessing NIP-29.

**"Concord" means the protocol at the link above**, its first public release
(CORD-01..07). There is no "v2" — it is simply the Concord Protocol. (A legacy,
incompatible predecessor shipped in Vector and Armada; Armada removed it, and
nothing here implements it.) The `c2:` and `concord2-*` spellings that survive
in the code are ON-DISK identifiers — ArmadaDB tenant ids, KV/localStorage
keys, the Android `concord2Subs` pref, and the cross-client `concord2|` app
scope key — deliberately left at their old spelling so existing installs keep
their data. Don't "finish" the rename.

The optional self-hostable backend (LiveKit voice + Concord AV broker) and its
deployment/hosting docs live in the separate
[`armada-av`](https://gitworkshop.dev/chad@chadwick.site/relay.ngit.dev/armada-av)
repository — this client does not depend on it at build time. The NIP-29 side
needs no Armada-specific server at all: any NIP-29 relay serves it.

## Repo layout

| Path         | What                                                            |
|--------------|-----------------------------------------------------------------|
| `src/`       | React 19 + Vite web client (Tailwind + shadcn/ui + Nostrify)    |
| `src/concord/` | The Concord protocol implementation (CORD-01..07): stream, control, chat, invites, rekey, voice, crypto derivations |
| `src/sw/`    | The Web Push service worker, in TypeScript: `worker.ts` (event handling), `pushRuntime.ts` (open/store/present), `sw.ts` (entry). The `serviceWorker()` plugin in `vite.config.ts` bundles it to one classic `/sw.js` in `vite build` and serves it from the dev server |
| `src/npanel/` | The link-preview script an npanel gateway runs for crawlers: profiles (`/npub1…`, `/nprofile1…`, `/name@domain`, `/domain`) and Concord invites, each with a drawn Armada card. Built to `/.well-known/npanel/preview.js` by the `npanelPreview()` plugin in `vite.config.ts`. An invite's community is sealed under the link's `#fragment`, which never reaches a server, so its card is the same for every invite |
| `src/lib/db/` | ArmadaDB — the one local storage interface (tenants of rumors + a KV), its IndexedDB adapter, the Android bridge adapter, and the migrations |
| `android/`   | Capacitor Android project (signed APK/AAB built in CI)          |
| `crates/webxdc-rt/` | Rust: the iroh-gossip transport for Mini App multiplayer, compiled to wasm. The only Rust in the repo |
| `android/…/app/db/` | ArmadaDB in Kotlin: the SQLite engine the Android build actually runs, shared by the WebView and the notification service |
| `ios/`       | Capacitor iOS project (SwiftPM, no CocoaPods; built manually on a Mac — no CI) |
| `ios/ArmadaDB/` | ArmadaDB in Swift: the SQLite engine the iOS build runs, with SQLite vendored. A SwiftPM package so it builds on **Linux**, where its conformance suite runs without a Mac |
| `ios/ArmadaNotify/` | The decrypt/store/present pipeline the iOS Notification Service Extension runs (NIP-44/NIP-17/Concord, libsecp256k1 vendored). A SwiftPM package for the same reason — its suite runs on **Linux** |
| `electron/`  | Electron desktop shell (loads the bundled web build; Linux/Windows/macOS installers built in CI) |
| `docs/`      | Design notes too long for this file — `settings-documents.md` (the NIP-78 settings root, its derived documents, and the split) and `releases.md` (the NIP-82 release and asset events `/downloads` and the desktop updater read) |
| `scripts/`   | Repo tooling, incl. two Concord-aware moderation-UX harnesses that mirror the same CORD-01/02/05 derivations: `scripts/spambot.mjs` (WRITES — chat spam with flood-fold evasion, plus kind-3313 direct-invite spam via `--invite-spam`) and `scripts/dump-community.mjs` (READS — resolves an invite and pages the decrypted Chat Plane out of the relays in `OpenedChat` shape, for feeding `floodCluster.ts`); see each file's header comment |

## Build / test

`npm install && npm run test` — tsc + eslint + vitest + production build. Always
run this before committing changes.

`npm run dev` serves at http://localhost:8080.

### The vitest environment split

Vitest runs as two projects (`vite.config.ts`), because building a jsdom
instance costs ~1.8s per test FILE and used to be the single largest line in
the suite — ~615s of the run's worker-time, more than executing the tests. The
split is by EXTENSION so there is no roster to rot: `**/*.test.tsx` is a
component test and gets `jsdom`, `**/*.test.ts` gets `node`. Roughly nine in
ten `.ts` suites never touch a DOM, so they now skip that construction.

A `.ts` suite that DOES need a DOM — one driving `renderHook`, or a browser
shim — carries `// @vitest-environment jsdom` as its first line, which
overrides its project's environment and travels with the file if it moves. A
new one announces itself as `document is not defined`, and that line is the
fix. `src/test/setup.ts` gates on the ENVIRONMENT rather than the project for
the same reason: those files are still in the `node` project and need the DOM
mocks and jest-dom matchers just the same.

### Benchmarks are not part of `npm run test`

`*.perf.test.*` files assert on how long something takes or how many times it
re-renders. That is not a correctness property: a loaded machine fails them
while nothing is wrong, and they were ~13% of the suite's test time. The
default run excludes them; `npm run test:perf` runs those files (nine at the
time of writing) and nothing else (~19s). Both modes come out of one `testFilesFor()` in
`vite.config.ts`, so the benchmarks stay reachable from the same config that
hides them, and they are typechecked and linted either way — only the runner
ignores them.

Note the glob needs a `.perf.` SEGMENT: `src/lib/perf.test.ts` is the
profiler module's own correctness suite and stays in the default run.

Two things that are easy to get wrong here:

- **`maxWorkers` must be set per project.** With `projects` configured, a root
  `test.maxWorkers` is silently ignored and the suite goes back to one worker
  per core with nothing to say it didn't take. Per-project is still a global
  ceiling, not one pool each — the projects do not run concurrently.
- **Wall time is almost exactly `worker-seconds / workers`**, so tightening the
  worker ceiling is paid back directly in duration. Cutting the work by a
  quarter and the workers by a quarter is a wash. `ARMADA_TEST_WORKERS`
  overrides the default (all cores but two) for a machine that wants all of
  itself, or less of it.

### The Vector parity ledger

`scripts/vector-parity/points.json` lists every decision Vector makes, extracted
from `vector-core/src` outside its tests: each refusal (`Err("…")`, `ok_or("…")`,
the fold's `refuse(…)`, a vend verdict, a permission gate) and each branch on
ranked vs legacy roles. `ledger.json` names the Armada test reproducing each one,
or why it doesn't apply; `vectorParity.test.ts` fails on a point with no entry or
an entry naming a test that doesn't exist, and lists the `todo`s. Passing Armada
tests are not parity: a `covered` entry is a test written against Vector's
behaviour. On a Vector bump, `VECTOR_SRC=<vector>/crates/vector-core/src npm run
parity:extract`, then give every new point an entry.

### Profiling (never in a shipped build)

Runtime instrumentation exists only in profiling builds, gated on compile-time
constants so a normal build carries none of it: `VITE_PROFILE=1` on the web
side (`src/lib/perfRuntime.ts`, `npm run build:profile`) and
`-ParmadaProfile=true` for the Android notification service
(`ServiceProfiler.java`, read through `adb shell dumpsys activity service
buzz.armada.app.profile/buzz.armada.app.NotificationRelayService`). Keep new
probes behind the same guards. `scripts/perf-profile.mjs` drives the web
client headless over seeded DM and Concord data; `scripts/android-profile.sh`
measures the service on a connected device. The profiling APK installs as
`buzz.armada.app.profile`, beside the real app, never over it.

### Performance rules that have regressed before

Measure before and after with `npm run perf:profile` (web) or
`scripts/android-profile.sh` (device); the numbers these rules came from are in
those reports.

- **Props handed to a memoized row must keep their identity.** No inline
  closures, objects or JSX elements per row (`onRetry={() => …}`, a fresh
  `<Badge />`, `{ kind, id }`). A callback that needs per-render data reads it
  through a ref and has `[]` deps. Context values are memoized the same way.
  One unstable prop re-renders the whole loaded timeline.
- **`useNavigate`/`useLocation` change on every navigation.** Anything handed
  to rows or memoized panes uses `useStableNavigate`, and hooks every row calls
  read the location at call time through `LocationRefContext`
  (see `useOpenProfile`).
- **On Android every ArmadaDB/KV call crosses the Capacitor bridge**, and its
  result is re-serialized per byte. Don't read KV in a path that runs per
  render, per switch or per event: memoize in memory (including "absent"), share
  immutable decoded values (`readFoldedShared`), and don't rewrite a value that
  hasn't changed. Keep Capacitor's `loggingBehavior: 'none'`.
- **A session memo holding decrypted data is cleared in `purgeClientStorage`**
  (before and after the purge). Otherwise logout leaves plaintext in memory and
  the next account can read it.
- **The notification service must not reconnect on a configure.** A config
  reload keeps live sockets and the signer and re-sends only changed
  subscriptions. After AUTH it re-sends only the walled subscriptions. NIP-42
  reasons may be prefixed (`ERROR: auth-required:`); use `isAuthRequired`. The
  self-state subscription reads with a `since` after its first EOSE.

### The one Rust dependency

Mini App multiplayer (`joinRealtimeChannel`) rides iroh-gossip, which lives in
`crates/webxdc-rt/` and compiles to wasm. `npm run dev` and `npm run build`
compile it through a prebuild hook, rebuilding only when a source file,
`Cargo.toml` or `Cargo.lock` is newer than the output.

**It is optional locally and required in the deploy.** Without a Rust
toolchain the hook prints what to install and exits 0: the app builds and runs,
Mini Apps still open and sync their state, and only multiplayer is off. Nobody
needs Rust to work on the chat UI. The deploy workflow sets
`WEBXDC_RT_REQUIRED=1`, which turns a missing toolchain or a failed compile
into a failed deploy rather than a published build with multiplayer silently
switched off.

To enable it locally:

```
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

macOS also needs a real LLVM clang (`brew install llvm`) — Apple Clang cannot
target wasm32, which surfaces as a `ring` build failure.

The wire formats the two clients share live in `src/lib/webxdcRealtime.ts`, not
in the crate, and are tested against Vector's Rust. The crate moves opaque
bytes; keep it that way, or the interop surface straddles a language boundary.

## How the client reaches backends (no build-time coupling)

The client talks to relays and voice brokers over **runtime-configurable URLs**,
never a compiled-in server address:

- Relay/server traffic is Nostr over WebSocket to user-added / configured relays.
- The relay's HTTP endpoints (NIP-29 LiveKit token, push) are derived at runtime
  from the relay's WS URL via `relayToHttpUrl()` in `src/lib/platform.ts`.
- Concord voice (CORD-07) fetches LiveKit tokens from a blind AV broker,
  defaulting to `CONCORD_AV_SERVERS` (public `https://av.armada.buzz`).

There is **no build-time relay pin at all** — every build, hosted included, has
no baked-in servers, and the user adds their own. Don't reintroduce one: a pin
is a WebSocket the client dials on boot whether or not that origin speaks Nostr
(the hosted `wss://armada.buzz` pin dialed the SPA's own origin, which serves
HTML and never upgrades), and `ws://localhost` is meaningless on a phone.

### Deployment settings: `config()`, never `import.meta.env`

Deployment settings (relay defaults, AV brokers, `APP_ID`, …) are read through
`config(name)` in `src/lib/env.ts`, never `import.meta.env`. The names are
unprefixed and listed once, in `CONFIG_NAMES` (`src/build/buildConfig.ts`);
the build bakes them in from its environment, still accepting the deprecated
`VITE_` spelling with a warning. A page may override any of them at runtime
through `window.ENV`, Remix-style browser environment variables set by a
same-origin script that runs before the bundle. A string there wins, empty
included. Only the PAGE consults it: the service worker and the Electron
main-process bundles have no `window` and keep the build value, which is what
keeps the desktop updater's trusted `RELEASE_AUTHORS` out of a host's reach.
A new setting goes into `CONFIG_NAMES`. `VITE_PROFILE` is not a setting — it
gates code out of the build, so it stays `import.meta.env`.

### Proof of work (NIP-13) on every published event

Every event Armada hands a relay as an EVENT can carry a NIP-13 `nonce`
(`src/lib/pow.ts`). The difficulty is the device's choice in Settings › Relays
(`AppConfig.powDifficulty`, per-device), else `POW_DIFFICULTY`, else 0 (off). Only
the OUTER event is mined: seals, rumors, NIP-42 AUTH, NIP-98/Blossom tokens and
zap requests are not. A new signing path must keep that true:

- **The user's signer mines** (`AppSigner.signEvent`), skipping the exempt kinds
  above. A new inner or credential kind signed by the user goes into
  `POW_EXEMPT_KINDS`.
- **A key held here** (wraps, invite links, signup lists) signs with
  `finalizePowEvent`, never a bare `finalizeEvent` — which is why `wrapSeal`,
  `wrapDmSeal` and friends are async. A long-lived key is a `PowNSecSigner`.
- Mining is on the UI thread, time-sliced, and costs time proportional to the
  content length per attempt (~60k attempts/s for a 1.5 KB wrap on a desktop),
  so each extra bit doubles a send's latency.

## Voice / LiveKit (client side)

The LiveKit JS SDK **always appends `/rtc`** to the server URL it's given, so a
voice server URL must be the bare origin (e.g. `wss://armada.example.com`), never
`.../rtc`. When bumping `livekit-client` in `package.json`, the self-hostable
LiveKit **server image** must be bumped to a matching/newer release in
`armada-av` (signaling protocol skew makes clients full-reconnect every
~16s). Full voice/LiveKit hosting guidance lives in `armada-av`'s `AGENTS.md`.

## Call recording (Concord)

Mumble's recorder, ported (`src/lib/callRecording/`, `src/components/chat/CallRecorder.tsx`):
one file per voice or a mixdown, in FLAC/WAV/Opus/AU, named by a `%user`
`%date` `%time` `%host` `%channel` template. Every voice runs through an
AudioWorklet tap in one AudioContext of the recorder's own, so all files share
one sample clock; the worker pads gaps with silence (Mumble's
`lastWrittenAbsoluteSample`) and stages into OPFS through sync access handles,
so a crash costs seconds, not the take. The files are copied to a picked folder
or downloaded on stop. `e2e/call-recording.spec.ts` runs the real pipeline.

Its privacy rules are the point of it, so keep all three:

- **Announce, then capture.** `["recording","1"]` rides the encrypted CORD-07
  presence (an additive tag, like `hand`), and capture starts only after a
  relay ACCEPTED it. A failed announcement records nothing.
- **Default deny.** Only VERIFIED members are recorded (`policy.ts`), because
  verification is the fresh signed presence that would carry their
  `["norecord","1"]`. Unverified, contested and screen-share identities are
  never captured, and a refusal disconnects that voice at the next sync.
- **Visible both ways.** Recorders and refusers are flagged on tiles, in the
  sidebar roster (read straight off the presence fold, so before joining too)
  and in the call bar's REC pill, and a recording start is toasted with a
  "Don't record me" action.

This binds honest clients only — a modified client can always record what it
hears, as in Mumble. Concord calls only: NIP-29 and DM calls have no signed,
encrypted channel to announce on, so `CallSignals.recording` is null there and
no recording UI renders. Staged takes hold decrypted audio, so logout removes
`STAGING_DIR`.

## Android App Links (deep linking)

The Android app registers a verified `https` intent filter for **armada.buzz**
(`android/app/src/main/AndroidManifest.xml`), so invite/share links open in the
app. Verification requires `https://armada.buzz/.well-known/assetlinks.json` to
be served by the web client (the file lives in `public/.well-known/` and ships in
the static build). It lists the APK signing cert's SHA-256 fingerprint (get it
with `apksigner verify --print-certs Armada.apk`). If the signing key rotates, or
the app is published through a store that re-signs (e.g. Play App Signing), add
the new cert fingerprint to the array.

## iOS (Capacitor)

`ios/` is a Capacitor 8 iOS project. Capacitor 8 wires plugins through
**SwiftPM** (`ios/App/CapApp-SPM/Package.swift`, regenerated by `cap sync`), so
there is **no CocoaPods** — a Mac with Xcode and Node is the whole toolchain.
`Package.resolved` is committed to pin `capacitor-swift-pm` and transitive
plugin deps.

Build (on a Mac; iOS is built manually — there is no automated build for it):

```sh
npm ci && npm run build && npx cap sync ios
cd ios/App && xcodebuild -project App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' build
```

For a release build use `scripts/ios-release.sh [vX.Y.Z]` (`ARCHIVE=1` to
archive for distribution). The version is carried by the git tag like every
other target — nothing is committed — and it stamps `MARKETING_VERSION` from
the tag plus `CURRENT_PROJECT_VERSION` from the SAME
`major*1_000_000 + minor*1_000 + patch` scheme Android's `versionCode` uses.
Monotonicity is load-bearing: App Store Connect rejects an upload whose build
number doesn't exceed the previous one.

- **Don't pass `CODE_SIGNING_ALLOWED=NO`** even for the simulator. An unsigned
  app has no keychain-access-group entitlement, so every
  `capacitor-secure-storage-plugin` write fails (`errSecMissingEntitlement`,
  surfacing as a bare `"error"`) — which is where the nsec lives. Xcode's
  default ad-hoc simulator signing is enough.
- Signing is automatic against `DEVELOPMENT_TEAM = GZLTTH5DLM` (Soapbox
  Technology LLC), set in `project.pbxproj`. The Team ID is also baked into the
  `appIDs` of `public/.well-known/apple-app-site-association`, so a team change
  means changing both or universal links silently stop associating.
- **Storage is ArmadaDB in Swift, in an App Group container.** `ios/ArmadaDB`
  is the engine; `ArmadaDbPlugin.swift` is the transport, registered from
  `ViewController.capacitorDidLoad()` rather than through
  `capacitor.config.json`'s `packageClassList`, which `cap sync` regenerates
  from npm packages and would drop an app-local plugin from. The file lives in
  `group.buzz.armada.app`, NOT the app sandbox, because that is the only
  container a notification extension can also open — and the choice stops being
  reversible the moment a build ships, since moving it later strands decrypted
  Concord and NIP-17 history that exists nowhere else. `ArmadaDbLocation`
  refuses to fall back to the sandbox for the same reason. The App Group must
  be enabled on the App ID in the developer portal, like Associated Domains.
- The WebView origin is `capacitor://localhost` (Android uses
  `https://localhost`). Changing `server.iosScheme` later would move the
  origin and orphan any OPFS/localStorage data, so treat it as
  fixed. (ArmadaDB itself is no longer at risk — it is a file in the App Group
  container, not storage keyed by the origin.) `shareOrigin()` already returns
  the public web origin on native.
- Safe-area insets are native on iOS (the safe-area plugin is an Android
  edge-to-edge polyfill), driven by `viewport-fit=cover` in `index.html`.
  `contentInset: 'never'` keeps UIKit from adding a second inset on top of the
  app's `env(safe-area-inset-*)` padding.
- `Info.plist` carries `NSCameraUsageDescription` /
  `NSMicrophoneUsageDescription` for LiveKit calls, voice messages and the
  WebView file input's "Take Photo or Video". Add a usage string *before*
  reaching for a capability — iOS kills the process on first use otherwise.
- Icon/splash are generated from `public/logo.svg` into
  `ios/App/App/Assets.xcassets` (app icon = the blade mark on `#100b15`, no
  alpha, matching the Android launcher icon; launch screen = the crest on the
  same background).
- **`PrivacyInfo.xcprivacy` has to be in the Resources build phase, not merely
  in the folder.** It is wired into `project.pbxproj` by hand (file reference +
  `PBXBuildFile` + the `App` group + `PBXResourcesBuildPhase`); a manifest that
  is only on disk ships in no bundle and App Store Connect still rejects the
  upload with `ITMS-91053`. Nothing generates it — `cap sync` doesn't, and none
  of the Capacitor SPM plugins vendor one of their own, so the app target's
  manifest is the only one in the binary and must cover their APIs too. What it
  declares: file-timestamp (`C617.1`), disk-space (`E174.1`) and user-defaults
  (`CA92.1`) reasons, all reached through the **vendored SQLite**
  (`ios/ArmadaDB/Sources/CArmadaSQLite`, which calls `stat`/`fstat`/`lstat` and
  `statfs`/`fstatfs`) rather than through any Swift written here —
  `ArmadaDbPlugin.swift` touches no required-reason API at all. Tracking is
  `false` and there are no tracking domains. Re-check the required-reason list
  when the SQLite amalgamation is re-pinned or a plugin is added.
- **Export compliance lives in the comment at `ios/App/App/Info.plist`.** Read it
  before touching `ITSAppUsesNonExemptEncryption`; the position rests on Armada's
  source staying publicly available.
- **Store builds rely on the section 7 additional permission in the README's
  License section** (App Store terms are the extra restrictions AGPL section 10
  forbids — this is what took VLC off the App Store). Soapbox can only grant it
  for copyright it holds, so **no copyleft code you don't own may enter a
  store build** unless its holder has granted the same permission.

Android-only pieces that are simply absent on iOS, and are gated so they don't
surface dead UI or throw: the `ArmadaNotification` background relay service
(use `hasNativeNotificationService()`, not `isNativeRuntime()`, for anything
touching it), NIP-55 external signers (Amber), the Bluetooth mesh, and
the Credential Manager nsec export (itself Android 14+ only — see Conventions).

### Notifications: APNs through nostr-push2

iOS is the one platform that cannot listen for its own events in the
background — no equivalent of Android's foreground service, and no Web Push in
WKWebView — so it takes an APNs device token (`ios/App/App/ArmadaPushPlugin.swift`,
`src/lib/nativePush.ts`) and hands it to the same nostr-push2 gateway as the
web (next section), as an `apn` connection. `useIosPush.ts` is the controller:
`apnsPushTarget` is a third `PushTarget` beside the web's two, so the list it
sets is built, carried forward and serialized by the same
`mutatePushRegistrations`, and both controllers expose one
`UsePushNotificationsReturn`, so the settings UI never learns which it has.
Apple is unavoidably in the delivery path; what survives is that the GATEWAY
still matches kinds and tags and forwards the still-encrypted event under a
fixed string, never a rendered message.

- **The message is decrypted on the device, by the Notification Service
  Extension.** `ios/App/NotificationService` is the target; all of its work is
  in `ios/ArmadaNotify`, the THIRD port of the decrypt/store/present pipeline
  (`src/sw/worker.ts`+`pushRuntime.ts` on web, `Dm17.kt`+`ServiceStore.kt` on Android).
  The gateway puts the `napp.push.payload` keys beside `aps`; the extension
  reads the plane off the event (`PushProcessor.scope`, the port of
  `pushScope`), opens it, writes it into the same ArmadaDB the WebView reads —
  which is why the database was put in the App Group before anything was
  stored in it — and rewrites the notification from the plaintext. An event
  too large for the 4 KB APNs payload arrives as `event_id` and is fetched
  from the named relay first (`RelayFetch`, 5 s), as the worker does. Every
  event, inlined or fetched, has its id and signature checked before anything
  else. One whose plane is known but which cannot be opened (a bunker that did
  not answer, a NIP-07 login, a kind-4 DM) gets that plane's fallback text and
  destination (`PushProcessor.fallback`); only an event that cannot be placed
  at all keeps the gateway's generic text.
- **`ios/ArmadaNotify` is a SwiftPM package so its suite runs on Linux**, like
  `ios/ArmadaDB` and for a sharper reason: this is the code that decides
  whether a rumor is authentic. Its vectors were generated with the very
  nostr-tools/@noble builds the web client uses, so a port that drifts from the
  app's own crypto fails `swift test --package-path ios/ArmadaNotify` (wired
  into `test.yml`) rather than in the field. libsecp256k1 is VENDORED
  (`Sources/CArmadaSecp256k1`, upstream v0.7.0, `extrakeys`+`schnorrsig` only),
  the same call SQLite gets. ECDH goes through `secp256k1_ec_pubkey_tweak_mul`,
  NOT the `ecdh` module, whose helper returns a SHA-256 OF the shared point
  while NIP-44 hashes the bare x — the same choice `NostrCrypto.java` makes.
  SHA-256/HMAC/HKDF/ChaCha20 are hand-written above the curve because NIP-44
  needs RAW ChaCha20 and CryptoKit exposes only ChaChaPoly; splitting the hash
  chain between CryptoKit and a fallback would leave the Linux suite testing
  code the extension does not run. **The counter starts at 0**, not the AEAD's
  1 — that alone is the difference between decrypting and garbage.
- **The extension is a separate process with its own sandbox.** It shares
  exactly one thing with the app, the App Group, so its entitlements must
  declare it and its own App ID must have it provisioned. Anything it needs to
  decrypt goes through `writeIosPushConfig` into
  `push-config.json` there, under `.completeUntilFirstUserAuthentication` —
  the weakest protection class that still works, because a push arrives while
  the device is LOCKED and anything stronger leaves the extension unable to
  read its own config. An nsec login puts `sk` there; a NIP-46 login puts the
  CLIENT key plus its bunker's pubkey/relays (`nip46`) and the extension asks
  the bunker to `nip44_decrypt` the wrap and the seal, over one socket, with
  the identity key never leaving the bunker — so a bunker that PROMPTS for
  decryption can never work here, since the push arrives with the device
  locked and no UI to approve anything. Both are deleted on disable/logout.
  **Always call the content handler exactly once**: an extension that returns
  without calling it, or crashes, silently shows the gateway's static text
  with no log anyone reads. It now has a genuine race to get that wrong —
  the avatar fetch below and `serviceExtensionTimeWillExpire` complete on
  different queues — so the call is behind a lock and a flag.
- **Presentation must not depend on persistence.** The store and the
  notification fail independently, so `PushProcessor` takes an OPTIONAL store:
  a database that will not open costs the message its history and its sender's
  name, and the text has already been decrypted by then. Gating the one on the
  other is not hypothetical — it shipped, and every push silently fell back to
  the gateway's static text because `NotifyStore()` returned nil.
- **A sender's face needs an `INSendMessageIntent`, not an attachment.** iOS
  shows the app icon on a notification unless it is a COMMUNICATION
  notification: donate the intent, rebuild the content with
  `UNNotificationContent.updating(from:)`, and the sender's avatar (or the
  monogram of their name) replaces it, with the conversation joining Focus
  modes' people rules. Needs the Communication Notifications capability on the
  App ID — automatic signing adds it, but without the entitlement
  `updating(from:)` throws and the notification degrades to the right text
  with the wrong icon, which looks like nothing is wrong. `PreparedPush.sender`
  is present only where the sender is ALREADY named in the body, which is what
  keeps a message request — whose whole point is that a stranger controls
  their own name and picture — from becoming a person on the lock screen.
- **The avatar has to be fetched in the extension**, because the
  image has to be bytes in hand when the content handler is called; there is no
  URL the system will fetch for us. It is bounded on every axis (`https` only,
  4s, 256 KB) and cached per sender in the App Group (`AvatarCache`, keyed by
  the SHA-256 of the URL so a changed picture misses once and nothing has to
  invalidate anything), so it is a per-sender cost rather than a per-message
  one. Every failure ends at the monogram, never at a missing notification.
- **iOS cannot withdraw a delivered alert.** A push the pipeline decides is not
  news (the viewer's own message from another device, a reaction to someone
  else's) still has to show something, so it becomes a `passive` "Messages
  synced" rather than the gateway's "New message" — which would be a
  notification about nothing.
- **`aps-environment` is a runtime question, not a build flag.** A device token
  is minted against exactly one APNs host and the other rejects it with
  `BadDeviceToken` — and a Release build run from Xcode is still sandbox while
  the same configuration through TestFlight is production, so neither
  `#if DEBUG` nor a build setting can answer it. `ArmadaPushBridge` reads the
  `aps-environment` entitlement back out of the app's own embedded
  provisioning profile and sends it with the token; an App Store build embeds
  no profile, which is itself the production answer. Requires Push
  Notifications on the App ID, like Associated Domains and App Groups.
- **The gateway client is its own key** (`loadNostrPush2ClientKey`, no VAPID
  half), so bunker and extension logins register without a signer prompt. The
  account-exit hook clears the extension's config first, locally, then deletes
  the client best-effort; a client the gateway never hears from again expires
  after 30 days.
- Taps are routed by the plugin, not by a URL. The extension writes the room's
  route into the notification as `url`; a tap that LAUNCHED the process is
  buffered natively and read by `coldLaunchDeepLink` alongside the launch URL,
  so both settle the one race against `HomeRedirect`, and a warm tap is the
  `pushOpened` listener in `useNotificationNavigation`.
- **A push while the app is open gets a banner unless it is about the room on
  screen.** `useNotificationNavigation` reports the route through
  `setActiveRoute`, and `willPresent` compares it with the notification's
  `url` (`ForegroundPresentation`, tested on Linux): the same room, or a
  passive notification, goes to Notification Center only. The page shows no OS
  notifications of its own on native, so this is the one foreground path.

Deep links: armada.buzz **universal links work**, via the
`com.apple.developer.associated-domains` entitlement in
`ios/App/App/App.entitlements` plus
`public/.well-known/apple-app-site-association` (shipped in the static build
like `assetlinks.json`, and matching every path on the host exactly as the
Android intent filter does). No app code is involved: `AppDelegate` already
proxies `continue userActivity` to Capacitor, and `deepLinkUrl.ts` /
`coldLaunchDeepLink.ts` are platform-agnostic. Two things this can break on —
the AASA must be served with `Content-Type: application/json` and **no
redirect** (it is extensionless, so servers that key content type off the
extension need an explicit rule for it), and its `appIDs` must be
`<TEAMID>.buzz.armada.app`.
There is still no `CFBundleURLTypes` entry, so the `armada://open<path>` scheme
does not resolve — deliberately: per `deepLinkUrl.ts` that scheme is emitted
ONLY by the Android notification service's PendingIntents, and iOS push taps
reach the router through the plugin rather than through a URL, so nothing on
iOS can produce one.

### Web notifications: nostr-push2 and `window.napp.push`

The web build has two ways to be woken while closed (iOS uses the same
gateway through a third target; see above), and `useNostrPush.ts` drives both: Tenna's `window.napp.push` when Armada runs there as an nsite
(`~/Projects/tenna/NAPP.md`), and Web Push through a
nostr-push2 (`nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/nostr-push2`)
gateway everywhere else (`nostrPush2.ts`; the public service is hardcoded in
`platform.ts`, and `NOSTR_PUSH2_*` only overrides it). They differ
ONLY in the `PushTarget` the list is handed to. Both take the same
`NappSubscription[]` (`nappPush.ts` packs the shared watch set into them) and
both deliver the same `napp.push.payload` to `sw.js`, which normalizes it and
presents it through the one path the legacy payloads also use. Don't give
either transport a presentation path of its own.

- **`set` replaces the whole list.** A snapshot with a plane still loading
  would unsubscribe that plane, so `carryForwardWatches` keeps the last-set
  watches of every plane that is not ready. This is the prune rule, and the
  only one — there are no per-record ids to reconcile any more.
- **The gateway client is an ephemeral per-install key, never the account's.**
  So bunker and extension logins get Web Push too, and account exit can always
  clear the list with no signer. The install also mints its OWN VAPID key and
  hands the private half to the gateway in `create`; a browser subscription
  made against any other key is dropped at preparation. Both keys live in
  localStorage and go with logout's purge.
- **The payload names no subscription.** The worker reads the plane off the
  event (`pushScope` in `pushRuntime.ts`: a 1059 authored by one of our stream
  addresses is Concord, one addressed to us is NIP-17, an `h`-tagged group kind
  is NIP-29) and takes a NIP-29 room's relay from `relays`, the relay the event
  arrived from. An event too big for the ~4 KB transport arrives as `event_id`
  and is fetched BEFORE anything is shown, because its plane is unknowable
  without it.
- **Verify the event in the worker.** Tenna delivers what its relays sent
  unchecked; `preparePush` drops anything whose signature does not hold.
- **nostr-push2 ignores `relays`**: it matches against the firehose of its own
  relays only. Tenna on Android does honour them (and cannot answer NIP-42).
- The page must not show its own OS notification while either path is live —
  `backgroundPushActive` is the one check, used by the foreground notifier —
  except for an event the worker arbitrates with it by id. A worker that
  cannot open an encrypted event (a bunker or NIP-07 login keeps the signer in
  the page) hands the wrap to the open pages (`armada-push-open`); a page runs
  it through its own ingest and answers by wrap id (`NotifyCandidate.wrapId`)
  with what its notifier did, and the worker's generic text is the fallback
  only when no page opens it.

## Local storage: ArmadaDB

One interface (`src/lib/db/types.ts`) — tenants of rumors plus a KV — with a
different engine per platform:

| Platform | Engine |
|----------|--------|
| Web | `IndexedDBArmadaDB` (Nostrify's `NIndexedDB` per tenant) |
| **Android** | `NativeArmadaDB` → `ArmadaDbPlugin` → **Kotlin** (`android/…/app/db/`) |
| **iOS** | `NativeArmadaDB` → `ArmadaDbPlugin` → **Swift** (`ios/ArmadaDB/`) |
| **Desktop** | `NativeArmadaDB` → Electron IPC → `SqliteArmadaDB` on `node:sqlite`, in the main process (`electronMain.ts`, `nodeSqlDriver.ts`) |

All three native rows are the SAME JS adapter with a different transport under
it, so the write coalescing, the KV `kvOps` batching and the read-your-writes
ordering are written once. A new platform adds a bridge, not an adapter — though
one whose background writer needs the query engine in-process (Android's
service, iOS's future notification extension) does add an engine port below the
bridge.

Upgrades are supported from **v0.50.0**. The pre-ArmadaDB databases
(`RETIRED_DATABASES` in `purgeClientStorage.ts`) are never read or migrated —
only deleted on logout — and format changes go through `SCHEMA_MIGRATIONS` in
`db/schema.ts`.

On Android the query engine is native and there is exactly one database file.
The background notification service writes an event into the same tenant the
WebView reads it from, so a message received while the app was dead is simply
*there* on open. `drainEvents`/`ackDrain` still exist but are ROUTING only — a
pass through wire ingest (parking wraps, ringing scopes, notification
candidates) — over the `svc:<relay>` queue tenants, not the path by which
anything becomes durable.

Things to know before touching it:

- **Scope by what the data IS, and for NIP-29 that includes its relay.** A group
  is named by an `h`/`d` value that means nothing on its own: the same id on two
  relays is two unrelated groups, and relay software that ships a SHARED signing
  identity (zooid) defeats scoping by author too — with kind 39000 addressable,
  two servers' metadata then *replace* one another rather than merely mix. So
  NIP-29 lives in `nip29:<normalized relay url>`, one tenant per relay, and the
  isolation is structural rather than a side-table of provenance that a read has
  to remember to consult. `relayScope.ts` (+ `RelayScope.kt`) is the only place
  the rule lives: an `h` tag or a relay-signed 39000-39005/13534 is relay-scoped,
  everything else is `main`. Corollary: an event whose source relay is unknown (a
  pool-wide `.query()`, a `group(urls)` read) is NOT stored rather than filed
  under a guess — every NIP-29 read path uses `nostr.relay(url)` and knows its
  relay, and a dropped cache row is refetchable from the one relay that has it.
  Don't relay-scope global data (profiles, the user's own lists, git): that forks
  one identity into a copy per relay.
- **The Kotlin and Swift ports must stay in step with `SqliteArmadaDB.ts`.**
  Same schema, same `seq = created_at × 2²⁰ + n` rowid encoding, same tag-token
  escaping, same planner. `ArmadaDbTest.kt` and `ArmadaDbTests.swift` are the TS
  conformance suite ported over; run them (`cd android && ./gradlew
  :app:testDebugUnitTest`, `cd ios/ArmadaDB && swift test`) for any change to
  any of the three. The Swift suite needs no Mac — that is why the engine is a
  SwiftPM package rather than files in the app target.
  Where Swift needed more than transcription, and why: string ORDER is UTF-16
  code units (Swift's `<` compares by canonical equivalence, so a decomposed
  accent equals a composed one, and UTF-8 bytes sort astral characters on the
  wrong side of U+E000..U+FFFF) — the `id ASC` tie-break and the KV range bounds
  are contract, not detail; text binds with an explicit BYTE COUNT, since
  SQLite reads a length of `-1` as "up to the first NUL" and would truncate any
  user-controlled string containing one; and a KV prefix upper bound that lands
  on an unpaired surrogate is reported as NO bound, because Swift strings can't
  hold one — the scan widens and the range check does the filtering.
- **A burst is one statement per table, not one per rumor** — and on SQLite
  that is most of what a write costs. `rumors` carries an AFTER INSERT trigger
  maintaining the content index, and SQLite runs a trigger's sub-program per
  INSERT STATEMENT rather than folding it into the row loop, so a row per
  statement paid that setup once per rumor: 76µs a row against 17µs for the
  same rows, the same trigger and the same transaction written in batches of
  200. `flushWrites` therefore STAGES a burst (`RumorBatch`) and emits one
  multi-row INSERT per table per chunk — measured 287µs → 61µs per NIP-17
  rumor, and 4.0 → 1.0 statements. Two things it must keep doing, and the
  Kotlin and Swift ports with it: a rumor that READS the rows around it (a
  replaceable one superseding its coordinate, a kind 5 deleting its targets)
  flushes the batch and writes alone, so it still sees everything before it and
  nothing after; and the rowid ledger lives in the batch, because a rowid
  reserved for a staged row is invisible to the `MAX(seq)` that reserves the
  next one. Both are in `ArmadaDB.test.ts`, so a port that skips either fails
  the conformance suite rather than the field. The per-rumor `INSERT OR IGNORE`
  into `rumor_terms` went the same way — a NIP-17 message is filed under three
  terms, which alone tripled a write's statements.
- **A term read that names anything else is planned by COUNTING, on
  IndexedDB.** A derived term lives in the index and nowhere else, so the
  moment a filter names a term plus anything, `NIndexedDB` has to be asked for
  a superset and narrowed here (`runChecked`) — and which superset is smaller
  is a property of the data. A thread page is the term, since every kind in the
  filter is in the thread; the same thread's TIMER is the kind, one row per
  conversation against every message ever sent in one. One index-only `count`
  each decides it, and the limit is PAGED rather than dropped — reading the
  range whole made a 50-row page of a 300-message thread deserialize the whole
  thread. The paging must stay exhaustive: it is a walk to the end of the
  range, not a search budget, or a timer set a year ago is reported as no timer
  at all.
- **SQLite is bundled, not borrowed.** The schema needs FTS5 with
  `contentless_delete` (3.43+) and JSON1; Android's platform SQLite is 3.9 on
  minSdk 24 and has neither. `androidx.sqlite:sqlite-bundled` ships 3.50.1 per
  ABI (~1.2 MB each, ~5 MB on a universal APK) and the same build for the JVM,
  which is what lets the conformance suite run the real engine as a plain unit
  test. iOS vendors the amalgamation (`ios/ArmadaDB/Sources/CArmadaSQLite`,
  compiled with `SQLITE_ENABLE_FTS5`) pinned to the SAME 3.50.1, so the two
  native platforms run one SQLite rather than two that merely both pass; Apple's
  `libsqlite3.dylib` only reaches 3.43 around iOS 17, two releases past the 15.0
  deployment target. Desktop gets its engine from Electron's embedded Node (`node:sqlite`),
  which is why the Electron major is a storage dependency, not just a Chromium
  one: `node:sqlite` landed in Node 22.5, so Electron 33 (Node 20) could not
  host the store at all. Electron 43 is Node 24 / SQLite 3.53. Check both when
  bumping, and don't drop below a major that has it. A bump can also change the
  spellcheck dictionary file versions Chromium asks for; re-pin
  `scripts/fetch-spell-dictionaries.sh` when it does, or the desktop app's
  Windows/Linux spellcheck goes quiet.
- **The desktop store is the same TypeScript engine the tests run.**
  `src/lib/db/electronMain.ts` is bundled to `electron/db.cjs`
  (`vite.config.electron.ts`, `npm run build:electron-db`) and `require`d by
  `main.js`, so there is no hand-written JS copy of the store to drift. Two
  consequences: the bundle is a BUILD ARTIFACT (gitignored, and `release.yml`
  must build it — a missing `db.cjs` is not a build failure, it is a shipped app
  quietly storing data in the wrong place), and it must stay free of Electron
  imports so `tsc`/eslint cover it as ordinary `src/` code. The file lives at
  `app.getPath("userData")/armada.db`, and `preload.js` answers
  `armada:db-available` SYNCHRONOUSLY because the renderer picks its adapter
  before anything reads.
- **The desktop updater reads the release events, by the same arrangement.**
  `src/lib/desktopUpdate.ts` → `electron/updateFeed.cjs`
  (`vite.config.electron-update.ts`, `npm run build:electron-update`), wrapped
  as an electron-updater `custom` provider by `electron/nostrUpdateProvider.js`
  and armed with `setFeedURL` in `main.js`. It resolves the SAME NIP-82
  release `/downloads` renders (`docs/releases.md`) down to the one installer this
  machine can replace itself with, so `parseRelease()` is not reimplemented in
  `electron/` — a second parser is a second contract. Its OWN vite config rather
  than a second entry beside `db.cjs`: a multi-entry lib build hoists shared code
  into a content-hashed chunk, and a filename that changes with the dependency
  tree cannot be listed in `electron-builder.yml`'s `files:`. The static
  `latest*.yml` feed is GONE — not generated (`publishAutoUpdate: false`) and not
  deployed, and nothing is sent over SSH.
- **Every desktop edition but the store ones loads its web app from the nsite.**
  `electron/webSite.js` stores the newest signed kind-35128 manifest
  (`parseWebSite`/`resolveWebSite` in `desktopUpdate.ts`, pinned
  `RELEASE_AUTHORS` key) and the blobs it names, staged atomically and served
  over app:// from the next launch; the shell (installer, AppImage, Flatpak
  shell) updates separately and rarely. What it stores becomes the app://
  origin with the whole preload bridge, so the manifest is re-verified at
  every launch and each file hashed whenever it is served — never trust it for
  having been checked when downloaded, and never resolve it from a URL the
  renderer supplies. A site runs on OLDER shells too, which is what
  `electron/desktopApi.json`'s `level` is for: a change to the preload bridge
  or the ArmadaDB engine fails `electron/desktopApi.test.mjs` until its
  `surface` is re-recorded, and `level` is bumped when a bundle built from the
  change cannot run on the previous shell (see electron/README.md, "The shell
  API level"). The `/downloads/armada-web.tar.gz` archive the deploy still
  publishes is only for Flatpak shells up to v0.67.6. The published build is
  distributed by npkg at `pkg.soapbox.pub`, which watches the NIP-82 release
  events, hash-verifies each artifact, and re-signs the apt/flatpak/fdroid
  repositories under its own keys — so Armada ships the `.flatpak` (and `.deb`
  and `.apk`) UNSIGNED and does no OSTree/GPG signing of its own. Don't bring the
  OSTree repository fold, a release signing key, or a
  `public/.well-known/armada-flatpak.fingerprint` back into `deploy-nsite.yml` or
  the release workflow; the self-hosted signing path was retired with the
  self-hosted remote. **The `publish:` block still has to exist**: electron-builder
  writes the packaged `app-update.yml` only when one does, and electron-updater
  reads that file on every DOWNLOAD (`updaterCacheDirName`, plus `publisherName`
  on Windows), so deleting it leaves the update check succeeding and the download
  throwing ENOENT — visible only on a manual check. Its `url:` is never fetched.
- **The adapter is chosen before anything reads.** Migrations write through
  `getArmadaDB()`, so on Android and desktop they land in the native store
  directly; don't add an IndexedDB hop there.
- **The service is a second writer, so it obeys the same store rules.** `Dm17.kt`
  ports NIP-17's kind filter and NIP-40 expiry refusal;
  `ServiceStore.storeConcord2Rumor` ports the chat plane's encrypted-seal rule;
  `RelayScope.kt` ports the tenant routing; `SelfState.kt` ports the self-sync
  catalogue (`selfSyncKinds.ts`) so the service can mirror the user's own
  replaceable documents — follow/mute lists, the 10009 server list, the Concord
  vaults, the NIP-78 settings document holding the rail's arrangement — into
  `main` while the app is dead, which is what makes a change made on another
  device already be on disk at open instead of racing a cold relay read. A rule
  only one writer applies is a
  conversation the two disagree about — for routing, literally a message stored
  where the timeline never reads — and the rules are load-bearing precisely
  because nothing is stored beside the rumor for a reader to re-check them
  against. Relay-URL normalization stays JS-side (the service is configured with
  already-normalized URLs) so there is one spelling of a tenant id, not two.
- **Never inject a tag into a stored rumor, and don't store a row beside it
  either.** Its tags are the bytes its id commits to, so bookkeeping written
  into them makes the row something the sender never signed, and makes whatever
  reads that tag forgeable by anyone who spells it. Derive instead: a DM's
  conversation comes from `pubkey` and the `p` tags NIP-17 requires
  (`dmPeersOf`), and where the derivation is more than a filter can express it
  becomes a derived TERM rather than a tag (see below). A Concord plane is its
  KINDS
  (`PLANE_RULES`/`queryPlane`), and a rekey round names its own scope and epoch
  in the tags `parseRekey` reads — so neither the stream address, the carrier
  wrap id nor the seal kind is stored at all. They are checked ONCE, at ingest
  (`writeOpened`), against the stream keys that actually opened the wrap, and
  wherever the seal form is still known in memory (`parseEdition` and friends —
  freshly-swept events reach a fold without a store round-trip).
- **The one exception is worth knowing, because it is the shape of a real
  one.** A compaction re-wraps control editions VERBATIM under the new epoch's
  address (CORD-06 §3), so whether an edition is in the current snapshot is
  genuinely not in the rumor. It lives in KV as one key per (control stream
  address, rumor) (`c2snap:<community>:<pk>:<rumor>`, `readControlSnapshot`) —
  the fact itself, not an event-shaped row impersonating one. The Guestbook
  address a rumor arrived at is the same kind of fact (only the live epoch's
  Nicknames count, CORD-04 §10): `c2gbaddr:<community>:<rumor>:<pk>`, held in
  memory once read (`readGuestbookAddresses`). A key per fact, never a merged
  set: recording one then never reads, so two writes can't lose each other, and
  a wrap already seen is never offered again to put a lost one back.
- **Where the derivation is real but unfilterable, index a TERM.** A NIP-01
  filter can only ask about what a rumor literally says, and a NIP-17
  conversation is the SET of its participants — half in `pubkey`, half in the
  `p` tags, and a tag filter is an OR over values, so `authors: [ana, ben]` also
  matches everything Ana sent in another room. Every such read could therefore
  only OVER-select and be narrowed in JavaScript afterwards, at a fixed 3×
  over-fetch per filter. A tenant may instead declare a `TermPolicy` (`db/types.ts`):
  a pure function of the stored rumor returning opaque strings, indexed beside it
  and looked up as a NIP-50 extension token (`{ search: "conv:<key>" }`). Not a
  tag on the rumor and not a row impersonating one — a CACHE of a derivation,
  discardable and rebuildable, unforgeable by a sender spelling anything, and
  read by nothing but the index. Three rules make it safe: the ENGINES never
  interpret a tenant id or a term (`db/termPolicies.ts` is the only table that
  does, and `TermPolicies.kt` / `TermPolicies.swift` must agree with it exactly);
  the policy binds to the TENANT, not to a write, so the Android service and the
  iOS extension file rows correctly while knowing nothing about terms; and an
  unknown term FAILS CLOSED, matching nothing rather than dropping the
  constraint. SQLite gets a b-tree (`rumor_terms`, schema v2) rather than more
  FTS tokens because `(tenant, term, seq)` is already time-ordered, so a lookup
  is a bounded backwards walk — and because a b-tree can be GROUPED, which is
  what `distinct:` below is. Existing rows are indexed by a one-time per-tenant
  backfill, since a term cannot be derived in SQL; only reads that TOUCH the
  index wait for it — which is every read carrying a `search`, and must be
  tested that way rather than on the terms the filter parsed to, because
  `distinct:` reaches the index while naming no term of its own. (Gating on the
  parsed terms is what left the Kotlin and Swift engines answering the
  conversation list from an index nothing had built.) The GENERATION that walked
  the tenant is recorded beside it — one number, identical in all three ports,
  because a policy edit without it leaves earlier rows carrying terms nothing
  looks up, and two ports that disagree rebuild the index against each other on
  every open. A pass runs at most once per tenant per process whatever the
  outcome, and a failed one is swallowed with its generation unrecorded: the
  read that triggered it is answerable from the index as it stands, and the next
  launch walks the tenant again.
- **`distinct:<namespace>` collapses a read to one rumor per group.** A term is
  namespaced (`<namespace>:<body>`, which the read path always required since a
  term is named as a `key:value` token), and this reserved token returns the
  NEWEST rumor per term in one namespace — so `limit` counts conversations while
  still counting rows. ditto-relay spells the same operation `distinct:author`
  over a field, and for the same reason: collapsing has to happen INSIDE the read,
  because de-duplicating the answer afterwards can only shrink an already
  truncated page. That was the NIP-17 conversation list, which sampled the newest
  500 message rumors and grouped them in memory — one busy thread hid every other
  conversation, and a peer written to a year ago fell out of the `mine` set the
  push gateways read as "not a stranger". Two plans, which must answer
  identically: `GROUP BY term` over the namespace's range (index-only, one body
  read per group) when nothing outside the term index has to be tested, and a
  collapse-as-you-scan otherwise — row conditions apply BEFORE the collapse, so
  `kinds` would have to be tested inside the grouping, which is why the policy
  files a message-only namespace (`convmsg:`) instead. It is a DIRECTIVE, not a
  term: query-only (a `remove()` naming it deletes nothing, since "one rumor per
  conversation" is not a deletion anyone should be able to ask for), never
  matched row-wise, and refused outright rather than approximated — two of them,
  or a namespace that isn't one, fail closed.
- **A message removed from this device is refused by the ENGINE, not by its
  callers.** `ArmadaDB.forget(ids)` deletes the ids from every tenant and
  records them in `removed_rumors` (IndexedDB: NUL-prefixed keys in the KV
  database's `termed` store), and
  `reserveSeq` answers a removed id like a stored one inside the lookup it
  already runs, so the Android service, the iOS extension and the service worker
  refuse it with no rule of their own. The table was added without a
  `user_version` bump: it is additive and created on every open, and a bump would
  make an older iOS build refuse the file. IndexedDB avoids a version bump for the
  same kind of reason: an upgrade waits on every open connection, and a tab of an
  older build never closes its own. Plaintext held outside the rumor
  stores (thread snapshots, the signer's decrypt cache, session memos, queries) is
  scrubbed by `removeMessageFromDevice`; a new cache of decrypted messages needs a
  line there too.
- **A migration converts to the CURRENT shape; it does not copy rows across.**
  Planes read back by kind, which is sound only because `writeOpened` refuses a
  rumor whose kind doesn't belong to the plane that opened its wrap — a
  migration touching Concord rows must apply the same refusals, or it can mint a
  control edition out of any guestbook keyholder's rumor.
- **Old key spellings are converted once, in a schema migration.** Don't put a
  "check the old key on miss" fallback in a cache or hook: it drifts and re-runs
  on every warm forever.
- The bridge carries JSON **text**, not marshalled objects: Capacitor would
  have to guess between an integer `kind` and a float, and a page of rumors is
  far cheaper as one string.

## CI: Blossom failover and mirroring

The nsite deploys (`deploy-nsite.yml`, `release.yml`), the legacy kind-30622
release event (`scripts/publish-release.mjs`, kept only for desktop builds up
to v0.64.13) and the NIP-82 release (`ngit release publish`,
`.ngit/release.yaml`) all write to the
Blossom servers listed in `.nsite/config.json`, and no ONE of them may be able
to fail a run:

- **Never call `nsyte deploy` from a workflow directly.** Go through
  `scripts/nsite-deploy.sh`. nsyte
  runs one upload queue per server and signs the manifest only after EVERY
  queue drains, with ~90 s of retries per file on a dead server, so a single
  broken mirror does not cost that mirror: it runs the step past its deadline
  and no manifest is published at all, while the healthy servers' finished
  uploads sit unreferenced. The wrappers probe the hosts
  (`scripts/live-hosts.sh`: a Blossom-level HEAD where a 5xx counts as down —
  a proxy up in front of a dead backend is the common outage, and a probe of
  `/` reports it alive), hand nsyte only the live ones, bound each run with
  `timeout`, and retry once without the servers the failed run's log blames.
- **`--sync` on every deploy is the mirroring.** Without it nsyte transfers
  only files whose hash changed since the last manifest, so a server that
  missed one deploy stays missing those blobs forever. With it every file of
  the site is HEAD-checked on every live server and uploaded where absent, so
  a dropped mirror is backfilled by the next deploy that finds it healthy.
- The servers nsyte is given are also the manifest's `server` tags (the hints
  gateways read), which is why it is one run over the live set rather than a
  primary pass plus a mirror pass: the manifest the second pass republished
  would name only the mirrors.
- `publish-release.mjs` probes the same list, stores each artifact on the
  first server that takes it, publishes the release, and only THEN asks the
  rest to mirror it (BUD-04 `/mirror`) under a fixed budget — so mirroring can
  delay a release but never block one. `ngit release publish` runs after it,
  so its blobs are already there; ngit needs only one confirmed copy per blob
  and reports incomplete replication as a warning.

## Translations (i18n)

The web UI ships in English, German, Spanish, French, Italian, Dutch, Brazilian
Portuguese and Japanese through FormatJS (`react-intl`), the same arrangement as
Ditto. English
is never a catalog the app loads: it is the inline `defaultMessage` at each call
site. `src/i18n/locales/<lang>.json` are flat `{ id: ICU message }` files, one
lazily-loaded chunk each; `en.json` is GENERATED (`npm run i18n:extract`) and
exists for the check and for translators.

- **Import from `@/i18n`, never from `react-intl`.** `useIntl`/`FormattedMessage`
  there fall back to English with no provider mounted, which is what keeps
  component tests and the outermost `ErrorBoundary` free of wrappers. Code the
  service worker bundles imports from `@/i18n/intl`, which has no React in it.
- **In a component, `useIntl()` or `<FormattedMessage>`** — both subscribe to the
  language, so a switch re-renders them. `t()` is for code outside a render (a
  class component, a toast fired from a lib, a callback). Never format at module
  load: a table of labels holds `defineMessage` descriptors and is formatted
  where it is shown.
- **Ids are static literals**, `<componentOrArea>.<key>` in camelCase
  (`messageComposer.placeholder`); the extractor rejects a computed id and two
  different messages under one id. A bare word that is a whole button or menu
  item can use `common.*` (`src/i18n/common.ts`); a sentence gets its own id.
- **Whole sentences, ICU for the grammar.** No concatenating translated
  fragments (`"Sent " + label`) and no `n === 1 ? "" : "s"`: write
  `{count, plural, one {# member} other {# members}}`, `{kind, select, …}`, and
  rich text as tags (`Read the <link>guide</link>` with
  `values={{ link: (chunks) => <a …>{chunks}</a> }}`).
- **Not translated:** user and event content, brand and protocol names (Armada,
  Concord, Nostr, Buzz, Blossom, LiveKit, NIP-xx), console/log output, and errors
  that never reach the screen.
- **Dates and numbers use the app's language**, not the browser's: pass
  `intl.locale` (or `getLocale()` outside React) where code would pass
  `undefined` to `toLocale*String` / `Intl.*`. That tag carries the user's
  region (`en-GB`, `de-AT`, `en-BR` for a pt-BR browser reading English —
  `formattingLocale`), so it is not a catalog key: a notifier or a catalog
  lookup takes `languageOf(…)` / `getLanguage()`.
- **Every new or changed message is translated into every catalog in the same
  change.** `npm run test` runs `npm run i18n:check`, which fails when `en.json`
  is stale, a catalog lacks or has extra ids, or a translation's placeholders and
  tags differ from the English. `node scripts/i18n.mjs missing <lang>` lists
  what a catalog lacks.
- The choice is device-wide (`armada:locale`, like the text size), preserved by
  the logout purge, and absent means "follow the browser/OS".
- **Background notifications are localized on every platform.** The service
  worker gets the locale and the `notification.*` slice of the catalog in its
  sealed config; Android's service and iOS's extension get the locale in theirs
  and carry their own tables (`values-<lang>/strings.xml`,
  `ArmadaNotify`'s `Strings.swift`), which must stay in step with the
  `notification.*` messages — `i18n:check` compares both against the catalogs
  (`ANDROID_KEYS`/`SWIFT_KEYS` in `scripts/i18n.mjs` map each native key to
  its message).

## Conventions

- **Comments say why, briefly.** Keep invariants, ordering/race constraints,
  security rationale, spec references (CORD-xx, NIP-xx) and named platform-bug
  workarounds, in 1–3 lines. Don't restate the code, and don't narrate bug
  history, earlier behavior or what a change removed — that belongs in the
  commit message. Keep a lone comment in an intentionally empty block
  (`catch { /* ignore */ }`) so `no-empty` stays quiet.
- **Never publish a user's Nostr lists without an explicit user action.** This
  covers every user-owned replaceable/list event: kind 10050 DM relays, kind
  10009 servers/groups, follow/mute lists, NIP-65, Concord membership lists.
  No publish-on-mount, publish-on-visit, publish-on-sync, or "publish a
  default because the read came back empty" — an empty read is
  indistinguishable from a failed one (cold pool, AUTH, wrong relay set), and
  replaceable events make such a publish destroy the user's real list
  everywhere. List writes must be read-modify-write and must refuse to build
  on an empty/failed read when local persisted state says a non-empty list
  existed. Preserve the existing event's format: a list stored as public tags
  (e.g. by Flotilla) stays public; encrypted private items stay encrypted.
  This rule has been violated twice with user-visible data loss — do not
  reintroduce any automatic list publish, however well-intentioned. The ONE
  sanctioned exception is signup: when a signup flow (`SignupWizard`,
  `SignupDialog`) generates a key ITSELF, it publishes that key's default
  kind 10002, 10050, 10007 and 10063 (`buildSignupLists` in
  `src/lib/signupLists.ts`, via `useSignupLists`). This is safe precisely
  because the rule's hazard cannot arise — a key minted moments ago has
  provably never published a list, so there is no existing/failed-read list to
  clobber. It is scoped structurally to the generate path (existing-key logins
  never reach it) and is the only place an unsolicited list publish is allowed.
- **The account key signs exactly one NIP-78 document: the settings root**
  (`d = ${APP_ID}`, fixed-length plaintext, no other tags). Every other piece of
  private state — settings, GIF favorites, the DM index — is signed by a key
  derived from the root's secret under an opaque `d` (`settingsKeys.ts`), so
  nothing on the wire ties it to the account. Don't add a tag or a variable-length
  field to the root, don't add an account-signed or per-installation 30078
  document, and never write a legacy `${APP_ID}/<name>` one: the migration reads
  them as evidence of an older build. A root is created only by an account that
  already keeps settings, or by an explicit Sync now, after a relay confirms it
  has none. See `docs/settings-documents.md`.
- **No Google Play Services in the Android build.** The APK ships zero
  `com.google.android.gms` / `googleid` artifacts, and the merged manifest has
  zero Google components — verify with
  `grep -icE "gms|googleid" android/app/build/intermediates/merged_manifests/debug/*/AndroidManifest.xml`
  after any dependency change. The trap is that one innocuous-looking AndroidX
  line pulls the whole subtree: `androidx.credentials:credentials-play-services-auth`
  alone brought in eight proprietary artifacts, which is why it was removed and
  why Credential Manager is Android 14+ only here (the platform service exists
  from API 34; below that androidx.credentials has no provider, and Google's is
  the only one that ships). Older devices fall back to the key-file export, which
  `backUpNsec` already does — don't "fix" them by re-adding the dependency.
  Likewise `com.google.gms:google-services` is off the buildscript classpath:
  notifications are an okhttp WebSocket to the user's relays, never FCM.
  (`androidx.profileinstaller` is fine — Apache-2.0 AndroidX, pulled by
  activity/appcompat/fragment/lifecycle. Its `ProfileInstallReceiver` names
  `android.permission.DUMP` as the permission a *caller* must hold; the app does
  not request DUMP and could not be granted it.) `com.google.code.gson` is also
  fine: Apache-2.0, no network.
- **Gate an Android-only plugin on `getPlatform() === "android"`, never on
  `isNativePlatform()`.** iOS is a native platform too, so an
  `isNativePlatform()` gate routes it into a `registerPlugin` proxy with no
  implementation behind it, and the call can only reject. Where the `catch`
  returns a safe default this merely hides a wasted round-trip; where the
  branch IS the feature it removes the feature with no fallback left. That is
  exactly how `exportNsec` came to return `"failed"` on iOS, which took the
  onboarding key backup (`backUpNsec`, the only route the signup wizard has)
  down with it — a generated nsec the user could not save anywhere. The list of
  plugins this applies to is `MainActivity.java`'s registrations MINUS the ones
  iOS also implements: `ArmadaNotification`, `ArmadaCredential`,
  `BluetoothMesh`, `WebReady`, `ShareTarget`, `MediaGallery` (the attach
  sheet's recent-media grid; iOS keeps the system photo picker). Cross-platform plugins (Share,
  Haptics, Clipboard, Filesystem, StatusBar, SecureStorage) are the case
  `isNativePlatform()` is actually for. `ArmadaDb` is now in neither group: it
  is implemented on Android AND iOS but nowhere else, so `hasNativeArmadaDB()`
  gates on an explicit platform SET plus `isPluginAvailable`. Gating it on
  `isNativePlatform()` would be wrong the day a third native platform appears;
  gating it on `"android"` would silently put iOS back on IndexedDB, with the
  data already written to SQLite left where nothing reads it. The rule runs the
  other way too: `ArmadaPush` is iOS-ONLY, so `hasIosPush()` gates on
  `getPlatform() === "ios"` plus `isPluginAvailable` — the second half because
  an iOS build predating the plugin would otherwise offer a toggle whose every
  call rejects. Android needs no such plugin and should never get one: the APK
  ships no Play Services to receive FCM on, and its background service is
  strictly better anyway, holding the relay sockets itself with no third party
  in the delivery path.
- **Every sender-named image loads through the media policy, in one place.**
  An `<img src>`, a `<video poster>`, a CSS `url()`, a notification icon and a
  `fetch` of an encrypted icon are all a request from the viewer's address to
  whatever host the sender named, so an image in a message learns the IP of
  everyone who scrolls past it; no referrer policy or CSP touches the TCP
  connection. `src/lib/mediaPolicy.ts` is the ONE place the rule lives, and the
  rule is a single PROXY: with `mediaProxies` set (Ditto's `{href}` template,
  OFF by default, user-settable — turning it on in settings suggests the public
  proxy Ditto ships, `DEFAULT_MEDIA_PROXY`) every such load goes through it, so
  the host sees the proxy's address; unset, media loads directly. A
  loopback/private address is never proxied and never loaded.
  Apply it by going through the hooks that already do (`useMediaWithFallback`,
  `useImageFallback`/`FallbackImage`, `useRoutedCandidates`, `useMediaSrc`,
  `AvatarImage`), never by putting a raw event URL into an element. The three
  background writers — `pushRuntime.ts`, `NotificationRelayService`'s
  `MediaPolicy.java`, `ArmadaNotify`'s `MediaPolicy.swift` — carry the same
  proxy in their configs and must stay in step with the TS
  (`MediaPolicyTest.java`, `MediaPolicyTests.swift` mirror `mediaPolicy.test.ts`);
  an absent or unreadable proxy config there is the DEFAULT — proxying off,
  loading directly — matching the web client, since it can only mean the user
  never turned a proxy on. An explicit `""` is off too.
  Two bypasses load directly on purpose: a Buzz-hosted blob (its signed GET
  header would not survive a proxy, and its host is a relay the viewer joined),
  and a deliberate file download, 3D model view or Mini App open
  (`FileAttachment`, `ModelViewer`, `Webxdc`), which the image proxy is not for.
  A model's still (its imeta `thumb`) is passive display and goes through the
  policy like any image. The model itself must stay self-contained:
  `modelRenderer.ts` routes every loader through a manager that refuses any URL
  but the `blob:`/`data:` resources inside the file, since a model can name
  buffers and textures on any host.
- Commit messages: concise, imperative, sentence case (see `git log`).
  Describe the technical change only — what was changed. Don't embed a
  confident problem diagnosis, root-cause narrative, or prescribed "this fixes
  X" claim; state the behavioral effect plainly if needed, without asserting it
  as the definitive cause.
- Don't commit secrets, Android signing material (`*.jks`, `*.keystore`,
  `key.properties`), or `scratch/` (may hold invite secrets).
- Always commit after finishing a set of changes (don't wait to be asked); do
  not push unless asked. Verify the client builds (`npm run test`) before
  committing.
- **Push only to `origin`**, and only when asked. Any other remote configured
  locally is maintainer-managed; never push or release to one.
- **Buttons are fill-only, never bordered.** A secondary action is
  `variant="secondary"` (a filled surface), not `variant="outline"`; a tertiary
  one is `ghost`. Don't add a new `outline` button or a `border` class to a
  button. The `outline` buttons already in the tree predate this rule.
- Touch ergonomics: interactive elements target ≥44px on touch devices via the
  `touch:` Tailwind variant (`@media (pointer: coarse)`; not also `hover: none`,
  which some Android WebViews misreport on a phone) —
  e.g. `size-9 touch:size-11`. Use `touch:` (real touch), not width
  breakpoints, so narrow desktop windows keep dense hover UI. Note `touch:`
  emits *before* `md:` in the cascade, so a class that shrinks at `md:` needs
  the stacked variant too: `size-9 md:size-7 touch:size-11 touch:md:size-11`.
