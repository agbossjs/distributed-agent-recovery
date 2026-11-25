import type { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";

/** Lets what is already started reach its next wait: real turns of the event loop, the SQLite file's included. */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Moves the test's virtual clock a second at a time until `call` settles: the workers' look at the
 * child queue (every 30 s), the parent's wait on a remote child (every second), a lease's renewal — all
 * run on it. Returns what the call returned; rethrows what it threw.
 */
export async function untilSettled<TResult>(
  call: Promise<TResult>,
  clock: VirtualClock,
  limit = seconds(300),
): Promise<TResult> {
  let isSettled = false;
  const watched = call.then(
    () => {
      isSettled = true;
    },
    () => {
      isSettled = true;
    },
  );
  for (let elapsed = 0; elapsed < Number(limit) / 1000 && !isSettled; elapsed += 1) {
    await settle();
    if (isSettled) break;
    await clock.advance(seconds(1));
  }
  await watched;
  return call;
}
