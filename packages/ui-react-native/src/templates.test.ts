// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { APP_TOKEN, HOME_SCREEN, TEMPLATE_DIR, TEMPLATE_GROUPS, WORKER_TOKEN } from "./templates";

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

const declared = (): string[] => [...Object.values(TEMPLATE_GROUPS).flat(), HOME_SCREEN.auth, HOME_SCREEN.bare].sort();

describe("the React Native template library", () => {
  test("every declared path exists on disk", async () => {
    for (const path of declared()) {
      const info = await stat(join(TEMPLATE_DIR, path)).catch(() => null);
      expect(info?.isFile(), `${path} is declared but missing`).toBe(true);
    }
  });

  test("every file in the tree is declared, and the tree is not empty", async () => {
    const files = await treeFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual(declared());
  });

  test("no file is claimed by two groups", () => {
    const paths = Object.values(TEMPLATE_GROUPS).flat();
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("nothing in the tree is a test: the templates' tests live in this package's src/", async () => {
    expect((await treeFiles()).filter((path) => /\.(test|spec)\.tsx?$/.test(path))).toEqual([]);
  });

  test("every screen ui-react ships has its counterpart here, at the same path", () => {
    const screens = Object.values(TEMPLATE_GROUPS)
      .flat()
      .filter((path) => path.startsWith("src/routes/pithy/"));
    for (const name of [
      "sign-in",
      "otp",
      "callback",
      "account-suspended",
      "account-deleted",
      "organization-suspended",
      "choose-organization",
      "invitation",
      "agent-consent",
      "connected-applications",
      "paywall",
      "pricing",
      "subscription",
      "consent",
    ]) {
      expect(screens, name).toContain(`src/routes/pithy/${name}.tsx`);
    }
  });

  test("a capability's helpers ride with its screens, never in base", () => {
    expect(TEMPLATE_GROUPS.base).not.toContain("src/session.tsx");
    expect(TEMPLATE_GROUPS.base).not.toContain("src/payments.tsx");
    expect(TEMPLATE_GROUPS.auth).toContain("src/session.tsx");
    expect(TEMPLATE_GROUPS.payments).toContain("src/payments.tsx");
  });

  test("the app's name and the Worker's are tokens the scaffolder substitutes", async () => {
    expect(await readFile(join(TEMPLATE_DIR, "app.config.ts"), "utf8")).toContain(APP_TOKEN);
    expect(await readFile(join(TEMPLATE_DIR, "src/pithy-config.generated.ts"), "utf8")).toContain(WORKER_TOKEN);
  });
});
