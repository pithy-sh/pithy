// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type PithyPluginHook, pithy } from "@pithy-sh/vite/src/plugin";
import { pithyTest } from "@pithy-sh/vite/src/testPlugin";
import { defineConfig as defineConfig6, type Plugin as Plugin6, type PluginOption as PluginOption6 } from "vite";
import { defineConfig as defineConfig7, type Plugin as Plugin7, type PluginOption as PluginOption7 } from "vite7";
import { defineConfig as defineConfig8, type Plugin as Plugin8, type PluginOption as PluginOption8 } from "vite8";

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
 * Nothing here is run. Compiling it is the point — and compiling it proves the *return type*, which is
 * all #414 was about and less than a reader of this file might assume. What the hooks do at 6 and 7 is
 * `hooks.test.ts` beside this, which builds a real project through the plugin at each major; what the
 * hook set is called is the three assertions at the foot of this file. Both were added on 2026-08-21,
 * after a review pointed out that this file alone proves a two-property object is a `PluginOption`.
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

/**
 * `true` only when `T` is `any`. `1 & T` collapses to `any` there and nothing else, which is the one
 * question `extends` cannot be asked directly.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** Mutual assignability. `any` satisfies it in both directions, which is why {@link IsAny} sits beside it. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The shape `pithy()` promises, written out here rather than imported.
 *
 * **A gate derived from its own subject proves nothing.** Comparing the return type to the kit's
 * `PithyPlugin` would pass whatever `PithyPlugin` became — including `any`, and including a Vite type
 * put back. The two properties are restated so that widening the promise means editing the promise
 * *and* the file that holds it, which is a thing a reviewer sees.
 */
type Promised = { name: string; enforce: "pre" };

/**
 * **`pithy(): any` passed every gate in this repository — Jim, 2026-08-21.** The three annotations
 * above, `packages/vite`'s own typecheck, the suite, and Biome, whose `noExplicitAny` is a warning and
 * whose `ci` exits 0 on warnings. `any` is assignable to `PluginOption`, so a fixture built only from
 * assignability cannot tell a narrow owned type from no type at all — and this fixture is what stands
 * between an adopter and a broken config.
 *
 * `never` is the other one and it is caught by {@link Exactly} below: it is assignable to everything,
 * so it too satisfies a `PluginOption` annotation.
 */
export const pluginIsNotAny: IsAny<ReturnType<typeof pithy>> = false;

/** `pithyTest()` is the same surface, awaited, and takes the same two checks. */
export const testPluginIsNotAny: IsAny<Awaited<ReturnType<typeof pithyTest>>> = false;

/** Exactly the two properties, no more and no fewer — so a Vite type put back is a red build here. */
export const pluginIsExactlyPromised: Exactly<ReturnType<typeof pithy>, Promised> = true;

/** The same, awaited, for the test-runner entry point. */
export const testPluginIsExactlyPromised: Exactly<Awaited<ReturnType<typeof pithyTest>>, Promised> = true;

/**
 * Every hook the plugin defines is a hook all three majors call.
 *
 * **This is the only thing about the hooks that crosses the range, and it is worth saying why.** The
 * signatures cannot cross. Vite 8 is rolldown-based and 6 and 7 are rollup-based, so `hotUpdate`'s
 * `this` is a `MinimalPluginContext` out of two different bundlers and no single object can be written
 * against both — restoring `pithy(): Plugin` reports precisely that at 6.1.6 and 7.0.0, and it is a
 * fact about the two Vites, not about this plugin. `packages/vite` checks the signatures against the
 * one Vite it develops against, `hooks.test.ts` beside this file runs a real build through the plugin
 * at each of the three, and this line covers the third thing: **a hook name.** A plugin that defines
 * `buildApp` — Vite 7 introduced it and Vite 6 has no name for it — under a range claiming `^6.1.0` is
 * dead code at 6 that reads as a feature, and nothing else here would say so. Watched failing with
 * exactly that name added to `PITHY_PLUGIN_HOOKS`: `hooksExistInSix` reddened and the other two did
 * not, which is also how the three lines are known not to be measuring the same copy twice.
 *
 * `keyof Plugin` rather than a hand-written list of hook names, in each major's own copy, so the answer
 * comes from Vite.
 */
export const hooksExistInSix: PithyPluginHook extends keyof Plugin6 ? true : false = true;

/** Vite 7's hook names. */
export const hooksExistInSeven: PithyPluginHook extends keyof Plugin7 ? true : false = true;

/** Vite 8's hook names. */
export const hooksExistInEight: PithyPluginHook extends keyof Plugin8 ? true : false = true;
