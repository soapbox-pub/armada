#!/usr/bin/env bash
# Fetch the Hunspell dictionaries the desktop app's spellchecker downloads
# (SPELL_DICTIONARY_URL in electron/main.js) into <dir>, for the site deploy.
#
# Chromium requests each file as <lang><version>.bdic LOWERCASED (en-us-10-1.bdic),
# so that is the name written here. The version is fixed per
# Chromium release (components/spellcheck/common/spellcheck_common.cc), so this
# list must be re-pinned when an Electron bump changes Chromium's spellcheck
# versions, or those languages silently lose spellcheck. Pinned to the
# hunspell_dictionaries revision Chromium 150 (Electron 43) builds from; its
# per-language sources and licences are in that repository.
set -euo pipefail

out="${1:?usage: $0 <dir>}"
rev=cccf64a8acc951afe3f47fee023908e55699bc58
base="https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/${rev}"

# The copies the last deploy published (SPELL_DICTIONARY_URL): a googlesource
# outage must not fail the whole deploy, and the pinned hashes vouch for either.
published="https://armada.buzz/dictionaries"

mkdir -p "$out"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
verified() { echo "$1  $tmp" | sha256sum -c --quiet - 2>/dev/null; }
while read -r name sum; do
  file="${out}/${name,,}"
  if { curl -fsSL --retry 3 "${base}/${name}?format=TEXT" | base64 -d > "$tmp"; } 2>/dev/null && verified "$sum"; then
    mv "$tmp" "$file"
  elif curl -fsSL --retry 3 "${published}/${name,,}" -o "$tmp" 2>/dev/null && verified "$sum"; then
    echo "warning: ${name} from ${published} (googlesource unavailable)" >&2
    mv "$tmp" "$file"
  else
    # Skipped rather than fatal: the desktop app keeps a downloaded dictionary,
    # so this costs only installs that ask for this language before the next deploy.
    echo "warning: ${name} unavailable from either source; not deployed" >&2
  fi
done <<'LIST'
en-US-10-1.bdic a075b01d9b015c616511a9e87da77da3d9881621db32f584e4606ddabf1c1100
en-GB-10-1.bdic eaed4a709abdbd2f14aa143f25fe9c4c1b44591c7cb1942f75f968fb2fcd3cf8
en-AU-10-1.bdic 9e045c63b05e5435cd2045c8db9e2e15239a896d3363298fcbba2a3890d74eb1
en-CA-10-1.bdic 0820d1fbc03198ef2933d3a6aed58a21dca5bb901af2c1db02346a496d4b7bdc
de-DE-3-0.bdic 076a470700dbd0aa62bb8b3d24c34e1340bdfe83cbbcfc035ce972f23c140400
es-ES-3-0.bdic e6334dcf080aaeca679db70565762a2c296ff5780c1af263530ac7345736bfa9
fr-FR-3-0.bdic 6cffc13b549c33d44180a3a7b13943fe0eadfbe80bcdbccc76f67c55c2012968
it-IT-3-0.bdic 8b83a0d4bba4cfcd4a4e7ee89b703014a00a5c08e721e568a5c552a732827fff
nl-NL-3-0.bdic 43eea1bd8149c1a24f4388ade6a261a981ca2e786e7df12e606295a8024b150e
pt-BR-3-0.bdic 6b2850f5a54994a5204a9a88d4b586e9d4e028a0360b67352b04cffdb2a3e0ea
LIST
