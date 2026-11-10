// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { TestBinding } from "@pithy-sh/core/src/capability/testBinding";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { importedPackages } from "../project/rootConfigImports";
import { removeTestBindings, WORKERS_TEST_CONFIG, writeTestBindings } from "../project/workersTestConfig";
import { sourceFiles } from "./sourceFiles";

/**
 * **Every CLI writer of a project-root config declares what it imports at the root, through one rule.**
 *
 * A root config loads from the root, and under a package manager that does not hoist the root resolves only what
 * the root's own `package.json` declares. `project/rootConfigImports.ts`'s `writeRootConfig` is the rule: it writes
 * the file and declares each imported package as a root `devDependency`. This holds the CLI to it in two halves.
 *
 * 1. **Every module that names a root config is in {@link ROOT_CONFIG_MODULES}**, as a reader or a writer, and a
 *    writer routes through `writeRootConfig` and imports no file writer of its own. A new module naming the file
 *    fails here until it is classified.
 * 2. **What each writer produces is declared at the root.** The scaffolder copies the starter's root configs
 *    beside the starter's root `package.json`, so that manifest declares every package they import; and the test
 *    binding writer, run over a value binding, leaves the root declaring the package it imported.
 */

const CLI_SRC = join(import.meta.dirname, "..");
const STARTER = join(import.meta.dirname, "..", "..", "..", "..", "templates", "starter");

/** Each module that names a root config, and what it does with one. */
const ROOT_CONFIG_MODULES = new Map<string, "reads" | "writes">([
  ["project/workersTestConfig.ts", "writes"],
  ["capabilities/remove.ts", "reads"],
  ["commands/remove.ts", "reads"],
  ["doctor/testBindings.ts", "reads"],
  ["doctor/rootImports.ts", "reads"],
]);

/** Naming a root config: the constant, or the file name as a literal. */
const NAMES_ROOT_CONFIG = /\bWORKERS_TEST_CONFIG\b|["'`]vitest\.workers\.config\.ts["'`]/;

/** A file writer a module could reach past the rule with. */
const RAW_WRITER = /\b(?:writeFileAtomic|writeFileSync|writeFile|appendFile|appendFileSync)\b/;

const posix = (path: string) => path.split(sep).join("/");

describe("root config writers", () => {
  const modules = sourceFiles(CLI_SRC)
    .map(({ path, text }) => ({ path: posix(relative(CLI_SRC, path)), code: blankComments(text) }))
    .filter(({ code }) => NAMES_ROOT_CONFIG.test(code));

  test("every module naming a root config is classified", () => {
    expect(modules.map(({ path }) => path).sort()).toEqual([...ROOT_CONFIG_MODULES.keys()].sort());
  });

  test("a writer routes through writeRootConfig and holds no file writer of its own", () => {
    for (const { path, code } of modules.filter(({ path }) => ROOT_CONFIG_MODULES.get(path) === "writes")) {
      expect(code, path).toMatch(/\bwriteRootConfig\(/);
      expect(code, path).not.toMatch(RAW_WRITER);
    }
  });
});

describe("what a writer produces is declared at the root", () => {
  test("the starter's root package.json declares every package its root configs import", () => {
    const root = JSON.parse(readFileSync(join(STARTER, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = new Set(Object.keys({ ...root.dependencies, ...root.devDependencies }));
    const configs = readdirSync(STARTER).filter((name) => /\.[cm]?[jt]s$/.test(name));
    expect(configs).toContain(WORKERS_TEST_CONFIG);
    for (const name of configs) {
      const missing = importedPackages(readFileSync(join(STARTER, name), "utf8")).filter((pkg) => !declared.has(pkg));
      expect(missing, name).toEqual([]);
    }
  });

  describe("the test binding writer", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pithy-root-writers-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const VALUE: TestBinding = { kind: "value", name: "KEYS", module: "@pithy-sh/secrets/src/keys", export: "keys" };

    test("leaves the root declaring the package a value binding imports, and takes it out with the binding", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "replay", workspaces: ["apps/*"] }));
      await mkdir(join(dir, "apps", "board"), { recursive: true });
      await writeFile(
        join(dir, "apps", "board", "package.json"),
        JSON.stringify({ name: "board", dependencies: { "@pithy-sh/secrets": "^0.6.8" } }),
      );
      await writeFile(join(dir, WORKERS_TEST_CONFIG), readFileSync(join(STARTER, WORKERS_TEST_CONFIG), "utf8"));
      const sync = async () => {};

      await writeTestBindings(dir, "secrets", [VALUE], sync);
      const written = await readFile(join(dir, WORKERS_TEST_CONFIG), "utf8");
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        devDependencies?: Record<string, string>;
      };
      for (const pkg of importedPackages(written).filter((name) => name.startsWith("@pithy-sh/"))) {
        expect(root.devDependencies?.[pkg], pkg).toBeDefined();
      }

      await removeTestBindings(dir, [VALUE], sync);
      const after = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        devDependencies?: Record<string, string>;
      };
      expect(after.devDependencies).toBeUndefined();
    });
  });
});
