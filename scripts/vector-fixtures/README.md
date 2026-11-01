# Vector conformance fixtures

`src/concord/lib/fixtures/cord25/*.json` are Communities Vector built through its
own service code on an in-memory relay: every event it published, the keys a
member holds, and the Roster and permissions Vector folded from them.
`src/concord/lib/cord25.fixtures.test.ts` checks that Armada folds the same events
to the same answer.

To regenerate them, append `armada_fixtures.rs` to the `mod tests` block at the
end of `crates/vector-core/src/community/v2/service.rs` in a Vector checkout
(the `widescreen` branch), then:

```sh
cd crates
ARMADA_FIXTURES=/tmp/fixtures cargo test -p vector-core --lib armada_fixture
cp /tmp/fixtures/*.json <armada>/src/concord/lib/fixtures/cord25/
```

On NixOS, run cargo inside `nix shell nixpkgs#gcc nixpkgs#pkg-config nixpkgs#openssl nixpkgs#cmake nixpkgs#perl`.
The fixtures in the tree were generated from Vector commit `e87e9d1`.
