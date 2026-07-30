// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { afterEach, describe, expect, test } from "vitest";
import { pithy } from "./plugin";

/**
 * A failed config load must not be cached.
 *
 * The plugin memoizes the config-load *promise*, because `load` runs concurrently for every virtual
 * module a bundle imports and each `runnerImport` builds a fresh environment. Memoizing a rejection
 * too would wedge the dev server: the most likely first failure is `pithy dev` before `bun install`,
 * where the config's `@pithy-sh/*` imports do not resolve, and no later edit could clear it — the
 * watch set only learns the config's transitive imports from a load that succeeded, so `hotUpdate`
 * would not even fire for the file the developer fixes.
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The plugin's hooks, typed for direct invocation, with `configResolved` already applied. */
function driver(root: string) {
  const hooks = pithy() as unknown as {
    configResolved: (config: ResolvedConfig) => void;
    configureServer: (server: { watcher: { add: (path: string) => void } }) => void;
    load: (id: string) => Promise<string | null>;
  } & Plugin;
  hooks.configResolved({ root } as ResolvedConfig);
  return hooks;
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-vite-"));
  dirs.push(dir);
  return dir;
}

describe("config-load failure recovery", () => {
  test("a load that fails on a transitive import recovers once the import is fixed", async () => {
    const dir = await scratch();
    const config = join(dir, "pithy.config.ts");
    const dep = join(dir, "capabilities.ts");
    await writeFile(config, 'import { capabilities } from "./capabilities";\nexport default { capabilities };', "utf8");
    // A syntax error in a file the config imports — not in the config itself.
    await writeFile(dep, "export const capabilities = [ { name: 'auth', ", "utf8");

    const hooks = driver(dir);
    const watched: string[] = [];
    hooks.configureServer({ watcher: { add: (path) => watched.push(path) } });

    await expect(hooks.load("\0virtual:pithy/auth")).rejects.toThrow();

    await writeFile(
      dep,
      'export const capabilities = [{ name: "auth", requiredBindings: [], client: () => ({ enabled: true }) }];',
      "utf8",
    );

    // No hot update, no restart: the next request alone must be enough.
    const recovered = await hooks.load("\0virtual:pithy/auth");
    expect(recovered).toContain("export const enabled = true;");
  });

  test("the config file itself is watched even when the first load fails", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "pithy.config.ts"), "export default { capabilities: [ ", "utf8");

    const hooks = driver(dir);
    const watched: string[] = [];
    hooks.configureServer({ watcher: { add: (path) => watched.push(path) } });

    await expect(hooks.load("\0virtual:pithy/auth")).rejects.toThrow();
    // Watching the config unconditionally is the other half of recovery: a fix to the config itself
    // has to fire hotUpdate, and it cannot learn that path from a load that never succeeded.
    expect(watched.some((path) => path.endsWith("pithy.config.ts"))).toBe(true);
  });

  test("a missing config is an actionable PithyError, not a raw module-resolution stack", async () => {
    const dir = await scratch();
    const hooks = driver(dir);
    await expect(hooks.load("\0virtual:pithy/auth")).rejects.toThrow(/pithy\.config\.ts/);
  });
});
