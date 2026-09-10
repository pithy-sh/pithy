// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/** This repository's root — where `packages/<name>` lives. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * Install capability packages into a fixture project, by symlink, the way a linked checkout does.
 *
 * A fixture scaffolded into `tmpdir()` has no `node_modules`, and until #533 that did not matter: the CLI
 * resolved `@pithy-sh/vector` from **its own** location, so a project with nothing installed loaded the
 * capability anyway. That was the bug — the project no longer decides — and the fixtures were quietly
 * relying on it. Now a fixture that means to compose a capability has to have it, which is the same thing
 * an adopter's project has to have.
 *
 * The link points at `packages/<name>`, not at whatever an install hoisted where: node resolves a
 * symlinked package from its realpath, so the linked package's own imports (`@pithy-sh/core`, `hono`,
 * `kysely`) resolve up the workspace's chain exactly as they do for the package's own tests.
 *
 * `@pithy-sh/<name>` is the only spelling this handles, because a capability package name *is* its
 * directory under `packages/`. A fixture wanting a third-party dependency wants `scaffoldGates.test.ts`'s
 * whole link farm instead.
 *
 * ## Never write a file into a package this has linked
 *
 * The link is to the repository's **own** `packages/<name>`, so `writeFile` on a path inside it follows
 * the link and overwrites the real, shipped file. `doctor/bindingScope.test.ts` did exactly that and
 * truncated `packages/email/pithy.manifest.json` from 73 lines to the 10 of its fixture — silently, since
 * the fixture's own assertions passed and the damage surfaced four files away, in whatever suite next read
 * the real manifest. The `afterEach` that removes the fixture removes the symlink and never the target, so
 * the corruption outlives the test that caused it and lands in a commit.
 *
 * A fixture that means to *overwrite* something inside a kit package calls {@link materializeKitPackage}
 * first, which swaps the link for a real copy. There is no way to make a linked directory safe to write
 * into, so the rule is the link or the write, never both.
 */
export async function linkKitPackages(projectDir: string, packages: readonly string[]): Promise<void> {
  const scope = join(projectDir, "node_modules", "@pithy-sh");
  await mkdir(scope, { recursive: true });
  for (const name of packages) {
    try {
      await symlink(await realpath(join(REPO_ROOT, "packages", name)), join(scope, name));
    } catch {
      // Already linked by an earlier call. A fixture reused across cases is the ordinary reason.
    }
  }
}

/**
 * Replace a linked package with a real copy, so a fixture may overwrite files inside it.
 *
 * The one thing {@link linkKitPackages} cannot survive is a write. A copy can: it has its own inodes, so
 * an overwritten `pithy.manifest.json` is the fixture's and the repository's stays as it shipped.
 *
 * **The copy carries a `node_modules` link back to the workspace**, because a package's code is only
 * loadable where its own dependencies resolve. Linked, `@pithy-sh/email/dist/*.js` reached `hono`,
 * `kysely` and `@pithy-sh/core` by resolving from its realpath up the workspace's chain; copied into a
 * `tmpdir()`, that chain is gone. One symlink at the copy's own `node_modules` restores it, and it is a
 * link rather than a copy because nothing writes there.
 *
 * Idempotent: calling it twice, or on a package that was never linked, leaves a copy either way.
 */
export async function materializeKitPackage(projectDir: string, name: string): Promise<void> {
  const source = await realpath(join(REPO_ROOT, "packages", name));
  const target = join(projectDir, "node_modules", "@pithy-sh", name);
  // `rm` on a symlink removes the link, never what it points at — which is the whole point of doing this
  // before the copy rather than copying over the top of a live link.
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, dereference: false });
  await symlink(join(REPO_ROOT, "node_modules"), join(target, "node_modules")).catch(() => {
    // The package ships its own `node_modules`, or the link is already there. Either way it can resolve.
  });
}
