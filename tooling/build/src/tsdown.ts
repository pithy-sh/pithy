// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { UserConfig } from "tsdown";

/**
 * How every published package is built: to JavaScript Node can run, with declarations beside it.
 *
 * ## Why there is a build at all
 *
 * The packages used to point `exports` at raw `./src/*.ts`. That works for anything with a bundler —
 * wrangler, Vite, vitest transforming a test file — and fails for the one consumer that has none:
 * **node itself**, which refuses to strip types under `node_modules` and cannot be argued out of it.
 * An adopter's `vitest.config.ts` importing `@pithy-sh/vite` died there, and so would any Node script.
 *
 * ## Every source file is an entry
 *
 * `exports` is `./src/*`, a deep-import surface — `@pithy-sh/core/src/error/pithyError` is a real path
 * an adopter writes. So the build cannot collapse to one bundle: each module keeps its own file, and
 * the map points at the built one.
 *
 * The entry is stated as globs and left to tsdown to expand. A hand-rolled walk was written first and
 * was the wrong instinct twice over: it is the sixth copy of a traversal this repository already owns
 * a primitive for (`packages/cli/src/ci/sourceFiles.ts`, which `sourceFiles.test.ts` enforces), and the
 * one place it cannot use that primitive is here, since every package's `tsdown.config.ts` imports this
 * and `@pithy-sh/cli` depends on those packages. Globs need neither.
 *
 * ## Siblings stay external
 *
 * `@pithy-sh/*` imports are left alone rather than inlined. They are real dependencies with real
 * versions, and inlining would put a copy of `core` inside all twenty packages that depend on it —
 * twenty copies to keep in step, and every `instanceof` across them false. They resolve to each other's
 * built output, which is exactly what an adopter's installer does.
 */
/** What a package needs to say about its own build, when the defaults are not the whole story. */
export interface LibraryBuildOptions {
  /**
   * Modules under `src` that are **not** part of the deep-import surface, as globs.
   *
   * There is one kind of these and it is worth naming rather than leaving to judgment: the entry of a
   * *separate* bundle the package also ships. `@pithy-sh/payments`' `src/client/paddlePrices.iife.ts`
   * is compiled by `scripts/buildPaddlePrices.ts` into one browser IIFE that `exports` names directly,
   * so building it here as well emits a module nothing imports — and, because the same file is excluded
   * from `tsconfig.build.json` for needing the DOM, one with no declaration beside it. A published
   * module missing half its pair is what `packaging.test.ts` refuses.
   *
   * Whatever is listed here has to be listed in two other places, and the gate is what says so. Its
   * package's `tsconfig.build.json` `exclude`, because the two halves are emitted by different tools
   * and a module with one and not the other is a deep import that resolves to a type-less module. And
   * its `files` negations, because a source file in the tarball with no built pair reads to
   * `packaging.test.ts` as a published module that failed to build — which, from the outside, is
   * indistinguishable from one that did.
   */
  readonly exclude?: readonly string[];
}

export function libraryBuild(options: LibraryBuildOptions = {}): UserConfig {
  return {
    // Every module a consumer can deep-import: the whole of `src`, minus what is not a module. A
    // `.d.ts` is a declaration — built as an entry it becomes `cloudflare-test.d.js`, an empty file
    // with no types beside it and nothing importing it — and a test is not published.
    entry: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "!src/**/*.d.ts",
      "!src/**/*.test.ts",
      "!src/**/*.test.tsx",
      ...(options.exclude ?? []).map((pattern) => `!${pattern}`),
    ],
    format: "esm",
    platform: "neutral",
    target: "node22",
    // **Declarations come from `tsc`, not from here.** tsdown bundles them, which flattens
    // `src/error/pithyError.ts` to `dist/pithyError.d.ts` — and `exports` is `./src/*`, a deep-import
    // surface whose types must sit at the same path as the JavaScript beside them. `tsc
    // --emitDeclarationOnly` mirrors the tree exactly, so the build runs it after this and the two
    // halves land together. `clean` here, and nothing after it, is why the order matters.
    dts: false,
    clean: true,
    // Nothing is bundled in: siblings and third parties are dependencies, and the tarball declares them.
    deps: { neverBundle: [/^@pithy-sh\//, /^[^./]/] },
  };
}
