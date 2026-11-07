# Vector conformance fixtures

`src/concord/lib/fixtures/cord25/*.json` are Communities Vector built through its
own service code on an in-memory relay: every event it published, the keys a
member holds, and the Roster and permissions Vector folded from them.
`src/concord/lib/cord25.fixtures.test.ts` checks that Armada folds the same events
to the same answer.

`writers.json` is a restricted Channel with one member let post there by an
overwrite: the writer key and certificate Vector delivered on the access plane,
and the post Vector sent with them. `cord25.writers.test.ts` collects them as
`useWriterAccess` does and builds a post as `useSendMessage` does.

`history.json` is a Private Channel with an earlier epoch and two members let in
after its rotation, one denied Read Message History there, with the events Vector
had published before its access duty ran (`events_before_duty`) and the owner's keys
then. `cord25.history.test.ts` checks Armada collects the key and the read-only
history Vector delivered, plans the duty Vector ran, and builds the same deliveries.

`writer_duty.json` is a Channel the owner restricted, a member let post there and
then not, and the Channel reopened, with the event ids at each step.
`cord25.writerDuty.test.ts` checks Armada's writer duty, judged on what Vector had
published before acting, decides what Vector did, and builds the same ledger and
deliveries.

`roster_fuzz.json` is differential: `armada_roster_fuzz.rs` builds random Control
Planes (Roles, Grants, `@everyone`, Tenures, deletions, forks, Banlists, overwrites,
syncs, unmarked and legacy editions, a switch carrying the legacy Channel list, Channel
editions squatting a Roster coordinate, uneven timestamps, and now and then a plane long
enough for deep chains), and records Vector's `fold_authority` with no
floors and over three withheld slices floored at the full fold, as a tracking reader
that stored it; the third holds some floors without their author (`anon`), always
including those a banned member authored. A fourth slice is floored at a fold made
before any Banlist landed, recording no author for a now-banned member's head
(`floor_rows`). Few seeds reach that case, so the committed file also carries the two
from the 500-case run below that do (seeds 1108 and 1167).
`roster.fuzz.test.ts` folds each slice and compares the Roster, the Banlist,
overwrites, syncs, every actor's permissions in each scope, the heads, the ban marks,
the legacy list and whether the fold was `complete`. The second withheld slice also holds
the Control fold's floors for the squatting Channel editions (`floor_rows`).
`ARMADA_FUZZ_CASES` (default 60) and `ARMADA_FUZZ_SEED_BASE` widen a local run; a
500-case run is ~20 MB, too big to commit.

`channel_fuzz.json` is the same for Channels and Categories (`armada_channel_fuzz.rs`,
`channel.fuzz.test.ts`).

To regenerate them, append `armada_fixtures.rs`, `armada_roster_fuzz.rs` and `armada_channel_fuzz.rs` to the `mod tests` block at the
end of `crates/vector-core/src/community/v2/service.rs` in a Vector checkout
(the `widescreen` branch), then:

```sh
cd crates
ARMADA_FIXTURES=/tmp/fixtures cargo test -p vector-core --lib armada_fixture
# a wider differential run, checked locally:
ARMADA_FIXTURES=/tmp/big ARMADA_FUZZ_CASES=500 ARMADA_FUZZ_SEED_BASE=1000 cargo test -p vector-core --lib armada_fixture_roster_fuzz
cp /tmp/fixtures/*.json <armada>/src/concord/lib/fixtures/cord25/
```

On NixOS, run cargo inside `nix shell nixpkgs#gcc nixpkgs#pkg-config nixpkgs#openssl nixpkgs#cmake nixpkgs#perl`.
All of them were generated from Vector `v0.5.0-5` (`800f15e8`).
