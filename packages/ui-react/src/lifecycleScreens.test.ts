// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { TEMPLATE_DIR, TEMPLATE_GROUPS } from "./templates";

/**
 * The source-text half of the lifecycle screens' gate (#620). `lifecycleScreens.test.tsx` renders them;
 * this reads them, because a file system is something a rendering program does not have.
 */

const SCREENS = [
  "src/routes/pithy/account-suspended.tsx",
  "src/routes/pithy/account-deleted.tsx",
  "src/routes/pithy/organization-suspended.tsx",
];

/** Every class selector `pithy-screens.css` defines. */
async function definedClasses(): Promise<Set<string>> {
  const css = await readFile(join(TEMPLATE_DIR, "src", "pithy-screens.css"), "utf8");
  return new Set([...css.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1] as string));
}

describe("the lifecycle screens ship with auth", () => {
  test("all three are in the auth group, so `pithy ui` copies them wherever auth is composed", () => {
    for (const path of SCREENS) expect(TEMPLATE_GROUPS.auth as readonly string[]).toContain(path);
  });

  test.each(SCREENS)("%s names no Pithy-hosted origin, and no address at all, in its code", async (path) => {
    const source = blankComments(await readFile(join(TEMPLATE_DIR, path), "utf8"));
    expect(source).not.toMatch(/pithy\.(sh|dev)/);
    expect(source).not.toMatch(/https?:\/\//);
  });

  test.each(SCREENS)("%s draws only with classes pithy-screens.css defines, so both themes hold", async (path) => {
    // The stylesheet declares every colour token it reads for light and again under
    // `prefers-color-scheme: dark` (palette.test.ts). A class nothing defines, or a colour written into
    // the screen, is the way a screen is legible in one scheme and not the other.
    const source = blankComments(await readFile(join(TEMPLATE_DIR, path), "utf8"));
    expect(source).not.toMatch(/\bstyle=\{/);
    const defined = await definedClasses();
    const used = [...source.matchAll(/className="([^"]+)"/g)].flatMap((match) => (match[1] as string).split(/\s+/));
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(defined.has(name), `.${name} is not in pithy-screens.css`).toBe(true);
  });

  test("the rendering gate's class list is itself defined by the stylesheet", async () => {
    // The `.tsx` gate holds each rendered element to a fixed set. This holds that set to the stylesheet, so
    // the two halves together say what neither can alone.
    const defined = await definedClasses();
    for (const name of ["screen", "muted", "stack", "secondary"]) expect(defined.has(name), name).toBe(true);
  });
});
