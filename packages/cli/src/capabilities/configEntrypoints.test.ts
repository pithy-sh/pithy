// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CATALOG, capabilityPackageDir, capabilityPackageName } from "./catalog";
import { capabilityImportSpecifier } from "./configImports";

const run = promisify(execFile);

/** `packages/` — this file lives at `packages/cli/src/capabilities/`. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/**
 * Every capability's config entry point must import in a plain Node process.
 *
 * `pithy add` writes `import { x } from "@pithy-sh/x/src/index"` into the adopter's `pithy.config.ts`
 * ({@link capabilityImportSpecifier}), and that file is loaded by *Node-side* tooling — `pithy upgrade`,
 * `pithy migrate`, `pithy deploy`, every command that needs to know what the project composes. So a
 * capability entry point that reaches a Workers-only module is not a Workers concern at all: it takes the
 * whole CLI down for any project composing it, and the failure surfaces as "could not load pithy.config.ts",
 * naming the wrong cause.
 *
 * `@pithy-sh/multiplayer` did exactly this (#172): its entry point re-exported the `MultiplayerSession`
 * Durable Object, and its routes imported two string constants out of that same module, so
 * `import("@pithy-sh/multiplayer/src/index")` dragged in `cloudflare:workers` and threw outside workerd.
 *
 * **The invariant, not a blocklist.** This does not scan for `cloudflare:workers`, `node:` builtins, or any
 * other named module — it performs the import and requires it to succeed. Whatever a future entry point
 * reaches for that Node cannot resolve fails here, without anyone having predicted the name.
 *
 * Each import runs in its own `bun` process, from inside the capability's own package directory, so
 * resolution is the real thing: the module graph an adopter's `pithy.config.ts` pulls in, not vitest's
 * transform pipeline with the CLI's `node_modules` in scope. A runtime-only module resolved by a test
 * runner's aliasing would be the one way to pass this while still being broken in the field.
 *
 * **Scope is {@link CATALOG}** — the set `pithy add` can write a config line for. A package that ships a
 * capability but is not yet catalogued is not reachable from a `pithy.config.ts` and so cannot break one;
 * it comes under this gate on the commit that adds its catalog entry, which is the right moment.
 */
describe("every capability's config entry point loads outside workerd", () => {
  /** One row per package: the catalog name, the directory, and the specifier `pithy add` writes. */
  const entries = [...new Map(CATALOG.map((entry) => [entry.package, entry])).values()].map((entry) => ({
    name: entry.name,
    dir: join(PACKAGES, capabilityPackageDir(entry.name)),
    specifier: capabilityImportSpecifier(capabilityPackageName(entry.name)),
  }));

  test("every catalogued capability is covered, and its entry point exists", () => {
    // A list that silently emptied — or a package whose `src/index.ts` was never written, the
    // `@pithy-sh/secrets` failure `catalog.test.ts` guards from the other side — would make the
    // import test below a no-op that passes.
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.filter((entry) => !existsSync(join(entry.dir, "src", "index.ts")))).toEqual([]);
  });

  test("importing it in a Node process resolves", async () => {
    const failures = await Promise.all(
      entries.map(async (entry) => {
        try {
          await run("bun", ["-e", `await import(${JSON.stringify(entry.specifier)})`], { cwd: entry.dir });
          return undefined;
        } catch (error) {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
          return `${entry.name} — ${entry.specifier} does not import in Node: ${stderr.split("\n")[0]}`;
        }
      }),
    );

    expect(failures.filter((failure) => failure !== undefined)).toEqual([]);
  });
});
