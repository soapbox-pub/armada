# Armada

Discord without the company. **No host required.** Your keys, your people.

Armada is an end-to-end encrypted community chat app built on
[Nostr](https://nostr.com) — servers, channels, threads, voice, and moderation,
everything you expect from a chat app. Nobody can read your messages, sell your
data, or shut your community down.

Communities are serverless by default, built on
[**Concord**](https://github.com/concord-protocol/concord): a serverless,
end-to-end encrypted community protocol. Spin up a community with nothing to set
up and nobody in the middle — text channels, live voice rooms, and invites, all
without running a server. Communities ride as gift-wrapped Nostr events over
ordinary relays; only members can read them.

Armada also supports [NIP-29 relay-based
groups](https://github.com/nostr-protocol/nips/blob/master/29.md) for operators
who want to **self-host a server** and own membership, moderation, and data. The
optional self-hostable backend (NIP-29 relay + LiveKit voice + Concord AV
broker) lives in a separate repo,
[`armada-relay`](https://gitlab.com/soapbox-pub/armada-relay).

This repository is the **client** — the web app (React 19 + Vite + Tailwind +
shadcn/ui + Nostrify), the Capacitor Android project (`android/`), and the
Electron desktop shell (`electron/`). It does not depend on the backend at build
time; it talks to relays and voice brokers over runtime-configurable URLs.

## Concepts

- **Concord communities** — serverless, E2EE. All control/chat/invite/rekey
  traffic is gift-wrapped (NIP-59) over generic Nostr relays; voice uses a blind
  LiveKit token broker (CORD-07) that learns nothing about the community. The
  full protocol lives client-side under `src/concord-v2/`. Armada's
  client-specific Concord conventions are documented in
  [CORD.md](CORD.md), the CORD analog of a project's `NIP.md`.
- **NIP-29 servers** — relays act as servers; channels are NIP-29 groups.
  Requires a relay to point at (self-host via `armada-relay`, or use any
  external NIP-29 relay).
- **Auth** — sign in with your key: nsec, NIP-07 extension, or NIP-46
  bunker/nostrconnect. Your identity is portable across devices.
- **App relays** — configurable general-purpose relays for non-community traffic
  (profiles, lists). Defaults to `relay.ditto.pub` + `relay.dreamith.to`;
  editable in Settings and at build time (`VITE_APP_RELAYS`).
- **Voice** — WebRTC audio via LiveKit, E2E-encrypted client-side under
  per-sender keys.

## Development

```sh
npm install
npm run dev        # http://localhost:8080
npm run test       # tsc + eslint + vitest + production build
```

Voice requires a secure context for microphone access: `localhost` works out of
the box; other hostnames need HTTPS.

### Configuration (build-time env)

- `VITE_PLATFORM_RELAYS` — comma-separated pinned relay URLs. **Empty by
  default** (and in the shipped APK/desktop builds): a fresh client starts with
  no baked-in servers and the user adds their own. Never pin `ws://localhost`
  here — it's meaningless on a phone.
- `VITE_APP_RELAYS` — default app relays for non-community traffic — profiles
  (kind 0), group lists (kind 10009) — in the style of Ditto's app relays
  (default `wss://relay.ditto.pub,wss://relay.dreamith.to`); users can edit the
  list in Settings, including removing all of them for air-gapped use.
- `VITE_SEARCH_RELAYS` — relays used for NIP-50 full-text search (profile /
  mention autocomplete); `search` filters route only to these (default
  `wss://relay.ditto.pub,wss://relay.dreamith.to`). User-editable in Settings;
  when empty, search falls back to the app relays.
- `VITE_APP_BLOSSOM_SERVERS` — comma-separated default Blossom media servers
  (BUD-03) uploads fall back to, in the style of `VITE_APP_RELAYS` (default
  `https://blossom.ditto.pub/,https://blossom.dreamith.to/,https://blossom.primal.net/`).
  User-editable in Settings, and can be turned off entirely with the "Use app
  media servers" toggle.
- `VITE_CONCORD_AV_SERVERS` — fallback Concord voice (CORD-07) token brokers
  (default `https://armada.buzz`).
- `VITE_APP_NAME` — display name.

## Packaging

- **Android** — Capacitor project in `android/`. `npx vite build && npx cap sync
  android`, then build with Gradle. CI produces a signed APK/AAB on `vX.Y.Z`
  tags.
- **Desktop** — Electron shell in `electron/`. Bundles the web build and serves
  it over a custom secure scheme. CI produces Linux/Windows/macOS installers on
  tags.
- **Web** — `Dockerfile` (nginx-served static build) + `nginx.conf`.

## Self-hosting a backend

To run your own NIP-29 relay, LiveKit SFU, and Concord AV broker, see the
[`armada-relay`](https://gitlab.com/soapbox-pub/armada-relay) repo. Its
`docker-compose.yml` can optionally build this client from a sibling checkout.

## License

[AGPL-3.0](LICENSE)
