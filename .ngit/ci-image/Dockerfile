# Armada CI image for ngit-ci's embedded act runner.
#
# The coordinator maps `ubuntu-latest` to this image via NGIT_CI_ACT_PLATFORMS.
# It holds TOOLS only: JDK 21 / Node 22 / Go toolcaches (so setup-* actions
# no-op), the Android SDK + NDK, system ruby + fastlane (Google Play publish),
# zsp (Zapstore publish), nsyte (nsite deploys), wine (Windows electron-builder
# targets), Flatpak tooling + runtimes, Swift (the iOS storage/notify suites),
# and the Rust wasm toolchain (Mini App transport).
#
# Dependency caches are NOT baked in. ~/.gradle, ~/.npm, ~/.cache/electron{,-
# builder} and the cargo registry/target dir are persistent docker volumes the
# coordinator mounts into every job (`-v` in NGIT_CI_ACT_CONTAINER_OPTIONS, see
# build.sh), so they stay warm across runs, never go stale, and a dependency
# bump never needs an image rebuild. Rebuild only when a tool pin below changes.
#
# ── IMPORTANT: act mounts a persistent volume OVER /opt/hostedtoolcache ──────
# act mounts the named docker volume `act-toolcache` at /opt/hostedtoolcache in
# every job container. The volume is seeded from the image ONLY when it is
# empty (docker's copy-on-first-mount), then persists forever — so toolcache
# content added in a NEW image build is invisible to jobs until the operator
# removes the stale volume (build.sh does this). This is exactly how the
# Google Play publish broke twice: the image gained ruby+fastlane under
# /opt/hostedtoolcache, but jobs still saw the old volume and the
# /usr/local/bin/fastlane symlink dangled ("fastlane: command not found").
# Rules that follow from this:
#   - ONLY things the setup-* actions look up (node, java, go) belong under
#     /opt/hostedtoolcache. They self-heal anyway: if the volume is stale,
#     setup-node/setup-java download into it once and it stays warm.
#   - Every tool a workflow invokes directly (fastlane, zsp, wine, sdkmanager)
#     must live OUTSIDE /opt/hostedtoolcache, on a path act always includes
#     (/usr/local/bin, /usr/bin) or reachable via env the workflow sets.
#
# ── Layout ───────────────────────────────────────────────────────────────────
# Each downloaded tool is its own stage, so BuildKit fetches them in parallel,
# a pin bump rebuilds only that stage, and a broken download fails in seconds.
# The final stage is one apt layer plus a COPY per stage, ordered largest and
# rarest-changing first.
#
# Build + push with .ngit/ci-image/build.sh (run on the coordinator host).

ARG BASE=ghcr.io/catthehacker/ubuntu:act-latest

FROM golang:1.24 AS zsp
ARG ZSP_VERSION=v0.4.12
RUN GOBIN=/out go install "github.com/zapstore/zsp@${ZSP_VERSION}"

FROM ${BASE} AS fetch
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── Toolcache entries (node, java, go — setup-* action managed) ─────────────
# Marker convention (verified on a live act job container):
#   /opt/hostedtoolcache/<tool>/<version>/x64{,.complete}
# These only matter as the SEED for the act-toolcache volume (see the header);
# at job time the volume shadows this path.
FROM fetch AS node
# Keep in step with .nvmrc.
ARG NODE_VERSION=22.23.1
RUN set -eux; \
    d="/opt/hostedtoolcache/node/${NODE_VERSION}"; mkdir -p "$d/x64"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C "$d/x64" --strip-components=1; \
    touch "$d/x64.complete"

FROM fetch AS jdk
ARG JAVA_DIR=21.0.11-10.0.LTS
ARG JAVA_RELEASE=jdk-21.0.11%2B10
RUN set -eux; \
    d="/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}"; mkdir -p "$d/x64"; \
    curl -fsSL "https://api.adoptium.net/v3/binary/version/${JAVA_RELEASE}/linux/x64/jdk/hotspot/normal/eclipse" \
      | tar -xz -C "$d/x64" --strip-components=1; \
    touch "$d/x64.complete"

FROM fetch AS go
ARG GO_VERSION=1.26.4
RUN set -eux; \
    d="/opt/hostedtoolcache/go/${GO_VERSION}"; mkdir -p "$d/x64"; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
      | tar -xz -C "$d/x64" --strip-components=1; \
    touch "$d/x64.complete"

# ── Android SDK (replaces android-actions/setup-android) ─────────────────────
# Same location setup-android uses ($HOME/.android/sdk), matching the SDK
# levels android/variables.gradle builds against (compileSdk 36). NOT under
# /opt/hostedtoolcache, so the act-toolcache volume can't shadow it. The NDK
# only strips debug symbols from prebuilt .so files; keep it in step with
# ndkVersion in android/variables.gradle. build-tools 35.0.0 is AGP 8.13's
# default, which the Capacitor plugin modules use; absent, Gradle downloads it
# on every job, and a bad download fails the release.
FROM fetch AS android
COPY --from=jdk /opt/hostedtoolcache/Java_Temurin-Hotspot_jdk /opt/hostedtoolcache/Java_Temurin-Hotspot_jdk
ARG JAVA_DIR=21.0.11-10.0.LTS
ENV JAVA_HOME="/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}/x64" \
    ANDROID_HOME=/root/.android/sdk
RUN set -eux; \
    mkdir -p "$ANDROID_HOME/cmdline-tools"; \
    curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/ct.zip; \
    unzip -q /tmp/ct.zip -d "$ANDROID_HOME/cmdline-tools"; \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; \
    rm /tmp/ct.zip; \
    sm="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"; \
    yes | "$sm" --licenses >/dev/null || true; \
    "$sm" --install "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" "platform-tools" "ndk;29.0.14206865" >/dev/null

# ── Swift toolchain (ios/ArmadaDB + ios/ArmadaNotify suites in test.yml) ─────
# The iOS engines are SwiftPM packages precisely so their suites run on Linux —
# act has no macOS runner, so this is the ONLY place they get tested. Under
# /usr/local/swift, outside /opt/hostedtoolcache (see the header).
#
# CI only runs `swift test`, so the debugger, the IDE services and Embedded
# Swift's runtimes (~0.8 GB) are dropped. Kept: the compiler, driver, SwiftPM,
# clang (the packages vendor C targets), lld and the host/linux runtimes.
#
# The platform slug has to match the base image's Ubuntu release, so it is read
# from /etc/os-release rather than pinned alongside the version.
FROM fetch AS swift
ARG SWIFT_VERSION=6.3.3
RUN set -eux; \
    . /etc/os-release; \
    slug="ubuntu${VERSION_ID//./}"; \
    mkdir -p /usr/local/swift; \
    curl -fsSL "https://download.swift.org/swift-${SWIFT_VERSION}-release/${slug}/swift-${SWIFT_VERSION}-RELEASE/swift-${SWIFT_VERSION}-RELEASE-ubuntu${VERSION_ID}.tar.gz" \
      | tar -xz -C /usr/local/swift --strip-components=1; \
    cd /usr/local/swift/usr; \
    rm -rf bin/lldb* bin/sourcekit-lsp bin/clangd bin/docc bin/swift-format bin/wasmkit \
      lib/liblldb.so* lib/libsourcekitdInProc.so lib/python3* \
      lib/swift/embedded lib/swift_static/embedded share/docc; \
    ./bin/swift --version

# ── Rust wasm toolchain (Mini App realtime transport: crates/webxdc-rt) ──────
# Built by scripts/build-wasm.mjs, which deploy-nsite/desktop/release invoke
# with WEBXDC_RT_REQUIRED=1 — a missing toolchain fails the deploy rather than
# silently shipping multiplayer off. rustup/cargo live in /root/.cargo, the
# toolchain + wasm32 std in /root/.rustup, both outside /opt/hostedtoolcache.
# There is no setup-rust in the workflows, so a stale image does NOT self-heal.
FROM fetch AS rust
ENV RUSTUP_HOME=/root/.rustup CARGO_HOME=/root/.cargo
# Keep in step with crates/webxdc-rt/rust-toolchain.toml, or every job downloads it.
ARG RUST_VERSION=1.99.1
ARG WASM_PACK_VERSION=0.13.1
# Must match wasm-bindgen in crates/webxdc-rt/Cargo.lock: scripts/build-wasm.mjs
# refuses a required build without it, rather than let wasm-pack fetch or
# compile its own (whose output differs). Same pin as scripts/reproduce/Dockerfile.
ARG WASM_BINDGEN_VERSION=0.2.127
ARG WASM_BINDGEN_SHA256=61d4a7dc85acfa0d2354ccc0b8361928c7e52a746d17f28ebaa795ed3dc1614a
RUN set -eux; \
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --target wasm32-unknown-unknown; \
    curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /root/.cargo/bin --strip-components=1 \
          "wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack"; \
    curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/wb.tgz; \
    echo "${WASM_BINDGEN_SHA256}  /tmp/wb.tgz" | sha256sum -c -; \
    tar -xz -C /root/.cargo/bin --strip-components=1 -f /tmp/wb.tgz \
      "wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl/wasm-bindgen"; \
    rm /tmp/wb.tgz

# ── nsyte binary (nsite deploys in deploy-nsite.yml) ─────────────────────────
# The release asset is ~129 MB and has repeatedly died mid-transfer with
# "SSL_read: decryption failed or bad record mac", so the workflow's own
# download is only a fallback. The workflows treat their pin as a MINIMUM and
# use this one when it is at least that version. 0.28.0 is the first release
# whose NIP-44 handles payloads over 64 KiB (large manifests through a bunker).
FROM fetch AS nsyte
ARG NSYTE_VERSION=0.28.0
RUN set -eux; \
    curl -fsSL --http1.1 --retry 5 --retry-delay 5 --retry-all-errors \
      --connect-timeout 20 --max-time 900 \
      "https://github.com/sandwichfarm/nsyte/releases/download/v${NSYTE_VERSION}/nsyte-linux-${NSYTE_VERSION}" \
      -o /out/nsyte --create-dirs; \
    chmod +x /out/nsyte

# ── Flatpak runtimes (desktop Flatpak target + Electron BaseApp) ────────────
# The SDK/runtime download is much larger than the manifest build itself. The
# desktop workflow retains a fallback install for stock act images.
FROM fetch AS flatpak
RUN set -eux; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends flatpak; \
    flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo; \
    flatpak install -y --noninteractive flathub \
      org.freedesktop.Platform//25.08 \
      org.freedesktop.Sdk//25.08 \
      org.electronjs.Electron2.BaseApp//25.08

FROM ${BASE}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# One apt layer for everything that has to come from the distro:
#   - ruby + fastlane: the DISTRO ruby, because setup-ruby's rubies are not
#     relocatable and /opt/hostedtoolcache is shadowed (see header). multi_json
#     is explicit because representable (fastlane's Play client) requires it
#     without declaring it.
#   - wine: electron-builder's Windows targets (NSIS + portable exe).
#   - flatpak, flatpak-builder, elfutils (eu-strip, which flatpak-builder
#     shells out to).
#   - Swift's runtime dependencies.
#   - clang: iroh's tls-ring pulls in `ring`, whose build script compiles C/asm
#     with clang to target wasm32 ("failed to find tool clang" without it).
RUN set -eux; \
    dpkg --add-architecture i386; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ruby-full ruby-dev \
      wine wine32:i386 wine64 \
      flatpak flatpak-builder elfutils \
      binutils libcurl4-openssl-dev libedit2 libpython3-dev libsqlite3-0 \
      libxml2-dev libz3-dev pkg-config tzdata zlib1g-dev \
      clang; \
    rm -rf /var/lib/apt/lists/*; \
    gem install fastlane multi_json --no-document; \
    gem cleanup

COPY --from=flatpak /var/lib/flatpak /var/lib/flatpak
COPY --from=swift /usr/local/swift /usr/local/swift
COPY --from=android /root/.android/sdk /root/.android/sdk
COPY --from=jdk /opt/hostedtoolcache/Java_Temurin-Hotspot_jdk /opt/hostedtoolcache/Java_Temurin-Hotspot_jdk
COPY --from=go /opt/hostedtoolcache/go /opt/hostedtoolcache/go
COPY --from=node /opt/hostedtoolcache/node /opt/hostedtoolcache/node
COPY --from=rust /root/.rustup /root/.rustup
COPY --from=rust /root/.cargo /root/.cargo
COPY --from=zsp /out/zsp /usr/local/bin/zsp
COPY --from=nsyte /out/nsyte /usr/local/bin/nsyte

# sdkmanager and gradle shell out to java; setup-java re-exports the same
# JAVA_HOME at job time. CARGO_TARGET_DIR is a fixed path so every job shares
# the one cargo target volume: iroh's dependency tree stays compiled and only
# the webxdc-rt crate itself recompiles.
ARG JAVA_DIR=21.0.11-10.0.LTS
ARG GO_VERSION=1.26.4
ENV JAVA_HOME="/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}/x64" \
    ANDROID_HOME=/root/.android/sdk \
    ANDROID_SDK_ROOT=/root/.android/sdk \
    RUSTUP_HOME=/root/.rustup \
    CARGO_HOME=/root/.cargo \
    CARGO_TARGET_DIR=/root/.cargo-target
ENV PATH="/opt/hostedtoolcache/go/${GO_VERSION}/x64/bin:$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Binstubs in /usr/local/bin, which act's step PATH always includes. Then the
# sanity check: every tool the workflows call directly, resolved outside
# /opt/hostedtoolcache.
RUN set -eux; \
    for b in swift swiftc; do ln -sf "/usr/local/swift/usr/bin/$b" /usr/local/bin/; done; \
    for b in cargo rustc rustup wasm-pack wasm-bindgen; do ln -sf "/root/.cargo/bin/$b" /usr/local/bin/; done; \
    node --version; go version; java -version; \
    ruby --version; fastlane --version; zsp --version; wine --version; \
    swift --version; flatpak-builder --version; flatpak info org.electronjs.Electron2.BaseApp >/dev/null; \
    sdkmanager --version; cargo --version; wasm-pack --version; wasm-bindgen --version; nsyte --version; \
    for t in fastlane zsp swift cargo wasm-pack wasm-bindgen nsyte; do command -v "$t" | grep -qv hostedtoolcache; done
