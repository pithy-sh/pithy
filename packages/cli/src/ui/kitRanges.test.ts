// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { importedKitPackages, kitRangesFor } from "./kitRanges";

let projectDir: string;
let workerDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-kit-ranges-"));
  workerDir = join(projectDir, "apps", "api");
  await mkdir(workerDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function manifest(dir: string, body: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "package.json"), `${JSON.stringify(body, null, 2)}\n`);
}

async function installed(dir: string, name: string, version: string): Promise<void> {
  const home = join(dir, "node_modules", ...name.split("/"));
  await mkdir(home, { recursive: true });
  await manifest(home, { name, version });
}

describe("importedKitPackages", () => {
  test("is every kit package the files import, by package, sorted", () => {
    expect(
      importedKitPackages({
        "a.ts":
          'import type { X } from "@pithy-sh/auth/src/client/api";\nimport { y } from "@pithy-sh/core/src/i18n/t";',
        "b.tsx": 'import { z } from "@pithy-sh/auth/src/client/bearer";\nimport React from "react";',
        "c.json": '{ "@pithy-sh/payments": "nothing" }',
      }),
    ).toEqual(["@pithy-sh/auth", "@pithy-sh/core"]);
  });
});

describe("kitRangesFor", () => {
  test("takes the worker's own range first, so the app and the worker run one release", async () => {
    await manifest(workerDir, { dependencies: { "@pithy-sh/auth": "^0.11.0" } });
    await manifest(projectDir, { dependencies: { "@pithy-sh/auth": "^0.9.0" } });
    const latest = vi.fn(async () => "0.12.0");
    expect(await kitRangesFor(["@pithy-sh/auth"], { projectDir, workerDir, installedFrom: [], latest })).toEqual({
      ranges: { "@pithy-sh/auth": "^0.11.0" },
      unresolved: [],
    });
    expect(latest).not.toHaveBeenCalled();
  });

  test("then the project root's, then an installed copy, then the registry's latest", async () => {
    await manifest(workerDir, {});
    await manifest(projectDir, { devDependencies: { "@pithy-sh/organization": "~0.8.0" } });
    await installed(projectDir, "@pithy-sh/payments", "0.6.1");
    const latest = vi.fn(async (name: string) => (name === "@pithy-sh/turnstile" ? "0.6.2" : null));
    const result = await kitRangesFor(
      ["@pithy-sh/organization", "@pithy-sh/payments", "@pithy-sh/turnstile", "@pithy-sh/consent"],
      { projectDir, workerDir, installedFrom: [projectDir], latest },
    );
    expect(result).toEqual({
      ranges: {
        "@pithy-sh/organization": "~0.8.0",
        "@pithy-sh/payments": "^0.6.1",
        "@pithy-sh/turnstile": "^0.6.2",
      },
      unresolved: ["@pithy-sh/consent"],
    });
  });

  test("an unpublished 0.0.0 is not a range anything can install", async () => {
    await installed(projectDir, "@pithy-sh/ui-core", "0.0.0");
    const result = await kitRangesFor(["@pithy-sh/ui-core"], {
      projectDir,
      workerDir,
      installedFrom: [projectDir],
      latest: async () => null,
    });
    expect(result).toEqual({ ranges: {}, unresolved: ["@pithy-sh/ui-core"] });
  });
});
