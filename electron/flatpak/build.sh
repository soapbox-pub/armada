#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
electron_dir=$(dirname -- "$script_dir")
repo_root=$(dirname -- "$electron_dir")
release_dir="$electron_dir/release"
manifest="$script_dir/buzz.armada.app.yml"
staged_appimage="$release_dir/Armada.AppImage"
build_dir="$release_dir/flatpak-build"
repo_dir="$release_dir/flatpak-repo"
bundle="$release_dir/Armada-flatpak-$(uname -m).flatpak"
# No --repo-url and no GPG signing: the bundle is the only artifact, and it is
# consumed by npkg (pkg.soapbox.pub), which publishes it into its OWN OSTree
# repo as a new commit signed with its OWN key — so a signature or an embedded
# origin here would be discarded. Only --runtime-repo is kept: npkg names it in
# its .flatpakref. The local repo built below is only the
# intermediate `flatpak build-bundle` exports from. The installed app's web
# app still updates in place (electron/webSite.js); its shell updates
# through `flatpak update` from whichever remote it was installed from.

builder=system
if command -v flatpak-builder >/dev/null 2>&1; then
  builder=system
elif command -v flatpak >/dev/null 2>&1 && flatpak info --user org.flatpak.Builder >/dev/null 2>&1; then
  builder=flatpak-user
elif command -v flatpak >/dev/null 2>&1 && flatpak info --system org.flatpak.Builder >/dev/null 2>&1; then
  builder=flatpak-system
else
  echo "flatpak-builder is required." >&2
  echo "Install the distro package, or: flatpak install --user flathub org.flatpak.Builder" >&2
  exit 1
fi

appimage=${1:-}
if [ -z "$appimage" ]; then
  for candidate in "$release_dir"/Armada-*-linux-*.AppImage; do
    if [ -f "$candidate" ]; then
      appimage=$candidate
    fi
  done
fi
if [ -z "$appimage" ] || [ ! -f "$appimage" ]; then
  echo "Usage: ./flatpak/build.sh path/to/Armada-*-linux-*.AppImage" >&2
  echo "Build one first with: npm run dist:linux" >&2
  exit 1
fi

mkdir -p "$release_dir"
# Always refresh the manifest's fixed source path from a versioned AppImage:
# building from the staged copy itself would silently repackage the prior web
# bundle even after electron-builder produced a newer AppImage beside it.
if [ "$(realpath -- "$appimage")" = "$(realpath -m -- "$staged_appimage")" ]; then
  echo "Refusing to build from the staging path itself: $staged_appimage" >&2
  echo "Pass the versioned electron-builder output (or no argument) so stale payloads cannot be repackaged." >&2
  exit 1
else
  install -m755 "$appimage" "$staged_appimage"
fi

# flatpak-builder keys local file sources by their manifest path, not by a
# release filename. Force the module rebuild when the staged AppImage changes;
# otherwise a fast local build can restore a cached /app/armada from a previous
# payload while still exporting a brand-new OSTree commit.
appimage_sha=$(sha256sum "$staged_appimage" | cut -d ' ' -f1)
printf '%s\n' "$appimage_sha" > "$release_dir/Armada.AppImage.sha256"

# The metainfo the manifest installs is staged here with a <release> for this
# version, so GNOME Software and `flatpak search` show it. The version comes
# from package.json, which release.yml sets from the tag; a local build at
# 0.0.0 lists no release rather than a wrong one.
version=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$electron_dir/package.json")
staged_metainfo="$release_dir/buzz.armada.app.metainfo.xml"
if [ -n "$version" ] && [ "$version" != 0.0.0 ]; then
  release_date=$(git -C "$repo_root" log -1 --format=%cs 2>/dev/null || date -u +%F)
  sed "s|^</component>|  <releases>\n    <release version=\"$version\" date=\"$release_date\"/>\n  </releases>\n</component>|" \
    "$script_dir/buzz.armada.app.metainfo.xml" > "$staged_metainfo"
else
  cp "$script_dir/buzz.armada.app.metainfo.xml" "$staged_metainfo"
fi

# Recorded in the bundle, so whoever installs it, directly or through npkg's
# .flatpakref, is pointed at the repository its runtime comes from.
runtime_repo=https://dl.flathub.org/repo/flathub.flatpakrepo

set -- --force-clean --disable-rofiles-fuse --default-branch=stable --repo="$repo_dir"
case "$builder" in
  system)
    flatpak-builder "$@" "$build_dir" "$manifest"
    flatpak build-update-repo "$repo_dir"
    flatpak build-bundle --runtime-repo="$runtime_repo" "$repo_dir" "$bundle" buzz.armada.app stable
    ;;
  flatpak-user)
    flatpak run --user --filesystem="$repo_root" --command=sh \
      --env=ARMADA_FLATPAK_BUILD_DIR="$build_dir" \
      --env=ARMADA_FLATPAK_MANIFEST="$manifest" \
      --env=ARMADA_FLATPAK_REPO_DIR="$repo_dir" \
      --env=ARMADA_FLATPAK_BUNDLE="$bundle" \
      --env=ARMADA_FLATPAK_RUNTIME_REPO="$runtime_repo" \
      org.flatpak.Builder -c '
        set -eu
        export XDG_DATA_HOME="$HOME/.local/share"
        flatpak-builder "$@" "$ARMADA_FLATPAK_BUILD_DIR" "$ARMADA_FLATPAK_MANIFEST" &
        wait "$!"
        flatpak build-update-repo "$ARMADA_FLATPAK_REPO_DIR"
        flatpak build-bundle --runtime-repo="$ARMADA_FLATPAK_RUNTIME_REPO" "$ARMADA_FLATPAK_REPO_DIR" "$ARMADA_FLATPAK_BUNDLE" buzz.armada.app stable
      ' sh "$@"
    ;;
  flatpak-system)
    flatpak run --system --filesystem="$repo_root" --command=sh \
      --env=ARMADA_FLATPAK_BUILD_DIR="$build_dir" \
      --env=ARMADA_FLATPAK_MANIFEST="$manifest" \
      --env=ARMADA_FLATPAK_REPO_DIR="$repo_dir" \
      --env=ARMADA_FLATPAK_BUNDLE="$bundle" \
      --env=ARMADA_FLATPAK_RUNTIME_REPO="$runtime_repo" \
      org.flatpak.Builder -c '
        set -eu
        export XDG_DATA_HOME="$HOME/.local/share"
        flatpak-builder "$@" "$ARMADA_FLATPAK_BUILD_DIR" "$ARMADA_FLATPAK_MANIFEST" &
        wait "$!"
        flatpak build-update-repo "$ARMADA_FLATPAK_REPO_DIR"
        flatpak build-bundle --runtime-repo="$ARMADA_FLATPAK_RUNTIME_REPO" "$ARMADA_FLATPAK_REPO_DIR" "$ARMADA_FLATPAK_BUNDLE" buzz.armada.app stable
      ' sh "$@"
    ;;
esac

echo "Flatpak bundle: $bundle"
echo "Local repository (bundle export input): $repo_dir"
