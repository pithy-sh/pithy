// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { isolatedCheckNotice } from "./isolatedCheck";

/**
 * **A worktree under the main checkout resolves a package its own `node_modules` lacks from the checkout's.**
 *
 * So a dependency removed on the branch still resolves in the worktree, and the change fails only on a clean
 * install. `pithy feature create` says so, and shows the check that runs outside the checkout.
 */

const WORKTREE = "/home/you/acme/.worktrees/12-media-cli";
const ROOT = "/home/you/acme";

describe("isolatedCheckNotice", () => {
  test("names the checkout the worktree falls back to", () => {
    const [warning] = isolatedCheckNotice({ worktree: WORKTREE, root: ROOT, packageManager: "bun" });
    expect(warning).toBe(
      "A package this worktree's node_modules lacks resolves from /home/you/acme/node_modules, so a dependency change can pass here and fail on a clean install. Verify one outside the checkout:",
    );
  });

  test("shows the copy, the frozen install and the gates, outside the checkout", () => {
    const [, ...steps] = isolatedCheckNotice({ worktree: WORKTREE, root: ROOT, packageManager: "bun" });
    expect(steps).toEqual([
      '  dir="$(mktemp -d)" && cp -R /home/you/acme/.worktrees/12-media-cli "$dir" && cd "$dir/12-media-cli"',
      "  bun install --frozen-lockfile",
      "  Then run your typecheck, lint and tests there.",
    ]);
  });

  test("spells the frozen install in the project's own package manager", () => {
    expect(isolatedCheckNotice({ worktree: WORKTREE, root: ROOT, packageManager: "npm" })[2]).toBe("  npm ci");
    expect(isolatedCheckNotice({ worktree: WORKTREE, root: ROOT, packageManager: "pnpm" })[2]).toBe(
      "  pnpm install --frozen-lockfile",
    );
  });

  test("quotes a path the shell would split", () => {
    const [, copy] = isolatedCheckNotice({
      worktree: "/home/you/my acme/.worktrees/12-media-cli",
      root: "/home/you/my acme",
      packageManager: "bun",
    });
    expect(copy).toBe(
      `  dir="$(mktemp -d)" && cp -R '/home/you/my acme/.worktrees/12-media-cli' "$dir" && cd "$dir/12-media-cli"`,
    );
  });
});
