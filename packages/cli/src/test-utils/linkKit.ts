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

/**
 * **Install capability packages as links to copies inside the fixture — the arrangement a fixture that
 * *deploys* needs (#650 review).**
 *
 * {@link linkKitPackages} points the project at the repository's own `packages/<name>`, which is right until
 * something writes there. `deployHostWorker` does: it writes each host's resolved config and generated entry
 * beside that host's worker module, and through a link that is `packages/email/src/workflows/`. Those files are
 * not git-ignored and turbo's `inputs` negations do not reach them, so they land in another task's hashed input
 * set while `ci/turboInputs.test.ts` compares two `--dry=json` plans — the failure 34b55c6b fixed for
 * `deployKit.test.ts`, met again by two more fixtures.
 *
 * **A link to a copy rather than a copy in `node_modules`**, because both halves have to hold: `pithy add` must
 * not reach the registry, and it skips it only for a package whose realpath is *outside* the project's
 * `node_modules` ({@link alreadyProvided}) — which a copy sitting inside it is not. A link to
 * `<projectDir>/.kit/<name>` satisfies that, and every write the deploy makes lands in the directory the
 * fixture's `afterAll` removes.
 *
 * **Each copy's own `@pithy-sh` scope is dropped.** The workspace install leaves
 * `packages/auth/node_modules/@pithy-sh` linking back at the repository's packages, so a copied `auth` read the
 * repository's `secrets` while the fixture composed its own copy — two module-level configs, and
 * `configureSharedSecrets` wrote to one of them (`packageManager.ts` names that failure exactly). Without it,
 * `@pithy-sh/*` resolves up to the fixture's own scope; everything else in that directory stays put.
 *
 * **`@pithy-sh/core` is deliberately not copied by any caller.** It carries the composition registry a fixture's
 * harness reads through `createEntrypoint`, so the fixture and the harness must have one core — which is what a
 * plain link to the repository's gives them.
 */
export async function linkKitCopies(projectDir: string, packages: readonly string[]): Promise<void> {
  const scope = join(projectDir, "node_modules", "@pithy-sh");
  await mkdir(scope, { recursive: true });
  for (const name of packages) {
    const copy = join(projectDir, ".kit", name);
    await cp(await realpath(join(REPO_ROOT, "packages", name)), copy, { recursive: true, dereference: false });
    await rm(join(copy, "node_modules", "@pithy-sh"), { recursive: true, force: true });
    await rm(join(scope, name), { recursive: true, force: true });
    await symlink(copy, join(scope, name));
  }
}
