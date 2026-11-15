/**
 * One key settle at a time per Community (CORD-03 §5, Vector `change_member_roles`).
 * A role change publishes its Grant and moves the Channel keys it caused, and only
 * then may the next change or a duty's rotation begin: a rotation planned on the
 * Roster before a Grant it never saw cuts a member that Grant let back in, after
 * the Grant's key went out, which no holder may repair (CORD-03 §5).
 */

const tails = new Map<string, Promise<unknown>>();

export function withKeySettle<T>(communityIdHex: string, run: () => Promise<T>): Promise<T> {
  const prior = tails.get(communityIdHex) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(run);
  const tail = next.catch(() => undefined);
  tails.set(communityIdHex, tail);
  void tail.then(() => {
    if (tails.get(communityIdHex) === tail) tails.delete(communityIdHex);
  });
  return next;
}
