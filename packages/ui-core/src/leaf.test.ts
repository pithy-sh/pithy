// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * `@pithy-sh/payments`, `@pithy-sh/i18n` and both template packages import this package, so it builds with nothing
 * ahead of it. That holds only while the published source imports nothing but React and itself.
 *
 * A React Native client imports it too, so `node:*` is allowed in one module only: the scaffolder's version read.
 */
test("the published source imports nothing but react and its own modules", () => {
  const published = readdirSync(SRC).filter(
    (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"),
  );
  expect(published).toEqual(expect.arrayContaining(["action.ts", "read.ts", "redirect.ts", "routes.ts", "config.ts"]));

  const foreign: string[] = [];
  for (const name of published) {
    const source = readFileSync(join(SRC, name), "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1] ?? "";
      if (specifier === "react" || specifier.startsWith("./")) continue;
      if (name === "version.ts" && specifier.startsWith("node:")) continue;
      foreign.push(`${name} imports ${specifier}`);
    }
  }
  expect(foreign).toEqual([]);
});
