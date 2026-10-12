// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { installedBeside } from "./kitResolve";

describe("installedBeside", () => {
  const root = mkdtempSync(join(tmpdir(), "pithy-installed-beside-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "node_modules", "@pithy-sh", "core");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "package.json"), '{"name":"@pithy-sh/core"}');
  // A directory with no package.json is not an install: a half-removed tree leaves exactly this.
  mkdirSync(join(root, "node_modules", "@pithy-sh", "hollow"), { recursive: true });
  const referrer = join(root, "node_modules", "@pithy-sh", "email", "src", "capability.ts");

  test("a package on the chain above the importing file is installed", () => {
    expect(installedBeside("@pithy-sh/core", referrer)).toBe(true);
  });

  test("a package found nowhere on that chain is not", () => {
    expect(installedBeside("@pithy-sh/absent", referrer)).toBe(false);
  });

  test("a directory without a package.json is not an install", () => {
    expect(installedBeside("@pithy-sh/hollow", referrer)).toBe(false);
  });

  test("the chain is the importer's, so a project file reaches the root's node_modules too", () => {
    expect(installedBeside("@pithy-sh/core", join(root, "apps", "api", "pithy.config.ts"))).toBe(true);
  });
});
