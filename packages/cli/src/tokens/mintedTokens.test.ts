// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import {
  forgetMintedToken,
  holdsMintedToken,
  MINTED_TOKENS_FILE_NAME,
  mintedTokensPath,
  readMintedTokens,
  writeMintedToken,
} from "./mintedTokens";

/**
 * `<config>/<project>/tokens.json` — where a minted Cloudflare token goes now that nothing is written
 * into the checkout (#182).
 *
 * **The refusal path is the point of most of this file.** This is a read-modify-write over a credential
 * file, and "the file would not open" answered as "there is no file" is the defect this repository has
 * now paid for four times: `.dev.vars` twice (#142 and the loss `readDevVarsFile` was written to end),
 * `dev.json`, and `pithy.manifest.json` (#184) — which is why {@link readOptionalFile} exists at all
 * (#190). A `tokens.json` holding four environments' credentials, replaced by one holding the single
 * token being written, is that defect with a fifth file name and no copy of what it held anywhere.
 */

let dir: string;

function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: dir } };
}

/** The project's file. The name is `replay`, deliberately not a directory basename. */
function file(): string {
  return join(dir, "replay", MINTED_TOKENS_FILE_NAME);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-minted-"));
});

afterEach(async () => {
  // Re-open anything a test tightened, or the cleanup fails on it.
  await chmod(join(dir, "replay"), 0o700).catch(() => {});
  await chmod(file(), 0o600).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("mintedTokensPath", () => {
  test("is keyed on the project's name, beside its secrets — never on a checkout", () => {
    // The same key `secrets.jsonc` and `dev.json` use, so every worktree of one project reads one file.
    expect(mintedTokensPath("replay", paths())).toBe(join(dir, "replay", "tokens.json"));
  });

  test("follows the platform resolver rather than a second one", () => {
    const posix = { platform: "linux" as const, homedir: "/home/u", env: {} };
    expect(mintedTokensPath("replay", posix)).toBe("/home/u/.config/pithy/replay/tokens.json");
  });
});

describe("writeMintedToken", () => {
  test("keys by environment, and a second environment does not disturb the first", async () => {
    await writeMintedToken("replay", "staging", "CF_TOKEN_CI_SYSTEM", "staging-value", paths());
    await writeMintedToken("replay", "production", "CF_TOKEN_CI_SYSTEM", "production-value", paths());

    expect(await readMintedTokens(file())).toEqual({
      staging: { CF_TOKEN_CI_SYSTEM: "staging-value" },
      production: { CF_TOKEN_CI_SYSTEM: "production-value" },
    });
  });

  test("a second token for one environment joins it rather than replacing the document", async () => {
    await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "one", paths());
    await writeMintedToken("replay", "dev", "CF_TOKEN_OTHER", "two", paths());

    expect(await readMintedTokens(file())).toEqual({
      dev: { CF_TOKEN_CI_SYSTEM: "one", CF_TOKEN_OTHER: "two" },
    });
  });

  test("re-minting replaces the value in place — a rolled token has one entry, not two", async () => {
    await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "old", paths());
    await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "new", paths());

    expect(await readMintedTokens(file())).toEqual({ dev: { CF_TOKEN_CI_SYSTEM: "new" } });
  });

  test("**refuses a file it could not read, rather than replacing it**", async () => {
    // Three environments' live credentials are in this file. A read that answered "absent" for `EACCES`
    // would merge the one token being written into an empty base and rename the result over them — every
    // other environment's token gone, with the run reporting a clean write and no copy anywhere.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(
      file(),
      JSON.stringify({
        dev: { CF_TOKEN_CI_SYSTEM: "dev-value" },
        staging: { CF_TOKEN_CI_SYSTEM: "staging-value" },
        production: { CF_TOKEN_CI_SYSTEM: "production-value" },
      }),
      { mode: 0o600 },
    );
    await chmod(file(), 0o000);

    await expect(writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths())).rejects.toThrow(PithyError);

    // Untouched. The bytes are still the three environments', not the one this run was handed.
    await chmod(file(), 0o600);
    expect(await readMintedTokens(file())).toEqual({
      dev: { CF_TOKEN_CI_SYSTEM: "dev-value" },
      staging: { CF_TOKEN_CI_SYSTEM: "staging-value" },
      production: { CF_TOKEN_CI_SYSTEM: "production-value" },
    });
  });

  test("the refusal names the path and the errno, and never a token value", async () => {
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), JSON.stringify({ dev: { CF_TOKEN_CI_SYSTEM: "a-live-credential" } }), { mode: 0o600 });
    await chmod(file(), 0o000);

    const error = await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(file());
    expect(whole).toContain("EACCES");
    expect(whole).not.toContain("a-live-credential");
    expect(whole).not.toContain("fresh");
  });

  test("**refuses a file that parsed to something that is not a document, rather than replacing it**", async () => {
    // The same defect one step further in: this read *succeeded*. A hand edit that wrapped the document
    // in brackets leaves three environments' live credentials on disk and nothing that reads as a
    // document — and an empty base merged with the one token being written renames over all three.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    const held = `${JSON.stringify([
      {
        dev: { CF_TOKEN_CI_SYSTEM: "dev-value" },
        staging: { CF_TOKEN_CI_SYSTEM: "staging-value" },
        production: { CF_TOKEN_CI_SYSTEM: "production-value" },
      },
    ])}\n`;
    await writeFile(file(), held, { mode: 0o600 });

    await expect(writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths())).rejects.toThrow(PithyError);

    // Byte for byte. Nothing was written, so every environment in it is still there to be recovered.
    expect(await readFile(file(), "utf8")).toBe(held);
  });

  test("the four shapes a `null` check would let through are each refused", async () => {
    // `typeof null === "object"`, so a null check reads as the whole rule and is a quarter of it. Every
    // one of these is a plausible hand edit, and every one used to be an empty base to write from.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    for (const source of ["null", '"a-token"', "12345", "true"]) {
      await writeFile(file(), source, { mode: 0o600 });
      await expect(writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths()), source).rejects.toThrow(
        PithyError,
      );
      expect(await readFile(file(), "utf8"), source).toBe(source);
    }
  });

  test("the shape refusal names the file and what it found, and never a token value", async () => {
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), '"a-live-credential"', { mode: 0o600 });

    const error = await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(file());
    expect(whole).toContain("a string");
    expect(whole).not.toContain("a-live-credential");
    expect(whole).not.toContain("fresh");
  });

  /**
   * The likelier hand edit of the two #209 left open, and the one it left wide (#219).
   *
   * A file that parses cleanly to a bare array is exotic. A stray brace after someone opened the file to
   * look at what was in it is ordinary — and it read as `{}`, which the writer merged one token into and
   * renamed over three environments' live credentials, reporting a clean write.
   */
  test("**refuses a file that will not parse, rather than replacing every environment in it**", async () => {
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    // Broken, and still holding all three credentials — which is the point: they are recoverable by hand
    // right up until something rewrites the file from an empty base.
    const held = `{ not json\n${JSON.stringify(
      {
        dev: { CF_TOKEN_CI_SYSTEM: "dev-value" },
        staging: { CF_TOKEN_CI_SYSTEM: "staging-value" },
        production: { CF_TOKEN_CI_SYSTEM: "production-value" },
      },
      null,
      2,
    )}\n`;
    await writeFile(file(), held, { mode: 0o600 });

    await expect(writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths())).rejects.toThrow(PithyError);

    // Byte for byte. Every environment in it is still there.
    expect(await readFile(file(), "utf8")).toBe(held);
  });

  test("and the parse refusal names the file, never a line of it — the parser's own message quotes it", async () => {
    // `JSON.parse` puts the offending text in its message: `Unexpected token 'n', "{ not json" is not
    // valid JSON`. This file is credentials, so the parser's sentence is exactly the one that cannot be
    // carried out to the operator.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), '{ "dev": { "CF_TOKEN_CI_SYSTEM": "a-live-credential" }', { mode: 0o600 });

    const error = await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(file());
    expect(whole).not.toContain("a-live-credential");
    expect(whole).not.toContain("fresh");
  });

  test("**refuses a record that is a document of something else, rather than emptying it**", async () => {
    // It parses, it is a record, and it is not this document: a hand edit that unquoted a token leaves
    // every other environment in the file and every one of them used to go in the next write.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    const held = `${JSON.stringify(
      {
        dev: { CF_TOKEN_CI_SYSTEM: 12345 },
        staging: { CF_TOKEN_CI_SYSTEM: "staging-value" },
        production: { CF_TOKEN_CI_SYSTEM: "production-value" },
      },
      null,
      2,
    )}\n`;
    await writeFile(file(), held, { mode: 0o600 });

    await expect(writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths())).rejects.toThrow(PithyError);

    expect(await readFile(file(), "utf8")).toBe(held);
  });

  test("the invalid-document refusal names the file and where it broke, and never a token value", async () => {
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), JSON.stringify({ dev: { CF_TOKEN_CI_SYSTEM: 12345 }, staging: "a-live-credential" }), {
      mode: 0o600,
    });

    const error = await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    const whole = `${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`;
    expect(whole).toContain(file());
    // The key path is what an operator needs to find the line. The value never is.
    expect(whole).toContain("dev.CF_TOKEN_CI_SYSTEM");
    expect(whole).not.toContain("a-live-credential");
  });

  test("only ENOENT starts from an empty document — a directory at the path is not an absence", async () => {
    // The other half of the same rule, and the portable stand-in for "present and will not open as a
    // file" on a machine where the test runs as root and 0o000 means nothing.
    await mkdir(file(), { recursive: true });

    await expect(writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths())).rejects.toThrow(PithyError);
  });
});

/**
 * The other half of the sink (#762): a value goes into `tokens.json` and, until this, never came out but by
 * a hand edit. The remover is a read-modify-write over the same credential file, so it holds the writer's
 * rules exactly — one merge base, one mode, every other entry left as it was.
 */
describe("forgetMintedToken", () => {
  test("drops one environment's value for one key, and leaves every other entry as it was", async () => {
    await writeMintedToken("replay", "staging", "CF_TOKEN_CI_SYSTEM", "staging-ci", paths());
    await writeMintedToken("replay", "staging", "CF_TOKEN_OTHER", "staging-other", paths());
    await writeMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", "prod-ci", paths());

    expect(await forgetMintedToken("replay", "staging", "CF_TOKEN_CI_SYSTEM", paths())).toEqual({
      path: file(),
      forgotten: true,
    });

    expect(await readMintedTokens(file())).toEqual({
      staging: { CF_TOKEN_OTHER: "staging-other" },
      prod: { CF_TOKEN_CI_SYSTEM: "prod-ci" },
    });
  });

  test("dropping an environment's last key drops the environment — nothing here ever writes `{}` for one", async () => {
    await writeMintedToken("replay", "staging", "CF_TOKEN_CI_SYSTEM", "staging-ci", paths());
    await writeMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", "prod-ci", paths());

    await forgetMintedToken("replay", "staging", "CF_TOKEN_CI_SYSTEM", paths());

    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ prod: { CF_TOKEN_CI_SYSTEM: "prod-ci" } });
  });

  test("writes the file back at 0600, with a trailing newline", async () => {
    await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "a", paths());
    await writeMintedToken("replay", "dev", "CF_TOKEN_OTHER", "b", paths());
    await chmod(file(), 0o644);

    await forgetMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", paths());

    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await readFile(file(), "utf8")).toBe(`${JSON.stringify({ dev: { CF_TOKEN_OTHER: "b" } }, null, 2)}\n`);
  });

  test("no file is nothing to forget — and no file is created to say so", async () => {
    expect(await forgetMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", paths())).toEqual({
      path: file(),
      forgotten: false,
    });
    await expect(stat(file())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a key that is not there leaves the file byte for byte, and rewrites nothing", async () => {
    await writeMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", "prod-ci", paths());
    const before = await readFile(file(), "utf8");
    const mtime = (await stat(file())).mtimeMs;

    expect(await forgetMintedToken("replay", "staging", "CF_TOKEN_CI_SYSTEM", paths())).toEqual({
      path: file(),
      forgotten: false,
    });

    expect(await readFile(file(), "utf8")).toBe(before);
    expect((await stat(file())).mtimeMs).toBe(mtime);
  });

  test("**refuses a file it could not make sense of, rather than rewriting it**", async () => {
    // The writer's rule, for the same reason: a remover that read a broken file as `{}` would have nothing
    // to remove and write nothing — but one that read it as a partial document would rename the part over
    // the whole. Byte for byte, every environment in it stays recoverable.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    const held = `{ not json\n${JSON.stringify({ prod: { CF_TOKEN_CI_SYSTEM: "a-live-credential" } })}\n`;
    await writeFile(file(), held, { mode: 0o600 });

    const error = await forgetMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", paths()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    expect(`${payload.message} ${payload.action ?? ""} ${payload.detail ?? ""}`).not.toContain("a-live-credential");
    expect(await readFile(file(), "utf8")).toBe(held);
  });

  test("refuses an unreadable file too", async () => {
    await writeMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", "prod-ci", paths());
    await chmod(file(), 0o000);

    await expect(forgetMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", paths())).rejects.toThrow(PithyError);
  });
});

describe("holdsMintedToken", () => {
  test("says whether one environment holds a value for one key", async () => {
    await writeMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", "prod-ci", paths());

    expect(await holdsMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", paths())).toBe(true);
    expect(await holdsMintedToken("replay", "staging", "CF_TOKEN_CI_SYSTEM", paths())).toBe(false);
    expect(await holdsMintedToken("replay", "prod", "CF_TOKEN_OTHER", paths())).toBe(false);
  });

  test("no file holds nothing", async () => {
    expect(await holdsMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", paths())).toBe(false);
  });

  test("is the strict read — a file it cannot make sense of is a refusal, not a `false`", async () => {
    // A `false` here is what tells `pithy token forget` there is nothing to protect. Answering it for a
    // file that would not parse would skip the check that the value has a second copy somewhere.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), "{ not json", { mode: 0o600 });

    await expect(holdsMintedToken("replay", "prod", "CF_TOKEN_CI_SYSTEM", paths())).rejects.toThrow(PithyError);
  });
});

describe("readMintedTokens", () => {
  test("no file is an empty document — a project that has minted nothing is not a fault", async () => {
    expect(await readMintedTokens(file())).toEqual({});
  });

  test("a file that will not parse reads as empty — a reader has nothing to destroy", async () => {
    // The asymmetry is deliberate: the *writer* refuses, because it is the one that could replace what
    // it could not read. A caller reading a token back gets an honest "nothing here".
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), "{ not json", { mode: 0o600 });

    expect(await readMintedTokens(file())).toEqual({});
  });

  test("a non-string value is not handed back as a credential", async () => {
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), JSON.stringify({ dev: { CF_TOKEN_CI_SYSTEM: 12345 } }), { mode: 0o600 });

    expect(await readMintedTokens(file())).toEqual({});
  });

  test("a file that parsed to a value that is not a document refuses here too", async () => {
    // The asymmetry above is about a file that will not *parse* — the reader has nothing to destroy and
    // says "nothing here". A file that parsed to a string is a different claim: something is in it, this
    // is not what it is, and answering `{}` is what let the writer replace it. Same rule as an unreadable
    // one, and it is the file's rather than each caller's.
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), '"a-token"', { mode: 0o600 });

    await expect(readMintedTokens(file())).rejects.toThrow(PithyError);
  });

  test("an unreadable file refuses here too — the rule is the file's, not the caller's", async () => {
    await mkdir(join(dir, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(file(), JSON.stringify({ dev: {} }), { mode: 0o600 });
    await chmod(file(), 0o000);

    await expect(readMintedTokens(file())).rejects.toThrow(PithyError);
  });
});

describe("the bytes on disk", () => {
  test("are JSON with a trailing newline, so a hand edit and a git diff both behave", async () => {
    await writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "v", paths());

    expect(await readFile(file(), "utf8")).toBe(`${JSON.stringify({ dev: { CF_TOKEN_CI_SYSTEM: "v" } }, null, 2)}\n`);
  });
});
