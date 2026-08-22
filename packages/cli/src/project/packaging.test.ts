// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GIT_NO_MAINTENANCE, removeTempDir } from "../test-utils/tempRepo";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(HERE, "../..");
const REPO = resolve(CLI_DIR, "../..");

/**
 * Files the fixture grows *after* its commit, before it is packed.
 *
 * A maintainer's checkout is never clean. `.dev.vars` is where `pithy add` and `pithy token mint`
 * write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS`; `.wrangler/` is local D1 state; the
 * third is plain untracked scratch that no ignore rule covers. All three were published — the
 * vendoring step copied the directory wholesale and `files` overrides `.gitignore`, so the tarball
 * carried whatever the maintainer's working tree happened to hold. Publishing is irreversible.
 */
const DIRT = [
  ["templates/starter/.dev.vars", "CLOUDFLARE_API_TOKEN=leaked-secret\n"],
  ["templates/starter/apps/api/.wrangler/state/v3/d1/db.sqlite", "local state\n"],
  ["templates/starter/LEAKPROBE.txt", "untracked scratch\n"],
] as const;

/** Every file the packed tarball carries, relative to the extracted `package/` root, `/`-separated. */
let packed: string[];
/** The extracted tarball's `package/` directory — the layout an adopter's `node_modules` gets. */
let pkgRoot: string;
/** The starter's committed files, relative to `templates/starter`. The allowlist, from git. */
let committed: string[];
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pithy-pack-"));
  committed = await trackedTemplateFiles();
  const fixture = await dirtyCheckout(join(workDir, "checkout"));
  const tarball = join(workDir, "cli.tgz");
  await run("bun", ["pm", "pack", "--quiet", "--filename", tarball], { cwd: join(fixture, "packages", "cli") });
  await run("tar", ["-xzf", tarball, "-C", workDir]);
  pkgRoot = join(workDir, "package");
  packed = await walk(pkgRoot);
}, 120_000);

afterAll(async () => {
  await removeTempDir(workDir);
});

/** The starter's committed files, from the index of the repo this test runs in. */
async function trackedTemplateFiles(): Promise<string[]> {
  const { stdout } = await run("git", ["-C", join(REPO, "templates", "starter"), "ls-files", "-z", "--cached"], {
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean).sort();
}

/**
 * A throwaway checkout that packs like the real one, with a working tree a maintainer would recognize.
 *
 * Isolated on purpose, and that is the second half of the fix. This test used to pack the live
 * `packages/cli`, so `prepack` and `postpack` created and deleted `packages/cli/templates/starter`
 * underneath the ~14 sibling suites calling `scaffoldProject()` concurrently — and dirtying the real
 * `templates/starter` to prove the leak would have handed every one of those suites a `.dev.vars` in
 * its scaffold. Nothing outside `workDir` is touched now, so there is nothing to race and nothing to
 * leave behind.
 *
 * Everything that decides what ships is the real thing: the CLI's own manifest, its `scripts/`, its
 * `src/`. Only the workspace dependency ranges are rewritten, because `bun pm pack` resolves
 * `workspace:*` against an install that a throwaway tree does not have.
 */
async function dirtyCheckout(root: string): Promise<string> {
  const cli = join(root, "packages", "cli");
  await mkdir(cli, { recursive: true });
  for (const file of committed) {
    const to = join(root, "templates", "starter", file);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(REPO, "templates", "starter", file), to);
  }
  await cp(join(REPO, ".gitignore"), join(root, ".gitignore"));
  for (const entry of ["src", "scripts", "LICENSE"]) {
    await cp(join(CLI_DIR, entry), join(cli, entry), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(join(CLI_DIR, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const group of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, range] of Object.entries(group ?? {})) {
      if (range.startsWith("workspace:")) (group as Record<string, string>)[name] = "0.0.0";
    }
  }
  await writeFile(join(cli, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const git = (...args: string[]) => run("git", ["-C", root, ...GIT_NO_MAINTENANCE, ...args]);
  await git("init", "--quiet");
  await git("config", "user.email", "test@pithy.invalid");
  await git("config", "user.name", "Pithy Test");
  await git("add", "--all");
  await git("commit", "--quiet", "--no-gpg-sign", "-m", "fixture");

  for (const [path, contents] of DIRT) {
    const to = join(root, ...path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, contents);
  }
  return root;
}

/** Every file under `dir`, relative to it, with `/` separators. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }
  return out.sort();
}

describe("the packed @pithy-sh/cli", () => {
  test("carries the committed starter template and nothing else", () => {
    const expected = committed.map((file) => `templates/starter/${file}`);
    expect(expected.length).toBeGreaterThan(0);
    // Equality, not `arrayContaining`. A superset assertion passes with a secret in the tarball.
    expect(packed.filter((file) => file.startsWith("templates/"))).toEqual(expected);
  });

  // The template's own `bindings.workers.test.ts` is exempt: that one is an asset the adopter receives.
  test("ships none of its own tests", () => {
    expect(packed.filter((file) => file.startsWith("src/") && file.endsWith(".test.ts"))).toEqual([]);
  });

  test("ships every script its manifest runs", async () => {
    const manifest = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const referenced = new Set<string>();
    for (const command of Object.values(manifest.scripts ?? {})) {
      for (const match of command.matchAll(/(?:^|\s)(scripts\/[\w./-]+\.ts)/g)) referenced.add(match[1] as string);
    }
    // `prepack` and `postpack` run in whatever tree the package sits in, including an installed one.
    // `files` listed `src` and `templates` and not `scripts`, so the published manifest named two
    // lifecycle hooks whose target was not there.
    expect(referenced.size).toBeGreaterThan(0);
    expect(packed).toEqual(expect.arrayContaining([...referenced]));
  });

  test("resolves its template from the packed layout, not the repo root", async () => {
    const { resolveTemplateDir } = await import("./scaffold");
    const resolved = resolveTemplateDir(join(pkgRoot, "src", "project"));
    expect(relative(pkgRoot, resolved).startsWith("..")).toBe(false);
    await stat(join(resolved, "apps", "api", "package.json"));
  });
});

describe("resolveTemplateDir", () => {
  /** Writes a template just real enough for the resolver to accept it. */
  async function plantTemplate(dir: string, marker: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: marker }));
    return dir;
  }

  test("never leaves the installed package for a sibling named templates", async () => {
    // `<node_modules>/templates/starter` is four levels up from `<node_modules>/@pithy-sh/cli/src/project`.
    // That path belongs to any dependency called `templates` — an adopter's, or a squatter's — and the
    // resolver reached it. `pithy init` would then scaffold from a directory the kit does not own.
    const root = await mkdtemp(join(tmpdir(), "pithy-resolve-"));
    try {
      const moduleDir = join(root, "node_modules", "@pithy-sh", "cli", "src", "project");
      await mkdir(moduleDir, { recursive: true });
      await plantTemplate(join(root, "node_modules", "templates", "starter"), "squatter");
      const own = await plantTemplate(join(root, "node_modules", "@pithy-sh", "cli", "templates", "starter"), "own");
      const { resolveTemplateDir } = await import("./scaffold");
      expect(resolveTemplateDir(moduleDir)).toBe(own);
    } finally {
      await removeTempDir(root);
    }
  });

  test("prefers the checkout's own template over a vendored copy left behind", async () => {
    // A pack that fails after `prepack` never runs `postpack`, so `packages/cli/templates/starter`
    // stays. It is gitignored, so `git status` says nothing — and every later CLI run and test in that
    // checkout scaffolded from the stale copy instead of the source of truth at the repo root.
    const root = await mkdtemp(join(tmpdir(), "pithy-resolve-"));
    try {
      const moduleDir = join(root, "packages", "cli", "src", "project");
      await mkdir(moduleDir, { recursive: true });
      const source = await plantTemplate(join(root, "templates", "starter"), "source");
      await plantTemplate(join(root, "packages", "cli", "templates", "starter"), "stale");
      const { resolveTemplateDir } = await import("./scaffold");
      expect(resolveTemplateDir(moduleDir)).toBe(source);
    } finally {
      await removeTempDir(root);
    }
  });

  test("says which install is broken when no layout has one", async () => {
    const root = await mkdtemp(join(tmpdir(), "pithy-resolve-"));
    try {
      const moduleDir = join(root, "node_modules", "@pithy-sh", "cli", "src", "project");
      await mkdir(moduleDir, { recursive: true });
      const { resolveTemplateDir } = await import("./scaffold");
      expect(() => resolveTemplateDir(moduleDir)).toThrow(/missing its starter template/);
    } finally {
      await removeTempDir(root);
    }
  });
});
