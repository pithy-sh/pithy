// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Vendor the starter template into the package for publication, and take it out again after.
 *
 * `templates/starter` lives at the repo root — one copy, read by the CLI and by the tests that hold
 * the template to the kit's rules. That path is outside `packages/cli`, so `npm pack` never saw it and
 * a published `@pithy-sh/cli` shipped no template at all. `prepack` copies it in, `postpack --clean`
 * removes it, and `files` in the manifest carries it into the tarball. The copy is never committed:
 * two copies of the starter is the failure mode this avoids, not the one it introduces.
 *
 * What gets copied is the allowlist in `templateManifest.ts`, file by file — never the directory. A
 * recursive copy published the maintainer's working tree, `.dev.vars` included.
 *
 * Run by the packer, so it fails loudly. A silent no-op here publishes a CLI whose first command cannot
 * run. `verifyPack.ts` is the post-condition on the artefact, for the packs this hook never sees.
 */

import { copyFile, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { SOURCE, TEMPLATES_DIR, templateFiles } from "./templateManifest";

const TARGET = join(TEMPLATES_DIR, "starter");

/** Every file under `dir`, relative to it, sorted, with `/` separators. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

async function vendor(): Promise<void> {
  const files = templateFiles(SOURCE);
  await rm(TEMPLATES_DIR, { recursive: true, force: true });
  try {
    for (const file of files) {
      const from = join(SOURCE, file);
      // Regular files only. A symlink in the tarball resolves inside the adopter's `node_modules`, and a
      // committed one aimed out of the template would copy whatever it points at.
      if (!(await lstat(from)).isFile()) throw new Error(`${from} is not a regular file. The template ships files.`);
      const to = join(TARGET, file);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    // The post-condition, checked rather than assumed: what landed is the allowlist, exactly.
    const copied = await walk(TARGET);
    if (copied.join("\n") !== files.join("\n")) {
      throw new Error(`Vendored ${TARGET} does not match the git index:\n  got ${copied.join(", ")}`);
    }
    // stderr, not stdout: `npm pack --json` splices a script's stdout into the JSON it prints.
    process.stderr.write(`Vendored ${files.length} committed template files into ${TARGET}\n`);
  } catch (error) {
    // A half-copied `templates/` outlives the failed pack, is gitignored, and then shadows the repo root
    // for every later run in this checkout. Leave nothing.
    await rm(TEMPLATES_DIR, { recursive: true, force: true });
    throw error;
  }
}

/**
 * True in a checkout, false in an installed package.
 *
 * `files` ships `scripts/` now, because a published manifest naming `prepack` and `postpack` has to carry
 * what they run. So both hooks can fire inside somebody's `node_modules` — where the repo-root template
 * does not exist and `templates/starter` is already in place. There, both are no-ops. The clean hook
 * especially: deleting the template out of an installed package is the defect this file exists to prevent.
 */
async function inCheckout(): Promise<boolean> {
  return (await stat(SOURCE).catch(() => null))?.isDirectory() === true;
}

if (!(await inCheckout())) {
  if (!(await stat(join(TARGET, "package.json")).catch(() => null))?.isFile()) {
    throw new Error(`No starter template at ${SOURCE} and none vendored at ${TARGET}. This install is broken.`);
  }
  process.stderr.write(`Template already in place at ${TARGET}. Nothing to do.\n`);
} else if (process.argv.includes("--clean")) {
  await rm(TEMPLATES_DIR, { recursive: true, force: true });
} else {
  await vendor();
}
