// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Where a kit module's **source** is, given the specifier that resolves it.
 *
 * ## Why the exports map is not the whole answer
 *
 * Every `@pithy-sh/*` package publishes a build (#476), and its `exports` map sends
 * `@pithy-sh/email/src/workflows/worker` to `dist/workflows/worker.js`. For an importer that is exactly
 * right and is the point of the change. For the handful of call sites that want the *file on disk* it
 * is not, and they are all one kind of call site: the CLI resolving a **host worker** it is about to
 * hand to wrangler.
 *
 * Those directories hold two things — a `worker.ts` and the committed `wrangler.jsonc` beside it whose
 * `main` names it. Wrangler bundles TypeScript itself, so the source directory is what it is given, and
 * `dist` holds no `wrangler.jsonc` at all: it is a compiler's output, and nothing copies a hand-written
 * config into it. Resolving to `dist` therefore turned every host deployment into `ENOENT` on a config
 * that was sitting, correctly, one directory over.
 *
 * ## Why mapping the path is exact rather than a guess
 *
 * `tsdown` and `tsc -p tsconfig.build.json` both mirror `src/` into `dist/`, one emitting `.js` and the
 * other `.d.ts` at the identical path, so `dist/workflows/worker.js` and `src/workflows/worker.ts` are
 * the same path under a different root. `packaging.test.ts` fails on any published module that has one
 * half without the other, so the mirror is a checked property rather than a convention.
 *
 * It also holds in an adopter's `node_modules`, which is the case that actually has to work: every
 * `@pithy-sh/*` package ships `src` alongside `dist` in its tarball — for source maps, and for exactly
 * this. `packing.ts` refuses a package that ships no `src`.
 *
 * @throws InternalError when the specifier does not resolve into a package's build, which means the
 * layout this depends on has changed and every host deployment is about to read the wrong directory.
 */
export function kitSource(specifier: string): string {
  const built = fileURLToPath(import.meta.resolve(specifier));
  const source = built.replace(/([\\/])dist\1(.+)\.js$/, "$1src$1$2.ts");
  if (source === built) {
    throw new InternalError({
      message: "A kit module could not be located.",
      detail: `${specifier} resolved to ${built}, which is not inside a package's dist. See kitSource.`,
    });
  }
  return source;
}
