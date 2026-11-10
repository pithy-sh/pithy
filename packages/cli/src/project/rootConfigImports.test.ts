// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { importedPackages, memberRange, packageOfSpecifier, writeRootConfig } from "./rootConfigImports";

const CONFIG = "vitest.workers.config.ts";
const PLAIN = 'import { cloudflareTest } from "@cloudflare/vitest-plugin";\nexport default {};\n';
const WITH_KEYS = `import { cloudflareTest } from "@cloudflare/vitest-plugin";\nimport { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";\nexport default {};\n`;

describe("packageOfSpecifier", () => {
  test("a scoped or bare specifier resolves through its package", () => {
    expect(packageOfSpecifier("@pithy-sh/secrets/src/test-utils/devEncryptionKeys")).toBe("@pithy-sh/secrets");
    expect(packageOfSpecifier("@cloudflare/vitest-plugin")).toBe("@cloudflare/vitest-plugin");
    expect(packageOfSpecifier("vitest/config")).toBe("vitest");
    expect(packageOfSpecifier("hono")).toBe("hono");
  });

  test("a path, a builtin, a URL scheme or a subpath import is no package", () => {
    for (const specifier of [
      "./env",
      "../shared",
      "/abs/path",
      "node:path",
      "fs",
      "cloudflare:test",
      "#internal",
      "@scope",
    ]) {
      expect(packageOfSpecifier(specifier)).toBeNull();
    }
  });
});

describe("importedPackages", () => {
  test("each package a source's static imports resolve through, once, in first-import order", () => {
    const source = `${WITH_KEYS}import { env } from "cloudflare:test";\nimport type { X } from "@cloudflare/vitest-plugin/types";\nimport "./setup";\n`;
    expect(importedPackages(source)).toEqual(["@cloudflare/vitest-plugin", "@pithy-sh/secrets"]);
  });
});

describe("with a project", () => {
  let dir: string;
  const syncs: string[] = [];
  const sync = async (projectDir: string) => {
    syncs.push(projectDir);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-root-imports-"));
    syncs.length = 0;
    await writeJson("package.json", {
      name: "replay",
      workspaces: ["apps/*"],
      devDependencies: { "@cloudflare/vitest-plugin": "1.4.2", vitest: "^4.1.0" },
    });
    await writeJson("apps/board/package.json", {
      name: "board",
      dependencies: { "@pithy-sh/secrets": "^0.6.8", zod: "^4.4.0" },
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  }

  async function rootManifest(): Promise<{
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  }> {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  }

  describe("memberRange", () => {
    test("the range a workspace member declares the package at", async () => {
      expect(await memberRange(dir, "@pithy-sh/secrets")).toBe("^0.6.8");
    });

    test("undefined when no member declares it", async () => {
      expect(await memberRange(dir, "@pithy-sh/email")).toBeUndefined();
    });
  });

  describe("writeRootConfig", () => {
    test("writes the config, and declares a package it imports at the root as a devDependency, sorted", async () => {
      await writeFile(join(dir, CONFIG), PLAIN);

      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });

      expect(await readFile(join(dir, CONFIG), "utf8")).toBe(WITH_KEYS);
      expect(change).toEqual({ added: ["@pithy-sh/secrets"], removed: [] });
      const root = await rootManifest();
      expect(root.devDependencies).toEqual({
        "@cloudflare/vitest-plugin": "1.4.2",
        "@pithy-sh/secrets": "^0.6.8",
        vitest: "^4.1.0",
      });
      expect(Object.keys(root.devDependencies ?? {})).toEqual(Object.keys(root.devDependencies ?? {}).sort());
      expect(root.dependencies).toBeUndefined();
      expect(syncs).toEqual([dir]);
    });

    test("an unchanged config that imports a package the root lacks still declares it at the root", async () => {
      await writeFile(join(dir, CONFIG), WITH_KEYS);

      const change = await writeRootConfig({
        projectDir: dir,
        file: CONFIG,
        original: WITH_KEYS,
        source: WITH_KEYS,
        sync,
      });

      expect(await readFile(join(dir, CONFIG), "utf8")).toBe(WITH_KEYS);
      expect(change).toEqual({ added: ["@pithy-sh/secrets"], removed: [] });
      expect((await rootManifest()).devDependencies?.["@pithy-sh/secrets"]).toBe("^0.6.8");
      expect(syncs).toEqual([dir]);
    });

    test("leaves the Worker's runtime declaration where it is", async () => {
      await writeFile(join(dir, CONFIG), PLAIN);
      const before = await readFile(join(dir, "apps/board/package.json"), "utf8");
      await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });
      expect(await readFile(join(dir, "apps/board/package.json"), "utf8")).toBe(before);
    });

    test("a package the root already declares, in any field, is no change and no sync", async () => {
      await writeJson("package.json", {
        name: "replay",
        workspaces: ["apps/*"],
        dependencies: { "@pithy-sh/secrets": "^0.6.8" },
      });
      await writeFile(join(dir, CONFIG), PLAIN);
      const before = await readFile(join(dir, "package.json"), "utf8");

      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });

      expect(change).toEqual({ added: [], removed: [] });
      expect(await readFile(join(dir, "package.json"), "utf8")).toBe(before);
      expect(syncs).toEqual([]);
    });

    test("a package no member declares has no range to write, and is left to the doctor", async () => {
      await writeJson("apps/board/package.json", { name: "board" });
      await writeFile(join(dir, CONFIG), PLAIN);
      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });
      expect(change).toEqual({ added: [], removed: [] });
      expect(syncs).toEqual([]);
    });

    test("takes out the devDependency of a package the config stops importing, once no root file imports it", async () => {
      await writeFile(join(dir, CONFIG), WITH_KEYS);
      await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });
      syncs.length = 0;

      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: WITH_KEYS, source: PLAIN, sync });

      expect(change).toEqual({ added: [], removed: ["@pithy-sh/secrets"] });
      expect((await rootManifest()).devDependencies).toEqual({
        "@cloudflare/vitest-plugin": "1.4.2",
        vitest: "^4.1.0",
      });
      expect(syncs).toEqual([dir]);
    });

    test("keeps the devDependency while another root file still imports the package", async () => {
      await writeFile(join(dir, CONFIG), WITH_KEYS);
      await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });
      await writeFile(
        join(dir, "vitest.config.ts"),
        'import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";\n',
      );

      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: WITH_KEYS, source: PLAIN, sync });

      expect(change.removed).toEqual([]);
      expect((await rootManifest()).devDependencies?.["@pithy-sh/secrets"]).toBe("^0.6.8");
    });

    test("keeps a declaration the root already had while a root script in a non-member directory imports the package", async () => {
      await writeJson("package.json", {
        name: "replay",
        workspaces: ["apps/*"],
        devDependencies: { "@pithy-sh/secrets": "^0.6.8", vitest: "^4.1.0" },
      });
      await mkdir(join(dir, "scripts"), { recursive: true });
      await writeFile(join(dir, "scripts/rotate-keys.ts"), 'import { rotate } from "@pithy-sh/secrets";\n');
      await writeFile(join(dir, CONFIG), PLAIN);
      expect(
        await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync }),
      ).toEqual({ added: [], removed: [] });

      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: WITH_KEYS, source: PLAIN, sync });

      expect(change.removed).toEqual([]);
      expect((await rootManifest()).devDependencies?.["@pithy-sh/secrets"]).toBe("^0.6.8");
      expect(syncs).toEqual([]);
    });

    test("keeps the devDependency while a file nested under a non-member root directory imports the package", async () => {
      await writeFile(join(dir, CONFIG), WITH_KEYS);
      await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });
      await mkdir(join(dir, "test/e2e"), { recursive: true });
      await writeFile(
        join(dir, "test/e2e/keys.test.mts"),
        'import "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";\n',
      );

      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: WITH_KEYS, source: PLAIN, sync });

      expect(change.removed).toEqual([]);
    });

    test("a workspace member's, node_modules' or dot directory's import does not keep the root devDependency", async () => {
      await writeFile(join(dir, CONFIG), WITH_KEYS);
      await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });
      const importer = 'import { rotate } from "@pithy-sh/secrets";\n';
      for (const path of ["apps/board/src/index.ts", "node_modules/x/index.js", ".cache/a.ts"]) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), importer);
      }

      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: WITH_KEYS, source: PLAIN, sync });

      expect(change.removed).toEqual(["@pithy-sh/secrets"]);
    });

    test("never takes a runtime dependency out of the root", async () => {
      await writeJson("package.json", { name: "replay", dependencies: { "@pithy-sh/secrets": "^0.6.8" } });
      await writeFile(join(dir, CONFIG), WITH_KEYS);
      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: WITH_KEYS, source: PLAIN, sync });
      expect(change.removed).toEqual([]);
      expect((await rootManifest()).dependencies).toEqual({ "@pithy-sh/secrets": "^0.6.8" });
    });

    test("a project with no root package.json gets its config and nothing else", async () => {
      await rm(join(dir, "package.json"));
      await writeFile(join(dir, CONFIG), PLAIN);
      const change = await writeRootConfig({ projectDir: dir, file: CONFIG, original: PLAIN, source: WITH_KEYS, sync });
      expect(change).toEqual({ added: [], removed: [] });
      expect(await readFile(join(dir, CONFIG), "utf8")).toBe(WITH_KEYS);
    });
  });
});
