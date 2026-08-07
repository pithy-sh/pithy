// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DOTENV_LINE, encodeDevVarsValue, parseDotenv, writeDevVars } from "./devVars";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-dev-vars-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every value shape a secret can take that the unquoted form gets wrong. */
const HOSTILE = [
  ["a hash truncates an unquoted value", "s3cr3t#tail"],
  ["a hash with no tail", "#leading"],
  ["a JSON envelope with a hash inside", '{"currentVersion":"1","versions":{"1":"ab#cd"}}'],
  ["an apostrophe and a hash", "it's#fine"],
  ["a double quote and a hash", 'say "hi"#now'],
  ["a value wrapped in double quotes", '"quoted"'],
  ["a value wrapped in single quotes", "'quoted'"],
  ["a value wrapped in backticks", "`quoted`"],
  ["leading and trailing spaces", "  padded  "],
  ["a backslash-n that dotenv would expand", "a\\nb#c"],
  ["a lone backslash", "back\\slash"],
  ["an equals sign", "a=b#c"],
] as const;

describe("encodeDevVarsValue", () => {
  test("an ordinary value is written exactly as it was — no churn on every project in the world", () => {
    const value = '{"currentVersion":"1","versions":{"1":"sCD2pPmEMv_KYnjav5"}}';
    expect(encodeDevVarsValue("auth-session-secret", value)).toEqual({ encoded: value, refused: null });
  });

  test.each(HOSTILE)("%s round-trips through wrangler's reader and ours", (_label, value) => {
    const result = encodeDevVarsValue("auth-session-secret", value);
    expect(result.refused).toBeNull();
    const line = `auth-session-secret=${result.encoded}\n`;
    // The two readers that matter: wrangler's, which is what the Worker actually gets, and ours, which
    // is what `pithy doctor` and the seeder compare against. A value only counts as written when both
    // hand it back unchanged.
    expect(parseDotenv(line)["auth-session-secret"]).toBe(value);
    expect(parseDevVars(line)["auth-session-secret"]).toBe(value);
  });

  test("a value no encoding survives is refused by name, and the refusal carries no value", () => {
    // A newline cannot be represented: our own reader splits the file on it, so any encoding that
    // dotenv accepts would still come back truncated.
    const result = encodeDevVarsValue("auth-google-credentials", "one\ntwo");
    expect(result.encoded).toBeNull();
    expect(result.refused).toContain("auth-google-credentials");
    expect(result.refused).not.toContain("one");
  });

  test("a secret name .dev.vars cannot hold is refused rather than written to nowhere", () => {
    // dotenv's key grammar is `[\w.-]+`. A name outside it produces a line the Worker never sees, and
    // silence is the worst possible answer for a secret.
    const result = encodeDevVarsValue("auth:session:secret", "value");
    expect(result.encoded).toBeNull();
    expect(result.refused).toContain("auth:session:secret");
  });
});

describe("parseDotenv", () => {
  test("is wrangler's own grammar, not an approximation of it", async () => {
    // The alarm for the day wrangler changes its dotenv. `encodeDevVarsValue` verifies every value it
    // writes against this parser, so a drift here is a value that reads back as something else in the
    // one process that matters — and it would drift silently.
    const bundle = await readFile(
      join(import.meta.dirname, "../../node_modules/wrangler/wrangler-dist/cli.js"),
      "utf8",
    );
    expect(bundle).toContain(DOTENV_LINE.source);
  });

  test("an unquoted value stops at a hash — the truncation this exists to prevent", () => {
    expect(parseDotenv("K=abc#def\n").K).toBe("abc");
  });
});

describe("writeDevVars", () => {
  test("the value reaches the Worker, not just the project root", async () => {
    // `pithy dev` runs wrangler with `cwd: apps/<worker>`, and wrangler reads the `.dev.vars` beside the
    // Worker's own config. A value written only at the project root is a value the Worker never sees:
    // a fresh `pithy init` + `pithy add auth` + `pithy dev` answered
    // `Secret binding 'auth-session-secret' is not configured.` with the row seeded and the line written.
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");

    const result = await writeDevVars({ projectDir: dir, values: { "auth-session-secret": "v" } });

    expect(result.written).toEqual(["auth-session-secret"]);
    expect(result.linked).toEqual([join(dir, "apps", "board")]);
    const seen = parseDevVars(await readFile(join(dir, "apps", "board", ".dev.vars"), "utf8"));
    expect(seen["auth-session-secret"]).toBe("v");
  });

  test("the link is relative, so a copied or moved project still resolves it", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await writeDevVars({ projectDir: dir, values: { K: "v" } });
    expect(await readlink(join(dir, "apps", "board", ".dev.vars"))).toBe(join("..", "..", ".dev.vars"));
  });

  test("a Worker's own .dev.vars is never replaced — it is reported as shadowing instead", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await writeFile(join(dir, "apps", "board", ".dev.vars"), "MINE=1\n");

    const result = await writeDevVars({ projectDir: dir, values: { "auth-session-secret": "v" } });

    expect(result.shadowed).toEqual([join(dir, "apps", "board")]);
    expect(await readFile(join(dir, "apps", "board", ".dev.vars"), "utf8")).toBe("MINE=1\n");
  });

  test("an existing symlink is left exactly where it points — a worktree's link is deliberate", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await writeFile(join(dir, "shared"), "SHARED=1\n");
    await symlink(join("..", "..", "shared"), join(dir, "apps", "board", ".dev.vars"));

    await writeDevVars({ projectDir: dir, values: { K: "v" } });

    expect(await readlink(join(dir, "apps", "board", ".dev.vars"))).toBe(join("..", "..", "shared"));
  });

  test("a refused value is named and nothing is written for it", async () => {
    const result = await writeDevVars({ projectDir: dir, values: { good: "ok", bad: "one\ntwo" } });
    expect(result.written).toEqual(["good"]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toContain("bad");
    const seen = parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"));
    expect(seen).toEqual({ good: "ok" });
  });

  test.each(HOSTILE)("%s survives the whole write path, not only the encoder", async (_label, value) => {
    // The encoder had a test from the day it was written; the path that calls it did not. Reintroducing
    // the truncation — writing `values` where `encoded` goes — left the whole suite green.
    await writeDevVars({ projectDir: dir, values: { "auth-session-secret": value } });
    const source = await readFile(join(dir, ".dev.vars"), "utf8");
    expect(parseDotenv(source)["auth-session-secret"]).toBe(value);
    expect(parseDevVars(source)["auth-session-secret"]).toBe(value);
  });

  test("a refused value takes its superseded line with it, rather than leaving one that still works", async () => {
    // Fail-closed. `.dev.vars` is the only place dev reads until #153, so a refusal that leaves the old
    // line behind hands the Worker the previous secret while every report says the value was replaced.
    // Wrong-and-silent is the one outcome worth breaking dev over.
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=superseded\n");

    const result = await writeDevVars({ projectDir: dir, values: { "auth-session-secret": "one\ntwo" } });

    expect(result.written).toEqual([]);
    expect(parseDevVars(await readFile(join(dir, ".dev.vars"), "utf8"))).toEqual({});
    expect(result.refused.join("\n")).toContain("superseded line was removed");
  });

  test("a refusal with no line to supersede says only what happened", async () => {
    const result = await writeDevVars({ projectDir: dir, values: { "auth-session-secret": "one\ntwo" } });
    expect(result.refused.join("\n")).not.toContain("superseded line was removed");
  });

  test("in a feature worktree the value reaches the Worker, through the link the layout uses", async () => {
    // The layout `pithy feature create` and `pithy worker add` produce, copied from a real one: the
    // worktree root's `.dev.vars` and every worker's are absolute symlinks at the main checkout's single
    // shared file. Writing at the root replaced that link with a private file and left every worker
    // pointing at the untouched original — `written: ["auth-session-secret"]`, `shadowed: []`, and
    // `wrangler dev` in the worktree served the superseded value from inside the Worker.
    const main = join(dir, "main");
    const worktree = join(main, ".worktrees", "wt");
    await mkdir(join(worktree, "apps", "board"), { recursive: true });
    await writeFile(join(main, ".dev.vars"), "auth-session-secret=superseded\n");
    await writeFile(join(worktree, "apps", "board", "wrangler.jsonc"), "{}\n");
    await symlink(join(main, ".dev.vars"), join(worktree, ".dev.vars"));
    await symlink(join(main, ".dev.vars"), join(worktree, "apps", "board", ".dev.vars"));

    const result = await writeDevVars({ projectDir: worktree, values: { "auth-session-secret": "fresh" } });

    // Read where wrangler reads it: the worker's own directory, with `cwd: apps/board`.
    const seen = parseDevVars(await readFile(join(worktree, "apps", "board", ".dev.vars"), "utf8"));
    expect(seen["auth-session-secret"]).toBe("fresh");
    // Already resolving to the file that was written. Nothing to link, and nothing shadowing it.
    expect(result).toMatchObject({ written: ["auth-session-secret"], linked: [], shadowed: [], undelivered: [] });
    // And the sharing survives. Writing over the link would take the worktree off the repo's one file.
    expect((await lstat(join(worktree, ".dev.vars"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(main, ".dev.vars"))).isFile()).toBe(true);
  });

  test("a link pointing at some other file is reported — nothing written here reaches that Worker", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await writeFile(join(dir, "shared"), "SHARED=1\n");
    await symlink(join("..", "..", "shared"), join(dir, "apps", "board", ".dev.vars"));

    const result = await writeDevVars({ projectDir: dir, values: { K: "v" } });

    expect(result.shadowed).toEqual([join(dir, "apps", "board")]);
  });

  test("a link that could not be created is reported, never counted as delivered", async () => {
    // The `catch(() => {})` this replaces pushed the directory onto `linked` regardless, so a delivery
    // that did not happen was reported as one — for a secret, the worst answer available.
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await chmod(join(dir, "apps", "board"), 0o500);
    try {
      const result = await writeDevVars({ projectDir: dir, values: { "auth-session-secret": "v" } });

      expect(result.linked).toEqual([]);
      expect(result.undelivered.join("\n")).toContain(join(dir, "apps", "board"));
    } finally {
      await chmod(join(dir, "apps", "board"), 0o700);
    }
  });

  test("the file is 0600 — it holds the same values .dev.secrets.jsonc does", async () => {
    await writeDevVars({ projectDir: dir, values: { K: "v" } });
    expect((await lstat(join(dir, ".dev.vars"))).mode & 0o777).toBe(0o600);
  });

  test("a .dev.vars that is there and will not open is never replaced by one holding only new values", async () => {
    // `readFile(...).catch(() => null)` read `EACCES` as "no file", so the write built its next content
    // from an empty base and renamed it over a file full of values it never saw. The same silent data
    // loss `readSource` was written to end for `.dev.secrets.jsonc`, in the file beside it. Only `ENOENT`
    // means absent.
    const path = join(dir, ".dev.vars");
    await writeFile(path, "KEEP=1\n");
    await chmod(path, 0o000);
    try {
      await expect(writeDevVars({ projectDir: dir, values: { K: "v" } })).rejects.toThrow(/could not be read/);
      await chmod(path, 0o600);
      expect(await readFile(path, "utf8")).toBe("KEEP=1\n");
    } finally {
      await chmod(path, 0o600).catch(() => {});
    }
  });

  test("a .dev.vars already world-readable is tightened, even when its content needs no write", async () => {
    // The no-write-when-identical guard is right and it left a hole: a file created at the umask before
    // this branch existed — or by any other tool — kept 0664 forever, because the one thing that set the
    // mode was a write that never had to happen. Nothing diagnosed it either.
    const path = join(dir, ".dev.vars");
    await writeFile(path, "K=v\n");
    await chmod(path, 0o664);

    const result = await writeDevVars({ projectDir: dir, values: { K: "v" } });

    expect(result.written).toEqual(["K"]);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test("a deliberately tighter mode survives — this narrows, it never widens", async () => {
    const path = join(dir, ".dev.vars");
    await writeFile(path, "K=v\n");
    await chmod(path, 0o400);
    try {
      await writeDevVars({ projectDir: dir, values: { K: "v" } });
      expect((await lstat(path)).mode & 0o777).toBe(0o400);
    } finally {
      await chmod(path, 0o600);
    }
  });

  test("a symlink chain that never ends is refused out loud, not written through", async () => {
    // The bound existed and the docstring promised a loud failure at it. What the code did was return a
    // path that was still a symlink, and the atomic rename then replaced that link with a private file —
    // the exact silent detachment the worktree case above exists to prevent.
    await symlink(join(dir, "b"), join(dir, ".dev.vars"));
    await symlink(join(dir, ".dev.vars"), join(dir, "b"));

    await expect(writeDevVars({ projectDir: dir, values: { K: "v" } })).rejects.toThrow(/never ends/);
    expect((await lstat(join(dir, ".dev.vars"))).isSymbolicLink()).toBe(true);
  });

  test("nothing to write touches no file at all", async () => {
    const result = await writeDevVars({ projectDir: dir, values: {} });
    expect(result).toEqual({ written: [], refused: [], linked: [], shadowed: [], undelivered: [] });
    await expect(lstat(join(dir, ".dev.vars"))).rejects.toThrow();
  });
});

describe("the producers", () => {
  /**
   * Every non-test module under `src/`, with its comments stripped — `.dev.vars` is named in prose in
   * forty files, and a docstring cannot write one. What is left is code.
   */
  async function code(): Promise<{ path: string; text: string }[]> {
    const root = join(import.meta.dirname, "..");
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    const out: { path: string; text: string }[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".ts") || file.name.endsWith(".test.ts")) continue;
      const full = join(file.parentPath, file.name);
      const source = await readFile(full, "utf8");
      out.push({ path: relative(root, full), text: source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "") });
    }
    return out;
  }

  test("nothing writes a .dev.vars value except the modules that are supposed to", async () => {
    // The tripwire, and the reason this is a test rather than a comment asking people to be careful.
    // Four rounds of review on this branch each found the same defect in one more producer than the
    // last. A `.dev.vars` value written anywhere but here is unquoted, unverified, and lands in a file
    // the Worker's wrangler does not open.
    //
    // A sixth producer makes this list grow, and the failure names the file. Route it through
    // `writeDevVars` and delete the line, or pin it here with the reason it is exempt.
    const writers = (await code())
      .filter(({ text }) => /["'`]\.dev\.vars/.test(text) && /write(FileAtomic|File)\(|upsertDevVars\(/.test(text))
      .map(({ path }) => path)
      .sort();

    expect(writers).toEqual(
      [
        // The funnel: it encodes every value, and links it into each Worker's own directory.
        join("devSecrets", "devVars.ts"),
        // A minted CLI token — hex, from `pithy token mint`, through its own writer. Out of #149's
        // scope, and pinned here rather than left for a seventh round of review to discover.
        join("tokens", "sinks.ts"),
        // Reads `.dev.vars` for a seed driver's credential; the write is the seed artifact, not a var.
        join("seed", "prepare.ts"),
        // `pithy init` seeds the project's one shared `.dev.vars` from the committed
        // `.dev.vars.example` — a comment block, at 0600. It writes the *file*, never a value: there
        // is no secret in existence yet when it runs. Added when this branch met the merged `main`,
        // which is the first tree in which both writers existed.
        join("project", "scaffold.ts"),
      ].sort(),
    );
  });
});
