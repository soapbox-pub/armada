#!/usr/bin/env sh
# Turnkey bootstrap for the Armada stack (multi-tenant zooid relay + LiveKit +
# client).
#
#   ./start.sh            # generate secrets + default community on first run,
#                         # build, start, health-check
#   ./start.sh down       # stop the stack (data volume is kept)
#   ./start.sh clean      # stop and DELETE all data (relay DB, communities)
#
# The relay is zooid: a multi-tenant Nostr relay. This script seeds ONE default
# community at infra/config/localhost:5577.toml. Add more communities by
# dropping another <host>.toml in infra/config (hot-reloaded) or via zooid's
# management REST API.
#
# Requirements: docker with the compose plugin. Nothing else.
set -eu

cd "$(dirname "$0")/infra"

# ── helpers ───────────────────────────────────────────────────────────────────
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

randhex() {
  # 32 random bytes as hex, without depending on openssl
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

is_hex64() {
  printf '%s' "$1" | grep -qiE '^[0-9a-f]{64}$'
}

port_free() {
  if command -v ss >/dev/null 2>&1; then
    ! ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  elif command -v nc >/dev/null 2>&1; then
    ! nc -z 127.0.0.1 "$1" 2>/dev/null
  else
    return 0 # can't check; assume free
  fi
}

first_free_port() {
  p=$1
  while ! port_free "$p"; do
    p=$((p + 1))
    [ $p -gt $(($1 + 20)) ] && die "no free port found near $1"
  done
  echo "$p"
}

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose plugin is not installed"

# ── subcommands ───────────────────────────────────────────────────────────────
case "${1:-up}" in
  down)
    docker compose down
    exit 0
    ;;
  clean)
    docker compose down -v
    rm -rf config
    say "stack stopped, data volumes and community configs removed"
    exit 0
    ;;
  up) ;;
  *)
    die "usage: ./start.sh [up|down|clean]"
    ;;
esac

# ── .env bootstrap ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "no infra/.env found — generating one with fresh secrets"
  LIVEKIT_API_SECRET=$(randhex)
  LIVEKIT_API_KEY="armada$(randhex | cut -c1-12)"
  CLIENT_PORT=$(first_free_port 8080)
  [ "$CLIENT_PORT" != "8080" ] && say "port 8080 is busy; using $CLIENT_PORT for the client"
  sed \
    -e "s/^LIVEKIT_API_KEY=$/LIVEKIT_API_KEY=$LIVEKIT_API_KEY/" \
    -e "s/^LIVEKIT_API_SECRET=$/LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET/" \
    -e "s/^CLIENT_PORT=8080$/CLIENT_PORT=$CLIENT_PORT/" \
    .env.example > .env
  chmod 600 .env
  say "wrote infra/.env"
else
  say "using existing infra/.env"
fi

# Load LiveKit creds for seeding the default community TOML.
LIVEKIT_API_KEY=$(grep '^LIVEKIT_API_KEY=' .env | cut -d= -f2)
LIVEKIT_API_SECRET=$(grep '^LIVEKIT_API_SECRET=' .env | cut -d= -f2)
LIVEKIT_PUBLIC_URL=$(grep '^LIVEKIT_PUBLIC_URL=' .env | cut -d= -f2)
LIVEKIT_PUBLIC_URL=${LIVEKIT_PUBLIC_URL:-ws://localhost:7880}
CLIENT_PORT=$(grep '^CLIENT_PORT=' .env | cut -d= -f2)
CLIENT_PORT=${CLIENT_PORT:-8080}

# ── default community bootstrap ────────────────────────────────────────────────
# zooid serves one community per host. Seed the localhost community as a TOML
# config. The file name is irrelevant to routing; the `host` field must match
# the Host header the client sends (here: localhost:5577).
mkdir -p config
COMMUNITY_FILE="config/localhost:5577.toml"
if [ ! -f "$COMMUNITY_FILE" ]; then
  # The owner pubkey identifies who owns the community; it can't be
  # auto-generated. zooid stores it as hex in the TOML, so require 64-char hex
  # (convert an npub with any nostr tool first). Allow OWNER_PUBKEY preset for
  # non-interactive installs.
  OWNER_PUBKEY=${OWNER_PUBKEY:-${ADMIN_PUBKEY:-}}
  while ! is_hex64 "$OWNER_PUBKEY"; do
    if [ ! -t 0 ]; then
      die "OWNER_PUBKEY is required (64-char hex). Set it in the environment or run interactively."
    fi
    printf 'Community owner pubkey (64-char hex): '
    read -r OWNER_PUBKEY
    is_hex64 "$OWNER_PUBKEY" || say "that is not 64-char hex; if you have an npub, convert it first"
  done

  RELAY_PRIVKEY=$(randhex)
  cat > "$COMMUNITY_FILE" <<EOF
# Default Armada community (localhost quickstart). One community per host.
# host MUST match the Host header the client sends (including port).
host = "localhost:5577"
schema = "armada"
secret = "$RELAY_PRIVKEY"

[info]
name = "Armada"
pubkey = "$OWNER_PUBKEY"
description = "Internal NIP-29 community relay"

[policy]
public_join = true

[groups]
enabled = true

[management]
enabled = true

[push]
enabled = false

[blossom]
enabled = false

[roles.member]
can_invite = true

[roles.admin]
pubkeys = ["$OWNER_PUBKEY"]
can_manage = true

[livekit]
server_url = "$LIVEKIT_PUBLIC_URL"
api_key = "$LIVEKIT_API_KEY"
api_secret = "$LIVEKIT_API_SECRET"
EOF
  chmod 600 "$COMMUNITY_FILE"
  say "seeded default community at infra/$COMMUNITY_FILE (RELAY_PRIVKEY is its identity — keep it safe)"
else
  say "using existing community config infra/$COMMUNITY_FILE"
fi

# ── build & start ─────────────────────────────────────────────────────────────
say "building and starting the stack (first build takes a few minutes)"
docker compose up -d --build

# ── health checks ─────────────────────────────────────────────────────────────
wait_for() {
  label=$1; url=$2; expect=$3
  i=0
  while [ $i -lt 30 ]; do
    # Send a Host header so zooid routes to the localhost community.
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' -H 'Host: localhost:5577' "$url" 2>/dev/null || true)
    if [ "$code" = "$expect" ]; then
      say "$label is up ($url)"
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  printf '\033[1;33mwarn:\033[0m %s did not respond at %s (last status: %s)\n' "$label" "$url" "${code:-none}"
  return 1
}

ok=0
wait_for "relay (NIP-11)"      "http://localhost:5577"                          200 || ok=1
wait_for "relay (NIP-29 AV)"   "http://localhost:5577/.well-known/nip29/livekit" 204 || ok=1
wait_for "livekit"             "http://localhost:7880"                          200 || ok=1
wait_for "client"              "http://localhost:$CLIENT_PORT"                  200 || ok=1

echo
if [ $ok -eq 0 ]; then
  say "Armada is running"
else
  say "Armada started, but some health checks failed — see: docker compose -f infra/docker-compose.yml logs"
fi
cat <<EOF

  client    http://localhost:$CLIENT_PORT
  relay     ws://localhost:5577   (NIP-11: http://localhost:5577)
  livekit   ws://localhost:7880

  First steps:
    1. Open http://localhost:$CLIENT_PORT and click "Sign up" (generates a key).
    2. Join the Armada community (public_join is on for the default community).
    3. Click "Join voice" in any channel to test audio (localhost is a
       secure context, so the mic prompt works out of the box).

  Add another community: drop infra/config/<host>.toml (hot-reloaded) or use
  zooid's management API (set RELAY_API_HOST / RELAY_API_WHITELIST in .env).

  Serving beyond localhost? Give each community its own host TOML, set
  PLATFORM_RELAYS to those hosts, put your TLS/edge in front (see AGENTS.md),
  and run ./start.sh again.
EOF
