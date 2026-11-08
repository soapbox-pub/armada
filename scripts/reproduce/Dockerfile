# The environment scripts/verify-build.mjs rebuilds a release in: the same
# toolchain versions as the CI image (.ngit/ci-image/Dockerfile), and nothing
# else, every download checked against a pinned hash. Two targets:
#
#   web      Node + the Rust wasm toolchain + clang: the web bundle (nsite).
#   android  web + JDK 21 + the Android SDK/NDK: the APK.
#
# Keep the versions in step with the CI image, .nvmrc and
# crates/webxdc-rt/rust-toolchain.toml; /build.json records what CI used, and
# the verifier warns when this image differs from it.

# The CI image's base (catthehacker act-latest) is Ubuntu 24.04; its apt clang
# is the one that compiles `ring` into the wasm.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852 AS web
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN set -eux; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils unzip build-essential clang; \
    rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=22.23.1
ARG NODE_SHA256=9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578
RUN set -eux; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJ -C /usr/local --strip-components=1 -f /tmp/node.tar.xz; \
    rm /tmp/node.tar.xz

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
ARG RUST_VERSION=1.99.1
ARG WASM_PACK_VERSION=0.13.1
ARG WASM_PACK_SHA256=c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539
RUN set -eux; \
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --target wasm32-unknown-unknown; \
    curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/wp.tgz; \
    echo "${WASM_PACK_SHA256}  /tmp/wp.tgz" | sha256sum -c -; \
    tar -xz -C /opt/cargo/bin --strip-components=1 -f /tmp/wp.tgz \
      "wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack"; \
    rm /tmp/wp.tgz; \
    chmod -R a+rwX /opt/cargo /opt/rustup

# The checkout is mounted here; git refuses a repository owned by another uid.
RUN git config --system --add safe.directory '*'
WORKDIR /src

FROM web AS android
ARG JDK_RELEASE=jdk-21.0.11%2B10
ARG JDK_SHA256=4b2220e232a97997b436ca6ab15cbf70171ecff52958a46159dfa5a8c44ca4de
ARG CMDLINE_TOOLS_SHA256=2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258
ENV JAVA_HOME=/opt/jdk ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=/opt/jdk/bin:$PATH
RUN set -eux; \
    curl -fsSL "https://api.adoptium.net/v3/binary/version/${JDK_RELEASE}/linux/x64/jdk/hotspot/normal/eclipse" -o /tmp/jdk.tgz; \
    echo "${JDK_SHA256}  /tmp/jdk.tgz" | sha256sum -c -; \
    mkdir -p /opt/jdk; tar -xz -C /opt/jdk --strip-components=1 -f /tmp/jdk.tgz; rm /tmp/jdk.tgz; \
    curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/ct.zip; \
    echo "${CMDLINE_TOOLS_SHA256}  /tmp/ct.zip" | sha256sum -c -; \
    mkdir -p "$ANDROID_HOME/cmdline-tools"; unzip -q /tmp/ct.zip -d "$ANDROID_HOME/cmdline-tools"; rm /tmp/ct.zip; \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; \
    sm="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"; \
    yes | "$sm" --licenses >/dev/null || true; \
    "$sm" --install "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" "platform-tools" "ndk;29.0.14206865" >/dev/null; \
    chmod -R a+rwX "$ANDROID_HOME"
