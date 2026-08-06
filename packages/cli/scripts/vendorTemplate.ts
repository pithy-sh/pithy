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
 * Run by the packer, so it fails loudly. A silent no-op here publishes a CLI whose first command cannot run.
 */

import { cp, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(CLI_DIR, "../../templates/starter");
const TARGET = join(CLI_DIR, "templates", "starter");

async function vendor(): Promise<void> {
  if (!(await stat(SOURCE).catch(() => null))?.isDirectory()) {
    throw new Error(`No starter template at ${SOURCE}. Pack from a checkout, not from a published package.`);
  }
  await rm(TARGET, { recursive: true, force: true });
  await cp(SOURCE, TARGET, { recursive: true });
  const copied = await readdir(TARGET, { recursive: true, withFileTypes: true });
  const files = copied.filter((entry) => entry.isFile()).length;
  if (files === 0) throw new Error(`Vendored ${TARGET} holds no files.`);
  // stderr, not stdout: `npm pack --json` splices a script's stdout into the JSON it prints.
  process.stderr.write(`Vendored ${files} template files into ${TARGET}\n`);
}

if (process.argv.includes("--clean")) {
  await rm(join(CLI_DIR, "templates"), { recursive: true, force: true });
} else {
  await vendor();
}
