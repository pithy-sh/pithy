// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkRootImports, describeRootImports, ROOT_IMPORTS_ACTION } from "./rootImports";

const CONFIG = "vitest.workers.config.ts";
const SOURCE = [
  'import { cloudflareTest } from "@cloudflare/vitest-plugin";',
  'import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";',
  'import { defineConfig } from "vitest/config";',
  "",
].join("\n");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-root-imports-"));
  await json("package.json", {
    name: "replay",
    workspaces: ["apps/*"],
    devDependencies: { "@cloudflare/vitest-plugin": "1.4.2", vitest: "^4.1.0" },
  });
  await json("apps/board/package.json", { name: "board", dependencies: { "@pithy-sh/secrets": "^0.6.8" } });
  await installed(dir, "@cloudflare/vitest-plugin");
  await installed(dir, "vitest");
  await installed(join(dir, "apps", "board"), "@pithy-sh/secrets");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), JSON.stringify(value));
}

async function installed(base: string, pkg: string): Promise<void> {
  const at = join(base, "node_modules", ...pkg.split("/"));
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
}

describe("checkRootImports", () => {
  test("names an import the root cannot resolve, and the devDependency line a member's range gives", async () => {
    await writeFile(join(dir, CONFIG), SOURCE);

    expect(await checkRootImports(dir)).toEqual({
      state: "unresolved",
      unresolved: [
        {
          file: CONFIG,
          package: "@pithy-sh/secrets",
          declared: false,
          line: '"@pithy-sh/secrets": "^0.6.8"',
        },
      ],
    });
  });

  test("resolves only from the root: a node_modules above the project does not count", async () => {
    const project = join(dir, "inner");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "inner" }));
    await writeFile(join(project, CONFIG), 'import { x } from "vitest/config";\n');
    const check = await checkRootImports(project);
    expect(check.unresolved.map((entry) => entry.package)).toEqual(["vitest"]);
  });

  test("a package the root declares and has not installed says so, with no line to add", async () => {
    await json("package.json", { name: "replay", devDependencies: { "@pithy-sh/secrets": "^0.6.8" } });
    await writeFile(join(dir, CONFIG), 'import { devEncryptionKeys } from "@pithy-sh/secrets/src/x";\n');
    expect((await checkRootImports(dir)).unresolved).toEqual([
      { file: CONFIG, package: "@pithy-sh/secrets", declared: true, line: null },
    ]);
  });

  test("a package no member declares has no range to name", async () => {
    await writeFile(join(dir, CONFIG), 'import { thing } from "left-pad";\n');
    expect((await checkRootImports(dir)).unresolved).toEqual([
      { file: CONFIG, package: "left-pad", declared: false, line: null },
    ]);
  });

  test("ok once the root resolves every import, a link into a store included", async () => {
    await writeFile(join(dir, CONFIG), SOURCE);
    const at = join(dir, "node_modules", "@pithy-sh", "secrets");
    await mkdir(dirname(at), { recursive: true });
    await symlink(join(dir, "apps", "board", "node_modules", "@pithy-sh", "secrets"), at);
    expect(await checkRootImports(dir)).toEqual({ state: "ok", unresolved: [] });
  });

  test("ok with no Workers test config", async () => {
    expect(await checkRootImports(dir)).toEqual({ state: "ok", unresolved: [] });
  });
});

describe("describeRootImports", () => {
  test("one sentence per import, naming the package, the file and the line to add", () => {
    expect(
      describeRootImports({
        state: "unresolved",
        unresolved: [
          { file: CONFIG, package: "@pithy-sh/secrets", declared: false, line: '"@pithy-sh/secrets": "^0.6.8"' },
          { file: CONFIG, package: "@pithy-sh/email", declared: true, line: null },
          { file: CONFIG, package: "left-pad", declared: false, line: null },
        ],
      }),
    ).toEqual([
      'vitest.workers.config.ts imports @pithy-sh/secrets, which the project root does not resolve. Add "@pithy-sh/secrets": "^0.6.8" to devDependencies in the root package.json.',
      "vitest.workers.config.ts imports @pithy-sh/email, which the project root declares and has not installed.",
      "vitest.workers.config.ts imports left-pad, which the project root does not resolve. Add left-pad to devDependencies in the root package.json.",
    ]);
  });

  test("one line when the check could not run, none when every import resolves", () => {
    expect(describeRootImports({ state: "could-not-check", unresolved: [] })).toEqual([
      "Could not check what vitest.workers.config.ts imports against the project root.",
    ]);
    expect(describeRootImports({ state: "ok", unresolved: [] })).toEqual([]);
  });

  test("the remedy names the install", () => {
    expect(ROOT_IMPORTS_ACTION).toBe("Then run your package manager's install at the project root.");
  });
});
