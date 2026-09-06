// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type PithyPlugin, type PithyPluginOptions, pithy } from "./plugin";

/**
 * The Pithy plugin, for a test runner's config.
 *
 * **It is not a second plugin.** It calls {@link pithy} and hands back what that returns — same config,
 * same `resolveClientProjection`, same `renderVirtualModule`, same bytes. There is no fixture here, and
 * therefore nothing that can drift from the projection.
 *
 * ## It is now a one-line redirect, and it was not always — Jim, #476
 *
 * Vitest loads its config by bundling it and leaving every **bare** specifier to node. Until this
 * package shipped a build, `import { pithy } from "@pithy-sh/vite/src/plugin"` in a `vitest.config.ts`
 * therefore handed node `plugin.ts` — TypeScript, under `node_modules`, where node refuses to strip
 * types — and its `@pithy-sh/core/src/capability/client` import had no extension for node to resolve
 * either. The config never loaded and no test ran, transitively taking every screen that read a
 * projection with it. Three lanes in `pithy-sh/dashboard` hit it independently, and this module was the
 * way round: its whole static graph was `vite` and `node:url`, and the plugin was reached through
 * vite's own loader rather than node's.
 *
 * `dist/plugin.js` is JavaScript with real extensions on its imports, so node loads it, and
 * `vitestConfig.test.ts` makes a real child `vitest` run say so — it drives the **build** plugin from a
 * bare specifier in an adopter-shaped project. The wall is gone and the loader hop with it.
 *
 * **What stays is the name.** `pithyTest` is exported from 0.1.0 and `pithy-sh/dashboard` names it in
 * its own configs, so removing it would break a working install to save a line. It is kept as the
 * documented spelling for a test config, and can be dropped whenever nothing imports it — there is no
 * behavior behind it left to maintain.
 *
 * ## What an adopter writes
 *
 * One line, in the test project that mounts client modules — never per consumer:
 *
 * ```ts
 * import { pithyTest } from "@pithy-sh/vite/src/testPlugin";
 *
 * export default defineConfig({
 *   plugins: [pithyTest({ configFile: "apps/board/pithy.config.ts" })],
 *   test: { environment: "happy-dom" },
 * });
 * ```
 *
 * `configFile` resolves against the Vite root, which for a test run is usually the repository root
 * rather than the Worker's directory — so a monorepo names the Worker, and a single-Worker project takes
 * the default.
 *
 * Still a promise, and still `Promise<PithyPlugin>` rather than `Promise<Plugin>`. The promise is part
 * of the published signature and a documented `PluginOption`, so awaiting nothing is cheaper than
 * changing what an adopter's config is typed against; the return type is for the reason
 * {@link PithyPlugin} gives (#414) — a Vite type in this signature is *this package's* Vite type, and an
 * adopter's `vitest.config.ts` cannot be checked against it unless their install happened to
 * deduplicate onto the same copy.
 */
export function pithyTest(options: PithyPluginOptions = {}): Promise<PithyPlugin> {
  return Promise.resolve(pithy(options));
}
