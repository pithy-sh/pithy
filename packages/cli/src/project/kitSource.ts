// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { kitResolve } from "./kitResolve";

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
 * ## Why the base is the project and not this module
 *
 * This resolved with `import.meta.resolve`, whose base is *this file* — so a globally installed `pithy`
 * returned the CLI's own bundled copy of a host worker, silently and with a real path on the end of it.
 * `pithy payments provision` then deployed **the CLI's** reconcile worker under the adopter's name. That
 * is #533's defect in its quietest form: no error, no refusal, a wrong artifact in production. The base
 * is the project's, for the reason {@link kitResolve} states.
 *
 * @param projectDir the project root the specifier is resolved from — where its `pithy.config.ts` was read.
 * @throws InternalError when the specifier does not resolve into a package's build, which means the
 * layout this depends on has changed and every host deployment is about to read the wrong directory.
 */
export function kitSource(projectDir: string, specifier: string): string {
  const built = kitResolve(projectDir, specifier);
  const source = built.replace(/([\\/])dist\1(.+)\.js$/, "$1src$1$2.ts");
  if (source === built) {
    throw new InternalError({
      message: "A kit module could not be located.",
      detail: `${specifier} resolved to ${built}, which is not inside a package's dist. See kitSource.`,
    });
  }
  return source;
}
