// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { isShippedModule, sourceFiles } from "./sourceFiles";

/**
 * **An organization is erased by its purge and by nothing else.** Every deletion, an owner's and an operator's,
 * goes through `removeOrganization` and the organization purge Workflow, whose last step is
 * `@pithy-sh/organization`'s own contribution. `deleteOrganization` is that step's batch. A second caller would
 * erase an organization with no `deleted` history row, no `onOrganizationDeleted`, and no other capability's
 * contribution run — the files, the media and the app's own work left behind.
 *
 * So the set of shipped modules that name it in code is pinned: the module that defines it and the contribution
 * that calls it. Its own tests exercise it directly and are not shipped.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The only shipped modules that may name `deleteOrganization` in code. */
const ERASERS = ["packages/organization/src/provision/provision.ts", "packages/organization/src/purge/contribution.ts"];

/** A call, or a name in an import or export list. `deleteOrganizationAsOwner` is not it. */
const REFERENCE = /\bdeleteOrganization\b(?=\s*[(,}])|\{\s*deleteOrganization\b/;

/** Every shipped module under the kit's packages and the starter that names it, comments blanked. */
function namers(): string[] {
  return ["packages", "templates"]
    .flatMap((top) => sourceFiles(join(REPO_ROOT, top), { keep: isShippedModule }))
    .filter((file) => REFERENCE.test(blankComments(file.text)))
    .map((file) => relative(REPO_ROOT, file.path))
    .sort();
}

describe("who erases an organization", () => {
  test("only the purge contribution calls deleteOrganization, beside the module that defines it", () => {
    expect(namers()).toEqual(ERASERS);
  });

  test("a call or an import counts; deleteOrganizationAsOwner does not", () => {
    expect(REFERENCE.test("await deleteOrganization(d1, id);")).toBe(true);
    expect(REFERENCE.test('import { deleteOrganization } from "./provision";')).toBe(true);
    expect(REFERENCE.test("import { createOrganization, deleteOrganization, renameOrganization }")).toBe(true);
    expect(REFERENCE.test("await deleteOrganizationAsOwner(c);")).toBe(false);
  });
});
