// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Maps keyed by a **secret name**, made safe to read with a plain `record[name]`.
 *
 * A secret name is not ours. A capability author picks it, an adopter types it into
 * the dev secrets file, and `constructor`, `toString` and `valueOf` are all legal ones. On an ordinary
 * object literal every one of those reads back a function from `Object.prototype`, so a secret named
 * for one is "already present" in an empty file, "declared" by every registry, and "already in
 * `.dev.vars`" in a project that has none.
 *
 * Four rounds of review on this branch each found `Object.hasOwn` missing from one more lookup than the
 * last: the loader, the merge, the seeder's two filters, the doctor's `in`. Guarding each site is the
 * discipline that failed four times. **A map with no prototype cannot have the bug**, so the fix is
 * applied where the map is built rather than where it is read — once per boundary, and it covers the
 * lookup nobody has written yet.
 */

/**
 * A copy of `record` with no prototype, so every lookup on it is an own-property lookup.
 *
 * Copy rather than `Object.setPrototypeOf`: the input is usually somebody else's object — a parsed
 * `.dev.vars`, a composed registry — and mutating its prototype from here would be action at a
 * distance. `Object.keys`, `Object.entries`, spread and `JSON.stringify` all behave identically on the
 * result; only the inherited members are gone, and nothing here ever wanted them.
 */
export function ownProperties<T>(record: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, record);
}
