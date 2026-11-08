// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rootLeavesApp, screenTestsRemedy } from "./rootRunner";

/** The repository root, four levels up from `packages/cli/src/ui`. */
const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The node project the starter's root config declared before it learned to leave an app with its own runner out. */
const BEFORE = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["apps/*/src/**/*.test.{ts,tsx}"],
          exclude: ["apps/*/src/**/*.workers.test.{ts,tsx}"],
        },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-root-runner-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("rootLeavesApp", () => {
  test("the starter's root config leaves the app to its own runner", async () => {
    await cp(join(REPO, "templates", "starter", "vitest.config.ts"), join(dir, "vitest.config.ts"));
    expect(await rootLeavesApp(dir, "app")).toBe(true);
  });

  test("the config before it does not, so the app's tests would run in plain Node", async () => {
    await writeFile(join(dir, "vitest.config.ts"), BEFORE);
    expect(await rootLeavesApp(dir, "app")).toBe(false);
  });

  test("an old config that excludes the app by hand does, for that app only", async () => {
    await writeFile(
      join(dir, "vitest.config.ts"),
      BEFORE.replace(
        '"apps/*/src/**/*.workers.test.{ts,tsx}"]',
        '"apps/*/src/**/*.workers.test.{ts,tsx}", "apps/app/**"]',
      ),
    );
    expect(await rootLeavesApp(dir, "app")).toBe(true);
    expect(await rootLeavesApp(dir, "mobile")).toBe(false);
  });

  test("a mention in a comment is not an exclusion", async () => {
    await writeFile(join(dir, "vitest.config.ts"), `// "apps/app/**" and ownRunners() someday\n${BEFORE}`);
    expect(await rootLeavesApp(dir, "app")).toBe(false);
  });

  test("a project with no root config collects nothing, so the app keeps its tests", async () => {
    expect(await rootLeavesApp(dir, "app")).toBe(true);
  });
});

test("the remedy names the exclusion to add and the command that adds the tests", () => {
  expect(screenTestsRemedy("app", "pithy ui add react-native --app app --worker api")).toBe(
    'Add "apps/app/**" to the node project\'s exclude in the root vitest.config.ts, then run pithy ui add react-native --app app --worker api to add them.',
  );
});
