# Armada

> **Canonical repository:** [gitworkshop.dev/soapbox.pub/armada](https://gitworkshop.dev/soapbox.pub/armada) — the GitLab repository is a read-only mirror.

Discord without the company. **No host required.** Your keys, your people.

Armada is an end-to-end encrypted community chat app built on
[Nostr](https://github.com/nostr-protocol/nostr) — servers, channels, threads, voice, and moderation,
everything you expect from a chat app. Nobody can read your messages, sell your
data, or shut your community down.

Communities are serverless by default, built on
[**Concord**](https://github.com/concord-protocol/concord): a serverless,
end-to-end encrypted community protocol. Spin up a community with nothing to set
up — text channels, live voice rooms, and invites, all without running a server.
Communities ride as gift-wrapped Nostr events over ordinary relays; only members
can read them.

Armada also supports [NIP-29 relay-based
groups](https://github.com/nostr-protocol/nips/blob/master/29.md) for operators
who want a **relay-backed server** that owns membership, moderation, and data —
point the client at any NIP-29 relay.

This repository is the **client** — the web app (React 19 + Vite + Tailwind +
shadcn/ui + Nostrify), the Capacitor Android project (`android/`), and the
Electron desktop shell (`electron/`). It does not depend on the backend at build
time; it talks to relays and voice brokers over runtime-configurable URLs.

## Concepts

- **Concord communities** — serverless, E2EE. All control/chat/invite/rekey
  traffic is gift-wrapped (NIP-59) over generic Nostr relays; voice uses a blind
  LiveKit token broker (CORD-07) that learns nothing about the community. The
  full protocol lives client-side under `src/concord/`. Armada's
  client-specific Concord conventions are documented in
  [CORD.md](CORD.md), the CORD analog of a project's `NIP.md`.
- **NIP-29 servers** — relays act as servers; channels are NIP-29 groups.
  Requires a relay to point at (use any external NIP-29 relay).
- **Auth** — sign in with your key: nsec, NIP-07 extension, or NIP-46
  bunker/nostrconnect. Your identity is portable across devices.
- **App relays** — configurable general-purpose relays for non-community traffic
  (profiles, lists). Defaults to `relay.ditto.pub` + `relay.dreamith.to`;
  editable in Settings and at build time (`RELAYS`).
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

### Configuration

Each setting below is read from the build's environment (or `.env.local`) and
baked into the bundle; the full list is `CONFIG_NAMES` in
`src/build/buildConfig.ts`. The older `VITE_`-prefixed spellings still work,
with a warning, when the bare name is unset.

A host can also set any of them at runtime, without a rebuild, as **browser
environment variables**: a same-origin script that runs before the bundle
defines `window.ENV`, and a string there takes precedence over the built-in
value (an empty string included, so a setting can be turned off).

```js
window.ENV = { RELAYS: "wss://relay.example.com", CONCORD_AV_SERVERS: "" };
```

The script must be external — the Content Security Policy admits no inline
script. Only the page reads `window.ENV`: the service worker and the desktop
shell's main process keep the built-in values, and so do the Open Graph tags
in `index.html`, which link-preview crawlers read without running scripts.

- `KLIPY_API_KEY` — **optional.** GIF search uses the keyless GIFverse
  provider by default. Set this to switch GIF search to KLIPY instead; leave it
  empty (the default) to keep GIFverse. KLIPY additionally sends a per-install
  `customer_id` on every request and injects sponsored results, which is why it
  is opt-in, and Armada's own builds don't set it. Set it in your build's
  environment, or in `.env.local` for local development. Like every key used by
  a browser-only API integration, it is embedded in the compiled client bundle,
  and it is recorded in the build's public `/build.json`.
  Configure any available platform restrictions in KLIPY's partner panel.
- `RELAYS` — comma-separated: the deployment's own relays, the one relay
  setting. Unset, Armada uses its public relays: `wss://relay.ditto.pub` and
  `wss://relay.dreamith.to` for account data and search, the CORD stock set
  (`wss://jskitty.com/nostr`, `wss://asia.vectorapp.io/nostr` and those two)
  for new communities and for the backup copies of a user's community and
  invite lists, and three helpers: `wss://relay.primal.net` as a write-only
  broadcast relay, public NIP-65 indexes (`wss://purplepag.es`,
  `wss://user.kindpag.es`, `wss://relay.nos.social`) to find a user's relay
  list at login, and `wss://index.ngit.dev` for git repository search. Set,
  these relays are all of it: account data, search, new communities, desktop
  releases and the backups go to them, and the helpers are off, so the client
  dials no other relay of its own accord. The stock set stays part of the
  invite-link format either way. Users can still edit each list in Settings.
- `BLOSSOM_SERVERS` — comma-separated Blossom media servers (BUD-03),
  most trusted first. The first is preferred: uploads embed its URL whenever
  it accepts the file, it is retried once if it fails for any reason other
  than refusing the file, and every other server holding the blob is listed
  as a NIP-94 `fallback`. Unset, Armada uses
  `https://blossom.ditto.pub/,https://blossom.dreamith.to/,https://blossom.primal.net/`
  with no preference (whichever answers first). User-editable in Settings, and
  can be turned off entirely with the "Use app media servers" toggle.
- `CONCORD_AV_SERVERS` — fallback Concord voice (CORD-07) token brokers
  (default `https://av.armada.buzz`).
- `BRIDGE_PORTAL_URL` — origin of a Discord bridge portal
  (`armada-discord-bridge`), e.g. `https://bridge.armada.buzz`. **Empty by
  default**, which hides every Discord affordance in the client; set it and the
  "Import a Discord server" buttons appear on the Add dialog, the welcome page,
  the Discover grid, and community settings. It is only the target of links the
  user clicks — nothing is dialed on boot and no Armada data is sent to it. The
  import itself runs on the portal, which signs the resulting community with the
  user's own Nostr key and hands back an ordinary invite link. Must be an
  `http(s)` URL; anything else is treated as unset.
- `NOSTR_PUSH2_PUBKEY` / `NOSTR_PUSH2_RELAYS` — override the
  nostr-push2 gateway that web and Home-Screen installs (Web Push) and the iOS
  app (APNs) register with for notifications while Armada is closed, and the
  comma-separated Nostr relays its encrypted RPC is carried over (relays the
  gateway itself reads). Unset, they default to the public service
  (`4c812266…e174c7` on `wss://relay.ditto.pub` and `wss://relay.dreamith.to`).
  Inside Tenna Armada uses the host's `window.napp.push` instead and needs
  neither.
- `APP_NAME` — display name.

## Packaging

- **Android** — Capacitor project in `android/`. `npx vite build && npx cap sync
  android`, then build with Gradle. CI produces a signed APK/AAB on `vX.Y.Z`
  tags.
- **Desktop** — Electron shell in `electron/`. Bundles the web build and serves
  it over a custom secure scheme. CI produces Linux/Windows/macOS installers on
  tags.
- **Web** — CI publishes the build as an nsite (`scripts/nsite-deploy.sh`).
  To host it yourself, run armada-stack, which serves that nsite alongside a
  relay, a Blossom server and a voice broker, and points the app at them
  through `window.ENV`.

## License

[AGPL-3.0](LICENSE)

### Additional permission for app store distribution

App stores make you agree to terms (device limits, DRM) that section 10 of the
AGPL forbids adding on top of it, so shipping an AGPL app through one needs an
explicit additional permission from the copyright holder:

> As an additional permission under section 7 of the GNU Affero General Public
> License version 3, Soapbox Technology LLC grants permission to convey the
> Program, and works based on it, through Apple's App Store and any other
> application distribution platform, notwithstanding the additional
> restrictions those platforms' terms of service impose on the recipient's
> exercise of the rights granted by this License.

This does not narrow the AGPL, and section 7 lets any recipient remove it from
their own copy.

