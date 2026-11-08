# What you can verify, and what you have to trust

Armada is AGPL-3.0, and every build it ships is made by public workflow files
(`.ngit/act/workflows/`) from a commit in the public repository. This page says
which of those builds you can check against the source yourself, and where
you still have to take someone's word for it.

## Builds you can reproduce

Each of these builds carries a `build.json` naming the commit it was built
from, the timestamp it used (`SOURCE_DATE_EPOCH`, the commit's own time), the
deployment config (`config()` values such as `BRIDGE_PORTAL_URL`) and the
toolchain versions. The same commit, config and toolchain give byte-identical
output, and `scripts/verify-build.mjs` checks that for you:

```sh
npm ci
node scripts/verify-build.mjs                          # the live web app
node scripts/verify-build.mjs --apk Armada-v1.2.3.apk  # a release APK
```

It reads `build.json` out of the published build, fetches that commit into a
fresh shallow clone (as CI checks it out), runs CI's build steps with the
recorded inputs inside `scripts/reproduce/Dockerfile`, and compares every file.
That image pins the same Node, Rust, wasm-pack, clang, JDK and Android SDK as
the CI image, and checks every download against a hash. It needs Docker, and
the APK build downloads about 2 GB the first time. `--no-container` builds with
your own tools instead, and warns where their versions differ from the record.

- **The web app (nsite).** This is what armada.buzz, the nsite gateways and
  every desktop edition except the store ones run. Its kind-35128 manifest is
  signed by the release key and lists every file's SHA-256, `/build.json`
  included, so the signature covers the commit too. The desktop shell checks
  that signature on every launch. The verifier rebuilds the site and compares
  every file it produces. It does not check files the deploy adds afterwards,
  and lists them by name: the spellcheck dictionaries (Chromium's, fetched by
  `scripts/fetch-spell-dictionaries.sh`) and the `/downloads` archive for old
  Flatpak shells.
- **The Android APK.** This covers the APK on the NIP-82 release and Zapstore,
  and the one npkg republishes (npkg checks the APK's hash against the release
  before it re-signs its repository). Every entry is compared except the v1
  signature files: the signature is the publisher's and can't be rebuilt, and
  the v2/v3 signing block is not a zip entry. Any entry that is missing from
  the rebuild, or present only in the rebuild, fails the check.

This covers builds from the commit that introduced `build.json` onward. Earlier
releases recorded no commit, so they can't be checked this way.

## What you still have to trust

- **Google Play.** Play installs split APKs that Google generates from the
  bundle we upload and signs with its own key (Play App Signing). Those APKs
  can't be compared with anything we publish. If you want a build you can
  check, install the APK from the release, Zapstore or npkg.
- **The iOS App Store build.** It is built by hand on a Mac, as there is no
  macOS CI. Apple then re-signs it and encrypts it (FairPlay). Nobody outside
  Apple can compare the installed app with the source.
- **The desktop shell.** The Electron main process, the preload bridge, the
  desktop storage engine and the update feed (`electron/`) are packaged into
  the installers, AppImage, `.deb`, Flatpak and macOS zips, which aren't
  checked yet. The web app the shell runs is the verified nsite above,
  checked against the pinned release key on every launch.
- **Services a deployment points at.** Armada ships no server of its own. The
  client talks to Nostr relays and Blossom servers, which only ever see
  signed or encrypted events and content-addressed blobs. Anyone can run
  these optional services:
  - **The Concord voice broker** (`av.armada.buzz`, source in `armada-av`)
    issues LiveKit tokens. It learns nothing about the community. Media is
    end-to-end encrypted in the client under per-sender keys, so the LiveKit
    server relays audio it can't decrypt.
  - **The nostr-push2 gateway** (public source) forwards still-encrypted
    events to your device. Your device decrypts them.
  - **The Discord bridge portal** (`BRIDGE_PORTAL_URL`) is only the target of
    links you click.

  You can't verify which code any of these run. They are designed so that
  doesn't matter for what you say: none of them receives anything in a form
  it can read. They still see ordinary metadata, such as your IP address and
  when you connect. Every one of them can be replaced in Settings or at build
  time.

## Keeping it this way

The rules that keep the web build reproducible are in `AGENTS.md` ("Reproducible
web builds"). When a toolchain version moves, it moves in three places at once:
`.nvmrc` / `crates/webxdc-rt/rust-toolchain.toml`, `.ngit/ci-image/Dockerfile`,
and `scripts/reproduce/Dockerfile`.
