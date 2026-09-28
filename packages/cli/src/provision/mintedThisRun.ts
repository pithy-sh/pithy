// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **What this process just created, for the one step that runs after it — #660.**
 *
 * `storeSecretMinter` generates a random value for every `cf-secrets-store` secret a registry declares
 * mintable, writes it into the account's Secrets Store, and lets it go. The Secrets Store is write-only
 * from the CLI: nothing reads an entry back, ever. So the moment the minter holds that value is the only
 * moment it exists anywhere this toolchain can see it.
 *
 * A prepared seed set sometimes has to *seal* something at creation time — encrypt a fixture's private
 * key under the environment's key-encryption secret, say — and it runs in this same process, a few steps
 * later, because `provisionEnvironment` migrates and seeds after the bindings are written. That is the
 * only arrangement in which the two facts coincide. Afterwards the value is unrecoverable by design.
 *
 * **This is not "the environment's secrets", and the name says so.** The seam a set reads an environment's
 * secret on is `context.secret`, and it refuses outside `dev` (#159) — deliberately, absolutely, and
 * untouched by this. What arrives here is narrower in a way that matters: it is what *this run* created,
 * a moment ago, in memory. A set asking for anything else still gets nothing.
 *
 * **In memory, this process, this run.** Nothing here is read from disk, written to disk, cached between
 * runs, or carried across environments — there is one record per run and it is garbage when the run ends.
 * A re-run creates nothing, so its record is empty, and that is the correct answer rather than a failure.
 */

/** The read side: what this run minted, by registry name. Handed to callers; carries no way to add. */
export interface MintedThisRun {
  /**
   * The value this run minted for `name`, or `undefined` when it minted none.
   *
   * **Synchronous, and that is the point.** A signature with no promise in it cannot open a file, cannot
   * reach the account, and cannot grow into either later. The only thing it can answer from is what this
   * process already has.
   */
  get(name: string): string | undefined;
  /** How many secrets this run minted. A count is the most a report may say about this, and it says it. */
  readonly size: number;
}

/** The write side, held by the minter alone. */
export interface MintedThisRunSink extends MintedThisRun {
  /** Record a value this run created, under its registry name. */
  record(name: string, value: string): void;
}

/**
 * A fresh record for one run.
 *
 * A `Map`, not an object literal, because a prepared set is adopter code asking by name: a bare index on
 * an object hands `constructor` and `toString` back members of `Object.prototype`, which is the rule
 * `devSecretReader` states `Object.hasOwn` for. A `Map` has no such chain to walk into.
 */
export function mintedThisRun(): MintedThisRunSink {
  const values = new Map<string, string>();
  return {
    record: (name, value) => void values.set(name, value),
    get: (name) => values.get(name),
    get size() {
      return values.size;
    },
  };
}

/**
 * The empty channel — what every caller that minted nothing offers, which is most of them.
 *
 * A standalone `pithy seed` mints nothing; a re-run of `pithy provision` mints nothing, because absence
 * is checked before anything is generated. Both are ordinary, so both hand a set this rather than
 * refusing, throwing, or inventing a value. The set decides what to do with an empty answer.
 */
export const NOTHING_MINTED: MintedThisRun = { get: () => undefined, size: 0 };
