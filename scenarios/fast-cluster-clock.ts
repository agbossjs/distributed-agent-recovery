import { Clock } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";

/**
 * Real system clock for multi-instance and multi-process scenarios that shortens
 * the 30s background worker sweep (`SWEEP_EVERY = 30_000`) and 1s parent poll
 * (`RECHECK_EVERY = 1_000`) to 150ms so child task claims and lease takeovers
 * happen sub-second without affecting 30s lease validity (`confirmedUntil`).
 */
export class FastClusterClock extends Clock {
  override now(): Date {
    return new Date();
  }

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    const effectiveDelay =
      Number(delay) === 30_000 || Number(delay) === 1_000
        ? 150
        : Number(delay);

    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, effectiveDelay);
      if (Number(delay) >= 10_000) {
        timer.unref();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
