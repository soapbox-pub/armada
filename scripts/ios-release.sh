#!/usr/bin/env bash
#
# Build the iOS app from a version tag. MUST run on a Mac with Xcode — there is
# no iOS CI and there cannot be one: ngit-ci executes workflows with `act`,
# which runs Linux containers only. (The macOS *desktop* build is cross-built
# from Linux because Electron ships prebuilt darwin binaries and `rcodesign`
# can ad-hoc sign them; an iOS app has no such escape hatch.)
#
# Version, like every other target, is carried by the git tag and never by a
# committed field (see .agents/skills/release/SKILL.md):
#
#   MARKETING_VERSION      = tag minus the leading "v"        (v0.31.1 -> 0.31.1)
#   CURRENT_PROJECT_VERSION = major*1_000_000 + minor*1_000 + patch  (-> 31001)
#
# The build-number scheme is deliberately identical to the Android versionCode
# in .ngit/act/workflows/release.yml: deterministic, monotonic with semver, and
# independent of checkout depth. Monotonicity is not cosmetic here — App Store
# Connect rejects an upload whose build number does not exceed the last one.
#
# Usage:
#   scripts/ios-release.sh                 # version from the tag at HEAD
#   scripts/ios-release.sh v0.31.1         # explicit tag
#   ARCHIVE=1 scripts/ios-release.sh       # archive and export an App Store
#                                          # .ipa instead of a simulator build
#   ARCHIVE=1 UPLOAD=1 scripts/ios-release.sh   # ...and upload it to App Store
#                                               # Connect (TestFlight)
#
# The export signs manually, with the Apple Distribution identity named by
# IOS_DIST_IDENTITY (a SHA-1, so a same-named certificate elsewhere in the
# keychain search list can't be picked instead) and the App Store profiles
# named below. Run ~/bin/unlock-signing first. The archive and upload
# authenticate with the App Store Connect API key in ASC_KEY_ID /
# ASC_ISSUER_ID / ASC_KEY_PATH.

set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-$(git describe --tags --exact-match 2>/dev/null || true)}"
if [ -z "$TAG" ]; then
  echo "error: no version tag at HEAD; pass one explicitly (e.g. $0 v0.31.1)" >&2
  exit 1
fi
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "error: tag '$TAG' is not vX.Y.Z" >&2; exit 1 ;;
esac

VERSION_NAME="${TAG#v}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION_NAME"
VERSION_CODE="$(( MAJOR * 1000000 + MINOR * 1000 + PATCH ))"
echo "Building $VERSION_NAME (build $VERSION_CODE) from tag $TAG"

npm ci
# Store builds must ship Mini App multiplayer. Apple Clang can't target wasm32,
# so point the crate's C build at Homebrew LLVM when it's there.
if [ "${ARCHIVE:-}" = "1" ]; then
  export WEBXDC_RT_REQUIRED=1
  LLVM="$(brew --prefix llvm 2>/dev/null || true)"
  if [ -n "$LLVM" ] && [ -x "$LLVM/bin/clang" ]; then
    export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-$LLVM/bin/clang}"
    export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-$LLVM/bin/llvm-ar}"
  fi
fi
npm run build
npx cap sync ios

cd ios/App

# NOTE: never add CODE_SIGNING_ALLOWED=NO, not even for the simulator. Unsigned
# means no keychain-access-group entitlement, so every
# capacitor-secure-storage-plugin write fails with errSecMissingEntitlement,
# surfacing as a bare "error" — and that is where the nsec lives.
COMMON=(
  -project App.xcodeproj
  -scheme App
  MARKETING_VERSION="$VERSION_NAME"
  CURRENT_PROJECT_VERSION="$VERSION_CODE"
)

if [ "${ARCHIVE:-}" = "1" ]; then
  TEAM_ID=GZLTTH5DLM
  DIST_IDENTITY="${IOS_DIST_IDENTITY:-6362D25BB1D97984B8C54157FB85BA02514DE489}"
  APP_PROFILE="${IOS_APP_PROFILE:-Armada App Store buzz.armada.app 2026-11}"
  EXT_PROFILE="${IOS_EXT_PROFILE:-Armada App Store buzz.armada.app.NotificationService 2026-11}"
  ASC_KEY_ID="${ASC_KEY_ID:-Y9HH9P7CF6}"
  ASC_ISSUER_ID="${ASC_ISSUER_ID:-4b9a9c95-0387-442a-b2f9-139c84570228}"
  ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
  AUTH=(
    -allowProvisioningUpdates
    -authenticationKeyPath "$ASC_KEY_PATH"
    -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  )
  ARCHIVE_PATH="build/Armada-$VERSION_NAME.xcarchive"
  EXPORT_PATH="build/Armada-$VERSION_NAME-export"

  # The archive is signed for development; the export re-signs it for the
  # store with the profiles named here.
  xcodebuild "${COMMON[@]}" "${AUTH[@]}" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    archive

  export_options() {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$1</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$DIST_IDENTITY</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>buzz.armada.app</key><string>$APP_PROFILE</string>
    <key>buzz.armada.app.NotificationService</key><string>$EXT_PROFILE</string>
  </dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF
  }
  mkdir -p build
  export_options export > build/ExportOptions.plist
  export_options upload > build/UploadOptions.plist

  rm -rf "$EXPORT_PATH"
  xcodebuild -exportArchive "${AUTH[@]}" \
    -archivePath "$ARCHIVE_PATH" \
    -exportOptionsPlist build/ExportOptions.plist \
    -exportPath "$EXPORT_PATH"

  # Check the signed entitlements before anything reaches App Store Connect:
  # a store build must be on production APNs, and without the App Group the
  # extension can open neither the database nor its config.
  PAYLOAD="$(mktemp -d)"
  unzip -q "$EXPORT_PATH"/*.ipa -d "$PAYLOAD"
  APP="$PAYLOAD/Payload/App.app"
  # PlistBuddy, not plutil: plutil's keypaths split on the dots in the keys.
  check() {
    local bundle="$1" key="$2" want="$3" got
    codesign -d --entitlements - --xml "$bundle" > "$PAYLOAD/entitlements.plist" 2>/dev/null
    got="$(/usr/libexec/PlistBuddy -c "Print :$key" "$PAYLOAD/entitlements.plist" 2>/dev/null || true)"
    if [ "$got" != "$want" ]; then
      echo "error: $(basename "$bundle") $key is '$got', expected '$want'" >&2
      exit 1
    fi
  }
  check "$APP" aps-environment production
  check "$APP" com.apple.security.application-groups:0 group.buzz.armada.app
  check "$APP" get-task-allow false
  check "$APP/PlugIns/NotificationService.appex" com.apple.security.application-groups:0 group.buzz.armada.app
  rm -rf "$PAYLOAD"
  echo "Exported $(ls "$EXPORT_PATH"/*.ipa)"

  if [ "${UPLOAD:-}" = "1" ]; then
    xcodebuild -exportArchive "${AUTH[@]}" \
      -archivePath "$ARCHIVE_PATH" \
      -exportOptionsPlist build/UploadOptions.plist \
      -exportPath "build/Armada-$VERSION_NAME-upload"
    echo "Uploaded $VERSION_NAME (build $VERSION_CODE) to App Store Connect"
  fi
else
  xcodebuild "${COMMON[@]}" \
    -sdk iphonesimulator \
    -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    build
fi
