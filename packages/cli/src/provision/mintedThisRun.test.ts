// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { mintedThisRun, NOTHING_MINTED } from "./mintedThisRun";

/**
 * **The channel a prepared set reads a just-minted secret on — #660.**
 *
 * `storeSecretMinter` creates a random value for each `cf-secrets-store` secret a registry declares
 * mintable, writes it into the account's Secrets Store, and discards it. The Secrets Store is write-only
 * from the CLI, so that is the only moment the value exists anywhere the CLI can see — and a fixture that
 * has to *seal* something at creation time needs it exactly then. This is the in-memory record that
 * carries it from the minter to the seed step of the same process, and no further.
 */
describe("what this run minted", () => {
  test("answers what it was given, by registry name", () => {
    const minted = mintedThisRun();
    minted.record("connection-key", "value-a");
    expect(minted.get("connection-key")).toBe("value-a");
  });

  test("a name this run did not mint is `undefined`, never a guess", () => {
    const minted = mintedThisRun();
    minted.record("connection-key", "value-a");
    expect(minted.get("session-secret")).toBeUndefined();
  });

  /**
   * A prepared set is adopter code asking by name. `Object.hasOwn` is the rule `devSecretReader` follows
   * for the same reason: a bare index would hand `constructor` or `toString` back something that is not a
   * secret at all. A `Map` has no prototype chain to walk into, which is why this is one.
   */
  test("a prototype member is not a secret", () => {
    const minted = mintedThisRun();
    expect(minted.get("constructor")).toBeUndefined();
    expect(minted.get("toString")).toBeUndefined();
    expect(minted.get("__proto__")).toBeUndefined();
  });

  test("the count is a count — what a report may say about this, and all of it", () => {
    const minted = mintedThisRun();
    expect(minted.size).toBe(0);
    minted.record("a", "value-a");
    minted.record("b", "value-b");
    expect(minted.size).toBe(2);
  });

  /**
   * **The empty channel is the ordinary case, not an error.** A re-run mints nothing, because every entry
   * is already in the store and absence is checked first. So is a standalone `pithy seed`, which mints
   * nothing at all. Both hand a set this, and the set decides what to do about it.
   */
  test("the empty channel answers `undefined` and throws nothing", () => {
    expect(NOTHING_MINTED.get("connection-key")).toBeUndefined();
    expect(NOTHING_MINTED.size).toBe(0);
  });

  /**
   * The record itself is the minter's, and it is never what a prepared set holds: a set is handed a bare
   * lookup function on its context, closed over this, with no way back to `record`. `seed/run.test.ts`
   * holds that end of it, where the context is actually built.
   */
  test("the record is a lookup and a count, and nothing else a set could reach", () => {
    expect(Object.keys(mintedThisRun()).sort()).toEqual(["get", "record", "size"]);
  });
});
