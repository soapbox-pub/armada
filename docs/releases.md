# Releases: NIP-82

Armada's releases are [NIP-82](https://github.com/nostr-protocol/nips/blob/master/82.md)
software releases of the application `buzz.armada.app`: one kind-30063 release
per version, naming one kind-3063 asset per build output, with the files on
Blossom. `/downloads`, the desktop updater, Zapstore and npkg
(`pkg.soapbox.pub`) all read the same events.

Every release Armada has published is in this form. Releases from v0.56.2 on
were first published as an invented kind 30622 and later republished as
NIP-82, dated to the original release. This client reads only NIP-82, but
desktop builds up to v0.64.13 update from kind 30622 and nothing else, so CI
still publishes one per release (below) until most installs are past them.

## The events

The application (kind 32267, `d = buzz.armada.app`) carries the listing:
name, summary, description, icon, license, platforms (`f`), and an `a` tag to
the NIP-34 repository.

A release (kind 30063):

```jsonc
{
  "kind": 30063,
  "created_at": 1791789786,           // the release date
  "content": "<release notes, markdown>",
  "tags": [
    ["a", "32267:<pubkey>:buzz.armada.app", "wss://relay.ngit.dev"],
    ["i", "buzz.armada.app"],
    ["version", "0.64.13"],           // the tag without its "v"
    ["d", "buzz.armada.app@0.64.13"],
    ["c", "main"],                    // "beta" for a prerelease tag
    ["e", "<asset id>", "<relay>"],   // one per asset, in release.yaml's order
    ["f", "android-arm64-v8a"],       // the union of the assets' platforms
    ["commit", "<the tagged commit>"]
  ]
}
```

An asset (kind 3063):

```jsonc
{
  "kind": 3063,
  "content": "",
  "tags": [
    ["a", "32267:<pubkey>:buzz.armada.app", "wss://relay.ngit.dev"],
    ["i", "buzz.armada.app"],
    ["m", "application/vnd.appimage"],
    ["x", "<sha256>"],
    ["version", "0.64.13"],
    ["url", "https://blossom.ditto.pub/<sha256>"],
    ["filename", "Armada-v0.64.13.AppImage"],
    ["size", "147084818"],
    ["f", "linux-x86_64"],
    ["supported_nip", "01"],          // …one per NIP in release.yaml
    ["variant", "installer"]          // Windows only: installer / portable
  ]
}
```

The APK asset adds `min_platform_version`, `target_platform_version`,
`version_code` and `apk_certificate_hash`, which ngit reads from the APK, and
names one `f` per ABI.

`x` is the only digest, and deliberately so. The desktop app self-updates from
these events, and electron-updater's own default is sha512 — but sha256 is the
same SHA-2 family, its collision resistance is far past what a content address
for an installer needs, and with SHA-NI or the ARMv8 crypto extensions it is
roughly twice as fast. Don't publish a second hash.

Platform ids are NIP-82's (Appendix A). Treat them as advisory for display:
`/downloads` falls back to the filename, so an unknown id costs a grouping
hint rather than a download button. NIP-82 assets carry no human label, so
`artifactLabel()` derives one from the filename, platform and variant.

## Reading

```jsonc
// every release of the application, newest first
{"kinds":[30063],"authors":["<release signer>"],"#i":["buzz.armada.app"]}
// one release's assets
{"kinds":[3063],"authors":["<the release's author>"],"ids":["<its e tags>"]}
```

`authors` is never optional: `#i` alone would accept a release of
`buzz.armada.app` from anybody. The signers are `RELEASE_AUTHORS`, a
build-time setting rather than anything read from the network, because these
events hand out executables and adding a signer has to go through code review.

An asset belongs to a release because the release names its id, and only then:
`releaseArtifacts()` drops assets the release does not name or that another key
signed. Assets are fetched per release because relays cap an `ids` query
(relay.dreamith.to at about 50), and `/downloads` fetches an older release's
assets only when it is expanded.

A release is a prerelease if its channel is not `main` or its version has a
`-` suffix (`isStable()`). The version check is there because ngit defaults
the channel to `main`.

Two readers, one set of events. `/downloads` renders them
(`src/lib/releases.ts`, `useReleases.ts`); the Electron app resolves them to
the single installer the running machine can replace itself with
(`src/lib/desktopUpdate.ts`, bundled into `electron/updateFeed.cjs` and wrapped
as an electron-updater provider by `electron/nostrUpdateProvider.js`). The
parsing is shared rather than reimplemented — a second parser would be a
second contract.

The updater is the reader that executes what it fetches, over an untrusted
relay socket, so it verifies everything: the release's signature, that its
author is a pinned `RELEASE_AUTHORS` key, that `i` is this application, and
each asset's signature and id. The id check is what binds an asset's bytes to
the signed release. It asks for the assets of at most five releases, newest
first, before deciding there is nothing for this platform.

Releases are read from `RELEASE_RELAYS` (`src/lib/releases.ts`), which must
name the same set as `publication.relays` in `.ngit/release.yaml`.

## Publishing

`ngit release publish`, configured by `.ngit/release.yaml`, from the `release`
job of `.ngit/act/workflows/release.yml`. That job `needs:` every build job so
exactly one writer produces the release, and the property is load-bearing: a
release is addressable, replacement is whole-event rather than a tag union, and
Nostr has no compare-and-swap, so two jobs publishing the same `d` would
silently lose one side's assets. A tag with a `-` publishes on the `beta`
channel.

Before it, `scripts/publish-release.mjs` publishes the legacy kind-30622 event
naming the same files, for desktop builds up to v0.64.13. Its format is
whatever that script writes; nothing in this repository reads it. Delete the
script and its step once few enough installs remain on those builds.

`scripts/zapstore-compat.mjs` then re-signs the application and the APK asset
for Zapstore's current client, and sends relay.zapstore.dev alone a copy of the
release naming only the APK, since that relay refuses the desktop assets and
won't list a release it doesn't hold every asset of (see its header). It is
skipped for prereleases.
