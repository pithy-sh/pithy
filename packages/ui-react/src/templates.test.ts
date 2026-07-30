// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { HOME_SCREEN, TEMPLATE_DIR, TEMPLATE_GROUPS, WORKER_TOKEN } from "./templates";

/**
 * The library is text, so its meta-test is about the manifest telling the truth: every path a group
 * names exists, and every file in the tree is named by some group. Either half failing is the same
 * class of bug — a template that silently never ships, or a group that points at nothing — and
 * neither is visible to `tsc` or to the CLI's own tests.
 */

/** Every file in the template tree, as paths relative to it, POSIX-separated. */
async function treeFiles(dir: string = TEMPLATE_DIR): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await treeFiles(path)));
    else found.push(relative(TEMPLATE_DIR, path).split(sep).join("/"));
  }
  return found.sort();
}

/** Every path any group or the home screen declares. */
function declaredPaths(): string[] {
  return [...Object.values(TEMPLATE_GROUPS).flat(), HOME_SCREEN.auth, HOME_SCREEN.bare].sort();
}

describe("the React template library", () => {
  test("every declared path exists on disk", async () => {
    for (const path of declaredPaths()) {
      const info = await stat(join(TEMPLATE_DIR, path)).catch(() => null);
      expect(info?.isFile(), `${path} is declared but missing`).toBe(true);
    }
  });

  test("every file in the tree is declared — no template ships by accident, and none is orphaned", async () => {
    const declared = new Set(declaredPaths());
    const orphans = (await treeFiles()).filter((path) => !declared.has(path));
    expect(orphans, "files present in templates/ but named by no group").toEqual([]);
  });

  test("the tree is not empty — a broken TEMPLATE_DIR must fail loudly, not vacuously pass", async () => {
    const files = await treeFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(declaredPaths().length).toBe(files.length);
  });

  test("base is what every template gets; every other group is additive on top of it", () => {
    expect(TEMPLATE_GROUPS.base).toContain("src/router.tsx");
    expect(TEMPLATE_GROUPS.base).toContain("client-env.d.ts");
    // The one module that imports the virtual modules and narrows them belongs to every capability, not
    // to auth — a payments-only scaffold needs it too. docs/UI.md states the rule.
    expect(TEMPLATE_GROUPS.base).toContain("src/pithy-config.tsx");

    // A capability's screens ride on that capability being composed, so none of them may sit in base.
    const capabilityOwned: Record<string, readonly string[]> = {
      auth: ["src/session.tsx", "src/turnstile.tsx"],
      payments: ["src/payments.tsx"],
    };
    for (const [group, helpers] of Object.entries(capabilityOwned)) {
      for (const path of TEMPLATE_GROUPS[group as "auth" | "payments"]) {
        expect(TEMPLATE_GROUPS.base as readonly string[], path).not.toContain(path);
        expect(path.startsWith("src/routes/pithy/") || helpers.includes(path), path).toBe(true);
      }
    }
  });

  test("no file is claimed by two groups — a scaffold writes each path once", () => {
    const declared = Object.values(TEMPLATE_GROUPS).flat();
    expect(new Set(declared).size).toBe(declared.length);
  });

  test("the payments group is the two screens and the bridge, and nothing from auth", () => {
    expect([...TEMPLATE_GROUPS.payments]).toEqual([
      "src/payments.tsx",
      "src/routes/pithy/paywall.tsx",
      "src/routes/pithy/subscription.tsx",
    ]);
  });

  test("the home screen has both variants, and they land at the same target", () => {
    expect(HOME_SCREEN.auth).not.toBe(HOME_SCREEN.bare);
    expect(HOME_SCREEN.target).toBe("src/routes/app/home.tsx");
  });

  test("the worker token appears only where a name belongs, and every use is substitutable", async () => {
    const users: string[] = [];
    for (const path of declaredPaths()) {
      const text = await readFile(join(TEMPLATE_DIR, path), "utf8");
      if (text.includes(WORKER_TOKEN)) users.push(path);
    }
    // Exactly one template needs the worker's name today: the document title.
    expect(users).toEqual(["index.html"]);
  });

  test("no template reaches for a token that nothing substitutes", async () => {
    for (const path of declaredPaths()) {
      const text = await readFile(join(TEMPLATE_DIR, path), "utf8");
      const tokens = (text.match(/__PITHY_[A-Z_]+__/g) ?? []).filter((token) => token !== WORKER_TOKEN);
      expect(tokens, `${path} uses an unsubstituted token`).toEqual([]);
    }
  });
});
