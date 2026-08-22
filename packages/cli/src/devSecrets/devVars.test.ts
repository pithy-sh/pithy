// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { readBootstrapVars } from "./bootstrapVars";
import { DOTENV_LINE, encodeDevVarsValue, parseDotenv, writeDevVars } from "./devVars";

let dir: string;
let config: string;

/** The config seams. A fresh directory per test, so no run can read or write the operator's own file. */
function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-dev-vars-"));
  config = await mkdtemp(join(tmpdir(), "pithy-dev-vars-config-"));
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** A Worker directory wrangler would run in. */
async function worker(name: string): Promise<string> {
  const path = join(dir, "apps", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "wrangler.jsonc"), "{}\n");
  return path;
}

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
    const board = await worker("board");

    const result = await writeDevVars({ projectDir: dir, values: { CLOUDFLARE_API_TOKEN: "v" }, paths: paths() });

    expect(result.written).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(result.generated).toEqual([board]);
    const seen = parseDevVars(await readFile(join(board, ".dev.vars"), "utf8"));
    expect(seen.CLOUDFLARE_API_TOKEN).toBe("v");
  });

  test("the value persists in the machine-local store, so the next run can regenerate without it", async () => {
    // A generated file cannot be its own source of truth. The master key `pithy add secrets` mints has to
    // survive to the next `pithy dev`, and reading it back out of the file it generated is the
    // accumulating `.dev.vars` this change exists to end.
    await worker("board");
    await writeDevVars({ projectDir: dir, values: { SECRETS_ENCRYPTION_KEYS: "k" }, paths: paths() });

    expect(await readBootstrapVars(dir, paths())).toEqual({ SECRETS_ENCRYPTION_KEYS: "k" });

    const again = await writeDevVars({ projectDir: dir, values: {}, paths: paths() });
    expect(again.unchanged).toEqual([join(dir, "apps", "board")]);
    expect(parseDevVars(await readFile(join(dir, "apps", "board", ".dev.vars"), "utf8"))).toEqual({
      SECRETS_ENCRYPTION_KEYS: "k",
    });
  });

  test("a refused value is named and nothing is written for it", async () => {
    await worker("board");
    const result = await writeDevVars({ projectDir: dir, values: { good: "ok", bad: "one\ntwo" }, paths: paths() });
    expect(result.written).toEqual(["good"]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toContain("bad");
    expect(result.refused[0]).not.toContain("one");
    const seen = parseDevVars(await readFile(join(dir, "apps", "board", ".dev.vars"), "utf8"));
    expect(seen).toEqual({ good: "ok" });
  });

  test.each(HOSTILE)("%s survives the whole write path, not only the encoder", async (_label, value) => {
    // The encoder had a test from the day it was written; the path that calls it did not. Reintroducing
    // the truncation — writing `values` where `encoded` goes — left the whole suite green.
    const board = await worker("board");
    await writeDevVars({ projectDir: dir, values: { CLOUDFLARE_API_TOKEN: value }, paths: paths() });
    const source = await readFile(join(board, ".dev.vars"), "utf8");
    expect(parseDotenv(source).CLOUDFLARE_API_TOKEN).toBe(value);
    expect(parseDevVars(source).CLOUDFLARE_API_TOKEN).toBe(value);
  });

  test("a refused value has no superseded line to leave behind — the file is built, not edited", async () => {
    // Fail-closed, and structurally. The binding is the only place a `cf-secrets-store` secret is read
    // from, so a refusal that left the old line in place handed the Worker the previous secret while
    // every report said the value was replaced. A generated file is rebuilt from the sources, so the
    // superseded line cannot survive a refusal.
    const board = await worker("board");
    await writeDevVars({ projectDir: dir, values: { CLOUDFLARE_API_TOKEN: "superseded" }, paths: paths() });

    const result = await writeDevVars({
      projectDir: dir,
      values: { CLOUDFLARE_API_TOKEN: "one\ntwo" },
      paths: paths(),
    });

    expect(result.written).toEqual([]);
    expect(parseDevVars(await readFile(join(board, ".dev.vars"), "utf8")).CLOUDFLARE_API_TOKEN).toBe("superseded");
    expect(result.refused.join("\n")).toContain("CLOUDFLARE_API_TOKEN");
  });

  test("a project with no name records nothing and still generates from what it has", async () => {
    // `requireProjectName` is what keys the machine-local store, and a nameless project has no key. It
    // must not be a crash: `pithy dev` has to start a project whose config is half-written.
    await rm(join(dir, "pithy.config.ts"));
    await worker("board");

    const result = await writeDevVars({ projectDir: dir, values: { K: "v" }, paths: paths() });

    expect(result.generated).toEqual([join(dir, "apps", "board")]);
    expect(parseDevVars(await readFile(join(dir, "apps", "board", ".dev.vars"), "utf8"))).toEqual({});
  });
});

describe("the producers", () => {
  /**
   * Every non-test module under `src/`, with its comments blanked — `.dev.vars` is named in prose in
   * forty files, and a docstring cannot write one. What is left is code.
   *
   * The shared walk rather than a pattern (#439). A pattern has no notion of a string, so the `//` in a
   * URL blanked the rest of its line — and the rest of a line is where the write this scans for sits.
   */
  async function code(): Promise<{ path: string; text: string }[]> {
    const root = join(import.meta.dirname, "..");
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    const out: { path: string; text: string }[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".ts") || file.name.endsWith(".test.ts")) continue;
      const full = join(file.parentPath, file.name);
      const source = await readFile(full, "utf8");
      out.push({ path: relative(root, full), text: blankComments(source) });
    }
    return out;
  }

  test("nothing writes a .dev.vars value except the modules that are supposed to", async () => {
    // The tripwire, and the reason this is a test rather than a comment asking people to be careful.
    // Four rounds of review on this branch each found the same defect in one more producer than the
    // last. A `.dev.vars` value written anywhere but here is unquoted, unverified, and lands in a file
    // the Worker's wrangler does not open.
    //
    // A fourth producer makes this list grow, and the failure names the file. Route it through
    // `writeDevVars` and delete the line, or pin it here with the reason it is exempt.
    const writers = (await code())
      .filter(({ text }) => /["'`]\.dev\.vars/.test(text) && /write(FileAtomic|File)\(|upsertDevVars\(/.test(text))
      .map(({ path }) => path)
      .sort();

    expect(writers).toEqual(
      [
        // The generator: it encodes every value and writes each Worker's own file (#154). Nothing else
        // writes an `apps/<worker>/.dev.vars` at all.
        join("devSecrets", "generate.ts"),
        // The machine-local store the generator reads. It writes `dev.json`, never a `.dev.vars` — it
        // is here because it names the variable namespace in a schema description.
        join("devSecrets", "bootstrapVars.ts"),
        // `tokens/sinks.ts` was here while `pithy token mint --store dev-vars` wrote the project's
        // `.dev.vars` and `.dev.vars.<env>`. It writes `<config>/<project>/tokens.json` now (#182), so
        // no minted credential lands in the checkout for any environment and there is no `.dev.vars`
        // string left in it to match.
        // `seed/prepare.ts` was here while it read `.dev.vars` for a prepared set's secret. It reads
        // the dev secrets file now (#176), so it neither writes nor reads a `.dev.vars` at all.
      ].sort(),
    );
  });
});
