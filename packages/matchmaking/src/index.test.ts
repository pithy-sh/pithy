// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);

/** The package root — this file lives at `packages/matchmaking/src/`. */
const PACKAGE = join(import.meta.dirname, "..");

/**
 * The entry point an adopter's `pithy.config.ts` imports must resolve in a plain Node process.
 *
 * `pithy add matchmaking` writes `import { matchmaking } from "@pithy-sh/matchmaking/src/index"` into
 * `pithy.config.ts`, and that file is loaded by *Node-side* tooling — `pithy upgrade`, `pithy migrate`,
 * `pithy deploy`, every command that needs to know what the project composes. An entry point that reaches
 * a Workers-only module therefore takes the whole CLI down for any project composing this capability, and
 * the failure surfaces as "could not load pithy.config.ts", naming the wrong cause. This entry point did
 * exactly that: it re-exported both Durable Object classes, so importing it pulled in `cloudflare:workers`
 * and threw everywhere but workerd (#180, the same defect `@pithy-sh/multiplayer` shipped as #172).
 *
 * **Why this lives here and not only in the CLI.** `configEntrypoints.test.ts` holds every catalogued
 * capability to this, but scope there is `CATALOG` — and `@pithy-sh/matchmaking` is not catalogued yet.
 * Nothing would have caught this until the commit that adds the catalog entry, which is the commit it
 * would otherwise have shipped broken on. A package carries its own gate until the shared one reaches it.
 *
 * **The invariant, not a blocklist.** This does not scan for `cloudflare:workers` or any other named
 * module — it performs the import and requires it to succeed. It runs in its own `bun` process, from the
 * package directory, so resolution is the real thing rather than vitest's transform pipeline: a
 * runtime-only module aliased away by a test runner would be the one way to pass here while still being
 * broken in the field.
 */
describe("@pithy-sh/matchmaking/src/index", () => {
  test("imports in a real Node process", async () => {
    await expect(
      run("bun", ["-e", 'await import("@pithy-sh/matchmaking/src/index")'], { cwd: PACKAGE }),
    ).resolves.toBeDefined();
  });
});
