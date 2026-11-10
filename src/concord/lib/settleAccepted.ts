/**
 * Settle a fan-out of relay publishes without waiting on the slowest relay: once one
 * accepts, the others get `graceMs` to answer before this resolves. Those still out keep
 * going in the background; only one acceptance is ever required, so a dead relay costs a
 * multi-edition write its timeout once per edition for nothing. Never rejects.
 */
export function settleAccepted<T>(tasks: readonly Promise<T>[], graceMs = 1000): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const results: PromiseSettledResult<T>[] = [];
    let pending = tasks.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve([...results]);
    };
    const settle = (result: PromiseSettledResult<T>) => {
      if (done) return;
      results.push(result);
      pending--;
      if (pending === 0) finish();
      else if (result.status === "fulfilled" && timer === undefined) timer = setTimeout(finish, graceMs);
    };
    for (const task of tasks) {
      task.then(
        (value) => settle({ status: "fulfilled", value }),
        (reason: unknown) => settle({ status: "rejected", reason }),
      );
    }
  });
}
