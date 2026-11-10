#!/usr/bin/env bash
#
# Deploy a directory as an nsite so that no single Blossom mirror can fail it.
#
# Usage: nsite-deploy.sh <dir> [extra `nsyte deploy` args, e.g. --name X --no-config]
#
# Environment:
#   NSYTE_BUNKER            required — the nbunksec NIP-46 session that signs
#   NSITE_CONFIG            relays/servers source, default .nsite/config.json
#   NSITE_DEPLOY_ATTEMPTS   nsyte runs before giving up, default 2
#   NSITE_DEPLOY_TIMEOUT    seconds per run, default 420
#   NSITE_LOG_DIR           where the nsyte logs go, default $RUNNER_TEMP or /tmp
#
# Every workflow step that publishes an nsite goes through here rather than
# calling `nsyte deploy` itself: nsyte runs one upload queue per server (~90 s
# of retries per file) and signs the manifest only once EVERY queue drains, so
# one server that is down — or up at the proxy and 5xx-ing behind it — runs the
# step past its deadline, no manifest is published, and the healthy servers'
# uploads sit unreferenced. The wrapper keeps the run inside its deadline with
# the servers that are actually working:
#
#   failover   Hosts are probed (scripts/live-hosts.sh, a Blossom-level HEAD,
#              5xx counts as down) and only the live ones are handed to nsyte.
#              Each run is bounded by `timeout`, and a failed run is retried
#              WITHOUT the servers its log names as failing, so a server that
#              passed the probe and then rejected or stalled uploads is dropped
#              on the retry rather than allowed to fail it again. A server that
#              stalled without the log naming it is found by asking each
#              server which of the site's blobs it holds.
#   mirroring  Every run is `--sync`: nsyte HEAD-checks every file of the site
#              on every server it was given and uploads the ones missing. That
#              is what backfills a server that was dropped, or down, during an
#              earlier deploy — without it nsyte transfers only files whose
#              hash changed since the last manifest, so a mirror that missed
#              one deploy would stay missing those blobs indefinitely.
#
# The servers nsyte is given are also the `server` tags it writes into the
# manifest (the hints gateways read), so a dropped server is not advertised
# for this deploy and is again the moment a deploy finds it healthy. That is
# also why this is one run over the live set rather than a primary pass plus
# a mirror pass: the manifest the second pass republished would name only the
# mirrors.
#
# Exit status: 0 when a manifest was published (nsyte's own rule — every file
# on at least one server and at least one relay accepted the manifest); 1 for
# nothing reachable, a zero-file scan, or every attempt failing.
set -euo pipefail

dir="${1:?usage: nsite-deploy.sh <dir> [nsyte deploy args...]}"
shift

# No apostrophe in that message: bash treats a single quote inside ${var:?word}
# as opening a quoted section even within double quotes.
: "${NSYTE_BUNKER:?NSYTE_BUNKER is not set; ask the ngit-ci operator to provision it for the #ALIAS of this repo.}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="${NSITE_CONFIG:-.nsite/config.json}"
attempts="${NSITE_DEPLOY_ATTEMPTS:-2}"
run_timeout="${NSITE_DEPLOY_TIMEOUT:-420}"
log_dir="${NSITE_LOG_DIR:-${RUNNER_TEMP:-/tmp}}"

if [ ! -d "$dir" ]; then
  echo "nsite-deploy: $dir is not a directory" >&2
  exit 1
fi
# nsyte 0.28.0 joins CWD onto the argument even when it is absolute, so an
# absolute path scans a doubled, non-existent directory and publishes nothing
# while exiting 0. Refuse rather than rely on the zero-file guard below.
case "$dir" in
  /*)
    echo "nsite-deploy: pass a workspace-relative directory, not $dir (nsyte resolves it against CWD)" >&2
    exit 1
    ;;
esac

# Same source of truth for every site this repo publishes, so deploy-nsite and
# the release workflow agree on where a site lives.
read_list() {
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((c[process.argv[2]]||[]).join(","))' "$config" "$1"
}
relays="$(read_list relays)"
servers="$(read_list servers)"
if [ -z "$relays" ] || [ -z "$servers" ]; then
  echo "nsite-deploy: $config lists no relays or no servers" >&2
  exit 1
fi

echo "Probing Blossom servers..."
live_servers="$("$here/live-hosts.sh" "$servers")"
echo "Probing relays..."
live_relays="$("$here/live-hosts.sh" "$relays")"

# No server means nothing can hold the blobs: fail now rather than after the
# timeout. Relays are different — the probe is HTTP and a relay is WebSocket,
# so an all-dropped answer is more likely a probe artefact than three dead
# relays, and nsyte reports per-relay results itself. Hand it the full list.
if [ -z "$live_servers" ]; then
  echo "nsite-deploy: no Blossom server in $config is reachable; cannot publish." >&2
  exit 1
fi
if [ -z "$live_relays" ]; then
  echo "nsite-deploy: no relay answered the probe; handing nsyte the configured list anyway." >&2
  live_relays="$relays"
fi

# Servers a failed run's log blames. nsyte's upload logger names the server on
# every retried HEAD/PUT ("HEAD preflight /x on https://s attempt 1/3 failed",
# "PUT upload /x to https://s ... timed out"), and the end-of-run summary
# names it beside a "failed" count. A healthy server produces none of these.
blamed_servers() {
  local log="$1" list="$2" out="" s
  IFS=, read -r -a arr <<<"$list"
  for s in "${arr[@]}"; do
    if grep -qE "(on|to) ${s}[^[:space:]]*.*(failed|timed out)|${s}[^[:space:]]*: [0-9]+/[0-9]+ \([0-9]+%\), [0-9]+ failed" "$log"; then
      out="${out:+$out,}$s"
    fi
  done
  printf '%s' "$out"
}

# Servers holding fewer of the site's blobs than the best one. A server can
# stall uploads without nsyte logging a single failure (blossom.dreamith.to
# behind Cloudflare: HEADs answer, PUTs hang to a 524), so when the log blames
# nobody, ask every server which of the files it now has.
lagging_servers() {
  local dir="$1" list="$2" hashes s n best=0 out=""
  hashes="$(mktemp)"
  find "$dir" -type f -print0 | xargs -0 sha256sum | cut -d' ' -f1 | sort -u >"$hashes"
  declare -A held
  IFS=, read -r -a arr <<<"$list"
  for s in "${arr[@]}"; do
    n="$(xargs -P 16 -I{} curl -s -o /dev/null -w '%{http_code}\n' --connect-timeout 5 --max-time 10 -I "${s%/}/{}" <"$hashes" | grep -c '^200$' || true)"
    held["$s"]="$n"
    echo "nsite-deploy: $s holds $n/$(wc -l <"$hashes") of the site's blobs" >&2
    [ "$n" -gt "$best" ] && best="$n"
  done
  rm -f "$hashes"
  for s in "${arr[@]}"; do
    [ "${held[$s]}" -lt "$best" ] && out="${out:+$out,}$s"
  done
  printf '%s' "$out"
}

without() {
  local list="$1" drop="$2" out="" s
  IFS=, read -r -a arr <<<"$list"
  for s in "${arr[@]}"; do
    case ",$drop," in
      *",$s,"*) ;;
      *) out="${out:+$out,}$s" ;;
    esac
  done
  printf '%s' "$out"
}

servers_now="$live_servers"
status=1
for attempt in $(seq 1 "$attempts"); do
  log="$log_dir/nsyte-deploy-$(basename "$dir")-$attempt.log"
  echo "nsyte deploy $dir (attempt $attempt/$attempts) servers=$servers_now relays=$live_relays timeout=${run_timeout}s"

  # The session goes on the command line because that is the only
  # non-interactive way in: nsyte's `--prompt-sec` is a hidden TTY prompt that
  # cannot be piped. It is visible in the runner's process list, to host root —
  # which already holds it. Job containers get their own PID namespace.
  #
  # 124 = timeout sent TERM, 137 = it had to follow up with KILL. Fails fast
  # and clean instead of climbing to OOM or losing the step's log to the
  # coordinator's run-level timeout.
  set +e
  timeout --signal=TERM --kill-after=30 "$run_timeout" \
    nsyte deploy "$dir" \
      --relays "$live_relays" \
      --servers "$servers_now" \
      --sync \
      --sec "$NSYTE_BUNKER" \
      --concurrency 2 \
      --non-interactive \
      --skip-secrets-scan \
      "$@" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  set -e

  # A scan that found ZERO files is never legitimate here — every site this
  # repo publishes has hundreds — so it means nsyte was pointed at the wrong
  # directory and published nothing while exiting 0. Not retried: it is a
  # configuration error, not a network one.
  if grep -qE "(^|[^0-9])0 files included|No files to upload after ignore rules" "$log"; then
    echo "nsite-deploy: nsyte scanned 0 files from $dir; refusing a no-op deploy." >&2
    exit 1
  fi

  if [ "$status" -eq 0 ]; then
    # nsyte exits 0 on partial success (manifest published, some blobs missing
    # on some server). Say so where a reader will look: --sync on the next
    # deploy backfills them, so this is a warning, not a failure.
    if grep -q "file(s) failed to upload, but manifest was published" "$log"; then
      echo "WARNING: some blobs are missing on at least one server; the next deploy's --sync backfills them." >&2
      grep -E "^[^ ]*https?://[^ ]*: [0-9]+/[0-9]+" "$log" >&2 || true
    fi
    exit 0
  fi

  case "$status" in
    124|137) echo "nsite-deploy: attempt $attempt exceeded ${run_timeout}s and was killed (rc=$status)." >&2 ;;
    *) echo "nsite-deploy: attempt $attempt failed (rc=$status)." >&2 ;;
  esac

  if [ "$attempt" -lt "$attempts" ]; then
    blamed="$(blamed_servers "$log" "$servers_now")"
    [ -n "$blamed" ] || blamed="$(lagging_servers "$dir" "$servers_now")"
    if [ -n "$blamed" ]; then
      narrowed="$(without "$servers_now" "$blamed")"
      if [ -n "$narrowed" ]; then
        echo "nsite-deploy: retrying without $blamed" >&2
        servers_now="$narrowed"
      else
        echo "nsite-deploy: every server was blamed; retrying with all of them" >&2
      fi
    fi
    sleep 15
  fi
done

echo "nsite-deploy: no attempt published a manifest for $dir." >&2
exit "$status"
