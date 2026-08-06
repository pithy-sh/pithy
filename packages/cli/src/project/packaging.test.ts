// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(HERE, "../..");
const STARTER = resolve(CLI_DIR, "../../templates/starter");

/**
 * Every file the packed tarball carries, as posix-ish paths relative to the extracted package root.
 *
 * The assertions below run against **this**, never against the workspace. A published `@pithy-sh/cli`
 * once shipped no starter template at all and every scaffold test stayed green, because each one
 * reached out of the package to the repo root — a path that exists only in a checkout.
 */
let packed: string[];
/** The extracted tarball's `package/` directory — the layout an adopter's `node_modules` gets. */
let pkgRoot: string;
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pithy-pack-"));
  await run("bun", ["pm", "pack", "--quiet", "--filename", join(workDir, "cli.tgz")], { cwd: CLI_DIR });
  await run("tar", ["-xzf", join(workDir, "cli.tgz"), "-C", workDir]);
  pkgRoot = join(workDir, "package");
  packed = await walk(pkgRoot);
}, 120_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Every file under `dir`, relative to it, with `/` separators. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }
  return out.sort();
}

describe("the packed @pithy-sh/cli", () => {
  test("carries the whole starter template", async () => {
    const expected = (await walk(STARTER)).map((file) => `templates/starter/${file}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(packed).toEqual(expect.arrayContaining(expected));
  });

  // The template's own `bindings.workers.test.ts` is exempt: that one is an asset the adopter receives.
  test("ships none of its own tests", () => {
    expect(packed.filter((file) => file.startsWith("src/") && file.endsWith(".test.ts"))).toEqual([]);
  });

  test("resolves its template from the packed layout, not the repo root", async () => {
    const { resolveTemplateDir } = await import("./scaffold");
    const resolved = resolveTemplateDir(join(pkgRoot, "src", "project"));
    expect(relative(pkgRoot, resolved).startsWith("..")).toBe(false);
    await stat(join(resolved, "apps", "api", "package.json"));
  });
});
