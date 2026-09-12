// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
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
 * an allowlist" — the shape itself: any module outside core's that names two of the allowlisted media
 * types is a second copy of this decision, whatever its constant is called. A gate that enumerated
 * packages would be green on the third one.
 *
 * This lives in the CLI package rather than in core because it reads the filesystem, and core's
 * tsconfig carries no node types — the same reason every other repo-wide parity gate is here.
 */

/** The one module allowed to name the allowlist. */
const RULE = join("packages", "core", "src", "image", "storedImage.ts");

/** Directories that hold no first-party source. */
const SKIP = new Set(["node_modules", "dist", ".turbo", "coverage", ".wrangler"]);

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

describe("the stored-image rule is declared once", () => {
  const packages = join(KIT_ROOT, "..");

  test("the sweep is looking at the kit, not at nothing", () => {
    // The guard the gate itself needs: a walk that matched nothing would report no violations, and no
    // violations is what passing looks like.
    expect(sources(packages).length).toBeGreaterThan(500);
  });

  test("no module outside core's rule names the image-type allowlist", () => {
    const copies = sources(packages)
      .map((path) => relative(join(KIT_ROOT, "..", ".."), path))
      .filter((path) => path !== RULE)
      .filter((path) => {
        const text = readFileSync(join(KIT_ROOT, "..", "..", path), "utf8");
        return text.includes('"image/svg+xml"') && text.includes('"image/webp"');
      });
    expect(copies, copies.join("\n")).toEqual([]);
  });
});
