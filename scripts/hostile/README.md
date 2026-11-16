# Hostile-relay comparison: Armada and Vector, side by side

Both clients, unmodified, against the same misbehaving relays, through the same
Concord scenario. Nothing is mocked: the Vector side is the vector-sdk
(`vector-driver/`, built against a local `../Vector` checkout), and the Armada side
is the web app in Chromium, driven through its own UI and read back from what it
persisted.

## The scenario (`compare.mjs`)

The shape of a real incident: an admin who can't read a set of Private Channels
toggles a member's Role, and only one other client holds the keys.

- **Owner** (always Vector) creates the Community with N Private Channels and three
  Roles, top first: `Holder` (Manage Channels), `Granter` (Manage Roles) and `Testers`.
  Every Channel lets `Holder` and `Testers` read. Then it goes offline.
- **Holder** (client under test) reads every Channel: the only party left that can
  deliver a key or rotate one.
- **Granter** (always Vector) holds no key. It toggles the member's `Testers` Role,
  every `--gap` ms, e.g. `on,off,on,off,on`.
- **Member** (client under test) is the one being toggled.

Setup runs on calm relays. From the first toggle on, the three Community relays
take a fault profile (`profiles.mjs`); a fourth, calm relay holds each client's own
account state, which Vector keeps in its local database.

Each run records, as one JSON line:

| field | meaning |
|---|---|
| `holderKeyedMs` | how long the holder took to hold every Channel after its Grant |
| `leaks` | after each `off`, Channels where the member still holds the key the holder writes under |
| `convergedHostileMs` | after the last toggle, ms until the member holds exactly what it should (every key on `on`, none on `off`), under the faults |
| `convergedHealedMs` | the same once the faults stop, when it didn't converge under them |
| `memberHolds` | Channels the member holds the holder's key for at the end |
| `rotations` | epochs each Channel moved through after setup (`offToggles` is the count a correct client needs, at most) |

## Fault profiles (`profiles.mjs`, applied by `relay.mjs`)

Each relay has its own store, so relays diverge as real ones do. Faults draw from a
seeded RNG (`--seed`).

- **hostile**:
  - one relay lies (OK without storing, 15%), refuses, withholds a quarter of every answer, caps pages at 200, duplicates, drops live events and disconnects;
  - one is slow (0.3–3 s, reordered), drops half its live events and leaves a fifth of OKs unsent;
  - one is a black hole: accepts the socket and never answers.
- **brutal**: the two that answer both lie (20–30%), withhold (30–40%), cap pages at 50–100, reorder, drop most live events and disconnect often; the third is still a black hole.

## Running it

```sh
scripts/hostile/setup.sh            # test CA, patched webpki-roots, vector-driver build
npm run dev -- --port 8181          # the Armada under test
node scripts/hostile/relay.mjs --control 7100 --relays calm --tls scripts/hostile/tls &
node scripts/hostile/compare.mjs --stack armada --set hostile --gap 30000
RUNS=2 scripts/hostile/matrix.sh vector armada   # the whole matrix, into /tmp/hostile/matrix.jsonl
```

Stacks: `vector`, `armada`, `mixed-a-holder` (Armada holder, Vector member) and
`mixed-a-member` (Vector holder, Armada member).

Vector refuses `ws://` relays and compiles its trust roots in, so the relays serve
TLS from a throwaway CA that `setup.sh` generates. That CA is added to a copy of
`webpki-roots` only for this driver's build, and Chromium runs with
`--ignore-certificate-errors`. Vector's own code is unchanged. Its bots still reach
its public `TRUSTED_RELAYS` for account traffic, but every Concord plane lives on
the Community's relays, which are these.
