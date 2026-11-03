# Settings documents (NIP-78)

Armada's private, cross-device state lives in kind-30078 (NIP-78) documents.
Exactly **one** of them is signed by the account key: the **settings root**,
`d = ${APP_ID}`. Every other document is signed by its own key derived from the
secret inside that root, under an opaque `d`, so nothing on the wire links it to
the account.

| Document | Contents | Written when | Merge |
|---|---|---|---|
| `metadata` | theme, custom theme, relay toggles, `appRelays`, `communityRelays`, replaceable app DM/media endpoints, voice-server preference, DM typing indicators, DM requests, DM previews, muted words, Discover curated list, zap defaults, Account Standing nag | a preference changes | wholesale |
| `rail` | `railLayout` | every rail drag | wholesale |
| `read-state` | `readState`, the whole map | when `read-state-recent` passes 8 KB | max per key |
| `read-state-recent` | `readState`, only entries newer than `read-state`'s | every channel view (4 s debounce) | max per key |
| `notifications` | `notifLevels`, `mutedCommunities`, `mutedChannels`, account-global notification categories | a notification preference changes | wholesale |
| `dms` | `dmProtocol`, `pinnedDms`, `closedDms`, `acceptedDms`, `startedDms` | a DM is pinned, closed, accepted, opened | additive peer maps; `dmProtocol` wholesale |
| `reactions` | `frequentReactions` | every reaction (10 s debounce) | max count / most recent |
| `gif-favorites` | every GIF favorite and un-favorite | a GIF is (un)favorited (400 ms debounce) | newest operation per GIF |
| `dm-conversations/0..7` | the DM conversation index, by hash bucket | a conversation is first seen (60 s debounce) | add-only union |

The catalogue is `src/lib/settingsDocs.ts` (names in `settingsDocNames.ts`);
the schemas are in `src/lib/schemas.ts`; the AppConfig key lists are in
`src/contexts/AppContext.ts` (`METADATA_/RAIL_/NOTIF_/DM_CONFIG_KEYS`); the
read/write hook is `src/hooks/useSettingsDoc.ts`. The root is
`src/lib/settingsRoot.ts` (format) and `src/lib/settingsRootStore.ts`
(lifecycle); derivation is `src/lib/settingsKeys.ts`; the React side is
`src/hooks/useSettingsKeys.ts`.

## The settings root

`d = ${APP_ID}`, and **no other tag** — no `client`, `title` or `published_at`,
which is why it is signed directly with the user's signer rather than through
`useNostrPublish`. The one addition is the NIP-13 `nonce` every published
event gets from the signer (`src/lib/pow.ts`); its target is the device's
proof-of-work setting, which the derived documents carry too. Content is NIP-44 to self over a plaintext that is always
exactly `ROOT_PLAINTEXT_BYTES` (512):

```json
{"v":1,"root":"<64 hex>","pad":"      …"}
```

This is the one document an observer can tie to the account, so it is the one
that must resist fingerprinting: every edition, of every version, has the same
tags and the same ciphertext length, and in normal use it is written once. A
field added later takes its bytes from `pad`; `encodeSettingsRoot` refuses a
payload that would overflow, and readers keep fields they do not know.

**The root is decrypted once per edition.** `resolveSettingsKeys` keeps it in
ArmadaDB KV (`nip78root:<pubkey>`) with the event id it came from, so later boots
derive every key without asking the signer anything; a NIP-46 user is prompted
once per device, not per write. The in-memory copies are cleared in
`purgeClientStorage`; the KV copy goes with the ArmadaDB purge.

**Creating one** (`ensureSettingsKeys`) happens only when all of these hold:

- no root is held locally and none is on disk;
- the account already keeps Armada settings (a legacy document is on disk), or
  the user pressed **Sync now** (`explicit`) — the AGENTS.md rule against
  unsolicited publishes;
- an account relay answered a read for the root (EOSE) and returned none. A root
  found there is adopted instead.

It is held in KV *before* it is published, so a partial fan-out cannot make this
device mint a second one. Right after minting, `copyLegacySettingsDocs` writes
every document that exists only in legacy form under its derived key (the eager
copy), so a document nobody touches again does not stay legacy-only. Only the
minting device may do this: it alone knows no derived copy exists yet.

**Two devices minting at once** both publish, and NIP-01 keeps one. A device
whose root lost keeps it as a *previous* root (`nip78root-prev:<pubkey>`, at most
four) and reads that root's documents as one more source, so its writes fold them
into the winner's. Nothing is lost; the race costs one extra read source.

## Derived documents

```
sk(label) = HKDF-SHA256(ikm=root, salt="armada-nip78/v1", info=label [|| 0x00 || ctr])
d(label)  = hex(HMAC-SHA256(root, "d:" || label))
```

Labels are `settings/<name>`, `gif-favorites` and `dm-conversations/<bucket>`;
`settingsKeys.test.ts` pins the vectors, because changing a label or the salt
re-addresses every document. Each document has its own key, carries only
`["d", <opaque>]`, and is NIP-44 to its own pubkey. Signing and encryption are
local (`NSecSigner`), so after the root no write touches the user's signer.

Every derived key signs exactly one kind-30078 document, which is what lets the
standing REQ ask `{authors: keyring.authors, kinds: [30078]}` with no `#d`.

**There are no per-installation documents.** GIF favorites and the DM index used
to be one shard per installation, because a write cost a signer round-trip and
two devices writing one replaceable would overwrite each other. The first is
gone, and the second is handled by merging on arrival: both payloads are CRDTs,
and a device that sees an edition missing something it knows republishes the
merge (`needsPublish`, `dirtyDmConversationIndexBuckets`). A lost concurrent
write is repaired the next time the losing device sees the winner. The set of
derived authors is therefore fixed — 16 — however many devices there are.

### What this does and does not hide

It hides the link from anyone reading relays: scrapers, other clients, a relay
you only publish to. It does **not** hide it from a relay you subscribe on:
the standing REQ asks for the account's root and its derived authors together,
over one connection, after NIP-42 AUTH as the account. Sizes are not padded
beyond NIP-44's own buckets, so read-state is visibly larger than reactions.

## Migration from account-signed documents

Before the root, every document was signed by the account: `${APP_ID}/<name>`
for settings, and per-installation shards tagged `t=armada-gif-favorites` /
`t=armada-dm-conversations`. They are **read, never written**:

- A settings document is read from up to three sources: its derived document,
  the same document under a previous root, and the legacy
  `${APP_ID}/<name>` (`readSettingsDocSources`). For wholesale documents the
  newest `created_at` wins (the current root's copy breaks a tie). This build
  never writes a legacy document, so a newer legacy one can only come from an
  older build, and folding it in is correct.
- read-state and reactions fold **every** source, since their merges are
  commutative (`sources` on `UseSettingsDocReturn`).
- Legacy GIF and DM-index shards are decoded with the account signer and unioned
  into the shared documents, which then republish the union.
- Setup Sync and the NIP-65 mirror carry legacy documents to new relays only as
  exact signed bytes; one whose signature was not kept is left behind rather than
  re-signed.

Older builds keep reading the legacy documents, so they stop seeing changes made
on upgraded devices until they upgrade too. Deleting the legacy documents
(NIP-09) is left to a later release, once older builds have aged out.

## Establishing and maintaining sync

The first **Start sync** / **Sync now** action is deliberately explicit. It
refreshes the user's existing replaceable records; copies their signed NIP-29,
search, DM-relay and Blossom lists; mirrors the complete encrypted Concord
community vault (kind 33302), creator invite authority (kind 13303); and creates or refreshes the settings root
and the derived documents on every NIP-65 write relay. A relay-set change performs the same state seeding before
publishing the new kind-10002 pointer. This ordering prevents a new device from
following the pointer to an empty account relay.

Sync now is also what may create the settings root for an account that has none
(see above). These copies keep their signed ciphertext where possible. Concord is never
reduced to community IDs: the vault also carries private channel/control keys,
old epochs, relay hints, tombstones and invite references needed for recovery.
Invite records likewise contain the creator secrets needed to revoke a link.
An empty relay read is not otherwise distinguishable from a failed one, so a
write proceeds only from a confirmed, decryptable merge base. Partial delivery
stays in the exact-relay outbox and is reported rather than counted as complete.

After a metadata document exists, AppConfig edits publish automatically (800 ms
debounce, with retry after a failed delivery). Hot-path documents keep their own
debounces. The standing self-state subscription connects directly to the
account's NIP-65 write relays, independent of the "Use my own relays" general
traffic toggle, so another open client applies a new version without reload;
the cold-boot sync performs the same discovery before the UI opens.

Each installation has a device-local **Automatic settings sync** switch. Turning
it off stops that client from publishing or applying encrypted settings
automatically, including read-state and frequent-reaction updates, and skips the
settings fetch during cold boot. The GIF-favorite and DM-conversation index
documents follow the same switch. It does not travel in NIP-78 — otherwise one
client could turn every other client back on or off. **Sync now** remains an
explicit one-shot publish while the switch is off. Standard signed Nostr lists
still change when the user explicitly edits or saves those lists.

Synchronized endpoint arrays are complete replacement sets. Build-time values
seed a fresh config only. In particular, `appRelays`, `communityRelays`, and a
non-empty voice-server preference do not have public Armada addresses unioned back in after restore. Public
NIP-65 discovery indexes and CORD's versioned stock-relay dictionary are
protocol discovery/interoperability floors, not runtime account settings.
DM inbox and media servers have no synced setting of their own: they are the
kind 10050 and 10063 lists, and the build's Blossom servers are only where
uploads go while the 10063 is empty.

## Why several and not one

A kind-30078 event is **replaceable**. Everything sharing one `d` tag is
re-serialized, re-encrypted, re-signed and re-published every time any single
field changes. With one document that meant:

- **Three writers racing one coordinate.** The config publish (800 ms), the
  read-state flush (4 s) and the reaction table (10 s) each did
  read-store → merge → sign → publish against the same event. Two landing
  inside one store-read window and the later one silently reverted the earlier.
- **An unbounded map dragged along with everything else.** `readState` has an
  entry per channel, DM, thread and mention scope the user has ever opened, and
  is never pruned. Changing the theme rewrote all of it.
- **One corrupt or undecryptable document losing everything.**

The split is by **write pattern, not by topic**. The rail has its own document
because a drag rewrites it, not because it is conceptually separate. Anything
that grows without bound or is written on a hot path gets its own; bounded
preferences that change when a human clicks something stay in `metadata`.

Read-state is split once more, into the whole map and a delta. An open channel
stamps a read for every incoming message, and every other device downloads what
that publishes: the whole map was ~76 KB per message, measured as most of the
Android service's idle traffic. A read now writes only `read-state-recent`, the
entries newer than `read-state`; the base is rewritten when the delta passes
8 KB. Both merge max-per-key, so the delta is self-contained and arrival order
does not matter. A build that predates the split reads only the base, and sees
another device's reads at the next rollover.

The cost is bounded: the standing REQ is still one subscription (`NostrSync.tsx`)
— the root and legacy documents by `#d`, the derived ones by author — and the
derived documents decrypt locally.

## `APP_ID`

`src/lib/platform.ts`:

```ts
export const APP_ID: string = config("APP_ID") || "armada";
```

`d = ${APP_ID}` is the root, so a fork or a custom build owns its own root — and
with it its own derived documents — on the same identity without colliding. The
legacy `${APP_ID}/<name>` documents are named the same way, which also keeps them
out of every other NIP-78 client's way on a kind the whole ecosystem shares.

**Don't change the default** `"armada"`. It would strand every existing
install's root, and with it everything derived from it.

`APP_ID` is deliberately separate from `APP_NAME`, which is cosmetic: renaming a
deployment must not move the documents its users already read.

A fork that changes `APP_ID` must also change
`SelfState.DEFAULT_D_TAGS` in the Android service — see below.

## Rules a writer must keep

1. **Never publish before the document has been read.** `useSettingsDoc.update`
   merges its patch over `{}` when the store holds nothing, and these are
   replaceable events, so publishing then replaces the user's real document with
   whatever subset the caller passed — on every device. A caller that publishes
   on its own schedule gates on `isFetched` (read-state, reactions) or on the
   metadata document's existence (`useConfigDocSync`, for which
   `metadata === null` means "this user has no Armada settings at all"). The
   first derived write of a document merges over its resolved legacy copy.
2. **The metadata writer strips the migrated fields.** See the migration
   section — this is what makes the timestamp comparison there mean anything.
3. **`lastSync` goes on `metadata` only.** Nothing here reads it; it exists
   because older Armada builds order metadata versions by it rather than by
   `created_at`. Every split document postdates those builds.
4. **ArmadaDB is the model.** `useSettingsDoc` never reads a relay. Documents
   reach disk from the standing REQ, from the Android notification service
   writing the same SQLite file while the app is dead, and from
   `useInitialSync`'s cold-boot read. The store settles versions by NIP-01
   addressable supersession, so "the document on disk" is by construction the
   newest one this device has seen from any source — which is why a write
   re-reads the store rather than trusting the query cache.
5. **Never write a legacy document, and never write the root after it exists.**
   The migration's "newer legacy wins" rule is sound only because legacy
   documents come from older builds alone.
6. **Writes to one document are serialized, and the query cache is not allowed
   to regress.** A write spans a store read and two signer round-trips —
   seconds on a NIP-46 signer — so two edits back to back (rail drags) would
   otherwise merge over the same previous version and stamp the same
   `created_at`, and the later edit could lose the NIP-01 tie to the earlier
   one. `serializeSettingsWrite` chains them per document. The cache is the
   softer surface: a refetch (triggered by the previous version's own relay
   echo) that read the store before a write landed can resolve after the
   write's `setQueryData` and put the older version back, which
   `useConfigDocSync` would fold over the user's newest edit. Three defenses,
   each sufficient alone: the write cancels in-flight queries before
   `setQueryData`; the sync hook's apply guard stays up while a publish is in
   flight (not just while its debounce pends); and the apply effect refuses
   any event older than one it has already applied.

## The metadata-split migration window

Before the split, everything was in `armada/metadata`. The migration is **lazy**
— there is no boot-time write storm, and no publish built over a read that might
have failed. A split document appears the first time its domain is written.

Resolution while both exist (`resolveLegacy` in `settingsDocs.ts`):

- Metadata carries none of the document's fields → use the split document.
- Only metadata carries them → use those, identified by the *metadata* event
  (so an applied-once guard re-fires when the legacy source is superseded).
- Both → **whichever event is newer wins.** A device on an older build writes
  the rail into metadata because that is the only document it knows; a device on
  this build writes `armada/rail`. Both are legitimate, so this self-heals in
  either direction instead of letting one build permanently shadow the other.

That comparison is only sound because this build **strips** the migrated fields
from every metadata write (`stripMigratedKeys`). Otherwise an unrelated theme
change would bump metadata's `created_at` past the rail document's and restore a
stale rail. Their presence is therefore proof that an *older* build wrote that
document.

Convergence: once the user's last old install is upgraded, metadata stops
carrying them and `resolveLegacy` becomes an identity on the split document.

`read-state` and `reactions` skip the arbitration entirely: their merges are
commutative (max timestamp, max count), so both sources are simply hydrated and
the merge sorts it out.

`railOrder` is a second legacy spelling — the pre-folder flat list that was
written alongside `railLayout` for a while. `railLayoutOf` seeds a layout from
it when no layout exists. Nothing writes it; it is `flattenLayout(railLayout)`
and keeping it as a second stored copy only created two things that could
disagree.

## The Android service

`NotificationRelayService` subscribes to and stores these documents while the
app is dead, so a change made on another device is already on disk at next open.
It needs the account-signed tag set **before any WebView has run** (a cold boot
reads prefs and opens sockets long before the app is opened), so it carries
`SelfState.DEFAULT_D_TAGS` — the root plus the legacy documents — alongside the
`selfDTags` list the plugin config supplies.

- The derived documents need the root, which the service never sees. The WebView
  sends `selfDocs` (`nativeSelfDocs`): each derived author with its one `d`. The
  service subscribes to those authors, and `SelfState.storable` admits each only
  at that exact coordinate. Until a WebView with the root has configured it, the
  service mirrors the root and the legacy documents only.
- read-state entries carry the document's NIP-44 **conversation key**, so the
  service opens them to dismiss notifications read elsewhere without the user's
  signer. A conversation key decrypts that one document and cannot sign.
- The derived filter has its own resume cursor, keyed by the author set, so a
  newly configured set is read in full rather than from the account's cursor.
- `selfCoordinateOf` includes the author: a derived document must not share a
  newest-version floor with the user's.
- Absent config means "use the default", never "use nothing" — an empty set
  would drop the kind-30078 subscription entirely. That is also what an older
  WebView, which doesn't send the field, gets.
- The REQ builder and `SelfState.storable` must use the **same** sets, or the
  service subscribes to documents it then refuses to store.
- The background subscription runs only on the account's self-state relays.
  Joined NIP-29 servers carry conversation traffic and must never become a
  fallback destination for private settings.
- `settingsDocs.test.ts` reads `SelfState.kt` and asserts the default set
  matches the root plus `SETTINGS_DOC_NAMES`. Drift is otherwise silent, and
  shows up only as "that one setting doesn't travel between my devices".

## What is deliberately NOT here

- **Per-device state**, which never syncs: `railOpenFolders`,
  `automaticSettingsSync`,
  `collapsedChannelCategories`, `memberListVisible`, `lastChannelByServer`
  (syncing it makes two open clients yank each other's channel selection
  around), and `meshEnabled` / `meshIncognito` (they gate a Bluetooth foreground
  service and must never be flipped on remotely).
- **Lists with a canonical home**: `searchRelays` (10007), `dmRelays` (10050),
  `relayMetadata` (10002), `blossomServerMetadata` (10063). AppConfig keeps
  local mirrors; the standard events own them. The metadata schema still
  declares them because `useInitialSync` reads them **once**, to rescue a user
  whose canonical event doesn't exist yet. Nothing writes them.
- **Notification permission and delivery enablement** — browser/OS permission,
  Web Push subscriptions, native-service enablement, and foreground intent are
  device capabilities. The category choices themselves (`PushPrefs`) sync in
  `armada/notifications`; localStorage is only their background-runtime mirror.
- **Anything in the DM conversation index beyond discovery.** Each record is the
  canonical participant-set key, a latest-activity marker and whether this
  account has participated. It deliberately contains no message text, preview,
  read state, request state, ciphertext or gift-wrap id. It restores placeholder
  rows quickly while the real NIP-04/NIP-17 history catches up; existing trust,
  mute, closed-DM and request rules still decide whether a restored row is
  visible.
- **`themes`** — a per-mode override of the builtin light/dark palettes that
  this client only ever read and never wrote. Removed. The schema is loose, so a
  copy left in an older device's document passes through untouched.

## Known issue: read-state growth

`armada/read-state` grows forever. There is no pruning, and the obvious pruning
rules are worse than the growth: a dropped entry reads back as `0`, i.e. the
conversation reappears as entirely unread. Splitting it out means it no longer
bloats every other write, but the document itself still needs a real answer
eventually — most likely a cut-off tied to what the client will ever render,
rather than an age or a count.

## Adding a document

1. A name in `SETTINGS_DOC_NAMES` (`src/lib/settingsDocNames.ts`). Its derived
   key and `d` follow from the name; the Android service learns them from
   `selfDocs`.
2. A `z.looseObject` schema in `src/lib/schemas.ts`, wired into
   `SETTINGS_DOC_SCHEMAS`.
3. If it mirrors AppConfig: a key list in `src/contexts/AppContext.ts`, an entry
   in `CONFIG_KEYS_BY_DOC` (`src/lib/syncedConfig.ts`), and a
   `useConfigDocSync("<name>")` call in `NostrSync`. Otherwise, an owner module
   that calls `useSettingsDoc("<name>")` and honours rule 1 above.
4. If it takes fields out of an existing document, an entry in `MIGRATED_KEYS`.

The schema must stay **loose**. A key this build doesn't know has to survive a
read-modify-write, or a newer Armada on another device loses its settings every
time this one writes.
