// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { freshenBoundSession } from "./dispatch";

/** How often a long-running command checks its session. Cheap: no call unless the token is near expiry. */
export const KEEP_FRESH_INTERVAL_MS = 60_000;

/** What {@link keepBoundSessionFresh} takes. Every field defaults to the real process. */
export interface KeepFreshOptions {
  cwd?: string;
  intervalMs?: number;
  freshen?: (options: { cwd?: string }) => Promise<unknown>;
}

/**
 * **Keep the session bound here fresh for as long as a command runs past the hour (#759).**
 *
 * Dispatch renews once, before a command body runs; `pithy dev` runs all afternoon. So it checks every
 * minute, and renews within the margin — the same locked, re-reading renewal dispatch uses, so a `deploy`
 * in another terminal and this timer never spend one rotation twice. Each check costs a file read unless
 * the token is about to expire. Unref'd: it never holds the process open. `stop` ends it.
 */
export function keepBoundSessionFresh(options: KeepFreshOptions = {}): { stop: () => void } {
  const freshen = options.freshen ?? freshenBoundSession;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void freshen({ cwd: options.cwd }).finally(() => {
      running = false;
    });
  }, options.intervalMs ?? KEEP_FRESH_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
