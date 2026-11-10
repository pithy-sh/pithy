// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { isolatedCheckNotice } from "../feature/isolatedCheck";

/**
 * **`scripts/worktree.ts setup` ends on the isolated dependency check.** A kit worktree sits under the main
 * checkout, so a package its own `node_modules` lacks resolves from the main checkout's, and a dependency removal
 * passes the gates there. The script sits outside this package's `rootDir`, so its exported `setupLines` is run
 * through `bun -e`.
 */

const SCRIPT = resolve(import.meta.dirname, "..", "..", "..", "..", "scripts", "worktree.ts");

function setupLines(heading: string, branch: string, wtPath: string, root: string): string[] {
  const args = [heading, branch, wtPath, root].map((arg) => JSON.stringify(arg)).join(", ");
  const program = `import { setupLines } from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(setupLines(${args})));`;
  return JSON.parse(execFileSync("bun", ["-e", program], { encoding: "utf8" }));
}

describe("setupLines", () => {
  const root = "/code/pithy";
  const wtPath = "/code/pithy/.worktrees/12-fix-thing";

  test("a new worktree names itself and its branch, then shows the check outside the checkout", () => {
    expect(setupLines("Worktree ready.", "feature/12-fix-thing", wtPath, root)).toEqual([
      `Worktree ready. ${wtPath}`,
      "Branch feature/12-fix-thing.",
      ...isolatedCheckNotice({ worktree: wtPath, root, packageManager: "bun" }),
    ]);
  });

  test("an existing worktree shows the same check", () => {
    const lines = setupLines("Worktree exists.", "feature/12-fix-thing", wtPath, root);
    expect(lines[0]).toBe(`Worktree exists. ${wtPath}`);
    expect(lines.slice(2)).toEqual(isolatedCheckNotice({ worktree: wtPath, root, packageManager: "bun" }));
  });
});
