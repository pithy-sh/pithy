// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "../ci/sourceFiles";
import { KIT_ROOT } from "../test-utils/kitRoot";

/**
 * One answer to *what may be stored as an image* — enforced, not asserted in a comment.
 *
 * `@pithy-sh/auth` holds a person's face and `@pithy-sh/organization` holds an account's mark. They are
 * the same object at different scales, and two answers to that question is one of them being wrong: a
 * type added to one allowlist and not the other is a value one package renders and the other refuses,
 * found by a customer rather than by a build. So the rule lives once, in
 * `@pithy-sh/core/src/image/storedImage`, and this fails the build when a second copy appears.
 *
 * **It describes what must be true rather than listing what is forbidden.** Not "auth must not declare
 * an allowlist" — the shape itself: any shipped module outside core's that names two of the allowlisted
 * media types is a second copy of this decision, whatever its constant is called. A gate that
 * enumerated packages would be green on the third one.
 *
 * The walk is `ci/sourceFiles.ts`, which is the repository's one traversal — a private `readdirSync`
 * here would be the seventh copy of a module four issues have spent removing, and it would carry none
 * of the exclusions that keep `.worktrees/` and a vendored template copy out of the answer.
 */

/** The one module allowed to name the allowlist. */
const RULE = join("packages", "core", "src", "image", "storedImage.ts");

/** `packages/` — `KIT_ROOT` is `packages/cli`. */
const PACKAGES = join(KIT_ROOT, "..");

/** The repository root, which every reported path is relative to. */
const REPO = join(PACKAGES, "..");

describe("the stored-image rule is declared once", () => {
  const shipped = sourceFiles(PACKAGES);

  test("the sweep is looking at the kit, not at nothing", () => {
    // The guard the gate itself needs: a walk that matched nothing would report no violations, and no
    // violations is what passing looks like. Measured at well over a thousand shipped modules.
    expect(shipped.length).toBeGreaterThan(500);
    // And it reaches the module the rule lives in, which is the narrowest possible proof that the root
    // is the right one.
    expect(shipped.some((file) => relative(REPO, file.path) === RULE)).toBe(true);
  });

  test("no module outside core's rule names the image-type allowlist", () => {
    const copies = shipped
      .filter((file) => file.text.includes('"image/svg+xml"') && file.text.includes('"image/webp"'))
      .map((file) => relative(REPO, file.path))
      .filter((path) => path !== RULE);
    expect(copies, copies.join("\n")).toEqual([]);
  });
});
