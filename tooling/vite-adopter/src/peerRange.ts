// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithy } from "@pithy-sh/vite/src/plugin";
import { pithyTest } from "@pithy-sh/vite/src/testPlugin";
import { defineConfig as defineConfig6, type PluginOption as PluginOption6 } from "vite";
import { defineConfig as defineConfig7, type PluginOption as PluginOption7 } from "vite7";
import { defineConfig as defineConfig8, type PluginOption as PluginOption8 } from "vite8";

/**
 * The gate for #414: an adopter who resolved a different Vite than the kit did can still compile the
 * config `pithy init` wrote for them.
 *
 * **Typechecking the kit against the kit is what always passed.** `@pithy-sh/vite` declares
 * `vite: ^6.1.0 || ^7.0.0 || ^8.0.0` and compiles against exactly one copy of it — its own — so a
 * signature that quietly required the adopter to resolve that same copy looked correct from inside the
 * monorepo and from inside CI, for as long as the surface existed. It was found by an adopter,
 * `pithy-sh/dashboard`, whose `bun install` put Vite 8.2.0 beside the kit's 8.2.1: the scaffolded
 * `vite.config.ts` failed with `TS2321: Excessive stack depth comparing types`, because `pithy()`
 * returned the kit's `Plugin` and the checker had to prove it assignable to the adopter's, field by
 * recursive field, before the `plugins` array would compile.
 *
 * Proving the fix needs **two resolutions of Vite present at once**, which is why this is a package
 * rather than one more file in `packages/vite`. This one pins a copy of each major in the declared peer
 * range; `@pithy-sh/vite` next door resolves `^8.0.16`. TypeScript follows the realpath of a symlinked
 * package, so `plugin.ts` compiles here against the kit's Vite exactly as it does in the kit, while the
 * lines below are checked against three others. That is the adopter's install, reproduced.
 *
 * **Both entry points, because both are adopter-facing.** `pithy()` goes in a `vite.config.ts` and
 * `pithyTest()` goes in a `vitest.config.ts`; the defect was in the return type, which they shared.
 *
 * **Two spellings per major, and the annotation is the one that bites.** `PluginOption` states the
 * property exactly: this is a thing the adopter's Vite accepts in `plugins`. The `defineConfig` calls
 * are the expression an adopter actually writes, and they are kept for that — but they are not the
 * gate. Measured, with `pithy(): Plugin` restored and the annotations removed: Vite 6 and Vite 7 fail
 * on the call, and **Vite 8 reports nothing at all.** A file built only from call shapes would have gone
 * green on the one case this issue is about, and read as covering all three.
 *
 * **The pins are exact versions, and each was watched failing.** A range that could resolve to whatever
 * `@pithy-sh/vite` resolved would let two copies deduplicate onto one, and this file would go on passing
 * while comparing a type to itself. With `pithy(): Plugin` restored, 6.1.6 and 7.0.0 fail on `hotUpdate`
 * not carrying the same `this`, and 8.0.0 produces the `TS2321` above — nothing incompatible, just a
 * comparison too deep to finish. 8.0.0 also sits below the `^8.0.16` floor the kit installs, so the two
 * copies of the major the kit develops against can never become one. `resolution.test.ts` beside this
 * holds all of that: the pins against the declared range, and the four copies against each other.
 *
 * Nothing here is run. Compiling it is the point.
 */
export const six: [PluginOption6, PluginOption6] = [pithy(), pithyTest()];

/** Vite 6, as an adopter writes it. See {@link six} for why the annotation above is the sharper half. */
export const sixConfig = defineConfig6({ plugins: [pithy(), pithyTest()] });

/** Vite 7, the middle of the peer range. */
export const seven: [PluginOption7, PluginOption7] = [pithy(), pithyTest()];

/** Vite 7, as an adopter writes it. */
export const sevenConfig = defineConfig7({ plugins: [pithy(), pithyTest()] });

/**
 * Vite 8 — the major the kit itself develops against, pinned below the copy it installs. This is the
 * case the dashboard hit: same major, different copy, and nothing whatever incompatible about it.
 */
export const eight: [PluginOption8, PluginOption8] = [pithy(), pithyTest()];

/** Vite 8, as an adopter writes it. */
export const eightConfig = defineConfig8({ plugins: [pithy(), pithyTest()] });
