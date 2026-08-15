// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "../ci/sourceFiles";

/**
 * **The rule has one owner, and this is what keeps it that way.**
 *
 * `secretWriteTargets` (`@pithy-sh/secrets/src/cli/writeTargets.ts`) decides where a secret write may
 * land and refuses the two requests that are category errors — narrowing a `global` secret to one
 * environment, and widening an `environment` one to all of them. `resolveWriteTargets`
 * (`@pithy-sh/secrets/src/scope.ts`) is the backend × scope **table** underneath it. The table holds no
 * policy and refuses nothing, so a caller that reaches it directly gets routing without the rule — which
 * is exactly the state #325 found: `dispatchSecretWrite` called the table, `mintDeclaredSecrets` called
 * the table, and each was left to hold the cross-environment invariant on its own.
 *
 * A comment saying "call the rule, not the table" is not a mechanism. **The invariant is stated as a
 * property of the source tree**: among shipped modules, the only one that names the table is the rule.
 * A write path added tomorrow that reaches past it fails the build here rather than shipping a fourth
 * producer of a guarantee three of them already got wrong.
 *
 * Tests are excluded and prose is not matched — `scope.test.ts` asserts the table's routing directly,
 * which is what a table is for, and half a dozen registry docs mention it by name.
 */

/** `packages/`, from this file. The walk is the repository's own (`ci/sourceFiles.ts`), never a second one. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The one module allowed to call the table: the rule, plus the table's own definition. */
const OWNERS = [join("secrets", "src", "cli", "writeTargets.ts"), join("secrets", "src", "scope.ts")];

/** A call, not a mention. `resolveWriteTargets(` in code; `resolveWriteTargets` in a sentence is fine. */
const CALLS_THE_TABLE = /\bresolveWriteTargets\s*\(/;

/** The same, for the rule itself. Both modules discuss it in prose, so prose cannot be the evidence. */
const CALLS_THE_RULE = /\bsecretWriteTargets\s*\(/;

describe("the write-target rule has one owner", () => {
  const shipped = sourceFiles(PACKAGES);

  test("the walk found this repository, not an empty tree", () => {
    // The vacuity floor. Without it every assertion below passes on a tree the walk failed to read.
    expect(shipped.length).toBeGreaterThan(500);
    expect(shipped.some((file) => file.path.endsWith(join("secrets", "src", "cli", "writeTargets.ts")))).toBe(true);
    expect(shipped.some((file) => file.path.endsWith(join("secrets", "src", "scope.ts")))).toBe(true);
  });

  test("no shipped module reaches the routing table except the rule that owns it", () => {
    const callers = shipped
      .filter((file) => CALLS_THE_TABLE.test(file.text))
      .map((file) => relative(PACKAGES, file.path))
      .sort();

    expect(callers).toEqual([...OWNERS].sort());
  });

  test("every module that dispatches a secret write asks the rule", () => {
    // The other half. Owning the rule is worth nothing if a dispatcher can be driven without consulting
    // it, so the population is *modules that hold a `SecretDispatcher` and drive it* — by type, not by
    // call syntax — and each has to name `secretWriteTargets`. The provisioners hold one and are
    // correctly absent: they deliver through `dispatchSecretWrite`, which asks for them.
    const dispatchers = shipped
      .filter((file) => file.text.includes("SecretDispatcher") && /\.dispatch\(/.test(file.text))
      .map((file) => relative(PACKAGES, file.path))
      .sort();

    // Three today: the shared dispatch path, the minting path that owns its own delivery loop, and — since
    // #367 — the rotation path, which owns its own for the same reason and one further one. A rotation
    // decides where the value goes *before* it produces one, because a `global` secret narrowed with
    // `--env` must be refused while a credential at somebody else's issuer is still the live one.
    expect(dispatchers).toEqual(
      [
        join("cli", "src", "capabilities", "mintSecrets.ts"),
        join("cli", "src", "capabilities", "rotateSecrets.ts"),
        join("secrets", "src", "cli", "dispatch.ts"),
      ].sort(),
    );

    for (const caller of dispatchers) {
      const source = shipped.find((file) => file.path.endsWith(`${sep}${caller}`));
      // A call, not a mention. Both of these modules discuss the rule at length in prose, and a gate
      // satisfied by a doc comment is satisfied by deleting the code and keeping the comment.
      expect(source?.text ?? "", caller).toMatch(CALLS_THE_RULE);
    }
  });
});
