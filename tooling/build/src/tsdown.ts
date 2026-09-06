// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
 * ## Siblings stay external
 *
 * `@pithy-sh/*` imports are left alone rather than inlined. They are real dependencies with real
 * versions, and inlining would put a copy of `core` inside all twenty packages that depend on it —
 * twenty copies to keep in step, and every `instanceof` across them false. They resolve to each other's
 * built output, which is exactly what an adopter's installer does.
 */
export function libraryBuild(): UserConfig {
  return {
    entry: sourceEntries("src"),
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

/** Every module a consumer can deep-import — the whole of `src`, tests excluded. */
function sourceEntries(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceEntries(path, found);
      // A `.d.ts` is a declaration, not a module. Built as an entry it becomes `cloudflare-test.d.js`,
      // an empty file with no types beside it and nothing importing it.
    } else if (path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.includes(".test.")) {
      found.push(path);
    }
  }
  return found;
}
