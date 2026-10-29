// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The published source imports React, node, itself, and `@pithy-sh/ui-core` — whose hooks `src/read`, `src/action`
 * and `src/redirect` re-export at the paths scaffolded screens already import. Nothing else: this package's
 * templates import the capability packages, and the runtime it ships stays as small as those three paths.
 */
test("the published source imports nothing but react, node, ui-core and its own modules", () => {
  const published = readdirSync(SRC).filter(
    (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"),
  );
  expect(published).toEqual(expect.arrayContaining(["action.ts", "read.ts", "redirect.ts", "templates.ts"]));

  const foreign: string[] = [];
  for (const name of published) {
    const source = readFileSync(join(SRC, name), "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1] ?? "";
      if (specifier === "react" || specifier.startsWith("node:") || specifier.startsWith("./")) continue;
      if (specifier.startsWith("@pithy-sh/ui-core/src/")) continue;
      foreign.push(`${name} imports ${specifier}`);
    }
  }
  expect(foreign).toEqual([]);
});
