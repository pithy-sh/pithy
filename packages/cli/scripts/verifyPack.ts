// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Hold a `@pithy-sh/cli` tarball to what it must contain, and fail the pack when it does not.
 *
 * `files` does not fail on a missing path. Pack with scripts disabled — `npm pack --ignore-scripts`, or
 * any publish path that turns lifecycle hooks off — and `prepack` never vendors the starter, `templates`
 * matches nothing, and the tarball ships with no template at all: silently, exit 0. That is a straight
 * regression to the defect this whole mechanism was built to close, and the mechanism itself could not
 * detect it, because the only check lived inside the hook that did not run.
 *
 * This is that missing post-condition, and it sits on the artefact rather than on the hook. Nothing our
 * manifest declares can execute during a pack that refuses to execute scripts — so the check has to be a
 * separate step, run by CI on every commit and by whatever publishes, on the exact file it is about to
 * push. `bun run pack:verify` packs and checks; `bun run pack:verify <tarball>` checks one already built.
 *
 *   packages/cli $ bun run pack:verify
 *   packages/cli $ bun run pack:verify ../../pithy-sh-cli-1.2.3.tgz
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_DIR, SOURCE, templateFiles, VENDORED } from "./templateManifest";

/** Everything the tarball holds, relative to the package root, `/`-separated and sorted. */
function entries(tarball: string): string[] {
  const listed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  return listed
    .split("\n")
    .filter((line) => line.length > 0 && !line.endsWith("/"))
    .map((line) => line.replace(/^package\//, ""))
    .sort();
}

function verify(tarball: string): string[] {
  const packed = entries(tarball);
  const expected = templateFiles(SOURCE).map((file) => `${VENDORED}/${file}`);
  const faults: string[] = [];

  const shipped = packed.filter((file) => file.startsWith("templates/"));
  const missing = expected.filter((file) => !shipped.includes(file));
  const extra = shipped.filter((file) => !expected.includes(file));
  if (missing.length > 0) {
    faults.push(`${missing.length} template file(s) missing — pithy init cannot run:\n  ${missing.join("\n  ")}`);
  }
  // The security half. A tarball is published once and cannot be unpublished.
  if (extra.length > 0) {
    faults.push(`${extra.length} file(s) under templates/ that are not committed:\n  ${extra.join("\n  ")}`);
  }

  const tests = packed.filter((file) => file.startsWith("src/") && file.endsWith(".test.ts"));
  if (tests.length > 0) faults.push(`${tests.length} of the CLI's own test file(s) shipped.`);

  // `prepack` and `postpack` run wherever the package sits, an adopter's `node_modules` included.
  const referenced = new Set<string>();
  const manifest = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const command of Object.values(manifest.scripts ?? {})) {
    for (const match of command.matchAll(/(?:^|\s)(scripts\/[\w./-]+\.ts)/g)) referenced.add(match[1] as string);
  }
  const absent = [...referenced].filter((file) => !packed.includes(file)).sort();
  if (absent.length > 0)
    faults.push(`the manifest runs script(s) the tarball does not carry:\n  ${absent.join("\n  ")}`);

  return faults;
}

const given = process.argv[2];
const workDir = mkdtempSync(join(tmpdir(), "pithy-verify-pack-"));
try {
  let tarball = given;
  if (tarball === undefined) {
    tarball = join(workDir, "cli.tgz");
    execFileSync("bun", ["pm", "pack", "--quiet", "--filename", tarball], { cwd: CLI_DIR, stdio: "inherit" });
  }
  const faults = verify(tarball);
  if (faults.length > 0) {
    process.stderr.write(`${tarball} is not publishable.\n\n${faults.join("\n\n")}\n`);
    process.exit(1);
  }
  process.stderr.write(`${tarball} checks out.\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
