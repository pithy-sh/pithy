// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEV_VARS_LOCAL, GENERATED_MARKER, generateDevVars, isGeneratedDevVars } from "./generate";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-generate-"));
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Worker directory wrangler would run in. */
async function worker(name: string): Promise<string> {
  const path = join(dir, "apps", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "wrangler.jsonc"), "{}\n");
  return path;
}

describe("generateDevVars", () => {
  test("every Worker gets its own file, with the header that makes overwriting it safe", async () => {
    const board = await worker("board");
    const web = await worker("web");

    const result = await generateDevVars({ projectDir: dir, values: { SECRETS_ENCRYPTION_KEYS: "k" } });

    expect(result.generated).toEqual([board, web]);
    for (const path of [board, web]) {
      const source = await readFile(join(path, ".dev.vars"), "utf8");
      expect(isGeneratedDevVars(source)).toBe(true);
      expect(source.startsWith(GENERATED_MARKER)).toBe(true);
      expect(parseDevVars(source).SECRETS_ENCRYPTION_KEYS).toBe("k");
      // No link anywhere. That is the whole change: #137, #139, #142 and #146 were all one design.
      expect((await lstat(join(path, ".dev.vars"))).isSymbolicLink()).toBe(false);
    }
  });

  test("the header names .dev.vars.local, so the mechanism is discoverable from the artefact", async () => {
    // An adopter who is going to edit anything edits the file in front of them. The supported answer has
    // to be in it, not in a doc they have not read.
    const board = await worker("board");
    await generateDevVars({ projectDir: dir, values: {} });
    expect(await readFile(join(board, ".dev.vars"), "utf8")).toContain(DEV_VARS_LOCAL);
  });

  test("mode 0600 — it holds the dev master key", async () => {
    const board = await worker("board");
    await generateDevVars({ projectDir: dir, values: { SECRETS_ENCRYPTION_KEYS: "k" } });
    expect((await lstat(join(board, ".dev.vars"))).mode & 0o777).toBe(0o600);
  });

  test("a file already world-readable is narrowed even when its content needs no write", async () => {
    // The skip-when-identical rule is right and it left a hole once before: the one thing that set the
    // mode was a write that never had to happen, so a file another tool created at the umask kept 0664
    // forever while holding the master key.
    const board = await worker("board");
    await generateDevVars({ projectDir: dir, values: { K: "v" } });
    await chmod(join(board, ".dev.vars"), 0o664);

    const result = await generateDevVars({ projectDir: dir, values: { K: "v" } });

    expect(result.unchanged).toEqual([board]);
    expect((await lstat(join(board, ".dev.vars"))).mode & 0o777).toBe(0o600);
  });

  test("a run that changes nothing writes no bytes — asserted on the mtime a watcher reacts to", async () => {
    // The decision is made on content, and the observable is the file's mtime: wrangler watches
    // `.dev.vars`, and rewriting it identically on every `pithy dev`, `pithy add` and `pithy seed` risks
    // a reload for a file whose content never changed.
    const board = await worker("board");
    await generateDevVars({ projectDir: dir, values: { K: "v" } });
    const before = (await lstat(join(board, ".dev.vars"))).mtimeMs;

    const result = await generateDevVars({ projectDir: dir, values: { K: "v" } });

    expect(result.generated).toEqual([]);
    expect(result.unchanged).toEqual([board]);
    expect((await lstat(join(board, ".dev.vars"))).mtimeMs).toBe(before);
  });

  test("a changed value does write, however recently the file was touched", async () => {
    // The half an mtime comparison gets wrong. Nothing in the project changes when a capability upgrade
    // adds a secret to the registry, so a file that is newer than every input can still be missing a
    // binding — and `git checkout` rewrites mtimes to now besides.
    const board = await worker("board");
    await generateDevVars({ projectDir: dir, values: { K: "v" } });

    const result = await generateDevVars({ projectDir: dir, values: { K: "v", ADDED: "1" } });

    expect(result.generated).toEqual([board]);
    expect(parseDevVars(await readFile(join(board, ".dev.vars"), "utf8")).ADDED).toBe("1");
  });

  test("two generations of the same state produce the same bytes, whoever asked", async () => {
    // The header used to carry the resolved secrets-file path, which one caller passed and another did
    // not — so the two generation passes inside a single `pithy dev` wrote two different files and
    // rewrote each other on every run, which is exactly the watcher churn the comparison exists to end.
    // Caught by running `pithy dev` twice and watching the mtime move.
    const board = await worker("board");
    await generateDevVars({ projectDir: dir, values: { K: "v" } });
    const first = await readFile(join(board, ".dev.vars"), "utf8");

    await generateDevVars({ projectDir: dir, workerDirs: [board], values: { K: "v" } });

    expect(await readFile(join(board, ".dev.vars"), "utf8")).toBe(first);
  });

  test("no mtime comparison appears anywhere in the generator", async () => {
    // Stated as a test because the saving it would buy is a few lines of I/O and the cost is a binding
    // that is silently absent. See #154's third comment for the five ways mtime lies.
    const source = await readFile(join(import.meta.dirname, "generate.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/mtime/i);
  });

  test("a .dev.vars pithy did not write is refused by name, never overwritten and never merged", async () => {
    // #142's lesson, and that defect has appeared twice in `.dev.vars` handling already. The file is
    // git-ignored, so what is overwritten is gone from the machine and from history both.
    const board = await worker("board");
    await writeFile(join(board, ".dev.vars"), "MINE=1\n");

    const result = await generateDevVars({ projectDir: dir, values: { K: "v" } });

    expect(result.generated).toEqual([]);
    expect(await readFile(join(board, ".dev.vars"), "utf8")).toBe("MINE=1\n");
    // Actionable rather than a wall: the path, and the supported place for local values.
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toContain(join(board, ".dev.vars"));
    expect(result.refused[0]).toContain(DEV_VARS_LOCAL);
  });

  test("a refusal stops that Worker only — every sibling still gets its bindings", async () => {
    const board = await worker("board");
    const web = await worker("web");
    await writeFile(join(board, ".dev.vars"), "MINE=1\n");

    const result = await generateDevVars({ projectDir: dir, values: { K: "v" } });

    expect(result.generated).toEqual([web]);
    expect(result.refused).toHaveLength(1);
  });

  test("a file pithy generated is overwritten without ceremony — the header is what makes that safe", async () => {
    const board = await worker("board");
    await generateDevVars({ projectDir: dir, values: { K: "old" } });
    await writeFile(join(board, ".dev.vars"), `${GENERATED_MARKER}\nHAND=edited\n`);

    const result = await generateDevVars({ projectDir: dir, values: { K: "new" } });

    expect(result.generated).toEqual([board]);
    expect(parseDevVars(await readFile(join(board, ".dev.vars"), "utf8"))).toEqual({ K: "new" });
  });

  test("a symlink from the old shared-file design becomes a real file, and is never silent", async () => {
    // The upgrade path. A link holds no content, so removing it loses nothing — the file it pointed at
    // is untouched — but which secrets a Worker runs with does change.
    const board = await worker("board");
    await writeFile(join(dir, ".dev.vars"), "SHARED=1\n");
    await symlink(join("..", "..", ".dev.vars"), join(board, ".dev.vars"));

    const result = await generateDevVars({ projectDir: dir, values: { K: "v" } });

    expect(result.relinked).toEqual([board]);
    expect((await lstat(join(board, ".dev.vars"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toBe("SHARED=1\n");
    expect(parseDevVars(await readFile(join(board, ".dev.vars"), "utf8"))).toEqual({ K: "v" });
  });

  describe(".dev.vars.local", () => {
    test("the root file reaches every Worker", async () => {
      const board = await worker("board");
      const web = await worker("web");
      await writeFile(join(dir, DEV_VARS_LOCAL), "X=1\n");

      await generateDevVars({ projectDir: dir, values: {} });

      for (const path of [board, web]) {
        expect(parseDevVars(await readFile(join(path, ".dev.vars"), "utf8")).X).toBe("1");
      }
    });

    test("a local value beats a generated one of the same name", async () => {
      // The whole point: overriding one secret for an afternoon without editing the source of truth and
      // without being blocked by a generator.
      const board = await worker("board");
      await writeFile(join(dir, DEV_VARS_LOCAL), "K=mine\n");

      await generateDevVars({ projectDir: dir, values: { K: "generated" } });

      expect(parseDevVars(await readFile(join(board, ".dev.vars"), "utf8")).K).toBe("mine");
    });

    test("a Worker's own local file wins over the root's", async () => {
      // Root-only is tempting and wrong: generated files legitimately differ per Worker, because a
      // Worker's bindings come from the capabilities *it* composes. An override that can only speak to
      // every Worker at once cannot express "point this one somewhere else".
      const board = await worker("board");
      const web = await worker("web");
      await writeFile(join(dir, DEV_VARS_LOCAL), "K=root\n");
      await writeFile(join(board, DEV_VARS_LOCAL), "K=board\n");

      await generateDevVars({ projectDir: dir, values: { K: "generated" } });

      expect(parseDevVars(await readFile(join(board, ".dev.vars"), "utf8")).K).toBe("board");
      expect(parseDevVars(await readFile(join(web, ".dev.vars"), "utf8")).K).toBe("root");
    });

    test("a local value with a hash in it survives the encoding, like any other", async () => {
      const board = await worker("board");
      await writeFile(join(dir, DEV_VARS_LOCAL), "K='a#b'\n");

      await generateDevVars({ projectDir: dir, values: {} });

      expect(parseDevVars(await readFile(join(board, ".dev.vars"), "utf8")).K).toBe("a#b");
    });

    test("a .dev.vars.local is never written, only read", async () => {
      const board = await worker("board");
      await writeFile(join(dir, DEV_VARS_LOCAL), "X=1\n");
      await generateDevVars({ projectDir: dir, values: { K: "v" } });
      expect(await readFile(join(dir, DEV_VARS_LOCAL), "utf8")).toBe("X=1\n");
      expect(await readdir(board)).not.toContain(DEV_VARS_LOCAL);
    });
  });

  test("a Worker directory reached through a symlink is refused, never written into (#167)", async () => {
    // `discoverWorkers` builds `apps/<name>` from a `readdir` that follows whatever `apps` is, so a link
    // planted at `apps/<name>` had a file holding the project's master key landing outside the project.
    // Whoever can write that directory then reads the team's secrets. The gate is the shared one.
    const canary = await mkdtemp(join(tmpdir(), "pithy-generate-canary-"));
    try {
      await writeFile(join(canary, "wrangler.jsonc"), "{}\n");
      await mkdir(join(dir, "apps"), { recursive: true });
      await symlink(canary, join(dir, "apps", "evil"));

      const result = await generateDevVars({ projectDir: dir, values: { SECRETS_ENCRYPTION_KEYS: "k" } });

      expect(result.generated).toEqual([]);
      // The canary, and not a report about it: nothing was planted there.
      expect(await readdir(canary)).toEqual(["wrangler.jsonc"]);
      expect(result.refused.join("\n")).toContain(join(dir, "apps", "evil"));
    } finally {
      await rm(canary, { recursive: true, force: true });
    }
  });

  test("a symlink at apps carries every Worker out of the project, and is refused the same way", async () => {
    // The half #147 shipped and #167 repeated: gating `apps/<name>` alone leaves the link one level up,
    // which carries the write out of the project exactly as completely.
    const canary = await mkdtemp(join(tmpdir(), "pithy-generate-canary-"));
    try {
      await mkdir(join(canary, "board"), { recursive: true });
      await writeFile(join(canary, "board", "wrangler.jsonc"), "{}\n");
      await symlink(canary, join(dir, "apps"));

      const result = await generateDevVars({ projectDir: dir, values: { SECRETS_ENCRYPTION_KEYS: "k" } });

      expect(result.generated).toEqual([]);
      expect(await readdir(join(canary, "board"))).toEqual(["wrangler.jsonc"]);
    } finally {
      await rm(canary, { recursive: true, force: true });
    }
  });

  test("no value ever reaches the report", async () => {
    // These lines go to a terminal scrollback and to `logs/dev.log`.
    const board = await worker("board");
    await writeFile(join(board, ".dev.vars"), "MINE=1\n");

    const result = await generateDevVars({ projectDir: dir, values: { SECRETS_ENCRYPTION_KEYS: "s3cr3t" } });

    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  test("a project with no Workers generates nothing and says nothing", async () => {
    const result = await generateDevVars({ projectDir: dir, values: { K: "v" } });
    expect(result).toEqual({ generated: [], unchanged: [], refused: [], relinked: [], names: [] });
  });
});
