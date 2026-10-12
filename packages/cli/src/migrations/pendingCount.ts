// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ProjectLedger } from "./run";

/**
 * **How many migrations a ledger established are pending, or `undefined` where it established nothing (#697).**
 *
 * One rule, read by every reporter that turns a ledger into a count, because five of them had written it out by
 * hand and they did not agree on the third state.
 *
 * - `read`: every database answered, so `pending` is the whole count.
 * - `partial`: `counted.pending`, the sum over the databases that answered. It can only understate how far
 *   behind the project is, so a reporter that warns or names `pithy migrate` on it never raises a false alarm.
 *   Which database went unread is `pithy doctor`'s sentence, not this number's.
 * - `unavailable`: `undefined`, never `0`. No comparison was made, and a zero would read as "up to date".
 *
 * A caller that acts only on a positive count writes `(establishedPending(ledger) ?? 0) > 0`, and says so.
 */
export function establishedPending(ledger: ProjectLedger): number | undefined {
  switch (ledger.state) {
    case "read":
      return ledger.pending;
    case "partial":
      return ledger.counted.pending;
    case "unavailable":
      return undefined;
  }
}
