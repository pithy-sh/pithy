// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { MINTED_TOKENS_FILE_NAME, mintedTokensPath, readMintedTokens, writeMintedToken } from "./mintedTokens";

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

  test("only ENOENT starts from an empty document — a directory at the path is not an absence", async () => {
    // The other half of the same rule, and the portable stand-in for "present and will not open as a
    // file" on a machine where the test runs as root and 0o000 means nothing.
    await mkdir(file(), { recursive: true });

    await expect(writeMintedToken("replay", "dev", "CF_TOKEN_CI_SYSTEM", "fresh", paths())).rejects.toThrow(PithyError);
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
