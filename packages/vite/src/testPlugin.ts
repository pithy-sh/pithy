// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { type Plugin, runnerImport } from "vite";
import type { PithyPluginOptions } from "./plugin";

/**
 * `./plugin.ts`, as an absolute path.
 *
 * From `import.meta.url` rather than from a bare specifier: this file's own realpath is the one place
 * the build plugin is certainly beside, whatever an adopter's `node_modules` looks like — a symlinked
 * checkout, a hoisted install, a worktree.
 */
const BUILD_PLUGIN = fileURLToPath(new URL("./plugin.ts", import.meta.url));

/**
 * The Pithy plugin, for a test runner's config.
 *
 * **It is not a second plugin.** It resolves to the object {@link pithy} returns, built from
 * `./plugin.ts` itself, so a test imports the module a build inlines — same config, same
 * `resolveClientProjection`, same `renderVirtualModule`, same bytes. There is no fixture here, and
 * therefore nothing that can drift from the projection. `testPlugin.test.ts` holds that: it renders a
 * module through the build plugin's own `load` hook and makes a real child `vitest` run compare what it
 * imports against it.
 *
 * ## Why the indirection exists at all
 *
 * Vitest loads its config by bundling it and leaving every **bare** specifier to node. So
 * `import { pithy } from "@pithy-sh/vite/src/plugin"` in a `vitest.config.ts` is handed to node, which
 * loads `plugin.ts` — and stops at its `@pithy-sh/core/src/capability/client` import, whose own
 * `../error/pithyError` has no extension for node to resolve. The config never loads and no test runs.
 * `vitest.shared.ts` in this repository documents the same wall from the other side, for the same reason.
 *
 * This module's whole static graph is `vite` and `node:url` — both things node loads — and the kit
 * source is reached through {@link runnerImport}, which is vite's own loader and resolves extensionless
 * TypeScript the way every other Pithy import site does. That constraint is load-bearing: **any
 * `@pithy-sh/*` import added to this file breaks every adopter's test run at config load.** The child
 * run in `testPlugin.test.ts` is what says so out loud.
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
 * A promise, because vite awaits a plugin. That is a documented `PluginOption`, and it is what lets the
 * real plugin be built by vite's loader instead of restated for node's.
 */
export function pithyTest(options: PithyPluginOptions = {}): Promise<Plugin> {
  return runnerImport<typeof import("./plugin")>(BUILD_PLUGIN).then(({ module }) => module.pithy(options));
}
