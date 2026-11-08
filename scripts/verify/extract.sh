#!/usr/bin/env bash
# Unpacks one desktop artifact into a directory tree, the same way for a
# published artifact and a rebuilt one, so scripts/verify-build.mjs can compare
# what they contain rather than how each container format happened to pack it
# (squashfs block order, ar and 7z member times, zip timestamps).
#
# Usage: extract.sh <artifact> <outdir>   (runs inside scripts/reproduce's desktop image)
#
#   .AppImage  the squashfs after the runtime ELF
#   .deb       control/ and data/
#   .flatpak   the OSTree commit, checked out
#   .exe       the NSIS payload, with every inner .7z unpacked into <name>.d/
#   .zip       as is
set -euo pipefail

artifact="$1"
out="$2"
mkdir -p "$out"

case "$artifact" in
  *.AppImage)
    # The squashfs starts where the runtime's ELF ends: after its section headers.
    offset=$(od -An -t u8 -j 40 -N 8 "$artifact" | tr -d ' ')
    entsize=$(od -An -t u2 -j 58 -N 2 "$artifact" | tr -d ' ')
    count=$(od -An -t u2 -j 60 -N 2 "$artifact" | tr -d ' ')
    rmdir "$out"
    unsquashfs -q -no-xattrs -o $((offset + entsize * count)) -d "$out" "$artifact" >/dev/null
    ;;
  *.deb)
    work=$(mktemp -d)
    abs=$(realpath "$artifact")
    (cd "$work" && ar x "$abs")
    mkdir -p "$out/control" "$out/data"
    cp "$work/debian-binary" "$out/"
    tar -xf "$work"/control.tar.* -C "$out/control"
    tar -xf "$work"/data.tar.* -C "$out/data" --no-same-permissions
    rm -rf "$work"
    ;;
  *.flatpak)
    repo=$(mktemp -d)
    ostree init --repo="$repo" --mode=bare-user-only
    flatpak build-import-bundle "$repo" "$artifact" >/dev/null
    rmdir "$out"
    ostree checkout --repo="$repo" -U "$(ostree --repo="$repo" refs | grep '^app/' | head -1)" "$out"
    rm -rf "$repo"
    ;;
  *.exe)
    7z x -y -bso0 -bsp0 -o"$out" "$artifact"
    while IFS= read -r -d '' inner; do
      7z x -y -bso0 -bsp0 -o"$inner.d" "$inner"
      rm "$inner"
    done < <(find "$out" -name '*.7z' -print0)
    ;;
  *.zip)
    unzip -q "$artifact" -d "$out"
    ;;
  *)
    echo "extract.sh: unknown artifact type: $artifact" >&2
    exit 1
    ;;
esac
