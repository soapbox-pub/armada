# Armada

A Discord-style chat client and relay stack for **internal infrastructure**, built
on Nostr [NIP-29 relay-based groups](https://github.com/nostr-protocol/nips/blob/master/29.md).
The client is derived from [Ditto](https://gitlab.com/soapbox-pub/ditto)'s codebase
(auth stack, NIP-42 relay pool, UI kit) and the relays-as-servers model is borrowed
from [Flotilla](https://gitea.coracle.social/coracle/flotilla).

> For production hosting (reverse proxies, single-domain routing, LiveKit
> behind an edge), see [`AGENTS.md`](AGENTS.md).

```
┌────────────┐  wss (NIP-42 AUTH)   ┌──────────────────┐  webhooks  ┌─────────┐
│   client   │ ───────────────────► │   armada relay   │ ◄───────── │ LiveKit │
│ (React 19) │  http (NIP-98 JWT)   │ (khatru/relay29) │            │   SFU   │
└────────────┘ ───────────────────► └──────────────────┘            └─────────┘
       └──────────────────── WebRTC audio ──────────────────────────────┘
```

- **Servers** = relays. The rail is pinned to your platform relays
  (`VITE_PLATFORM_RELAYS`); users can add more internal relays.
- **Channels** = NIP-29 groups (kind 39000 metadata, kind 9 chat, 9000-9009
  moderation, 9021/9022 join/leave, kind 10009 personal group list).
- **Auth** = NIP-42 relay auth (kind 22242), signed by nsec, NIP-07 extension,
  or NIP-46 bunker/nostrconnect logins.
- **App relays** = configurable general-purpose relays (Ditto-style) for
  everything that isn't channel traffic — profiles, group lists. Defaults to
  `relay.ditto.pub` + `relay.dreamith.to`; editable in Settings and at build
  time (`APP_RELAYS`). Channel events never route to app relays.
- **Voice** = NIP-29 AV spaces: the relay issues LiveKit JWTs at
  `/.well-known/nip29/livekit/<group-id>` (NIP-98 authorization) and publishes
  kind 39004 room presence from LiveKit webhooks.

## Layout

| Path      | What                                                            |
|-----------|-----------------------------------------------------------------|
| `client/` | React 19 + Vite + Tailwind + shadcn/ui + Nostrify web client    |
| `server/` | Go relay: khatru + relay29 + badger + LiveKit token endpoint    |
| `infra/`  | docker-compose for the full stack (relay + LiveKit + client)    |

## Quick start (full stack)

```sh
./start.sh
```

That's it. On first run it generates secrets into `infra/.env` (relay key,
LiveKit API secret), picks a free client port if 8080 is taken, builds the
three containers, starts them, and health-checks every endpoint.

- Client: http://localhost:8080 (or the port `start.sh` prints)
- Relay:  ws://localhost:5577 (NIP-11 at http://localhost:5577)
- LiveKit: ws://localhost:7880

`./start.sh down` stops the stack; `./start.sh clean` stops it and deletes
all data. Prefer manual control? The script is a thin wrapper around
`docker compose` in `infra/` — see `infra/.env.example` for every knob.

Sign up in the client (generates an nsec), create a channel, talk. Voice
requires a secure context for microphone access: `localhost` works out of the
box; for other internal hostnames serve the client over HTTPS (internal CA)
and set `RELAY_PUBLIC_BASE_URL` / `LIVEKIT_PUBLIC_URL` accordingly.

## Client development

```sh
cd client
npm install
npm run dev        # http://localhost:8080
npm run test       # tsc + eslint + vitest + production build
```

Configuration (build-time env):

- `VITE_PLATFORM_RELAYS` — comma-separated pinned relay URLs (default `ws://localhost:5577`)
- `VITE_APP_RELAYS` — default app relays for non-NIP-29 traffic — profiles
  (kind 0), group lists (kind 10009) — in the style of Ditto's app relays
  (default `wss://relay.ditto.pub,wss://relay.dreamith.to`); users can edit
  the list in Settings, including removing all of them for air-gapped use
- `VITE_SEARCH_RELAYS` — relays used for NIP-50 full-text search (profile /
  mention autocomplete); `search` filters route only to these (default
  `wss://relay.ditto.pub,wss://relay.dreamith.to`). User-editable in Settings;
  when empty, search falls back to the app relays
- `VITE_APP_NAME` — display name

## Server development

```sh
cd server
RELAY_PRIVKEY=$(openssl rand -hex 32) go run .
```

Env vars: see `infra/.env.example`. Without `LIVEKIT_*` set, the relay runs
chat-only and voice is hidden in the client.

### Server behavior notes

- Built on relay29 v0.5.1; **only group members can write** into a group.
  Open groups auto-admit kind 9021 join requests (unless the user was
  previously removed); closed groups require an invite code minted by an
  admin/moderator (kind 9009 — implemented in `server/invites.go`, on top of
  upstream relay29).
- Kinds `0` (profiles) and `10009` (user group lists) are accepted as
  "unmanaged" kinds so the deployment works with a single relay; writing them
  requires NIP-42 auth as the same pubkey, reading requires an `authors`
  filter (`server/unmanaged.go`).
- Kind 39004 (voice presence) is generated from LiveKit webhooks and served
  from memory; it is not persisted (`server/livekit.go`).
- Roles: `admin` (everything) and `moderator` (remove users, delete messages,
  invite). The group creator becomes `admin`.

## Security model

- The relay only trusts kind 39000-39004 events signed by its own key; the
  client filters those queries by the relay's NIP-11 pubkey.
- NIP-42 AUTH protects private-group reads and unmanaged-kind writes.
- The LiveKit token endpoint checks NIP-98 signatures (fresh timestamp, exact
  URL match) and group membership for private/closed groups before minting a
  JWT whose identity starts with the user's pubkey (per NIP-29).
- Group/channel events are only ever published to their host server. App
  relays (public by default) only see profiles and NIP-51 lists; set
  `APP_RELAYS` to internal hosts (or remove them in Settings) for a fully
  air-gapped deployment.
