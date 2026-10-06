# Armada desktop (Electron)

A **standalone, sovereign** Armada client. It bundles the web build (`dist/`,
copied in by CI) and serves it over a custom **secure** scheme (`app://armada/…`)
rather than loading a hosted URL. Consequences:

- **Not tied to any domain.** The bundled web build bakes in no servers at all —
  the user adds whatever servers they want. Clients are rogue.
- A custom *secure* scheme is still a secure context, so the **service worker**
  and **Web Push** work, and per-relay push subscriptions (whose endpoints are
  the relays' own HTTPS origins) keep working — unlike a plain `file://` bundle,
  where Chromium refuses to register a service worker.

It also adds desktop-native behavior the web build can't:

- **System tray** — close-to-tray, a Show / Quit menu, click-to-toggle, an
  unread badge (tray tooltip + macOS dock + Windows taskbar overlay), and a
  `--hidden`/`--minimized` flag to launch minimized (for autostart).
- **Launch at login** — a Settings → Desktop toggle registers the app to start
  when the user logs in (`app.setLoginItemSettings`; native on Windows/macOS, a
  `~/.config/autostart` entry on Linux), with a "start minimized" flag that
  passes `--hidden` so it comes up in the tray. `autoLaunch.js` wraps it; the OS
  holds the registration, the hidden flag is mirrored into userData because it
  doesn't round-trip through every platform's login-item store. Under a Linux
  AppImage the entry points at `$APPIMAGE`, not the transient extracted binary.
- **Resume-from-suspend recovery** — across a sleep/resume the relay WebSockets
  die but Chromium often fires no `close`, so they read OPEN while dead and the
  renderer never reconnects. `powerMonitor`'s `resume`/`unlock-screen` are
  relayed to the renderer (`armada:resume`), which force-rebuilds every pool
  socket (see `NostrProvider`) instead of waiting for a restart.
- **Screen and application sharing** — the in-app picker can switch the active
  screen/window without ending the share. Windows captures system audio minus
  Armada's own playback (Chromium's `loopbackWithoutChrome` process loopback,
  granted by name in `displayMediaPolicy.js` on Windows 10 2004+, so a share
  never carries the call back to the people in it); Linux uses PipeWire plus
  `@vencord/venmic` for either the entire system or a selected application's
  audio. Resolution, frame rate, bitrate, codec and
  delivery mode are configurable, and either side can open live stream details
  or make the shared content genuinely full-screen.
- **Global push to talk** — Windows, macOS and X11 use `uiohook-napi`; Wayland
  uses the trusted Global Shortcuts portal, including sandboxed Flatpak builds.
- **Package-aware updates** — installed Windows and AppImage editions update
  themselves; portable and deb builds defer to their actual package owner. The
  Flatpak updates its web bundle in place, and its shell through
  `flatpak update` from the remote it was installed from.
- **Encrypted login store** — the web build keeps the login blob (which for an
  nsec login holds the raw secret key) in plaintext `localStorage`. Here it is
  encrypted at rest with `safeStorage`, i.e. the OS credential store
  (libsecret/kwallet, Keychain, DPAPI). This is at-rest protection only — it
  stops a stolen disk, a backup tool, or another account on the machine, not
  code running inside the app. Notes:
  - The value stays in `localStorage`; only its contents are ciphertext, in a
    `{"v":1,"enc":"safeStorage","data":…}` envelope (`src/lib/secureStorage.ts`).
    An empty login list is stored as literal `[]` — nothing secret in it, and
    `index.html`'s inline boot script reads this key synchronously to decide
    whether to draw the crest.
  - Migration is lazy, on first successful read. If the credential store is
    unavailable the adapter writes plaintext rather than failing the write.
  - A blob that won't decrypt (reset keyring, profile copied to another
    machine) means *locked*, not *empty*: it is copied to `armada:login-locked`
    before the signed-out UI can overwrite it, since it may be the only copy of
    the user's key.
  - On Linux, `main.js` restores `DBUS_SESSION_BUS_ADDRESS` from
    `/run/user/<uid>/bus` when the launcher stripped it. Version-manager shims
    do this — asdf's `node` shim drops it, and `npm start` runs through that
    shim — which leaves Chromium with `disabled:`, no reachable secret
    service, and a login store silently written in plaintext. Packaged builds
    exec the binary directly and were never affected, which is what makes this
    a dev-launch trap specifically.
  - On Linux with no keyring daemon, Chromium selects the `basic_text` backend
    — a hardcoded key, so obfuscation rather than encryption. The backend is
    reported in Settings → Keys so the user isn't told they have protection
    they don't.

The web client talks to the shell through a small, explicit bridge
(`window.armadaDesktop`, see `preload.js`); on the web that object is absent and
every integration no-ops.

## Development

```sh
npm run electron:dev     # from the repo root
```

`scripts/dev-electron.sh` starts the Vite dev server and launches this shell
against it (`ARMADA_DEV_URL`), so the renderer has HMR and React fast refresh
while the main process is the same `main.js` the packaged app runs — tray,
screen picker, `safeStorage`, the SQLite store all behave as they do in a
build. Ctrl-C stops both. `PORT` overrides 8080; F12 / Ctrl+Shift+I open the
inspector (the app menu is removed, so the default accelerators are gone with
it).

Two things dev mode does *not* share with an installed Armada, both deliberate:
the **profile** (`--user-data-dir` points at `electron/.dev-profile`, so a
work-in-progress build can't write the real `armada.db`; set
`ARMADA_DEV_USER_DATA` if you want the real one), and the **origin**
(`http://localhost:8080` vs `app://armada`, and localStorage — hence the login
store — is per-origin, so you log in again here).

## Local build / run

```sh
# From the repository root:
npm ci
cd electron
npm ci
npm start            # builds web + db.cjs + updateFeed.cjs, stages, then launches

# Package installers (output in release/):
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS installer + portable .exe (needs wine on Linux)
npm run dist:mac     # .dmg (must run on macOS)

# macOS .app bundles from any OS, after a dist:linux (see below):
node scripts/package-mac.mjs
```

The Electron lifecycle scripts always rebuild and stage the web client and both
`src/`-derived main-process bundles — the ArmadaDB bridge (`db.cjs`, required at
startup) and the updater's release feed (`updateFeed.cjs`). Both are gitignored
build artifacts. This prevents a current shell from being paired with a stale
renderer, silently falling back to a different storage engine, or checking for
updates through a stale copy of the release-event parser.

The app icon lives at `build/icon.png` (1024×1024, committed); electron-builder
derives `.ico`/`.icns` from it. Linux uses `build/linux-icon.png` instead — the
crest on the cut-corner tile the UI gives server icons — as both the packaged
launcher icon (`linux.icon`) and the *window* icon, because on Linux the window
icon is what a dock draws whenever it cannot match the window to an installed
`.desktop` entry.

That case is the AppImage, and `desktopIntegration.js` is the other half of the
fix: the deb and the Flatpak install an entry, an AppImage run from
`~/Downloads` has none, and a desktop environment with no entry to match falls
back to naming the app after its WM_CLASS — `buzz.armada.app` in the dock
tooltip. So the AppImage writes its own entry (and hicolor icons) into
`XDG_DATA_HOME` at launch, with the same id, `Name` and `StartupWMClass` the
packaged entries use. It only ever writes when `$APPIMAGE` is set, never
replaces an entry it did not write itself (AppImageLauncher's, or a
hand-edited one), stands down when a system-wide entry exists, and is disabled
entirely by `ARMADA_NO_DESKTOP_INTEGRATION=1`.

The tray icon is separate art — the simplified Armada A, the same shape as the
Android notification small icon — because the crest is illegible in a ~16px
panel slot. Source: `icon-src/tray.svg`, with the regeneration commands in its
comment. Only macOS masks a tray icon for you (`build/trayTemplate.png` +`@2x`,
marked as a template image); a Linux or Windows panel is handed a bitmap and
draws it as authored, so the variants are picked in `main.js`:
`build/tray-white.png` (+`@2x`) on Linux, and `build/tray-white.ico` /
`build/tray-dark.ico` on Windows, swapped on `nativeTheme` updates since the
taskbar follows the system theme. Linux deliberately does *not* follow
`nativeTheme` — that is the app's color-scheme preference, and panels are
styled independently of it.

Both the tray art and the window icon are loaded at runtime, so `build/**/*` is
listed in `electron-builder.yml`'s `files`.

Linux uses StatusNotifierItem on desktops with a watcher (including KDE and a
GNOME AppIndicator extension). Stock GNOME has no visible tray host. Armada
verifies its own registration before allowing close-to-tray; without a usable
host the close button exits instead of leaving calls running in an invisible
process. Non-GNOME X11 desktops may use Electron's legacy tray fallback.

Native notifications come from the renderer's own `new Notification()` — the
foreground notifier and the push runtime both post through the Web Notifications
API, and Electron backs it with the OS notifier (libnotify on Linux, the Action
Center on Windows, `NSUserNotification`/`UNUserNotification` on macOS). Two
platforms need an identity set before `ready` for those toasts to appear and
be attributed correctly: Linux via `app.setDesktopName("buzz.armada.app.desktop")`
(matching the installed `.desktop` entry the Flatpak's
`--talk-name=org.freedesktop.Notifications` permission also depends on), and
Windows via `app.setAppUserModelId("buzz.armada.app")` — the AUMID the NSIS
installer stamps onto the Start Menu shortcut, without which Windows silently
drops the toast or shows it as `electron.app.Electron`. Both live in `main.js`
right after the app object is created.

## Screen-share quality and codecs

The screen-share dialog controls the requested output resolution, frames per
second, maximum bitrate, codec and delivery mode. The bitrate is an encoder
ceiling rather than a promise that static content will consume every bit. The
stream-details dialog reports the measured encoded rate and input cadence; a
`missed` frame is a capture deadline for which no fresh frame arrived, not a
frame that was encoded and then lost on the network.

VP8 is the compatibility fallback. Encrypted H.264 prefers packetization mode
1 and, on Linux, can use the software compatibility path when the platform
encoder is not interoperable. Standard H.265 is exposed only when Chromium
reports an encoder for the current Windows or macOS machine, so there is no
separate FFmpeg helper to install on those systems. A receiver must also have
H.265 decoding support; older Armada builds that do not negotiate H.265 need
to be updated or should receive VP8/H.264 instead.

Chromium does not expose H.265 WebRTC encoding on Linux, so Armada has a
Linux-only E2EE pipeline: Electron captures the trusted picker selection,
FFmpeg encodes HEVC Main through VA-API, and the bundled
`armada-hevc-publisher` sends the pre-encoded track through LiveKit. The
publisher is packaged into AppImage, deb and Flatpak builds from one generated
binary; it is deliberately excluded from Windows and macOS packages. Its
auxiliary LiveKit identity is authenticated by signed Concord presence and is
folded into the presenter's tile rather than shown as another caller.

For AppImage and deb, the host must provide an FFmpeg build with
`hevc_vaapi`, an HEVC-capable VA-API driver, and access to a
`/dev/dri/renderD*` node. Capability detection runs a small real encode probe
and reports the failing driver/device instead of offering a broken choice.
The Flatpak uses its Freedesktop runtime FFmpeg/VA-API stack and grants render
device access in the manifest. Do not bundle an arbitrary static FFmpeg for
AppImage: VA-API must load the host's matching libva/libdrm driver stack.

Build the publisher with the Go version declared in
`hevc-publisher/go.mod`:

```sh
cd electron
./scripts/build-hevc-publisher.sh --arch x64
```

The script vendors dependencies in a temporary directory, applies the local
LiveKit primary-codec metadata patch, runs the Go tests, and stages a static
binary under `generated/hevc/x64/`. `npm run dist:linux` performs this step
automatically before electron-builder packages the AppImage and deb; the
Flatpak is then built from that AppImage so their publisher and renderer cannot
drift.

## Push to talk

Enable push to talk and record a physical key under Settings → Voice. The
binding is per-device. Armada registers it globally but only forwards it to
LiveKit while a call is connected; release, disconnect, binding changes and app
shutdown all fail closed to a muted microphone.

macOS requests Accessibility access for the native global hook. X11 uses that
same hook. On Wayland the desktop portal owns the authoritative assignment:
KDE's version-2 portal exposes its shortcut editor, while GNOME's version-1
portal reopens the trusted chooser by replacing the portal action. COSMIC's
current native portal does not implement Global Shortcuts, so Armada reports
it as unsupported rather than falling back to a shortcut that works only while
the app is focused.

## Update ownership

Every edition has exactly one update owner:

| Edition | Update mechanism |
| --- | --- |
| Windows NSIS installer | Armada downloads and installs from the release event |
| Windows portable / Store | Replace manually / Microsoft Store |
| Developer ID–signed macOS build | Armada consumes the signed zip from the release event |
| CI cross-built ad-hoc macOS zip | Replace manually; marked no-self-update |
| Linux AppImage | Armada replaces the running AppImage from the release event |
| Linux deb | Download and install the newer deb; in-app updater disabled |
| Linux Flatpak | Armada updates its web bundle in place; the shell and major versions update via `flatpak update` from the install's remote (pkg.soapbox.pub for the published build) |

### The feed is the release event

The updater reads the same NIP-34 kind-30622 release event `/downloads` renders
— see `docs/releases.md` — not a `latest*.yml` on a web server. The pieces:

| File | Role |
| --- | --- |
| `src/lib/desktopUpdate.ts` | queries the relays, verifies, picks this platform's artifact |
| `electron/updateFeed.cjs` | that file bundled for the main process (gitignored build artifact) |
| `electron/nostrUpdateProvider.js` | wraps it as an electron-updater `custom` provider |
| `electron/main.js` | `setFeedURL({ provider: "custom", updateProvider: … })` |

Nothing here reimplements downloading or installation — `NsisUpdater`,
`AppImageUpdater` and `MacUpdater` still do all of that. The provider answers
only "what is the latest version" and "where are its bytes".

Two consequences worth knowing before changing any of it:

- **The download URL deliberately drops the Blossom extension.**
  electron-updater names the cached file after the URL's basename when the URL
  ends in the expected extension, and otherwise after `UpdateFileInfo.url`,
  where the provider puts the real filename. A Blossom basename is a hash, and
  on Linux the cache name becomes the *installed* name — so with the extension
  left on, updating would rename the user's AppImage to `3f9ac2….AppImage`.
- **Differential download is off.** A blockmap is different bytes, so a
  different hash, at a URL the event does not name. Leaving it on would cost a
  guaranteed-404 request per check before full-downloading anyway.

This is a stronger trust boundary than the static feed it replaced. The artifact
is content-addressed and named by an event signed by a build-pinned maintainer
key (`RELEASE_AUTHORS`), so a compromised web host can no longer serve a
different binary — the previous arrangement's weakest point, and it was the half
that executes what it downloads. Signature, author and repository are all
checked before a URL is used; a relay is untrusted transport.

### The static feed is gone

No `latest*.yml` is generated (`publishAutoUpdate: false`) and nothing for the
desktop is published over SSH. The `publish:` block in `electron-builder.yml`
stays only because electron-builder packages `app-update.yml` only when one
exists, and electron-updater reads that file on every download; its `url:` is
never fetched.

**Installs from v0.56.3 and earlier cannot auto-update.** They have the old feed
URL compiled in, and it is no longer refreshed, so they report "Armada is up to
date" indefinitely. Recovery is a manual download from `/downloads`. The retired
feed files are still on the server — nothing deletes them; remove them by hand
whenever you like.

Windows executables are Authenticode signed through Azure Artifact Signing
(formerly Trusted Signing) when the release has its six `AZURE_*` secrets
(listed in `release.yml`); `scripts/sign-windows.cjs` is the
`win.signtoolOptions.sign` hook, and runs Jsign because the release runner is
Linux. Signing gives the installer and later updates one publisher identity and
builds SmartScreen reputation. With none set the build is unsigned; with only
some set it fails. Signing is not required for self-update. An installed unsigned NSIS build uses the same trust boundary as
the AppImage: HTTPS protects delivery, and electron-updater checks the
downloaded file against the `x` sha256 the release event declares, which is also
the artifact's Blossom content address.

macOS self-update does require a native macOS build signed with a Developer ID
Application certificate and a consistently signed updater zip; the Linux
cross-build is only ad-hoc signed and carries `armada-no-self-update` for that
reason.

## Flatpak

The manifest is `flatpak/buzz.armada.app.yml`. It wraps the already-built
AppImage with Electron BaseApp and grants PipeWire audio and the narrow session
bus permissions needed for screen audio, the shortcut portal and tray
registration.

Install the builder and runtimes (Debian/Ubuntu example):

```sh
sudo apt install flatpak flatpak-builder
flatpak remote-add --user --if-not-exists flathub \
  https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub \
  org.freedesktop.Platform//25.08 \
  org.freedesktop.Sdk//25.08 \
  org.electronjs.Electron2.BaseApp//25.08
```

On an immutable host, install Builder itself as a Flatpak instead:

```sh
flatpak install --user flathub org.flatpak.Builder
```

Then build the single-file bundle:

```sh
cd electron
npm run dist:linux
npm run dist:flatpak
flatpak install --user ./release/Armada-flatpak-x86_64.flatpak
```

`build.sh` also leaves an OSTree repository at `release/flatpak-repo/`
(the intermediate `flatpak build-bundle` exports from; nothing publishes it).
For a local update cycle against it:

```sh
flatpak remote-add --user --no-gpg-verify armada-local \
  "file://$PWD/release/flatpak-repo"
flatpak install --user armada-local buzz.armada.app
flatpak update --user buzz.armada.app
```

### Distribution

The published Flatpak comes from **pkg.soapbox.pub**, run by
[npkg](https://github.com/soapbox-pub/npkg). npkg watches for Armada's
kind-30622 release events (`docs/releases.md`), downloads the `.flatpak` bundle
from Blossom, verifies its bytes against the `x` sha256 the signed event
declares, imports it into its own OSTree repository, and re-signs the summary
with its own key. Users add one remote and install:

```sh
flatpak remote-add --if-not-exists soapbox \
  https://pkg.soapbox.pub/flatpak/soapbox.flatpakrepo
flatpak install soapbox buzz.armada.app
```

That is a normal remote-tracked install, so `flatpak update` upgrades the whole
app — shell, native modules and web bundle — from the soapbox remote.

The same `.flatpak` bundle is also named in the release event and rendered by
`/downloads` for a direct sideload:

```sh
flatpak install --user ./Armada-vX.Y.Z.flatpak
flatpak run buzz.armada.app
```

**Armada does not sign this bundle.** Authenticity rests on the sha256 in the
kind-30622 event, which is signed by a build-pinned maintainer key
(`RELEASE_AUTHORS`); npkg verifies that hash before re-signing under its own
key, which is the key the soapbox remote is trusted by. A direct sideload of the
raw bundle is unsigned — the trust for it is the same event hash, checked out of
band. Its Freedesktop and Electron runtimes need a configured Flathub remote;
most Flatpak installations already have one. If needed, add it first with the
`flathub` command in the builder setup above.

### Updating

Two update paths, and they do not conflict:

- **The web bundle updates in place.** Every web deploy publishes its `dist`
  as `/downloads/armada-web.tar.gz` in the signed nsite manifest. Armada reads
  the newest manifest from the pinned release key, downloads the archive from
  the Blossom servers it names, refuses it unless its sha256 matches the
  manifest, unpacks it into the app's userData and serves that, then offers a
  restart as an in-app toast (`checkForWebBundleUpdate` in `electron/main.js`,
  `electron/webBundleUpdate.js`, `DesktopUpdateToast`). It checks once at
  startup (and from the tray's "Check for Updates…"), never on a timer. Most releases touch only `src/`, so this is
  what carries them, without a `flatpak update`.
- **The shell updates through `flatpak update`.** Electron, the native modules
  and any major version bump arrive when the soapbox remote publishes a newer
  bundle and the user (or GNOME Software) runs `flatpak update`. The web bundle
  the new shell ships is content-addressed like any other, so it slots in beside
  whatever the in-place updater last fetched with no version file to reconcile.

Installs from an older, self-hosted bundle embedded a now-dead origin. If a
global `flatpak update` complains about it, disable it — this keeps the profile
under `~/.var/app/buzz.armada.app`:

```sh
flatpak remote-modify --user --disable \
  "$(flatpak info --user --show-origin buzz.armada.app)"
```

### Migrating an older system-wide installation

Releases before bundle signing created a `no-gpg-verify` origin, commonly
named `app-origin`, and some were installed system-wide. A non-root process
cannot pull unverified content into the system-wide Flatpak installation,
which produces `Can't pull from untrusted non-gpg verified remote` in
graphical updaters and system upgrade tools. The recommended layout is a
per-user installation: it avoids the privileged system helper and matches the
commands on the downloads page. Close Armada, install the current bundle
per-user, then remove the old system deployment:

```sh
flatpak install --user ./Armada-vX.Y.Z.flatpak
flatpak info --user buzz.armada.app
armada_system_origin="$(flatpak info --system --show-origin buzz.armada.app)"
sudo flatpak uninstall --system buzz.armada.app
```

Optionally launch it with `flatpak run --user buzz.armada.app` and close it
again before the uninstall. This brief overlap leaves the known-working system
deployment in place if downloading or installing the bundle fails.

Do not add `--delete-data` to the uninstall: leaving it out preserves the
profile under `~/.var/app/buzz.armada.app`. If the now-unused unsigned system
remote remains listed, remove only that captured origin:

```sh
sudo flatpak remote-delete --system "$armada_system_origin"
```

For an installation deliberately kept system-wide, install each release's
bundle with `sudo flatpak install --system` instead.

### Notes

CI builds the bundle unsigned (`flatpak/build.sh`, no GPG key) and stages it for
the release event beside the other installers; npkg re-signs on import, so there
is no release signing key to provision or rotate.

The manifest swaps only venmic's native prebuild to its
Freedesktop-25.08-compatible 6.1 build; AppImage and deb retain the
lockfile-pinned 7.x build.

## CI

`.ngit/act/workflows/release.yml`, on version tags (`vX.Y.Z`) — the `desktop`
job builds the web bundle and desktop DB bridge, then every published platform
from a single Linux container.

Nothing is served over HTTP by CI any more, and nothing is deployed over SSH.
Every installer — including the signed `.flatpak` bundle — is staged into
`.release-artifacts/`, uploaded to Blossom, and named by hash in the kind-30622
release event the `release` job publishes (`docs/releases.md`), which is what
`/downloads` reads and what the desktop app self-updates from.

| File | Built by |
|------|----------|
| `Armada-vX.Y.Z.AppImage`, `.deb` | electron-builder `--linux` |
| `Armada-vX.Y.Z.flatpak` | Flatpak Builder from that AppImage |
| `Armada-vX.Y.Z.exe` (NSIS), `-portable.exe` | electron-builder `--win`, via wine |
| `Armada-vX.Y.Z-mac-x64.zip`, `-mac-arm64.zip` | `scripts/package-mac.mjs` + rcodesign |

### macOS is cross-built

There is no macOS runner (ngit-ci executes Linux containers), and
electron-builder refuses mac targets off darwin. But that refusal is about
*signing*, not about the bundle: a `.app` is the prebuilt darwin Electron with
our `app.asar` in `Contents/Resources` and a rewritten `Info.plist`, which
`@electron/packager` assembles anywhere. `scripts/package-mac.mjs` does that,
reusing the asar electron-builder staged for Linux — so the mac bundles ship
byte-identical app code, with no second file list to drift. `uiohook-napi`
ships all supported N-API prebuilds together; the script explicitly copies its
electron-builder-generated `app.asar.unpacked` payload because prebuilt-asar
packaging does not do so automatically. Linux-only venmic is not copied.

Two Apple-only pieces are handled honestly rather than faked:

- **Signing.** An arm64 Mac won't exec a binary with *no* signature, so CI
  ad-hoc signs with [rcodesign](https://github.com/indygreg/apple-platform-rs),
  which runs off darwin. That makes the app launchable, not trusted: it is
  neither Developer ID signed nor notarized, so a first open still needs
  System Settings → Privacy & Security → Open Anyway. Real signing needs Apple
  credentials — either electron-builder on a Mac (`CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`) or rcodesign with a `.p12` plus an App Store Connect key.
- **Updates.** The ad-hoc archive is explicitly marked manual-update. A native,
  Developer ID–signed electron-builder release omits that marker and self-updates
  from the per-arch zip in the release event. This is the one platform the switch
  to the event newly enabled rather than merely moved: `latest-mac.yml` was never
  among the files CI deployed, so the static feed had nothing for macOS at all,
  while the `-mac-x64.zip` / `-mac-arm64.zip` artifacts have been in the event
  since it existed.
- **`.zip`, not `.dmg`.** A disk image needs HFS+ tooling that isn't in the
  container (Firefox cross-builds `.dmg` on Linux with `libdmg-hfsplus`, if
  that's ever wanted). Zip is a first-class macOS distribution format — it's
  what Electron's own auto-updater consumes — and an unsigned `.dmg` would buy
  nothing but the drag-to-Applications ritual.
