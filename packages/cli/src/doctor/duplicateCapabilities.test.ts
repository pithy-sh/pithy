// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  checkDuplicateCapabilities,
  DUPLICATE_CAPABILITIES_ACTION,
  describeDuplicateCapabilities,
} from "./duplicateCapabilities";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-duplicate-capabilities-"));
  await json("apps/api/package.json", {
    name: "api",
    dependencies: { "@pithy-sh/secrets": "^0.6.9", "@pithy-sh/core": "^0.21.0", hono: "^4.13.2" },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), JSON.stringify(value));
}

describe("checkDuplicateCapabilities", () => {
  test("names a capability the root and a Worker both declare as a runtime dependency", async () => {
    await json("package.json", {
      name: "stats",
      workspaces: ["apps/*"],
      dependencies: { "@pithy-sh/secrets": "^0.6.9" },
    });
    expect(await checkDuplicateCapabilities(dir)).toEqual({
      state: "duplicated",
      duplicates: [{ package: "@pithy-sh/secrets", members: [".", "apps/api"] }],
    });
  });

  test("leaves a root devDependency alone: that is how the root resolves a test binding's import", async () => {
    await json("package.json", {
      name: "stats",
      workspaces: ["apps/*"],
      devDependencies: { "@pithy-sh/secrets": "^0.6.9" },
    });
    expect(await checkDuplicateCapabilities(dir)).toEqual({ state: "ok", duplicates: [] });
  });

  test("two Workers composing one capability each declare it, and that is no duplicate", async () => {
    await json("package.json", { name: "stats", workspaces: ["apps/*"] });
    await json("apps/admin/package.json", { name: "admin", dependencies: { "@pithy-sh/secrets": "^0.6.9" } });
    expect(await checkDuplicateCapabilities(dir)).toEqual({ state: "ok", duplicates: [] });
  });

  test("a package that is no capability is not its business", async () => {
    await json("package.json", { name: "stats", workspaces: ["apps/*"], dependencies: { hono: "^4.13.2" } });
    expect(await checkDuplicateCapabilities(dir)).toEqual({ state: "ok", duplicates: [] });
  });

  test("names every Worker declaring it beside the root, in member order", async () => {
    await json("package.json", {
      name: "stats",
      workspaces: ["apps/*"],
      dependencies: { "@pithy-sh/secrets": "^0.6.9" },
    });
    await json("apps/admin/package.json", { name: "admin", dependencies: { "@pithy-sh/secrets": "^0.6.9" } });
    expect((await checkDuplicateCapabilities(dir)).duplicates).toEqual([
      { package: "@pithy-sh/secrets", members: [".", "apps/admin", "apps/api"] },
    ]);
  });

  test("a project with no root package.json has nothing to compare", async () => {
    expect(await checkDuplicateCapabilities(dir)).toEqual({ state: "ok", duplicates: [] });
  });
});

describe("describeDuplicateCapabilities", () => {
  test("one sentence per capability, naming the root and each Worker", () => {
    expect(
      describeDuplicateCapabilities({
        state: "duplicated",
        duplicates: [{ package: "@pithy-sh/secrets", members: [".", "apps/admin", "apps/api"] }],
      }),
    ).toEqual(["@pithy-sh/secrets is a runtime dependency of the project root and of admin and api."]);
  });

  test("a check that threw says so", () => {
    expect(describeDuplicateCapabilities({ state: "could-not-check", duplicates: [] })).toEqual([
      "Could not compare the capabilities the project root and its Workers declare.",
    ]);
  });

  test("the remedy keeps each Worker's declaration and takes out the root's", () => {
    expect(DUPLICATE_CAPABILITIES_ACTION).toBe(
      "Take each out of the root package.json's dependencies. A Worker declares what it composes.",
    );
  });
});
