// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as manual from "./manual";

/**
 * The gate #305 asked for: a build failure when a **new unchecked producer** of a held entitlement appears.
 *
 * The defect this closes is the shape four defect classes in this kit have each had three or more producers
 * of — the unresolvable dependency range, the `.dev.vars` file mode, the symlink escape, publishing ignored
 * files. Every one because a rule lived at a *call site* instead of at the thing being called. The catalog
 * check lived in `POST /payments/entitlements/grant`; the function that writes the row had none and was
 * exported. This was that shape caught on the first producer.
 *
 * So a test that listed today's callers would be the same mistake in a test file. Both gates below state the
 * **invariant** and derive the answer from the tree, which is why a producer added next year fails them
 * without anybody remembering this issue.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

/**
 * Every non-test source file in this package, as `{ path, text }`, `path` relative to `src/`.
 *
 * `readdirSync`'s own `recursive` rather than a traversal written here: `packages/cli/src/ci/sourceFiles.ts`
 * is this repository's one walk and refuses the next private copy of itself, but it lives in `@pithy-sh/cli`
 * and a capability package taking a dev dependency on the CLI to read its own `src/` would invert the
 * dependency graph to reach a directory listing. The platform's recursion is the honest third answer: no
 * self-call to get wrong, and it does not descend a symlinked directory either. The question here is one
 * package's own source, which is a still tree — none of the scaffolds and second checkouts that walk exists
 * to tolerate can appear under it.
 */
function sources(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return { path: relative(SRC, absolute).split(sep).join("/"), text: readFileSync(absolute, "utf8") };
    });
}

describe("every module that writes the entitlements table", () => {
  /**
   * A write, in Kysely's vocabulary. A `selectFrom` is a read and irrelevant here — the invariant is about
   * rows that come into existence, not rows that are looked at.
   */
  const WRITES = /\.(insertInto|updateTable|replaceInto)\(PAYMENTS_ENTITLEMENTS_TABLE\)/;

  /**
   * A module is **checked** if it consults the grantable set, and **derived** if it writes the hold off. One
   * or the other is what makes the row legitimate: either a human named a key the project defines, or a
   * purchase produced it. Neither is a name — both are properties of the file, so a new file gets asked the
   * same question.
   */
  const CHECKED = /grantableEntitlements/;
  const DERIVED = /manual:\s*(?:0|false)\b/;

  function writers(): { path: string; text: string }[] {
    return sources().filter((file) => WRITES.test(file.text));
  }

  test("is reading real sources, not an empty tree", () => {
    // Anti-vacuous. A walk that matched nothing would make the assertion below pass for the wrong reason.
    expect(sources().length).toBeGreaterThan(20);
    expect(writers().length).toBeGreaterThan(0);
  });

  test("either consults the grantable set or writes the hold off", () => {
    const unaccounted = writers()
      .filter((file) => !CHECKED.test(file.text) && !DERIVED.test(file.text))
      .map((file) => file.path);
    expect(
      unaccounted,
      `These modules write \`pithy_payments_entitlements\` and neither consult \`grantableEntitlements\` nor write \`manual: 0\`. A row they create is a comp nothing checked and no purchase supports — the exact write #300's catalog check was added to refuse, reached by a path that does not pass through it:\n${unaccounted.map((path) => `  src/${path}`).join("\n")}`,
    ).toEqual([]);
  });
});

describe("the manual entitlement module's own surface", () => {
  test("exports nothing that sets the hold without the catalog", () => {
    // `writeEntitlement` takes `active: boolean` and asks nothing. It is the unchecked primitive, and it is
    // unexported on purpose — exporting it, from here or through `src/index.ts`, hands a caller the row write
    // with the rule removed. The list is this module's whole runtime surface, not a roster of known callers:
    // a new export has to be added here, which is where somebody is asked whether it takes a config.
    expect(Object.keys(manual).sort()).toEqual(["grantEntitlement", "revokeEntitlement"]);
  });

  test("the grant takes a config and the revoke does not", () => {
    // The asymmetry in the signatures, which is where it belongs: a grant cannot be called without the thing
    // that decides whether the key means anything, and a revoke cannot be accidentally symmetrized into
    // needing one. `(d1, config, input, options?)` against `(d1, input, options?)` — arity counts the
    // parameters before the first default.
    expect(manual.grantEntitlement.length).toBe(3);
    expect(manual.revokeEntitlement.length).toBe(2);
  });
});
