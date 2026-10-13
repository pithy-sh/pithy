// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredEntry, exportedTarget } from "@pithy-sh/core/src/error/unresolved";
import { afterAll, describe, expect, test } from "vitest";
import { entryBeside, installedBeside } from "./kitResolve";

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

  // Bun's isolated linker, on disk: the root links `email` into its store, and email's own dependency sits
  // beside email's real directory and nowhere on the root's chain. The resolver walks from the real path.
  // Walked from the link as given, `stripe` was reported absent and the adopter told to install it.
  test("a symlinked importer is walked from where it really is, as the resolver walked it", () => {
    const store = join(root, "node_modules", ".bun", "@pithy-sh+email@1.0.0", "node_modules");
    mkdirSync(join(store, "@pithy-sh", "email", "src"), { recursive: true });
    writeFileSync(join(store, "@pithy-sh", "email", "package.json"), '{"name":"@pithy-sh/email"}');
    writeFileSync(join(store, "@pithy-sh", "email", "src", "capability.js"), "");
    mkdirSync(join(store, "stripe"), { recursive: true });
    writeFileSync(join(store, "stripe", "package.json"), '{"name":"stripe"}');
    const linked = join(root, "linked");
    mkdirSync(join(linked, "node_modules", "@pithy-sh"), { recursive: true });
    symlinkSync(join(store, "@pithy-sh", "email"), join(linked, "node_modules", "@pithy-sh", "email"), "dir");

    expect(installedBeside("stripe", join(linked, "node_modules", "@pithy-sh", "email", "src", "capability.js"))).toBe(
      true,
    );
  });
});

describe("entryBeside", () => {
  const root = mkdtempSync(join(tmpdir(), "pithy-entry-beside-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const manifests: Record<string, string> = {
    "@pithy-sh/core": '{"name":"@pithy-sh/core","exports":{"./src/*":{"default":"./dist/*.js"}}}',
    unbuilt: '{"name":"unbuilt","exports":{".":"./dist/index.js"}}',
  };
  for (const [name, text] of Object.entries(manifests)) {
    mkdirSync(join(root, "node_modules", name), { recursive: true });
    writeFileSync(join(root, "node_modules", name, "package.json"), text);
  }
  const referrer = join(root, "apps", "api", "pithy.config.ts");

  // The two Bun 1.4.2 cannot tell apart, read from disk: the kit's own packages declare no bare entry, and
  // an unbuilt package declares one it does not carry (#709).
  test("reads the entry an installed package declares, or that it declares none", () => {
    expect(declaredEntry(entryBeside("@pithy-sh/core", referrer)?.manifest)).toBeNull();
    expect(declaredEntry(entryBeside("unbuilt", referrer)?.manifest)).toBe("dist/index.js");
  });

  // Every deep import of an unbuilt kit package matches `./src/*` and lands in a `dist` that is not there.
  test("reads where a deep import leads, and whether the directory it expands under is on disk", () => {
    const core = entryBeside("@pithy-sh/core", referrer);
    expect(exportedTarget(core?.manifest, "./src/capability")).toEqual({ target: "dist/capability.js", under: "dist" });
    expect(core?.has("dist")).toBe(false);
    expect(core?.has("package.json")).toBe(true);
  });

  test("a package that is not installed declares nothing it can be asked about", () => {
    expect(entryBeside("absent", referrer)).toBeUndefined();
  });
});
