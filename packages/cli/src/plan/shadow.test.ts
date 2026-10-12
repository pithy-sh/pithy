// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { ConflictError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linkStandingAt, lstatAsProject } from "../project/linkView";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { inShadow } from "./shadow";

/**
 * **A dry run runs the real write, somewhere else (#697).** The plan a person reviews is only worth
 * anything if it is the change the real run makes, so `add` and `ui add` do not describe their writes —
 * they make them, in a copy of the project, and the plan is the difference. These hold the copy to the
 * two things that makes safe: the project is never touched, and the difference is exactly the write.
 */

const execFileAsync = promisify(execFile);

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "pithy-shadow-test-"));
  await mkdir(join(project, "apps", "api"), { recursive: true });
  await writeFile(join(project, "package.json"), '{ "name": "acme" }\n');
  await writeFile(join(project, "apps", "api", "wrangler.jsonc"), '{\n  "name": "acme-api"\n}\n');
  await writeFile(join(project, "apps", "api", "keep.ts"), "export {};\n");
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("inShadow", () => {
  test("a write in the copy is a planned edit, with its diff, and the project is untouched", async () => {
    const before = await snapshotTree(project);
    const { result, files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(join(project, "apps", "api", "wrangler.jsonc")), '{\n  "name": "acme-board"\n}\n');
      return "ran";
    });
    expect(result).toBe("ran");
    expect(files).toEqual([
      {
        path: "apps/api/wrangler.jsonc",
        action: "edit",
        changes: [],
        diff: '@@ -1,3 +1,3 @@\n {\n-  "name": "acme-api"\n+  "name": "acme-board"\n }\n',
      },
    ]);
    expect(await snapshotTree(project)).toEqual(before);
  });

  test("a new file is a create, a removed one a delete, an untouched one nothing", async () => {
    const { files } = await inShadow(project, async (shadow) => {
      await mkdir(shadow.at(join(project, "apps", "api", "src")), { recursive: true });
      await writeFile(shadow.at(join(project, "apps", "api", "src", "new.ts")), "export const a = 1;\n");
      await rm(shadow.at(join(project, "apps", "api", "keep.ts")));
    });
    expect(files).toEqual([
      { path: "apps/api/keep.ts", action: "delete", changes: [] },
      { path: "apps/api/src/new.ts", action: "create", changes: [], diff: "@@ -0,0 +1 @@\n+export const a = 1;\n" },
    ]);
  });

  test("the copy is gone afterwards, and gone when the work throws", async () => {
    let root = "";
    await inShadow(project, async (shadow) => {
      root = shadow.root;
    });
    expect(existsSync(root)).toBe(false);
    await expect(
      inShadow(project, async (shadow) => {
        root = shadow.root;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(root)).toBe(false);
  });

  test("node_modules is reached through a link, never copied, and never planned", async () => {
    await mkdir(join(project, "node_modules", "@pithy-sh", "auth"), { recursive: true });
    await writeFile(join(project, "node_modules", "@pithy-sh", "auth", "package.json"), '{ "version": "1.0.0" }\n');
    const { result, files } = await inShadow(project, async (shadow) =>
      readFile(join(shadow.root, "node_modules", "@pithy-sh", "auth", "package.json"), "utf8"),
    );
    expect(result).toContain("1.0.0");
    expect(files).toEqual([]);
  });

  test("what a dry run has no business reading is not copied: git, build output, local state, secrets", async () => {
    for (const dir of [".git", ".wrangler", "apps/api/dist", ".turbo"]) {
      await mkdir(join(project, dir), { recursive: true });
      await writeFile(join(project, dir, "x"), "x");
    }
    await writeFile(join(project, ".dev.vars"), "SECRET=1\n");
    await writeFile(join(project, "apps", "api", ".env.local"), "SECRET=1\n");
    // The shared secrets file a worktree links to in the main checkout: not a link in the copy either.
    await symlink(join(tmpdir(), "main-checkout", ".dev.vars"), join(project, "apps", "api", ".dev.vars"));
    await inShadow(project, async (shadow) => {
      for (const path of [".git/x", ".wrangler/x", "apps/api/dist/x", ".turbo/x", ".dev.vars", "apps/api/.env.local"]) {
        expect(existsSync(join(shadow.root, path)), path).toBe(false);
      }
      await expect(lstat(join(shadow.root, "apps", "api", ".dev.vars"))).rejects.toThrow(/ENOENT/);
      expect(existsSync(join(shadow.root, "apps", "api", "keep.ts"))).toBe(true);
    });
  });

  test("a generated config under .wrangler/pithy is copied, so regenerating it is an edit and not a create", async () => {
    const generated = join(project, "apps", "api", ".wrangler", "pithy");
    await mkdir(generated, { recursive: true });
    await writeFile(join(generated, "wrangler.feature.jsonc"), '{\n  "name": "acme-api-f42"\n}\n');
    // The rest of `.wrangler` is local state, and stays out.
    await mkdir(join(project, "apps", "api", ".wrangler", "state"), { recursive: true });
    await writeFile(join(project, "apps", "api", ".wrangler", "state", "db.sqlite"), "x");

    const { files } = await inShadow(project, async (shadow) => {
      expect(existsSync(join(shadow.root, "apps", "api", ".wrangler", "state"))).toBe(false);
      await writeFile(shadow.at(join(generated, "wrangler.feature.jsonc")), '{\n  "name": "acme-api-f43"\n}\n');
    });

    expect(files).toEqual([
      {
        path: "apps/api/.wrangler/pithy/wrangler.feature.jsonc",
        action: "edit",
        changes: [],
        diff: '@@ -1,3 +1,3 @@\n {\n-  "name": "acme-api-f42"\n+  "name": "acme-api-f43"\n }\n',
      },
    ]);
  });

  test("a link inside the project is kept as a link, and one written as an absolute path stays inside the copy", async () => {
    await symlink("keep.ts", join(project, "apps", "api", "alias.ts"));
    await symlink(join(project, "apps", "api", "keep.ts"), join(project, "apps", "api", "absolute.ts"));
    await inShadow(project, async (shadow) => {
      expect(await readFile(join(shadow.root, "apps", "api", "alias.ts"), "utf8")).toBe("export {};\n");
      // Followed in the copy, never back into the project: a write through it is a write to the copy's keep.ts.
      expect(await realpath(join(shadow.root, "apps", "api", "absolute.ts"))).toBe(
        join(shadow.root, "apps", "api", "keep.ts"),
      );
    });
  });

  /**
   * **A link out of the project to a directory is a snapshot of that directory, in the copy (#697).** The real run
   * reads through the link — a Worker whose `src` lives in a shared checkout bundles from there — and writes through
   * it. The copy pointed every such link nowhere, so the dry run failed where the real run succeeded. A snapshot gives
   * the command the same bytes to read and somewhere to write that is not somebody's real files; the plan names each
   * write at the path the command wrote, and says where it really lands.
   */
  describe("a link out of the project to a directory", () => {
    let outside: string;
    beforeEach(async () => {
      outside = await realpath(await mkdtemp(join(tmpdir(), "pithy-shadow-outside-")));
      await mkdir(join(outside, "src"), { recursive: true });
      await writeFile(join(outside, "src", "index.ts"), "export const a = 1;\n");
      await writeFile(join(outside, "src", "gone.ts"), "export {};\n");
    });
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    test("is a readable snapshot, relative or absolute, and the shadow names it", async () => {
      await symlink(relative(join(project, "apps", "api"), join(outside, "src")), join(project, "apps", "api", "src"));
      await mkdir(join(outside, "lib"));
      await writeFile(join(outside, "lib", "index.ts"), "export const a = 1;\n");
      await symlink(join(outside, "lib"), join(project, "apps", "absolute"));
      // A second link to a directory already copied is a link to that copy: one tree outside, one snapshot of it.
      await symlink(join(outside, "lib"), join(project, "apps", "again"));
      const { files, notes } = await inShadow(project, async (shadow) => {
        expect(await realpath(join(shadow.root, "apps", "again"))).toBe(join(shadow.root, "apps", "absolute"));
        for (const path of ["apps/api/src", "apps/absolute"]) {
          const copy = join(shadow.root, path);
          expect((await lstat(copy)).isDirectory(), path).toBe(true);
          expect(await readFile(join(copy, "index.ts"), "utf8"), path).toBe("export const a = 1;\n");
        }
        expect([...shadow.outside].sort()).toEqual(["apps/absolute", "apps/api/src"]);
      });
      expect(files).toEqual([]);
      expect(notes).toEqual([]);
    });

    test("a write in it is planned at the project's path, with a note, and the directory outside is untouched", async () => {
      await symlink(join(outside, "src"), join(project, "apps", "api", "src"));
      const before = await snapshotTree(outside);
      const { files, notes } = await inShadow(project, async (shadow) => {
        await writeFile(shadow.at(join(project, "apps", "api", "src", "index.ts")), "export const a = 2;\n");
        await writeFile(shadow.at(join(project, "apps", "api", "src", "new.ts")), "export {};\n");
        await rm(shadow.at(join(project, "apps", "api", "src", "gone.ts")));
      });
      expect(files).toEqual([
        { path: "apps/api/src/gone.ts", action: "delete", changes: [] },
        {
          path: "apps/api/src/index.ts",
          action: "edit",
          changes: [],
          diff: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
        },
        { path: "apps/api/src/new.ts", action: "create", changes: [], diff: "@@ -0,0 +1 @@\n+export {};\n" },
      ]);
      expect(notes).toEqual([
        "apps/api/src/gone.ts is under apps/api/src, a link to a directory outside the project. The delete lands there.",
        "apps/api/src/index.ts is under apps/api/src, a link to a directory outside the project. The edit lands there.",
        "apps/api/src/new.ts is under apps/api/src, a link to a directory outside the project. The file lands there.",
      ]);
      expect(await snapshotTree(outside)).toEqual(before);
    });

    test("removing the link is one delete, of the link, never of the directory it leads to", async () => {
      await symlink(join(outside, "src"), join(project, "apps", "api", "src"));
      const { files, notes } = await inShadow(project, async (shadow) => {
        await rm(shadow.at(join(project, "apps", "api", "src")), { recursive: true, force: true });
      });
      expect(files).toEqual([{ path: "apps/api/src", action: "delete", changes: [] }]);
      expect(notes).toEqual([
        "apps/api/src is a link to a directory outside the project. Deleting it deletes the link, never the directory.",
      ]);
    });

    test("a guard that asks whether the path is a link is answered by the link, not by the snapshot", async () => {
      await symlink(join(outside, "src"), join(project, "apps", "api", "src"));
      const link = await lstat(join(project, "apps", "api", "src"));
      await inShadow(project, async (shadow) => {
        const copy = join(shadow.root, "apps", "api", "src");
        expect((await lstatAsProject(copy)).isSymbolicLink()).toBe(true);
        expect((await lstatAsProject(copy)).uid).toBe(link.uid);
        expect(linkStandingAt(join(copy, "index.ts"))).toBeUndefined();
        expect((await lstatAsProject(join(shadow.root, "apps", "api", "keep.ts"))).isFile()).toBe(true);
      });
      // Outside a dry run, the question is the plain lstat it always was.
      expect((await lstatAsProject(join(project, "apps", "api", "src"))).isSymbolicLink()).toBe(true);
      expect(linkStandingAt(join(project, "apps", "api", "src"))).toBeUndefined();
    });

    test("a link inside it that leads further out is a snapshot too, and one that loops back is a link", async () => {
      const further = await realpath(await mkdtemp(join(tmpdir(), "pithy-shadow-further-")));
      try {
        await writeFile(join(further, "deep.ts"), "export const deep = 1;\n");
        await symlink(further, join(outside, "src", "further"));
        // Back to the directory it is in: followed for ever, this never ends.
        await symlink(".", join(outside, "src", "loop"));
        // Back into the project.
        await symlink(join(project, "apps", "api", "keep.ts"), join(outside, "src", "home.ts"));
        await symlink(join(outside, "src"), join(project, "apps", "api", "src"));
        const { files, notes } = await inShadow(project, async (shadow) => {
          const src = join(shadow.root, "apps", "api", "src");
          expect(await readFile(join(src, "further", "deep.ts"), "utf8")).toBe("export const deep = 1;\n");
          expect([...shadow.outside].sort()).toEqual(["apps/api/src", "apps/api/src/further"]);
          expect((await lstat(join(src, "loop"))).isSymbolicLink()).toBe(true);
          expect(await realpath(join(src, "loop"))).toBe(src);
          expect(await realpath(join(src, "home.ts"))).toBe(join(shadow.root, "apps", "api", "keep.ts"));
          await writeFile(join(src, "further", "deep.ts"), "export const deep = 2;\n");
        });
        expect(files.map((file) => [file.path, file.action])).toEqual([["apps/api/src/further/deep.ts", "edit"]]);
        expect(notes).toEqual([
          "apps/api/src/further/deep.ts is under apps/api/src/further, a link to a directory outside the project. The edit lands there.",
        ]);
        expect(await readFile(join(further, "deep.ts"), "utf8")).toBe("export const deep = 1;\n");
      } finally {
        await rm(further, { recursive: true, force: true });
      }
    });

    test("what the rest of the copy skips, it skips too: secrets, build output, links that lead nowhere", async () => {
      await mkdir(join(outside, "src", "dist"), { recursive: true });
      await writeFile(join(outside, "src", "dist", "index.js"), "x");
      await writeFile(join(outside, "src", ".dev.vars"), "SECRET=1\n");
      await symlink(join(outside, "nowhere"), join(outside, "src", "dangling"));
      await symlink(join(outside, "src"), join(project, "apps", "api", "src"));
      await inShadow(project, async (shadow) => {
        const src = join(shadow.root, "apps", "api", "src");
        expect(existsSync(join(src, "dist"))).toBe(false);
        expect(existsSync(join(src, ".dev.vars"))).toBe(false);
        await expect(writeFile(join(src, "dangling", "x.ts"), "x")).rejects.toThrow();
      });
      expect(await readdir(outside)).toEqual(["src"]);
    });

    test("a link inside the project that resolves through one is read through the snapshot, and planned where it lands", async () => {
      await symlink(outside, join(project, "shared"));
      await symlink(join("..", "..", "shared", "src"), join(project, "apps", "api", "src"));
      const { files, notes } = await inShadow(project, async (shadow) => {
        expect((await lstat(join(shadow.root, "apps", "api", "src"))).isSymbolicLink()).toBe(true);
        expect([...shadow.outside]).toEqual(["shared"]);
        await writeFile(join(shadow.root, "apps", "api", "src", "index.ts"), "export const a = 3;\n");
      });
      expect(files.map((file) => file.path)).toEqual(["shared/src/index.ts"]);
      expect(notes).toEqual([
        "shared/src/index.ts is under shared, a link to a directory outside the project. The edit lands there.",
      ]);
      expect(await readFile(join(outside, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
    });
  });

  /**
   * **A file the run cannot read is in the copy, and still cannot be read (#697).** Leaving it out turned the real
   * run's permission error into a missing file — a different code and a different sentence, so an agent reading the
   * plan was told the wrong thing to fix. A placeholder with the file's own mode fails the read the same way.
   */
  test.skipIf(process.getuid?.() === 0)(
    "an unreadable file is a placeholder that refuses the read as the file does",
    async () => {
      const locked = join(project, "apps", "api", "wrangler.jsonc");
      await chmod(locked, 0o000);
      try {
        const { files } = await inShadow(project, async (shadow) => {
          const copy = shadow.at(locked);
          expect((await lstat(copy)).mode & 0o777).toBe(0);
          await expect(readFile(copy)).rejects.toMatchObject({ code: "EACCES" });
        });
        expect(files).toEqual([]);
      } finally {
        await chmod(locked, 0o644);
      }
    },
  );

  /**
   * **A link out of the project to a file is that file, in the copy (#697).** The real run writes through it —
   * `writeFileAtomic` follows the adopter's link — so `pithy add` over a `pithy.config.ts` linked from a shared
   * directory succeeds. A copy that pointed the link nowhere failed the plan with a raw `ENOTDIR` instead. A
   * snapshot of the target's bytes is what the command reads and edits, the edit is planned at the path the
   * command wrote, and the plan says where it really lands. The file outside is never touched.
   */
  test("a link out of the project to a file is a copy of that file, and an edit through it is planned at the link", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pithy-shadow-outside-"));
    try {
      await writeFile(join(outside, "pithy.config.ts"), "export default {};\n");
      await symlink(
        relative(join(project, "apps", "api"), join(outside, "pithy.config.ts")),
        join(project, "apps", "api", "pithy.config.ts"),
      );
      const { files, notes } = await inShadow(project, async (shadow) => {
        const path = shadow.at(join(project, "apps", "api", "pithy.config.ts"));
        expect((await lstat(path)).isFile()).toBe(true);
        expect(await readFile(path, "utf8")).toBe("export default {};\n");
        await writeFile(path, "export default { a: 1 };\n");
      });
      expect(files).toEqual([
        {
          path: "apps/api/pithy.config.ts",
          action: "edit",
          changes: [],
          diff: "@@ -1 +1 @@\n-export default {};\n+export default { a: 1 };\n",
        },
      ]);
      expect(notes).toEqual([
        "apps/api/pithy.config.ts is a link to a file outside the project. The edit lands in that file.",
      ]);
      expect(await readFile(join(outside, "pithy.config.ts"), "utf8")).toBe("export default {};\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a link out of the project to a file the run leaves alone is no note", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pithy-shadow-outside-"));
    try {
      await writeFile(join(outside, "shared.ts"), "export {};\n");
      await symlink(join(outside, "shared.ts"), join(project, "apps", "api", "shared.ts"));
      const { files, notes } = await inShadow(project, async () => {});
      expect(files).toEqual([]);
      expect(notes).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  /**
   * **Whatever fails inside the copy fails in the project's terms (#697).** A raw `node:fs` error is outside the
   * `PithyError` contract `withErrorReporting` prints from: it escaped as a stack trace, with no `--json` line,
   * naming `/tmp/pithy-plan-…` — a path the adopter has never seen and cannot act on.
   */
  describe("a failure inside the copy", () => {
    test("a raw filesystem error becomes a PithyError naming the project's path, never the copy's", async () => {
      // A link out of the project that leads nowhere: in the copy it leads under a file, and a write through it fails.
      const outside = await mkdtemp(join(tmpdir(), "pithy-shadow-outside-"));
      await symlink(join(outside, "nowhere"), join(project, "apps", "out"));
      try {
        const error = await inShadow(project, async (shadow) => {
          await writeFile(join(shadow.root, "apps", "out", "x.ts"), "x");
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(PithyError);
        const payload = (error as PithyError).payload;
        expect(payload.code).toBe("core/internal");
        expect(payload.message).toBe("The dry run could not open apps/out/x.ts (ENOTDIR).");
        expect(JSON.stringify(payload)).not.toContain("pithy-plan-");
        expect((error as PithyError).message).not.toContain("pithy-plan-");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    test("a PithyError naming the copy names the project instead, and keeps its class", async () => {
      const error = await inShadow(project, async (shadow) => {
        throw new ConflictError({
          message: `${shadow.root}/apps/api/keep.ts is in the way.`,
          action: `Move ${shadow.root}/apps/api/keep.ts aside.`,
          detail: `at ${shadow.root}`,
        });
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictError);
      const payload = (error as ConflictError).payload;
      expect(payload.message).toBe(`${project}/apps/api/keep.ts is in the way.`);
      expect(payload.action).toBe(`Move ${project}/apps/api/keep.ts aside.`);
      expect(payload.detail).toBe(`at ${project}`);
      expect((error as ConflictError).message).toBe(payload.message);
    });

    test("any other error has the copy's path put back in its message and stack", async () => {
      const error = await inShadow(project, async (shadow) => {
        throw new TypeError(`bad ${shadow.root}/apps/api/keep.ts`);
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`bad ${project}/apps/api/keep.ts`);
      expect((error as Error).stack).not.toContain("pithy-plan-");
    });
  });

  test("a dangling link, and a node_modules link that leads nowhere, are skipped rather than fatal", async () => {
    await symlink("missing.ts", join(project, "apps", "api", "dangling.ts"));
    await symlink(join(project, "nowhere"), join(project, "node_modules"));
    const { files } = await inShadow(project, async (shadow) => {
      expect(existsSync(join(shadow.root, "apps", "api", "keep.ts"))).toBe(true);
    });
    expect(files).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)("a directory the run cannot read is skipped rather than fatal", async () => {
    const locked = join(project, "apps", "locked");
    await mkdir(locked);
    await writeFile(join(locked, "x"), "x");
    await chmod(locked, 0o000);
    try {
      const { files } = await inShadow(project, async (shadow) => {
        expect(existsSync(join(shadow.root, "apps", "api", "keep.ts"))).toBe(true);
      });
      expect(files).toEqual([]);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  test("build output is not copied, outside a repository and where the repository ignores it", async () => {
    for (const dir of ["build", ".next", "coverage", ".cache"]) {
      await mkdir(join(project, "apps", "api", dir), { recursive: true });
      await writeFile(join(project, "apps", "api", dir, "x"), "x");
    }
    await inShadow(project, async (shadow) => {
      for (const dir of ["build", ".next", "coverage", ".cache"]) {
        expect(existsSync(join(shadow.root, "apps", "api", dir)), dir).toBe(false);
      }
    });
  });

  test("a source directory that only shares a build output's name is copied when the repository tracks it", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await writeFile(join(project, ".gitignore"), "/apps/api/dist/\n");
    await mkdir(join(project, "apps", "api", "src", "build"), { recursive: true });
    await writeFile(join(project, "apps", "api", "src", "build", "steps.ts"), "export {};\n");
    await mkdir(join(project, "apps", "api", "dist"), { recursive: true });
    await writeFile(join(project, "apps", "api", "dist", "index.js"), "x");
    await inShadow(project, async (shadow) => {
      expect(existsSync(join(shadow.root, "apps", "api", "src", "build", "steps.ts"))).toBe(true);
      expect(existsSync(join(shadow.root, "apps", "api", "dist"))).toBe(false);
    });
  });

  /**
   * **A `.env` file the repository tracks is source, by the repository's own choice (#697).** A front end's
   * build reads `apps/web/.env.production`, and a dry run that left it out built a different bundle from the
   * one the deploy ships. So a tracked `.env*` is copied; an untracked or ignored one is a secret until the
   * repository says otherwise, and `.dev.vars*` is a secret whatever git says.
   */
  test("a .env file git tracks is copied; an untracked or ignored one, and every .dev.vars, is not", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await writeFile(join(project, ".gitignore"), ".env\n");
    await mkdir(join(project, "apps", "web"), { recursive: true });
    await writeFile(join(project, "apps", "web", ".env.production"), "VITE_API=https://api.acme.dev\n");
    await writeFile(join(project, "apps", "api", ".dev.vars"), "SECRET=1\n");
    await execFileAsync("git", ["add", "-f", ".gitignore", "apps/web/.env.production", "apps/api/.dev.vars"], {
      cwd: project,
    });
    await writeFile(join(project, ".env"), "SECRET=1\n");
    await writeFile(join(project, "apps", "web", ".env.local"), "SECRET=1\n");
    await inShadow(project, async (shadow) => {
      expect(await readFile(join(shadow.root, "apps", "web", ".env.production"), "utf8")).toBe(
        "VITE_API=https://api.acme.dev\n",
      );
      for (const path of [".env", "apps/web/.env.local", "apps/api/.dev.vars"]) {
        expect(existsSync(join(shadow.root, path)), path).toBe(false);
      }
    });
  });

  test("with no repository to ask, no .env file is copied, committed-looking or not", async () => {
    await mkdir(join(project, "apps", "web"), { recursive: true });
    await writeFile(join(project, "apps", "web", ".env.production"), "VITE_API=https://api.acme.dev\n");
    await inShadow(project, async (shadow) => {
      expect(existsSync(join(shadow.root, "apps", "web", ".env.production"))).toBe(false);
    });
  });

  test("the copy's own path never reaches a plan: a diff and a sentence both name the project", async () => {
    const { result, files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(join(project, "apps", "api", "keep.ts")), `// ${shadow.root}/apps/api\n`);
      return shadow.toProject(`Wrote ${shadow.root}/apps/api/keep.ts.`);
    });
    expect(result).toBe(`Wrote ${project}/apps/api/keep.ts.`);
    expect(files[0]?.diff).toContain(`+// ${project}/apps/api`);
  });

  /**
   * A write that differs from the project only by the copy's own root — a generated config holding an absolute
   * path, regenerated — is the file that is there, put back in the project's terms. Not an edit, and never an
   * edit with an empty diff (#697).
   */
  test("a file that differs only by the copy's root is unchanged, not an edit", async () => {
    const config = join(project, "apps", "api", "wrangler.jsonc");
    await writeFile(config, `{\n  "main": "${project}/apps/api/src/index.ts"\n}\n`);
    const { files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(config), `{\n  "main": "${shadow.root}/apps/api/src/index.ts"\n}\n`);
    });
    expect(files).toEqual([]);
  });

  test("a path outside the project has no place in the copy", async () => {
    await inShadow(project, async (shadow) => {
      expect(() => shadow.at(tmpdir())).toThrow(/outside the project/);
    });
  });

  test("a binary file is planned without a diff", async () => {
    const { files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(join(project, "apps", "api", "icon.png")), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    });
    expect(files).toEqual([{ path: "apps/api/icon.png", action: "create", changes: ["Binary file."] }]);
  });
});
