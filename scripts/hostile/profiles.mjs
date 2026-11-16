/** Fault profiles for scripts/hostile/relay.mjs, shared with the scenarios that switch them. */

export const CALM = { latency: [5, 30] };
// The fourth relay is never part of a Community: it is the account relay a client keeps
// its own state on (Armada's Community List), calm in every set, as Vector's local
// database is.
export const SETS = {
  calm: [CALM, CALM, CALM, CALM],
  // Three relays a real Community could plausibly be on during a bad hour.
  hostile: [
    { latency: [50, 900], okLie: 0.15, okFalse: 0.05, omit: 0.25, cap: 200, dup: 0.1, liveDrop: 0.3, disconnect: 0.02 },
    { latency: [300, 3000], reorder: true, okSilent: 0.2, omit: 0.1, liveDrop: 0.5, disconnect: 0.05 },
    { blackhole: true },
    CALM,
  ],
  // No relay is honest: the two that answer both lie and withhold.
  brutal: [
    { latency: [100, 2500], reorder: true, okLie: 0.3, okFalse: 0.1, omit: 0.4, cap: 50, dup: 0.2, liveDrop: 0.6, disconnect: 0.08 },
    { latency: [500, 6000], reorder: true, okLie: 0.2, okSilent: 0.3, omit: 0.3, cap: 100, liveDrop: 0.7, disconnect: 0.1 },
    { blackhole: true },
    CALM,
  ],
};
