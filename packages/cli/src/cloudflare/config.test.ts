// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CLOUDFLARE_CONFIG_FILE_NAME,
  CloudflareAccountName,
  type CloudflareConfigOptions,
  cloudflareAccountConfirmation,
  cloudflareAccountFile,
  cloudflareConfigPath,
  cloudflareCredentialSplit,
  cloudflareEnv,
  describeUnconfirmedCloudflareAccount,
  parseCloudflareConfig,
  pithyOffline,
  resolveCloudflare,
  sessionMark,
  writeCloudflareConfig,
} from "./config";
import { bindProfile } from "./session/bindings";
import { writeSession } from "./session/store";

/**
 * Every test here resolves against a temp `PITHY_CONFIG_DIR`. That is not tidiness: the real file holds
 * the operator's live Cloudflare API token, and a suite that read or wrote it would either leak it into
 * an assertion or destroy it.
 */
let dir: string;

function paths(env: Record<string, string> = {}): CloudflareConfigOptions {
  // The unnamed file, stated: every resolution says which account it is for, and "none" is an answer.
  return { env: { PITHY_CONFIG_DIR: dir, ...env }, account: null };
}

async function config(values: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, CLOUDFLARE_CONFIG_FILE_NAME), JSON.stringify(values, null, 2), { mode: 0o600 });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-cf-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cloudflareConfigPath", () => {
  test("is the account's file at the config root, not under any project", () => {
    expect(cloudflareConfigPath(paths())).toBe(join(dir, "cloudflare.json"));
  });

  test("a named account selects its own file, so two projects on one machine do not share one", () => {
    expect(cloudflareConfigPath({ ...paths(), account: { accountName: "leed" } })).toBe(
      join(dir, "cloudflare.leed.json"),
    );
    expect(cloudflareConfigPath({ ...paths(), account: { accountName: "other-co" } })).toBe(
      join(dir, "cloudflare.other-co.json"),
    );
  });

  test("no name resolves cloudflare.json exactly as before — nothing changes for a single-account machine", () => {
    expect(cloudflareConfigPath({ ...paths(), account: { accountId: "acct" } })).toBe(join(dir, "cloudflare.json"));
    expect(cloudflareConfigPath({ ...paths(), account: null })).toBe(join(dir, "cloudflare.json"));
  });

  test("there is no ambient to fall back to — the account is always the caller's word", () => {
    // The whole point of the required argument: two resolutions in one process, for two accounts,
    // neither able to affect the other. A holder made this a question of which ran first.
    expect(cloudflareConfigPath({ ...paths(), account: { accountName: "leed" } })).toBe(
      join(dir, "cloudflare.leed.json"),
    );
    expect(cloudflareConfigPath(paths())).toBe(join(dir, "cloudflare.json"));
  });
});

/**
 * `accountName` is a config string that becomes a file name in the config directory — outside every
 * checkout, so `ensureScaffoldPath` and the atomic writer do not cover it. The schema is the gate, and
 * these are the values that make it one (#174, #183).
 */
describe("CloudflareAccountName", () => {
  test.each([
    ["../../etc/passwd", "a traversal"],
    ["../cloudflare", "a parent segment"],
    ["a/b", "a posix separator"],
    ["a\\b", "a windows separator"],
    ["", "empty"],
    [" ", "blank"],
    ["leed ", "a trailing space"],
    ["Leed", "an uppercase letter"],
    ["leed.prod", "a dot"],
    [`leed${String.fromCharCode(0)}`, "a null byte"],
    [`leed${String.fromCharCode(7)}`, "a control character"],
    ["leed\nx", "a newline"],
    ["-leed", "a leading hyphen"],
    ["leed-", "a trailing hyphen"],
    ["a--b", "a doubled hyphen"],
    ["~", "a home reference"],
    ["a".repeat(65), "longer than a name has any reason to be"],
  ])("refuses %j — %s", (value) => {
    expect(CloudflareAccountName.safeParse(value).success).toBe(false);
  });

  test.each(["leed", "other-co", "acme2", "13ways", "a"])("accepts the bare token %j", (value) => {
    expect(CloudflareAccountName.safeParse(value).success).toBe(true);
  });

  test("the refusal names the config and the value, so the fix needs no second lookup", () => {
    const message = CloudflareAccountName.safeParse("../../etc/passwd").error?.issues[0]?.message ?? "";
    expect(message).toContain("cloudflare.accountName");
    expect(message).toContain("pithy.config.ts");
    expect(message).toContain("../../etc/passwd");
  });

  test("a name that is not a bare token never reaches a path, even passed straight to the resolver", () => {
    expect(() => cloudflareAccountFile("../../etc/passwd")).toThrow(PithyError);
    expect(() => cloudflareConfigPath({ ...paths(), account: { accountName: "a/b" } })).toThrow(PithyError);
    expect(() => resolveCloudflare({ ...paths(), account: { accountName: ".." } })).toThrow(PithyError);
  });

  test("the file name is the whole shape, so nothing else can be spliced into it", () => {
    expect(cloudflareAccountFile(null)).toBe("cloudflare.json");
    expect(cloudflareAccountFile("leed")).toBe("cloudflare.leed.json");
  });
});

describe("the account a project names", () => {
  test("two projects naming different accounts each resolve their own credentials", async () => {
    await writeFile(
      join(dir, "cloudflare.leed.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "leed-acct", CLOUDFLARE_API_TOKEN: "leed-token" }),
    );
    await writeFile(
      join(dir, "cloudflare.other-co.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "other-acct", CLOUDFLARE_API_TOKEN: "other-token" }),
    );
    // The unnamed file holds a third account's pair, and neither project may read it.
    await config({ CLOUDFLARE_ACCOUNT_ID: "default-acct", CLOUDFLARE_API_TOKEN: "default-token" });

    expect(cloudflareEnv({ ...paths(), account: { accountName: "leed" } })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "leed-acct",
      CLOUDFLARE_API_TOKEN: "leed-token",
    });
    expect(cloudflareEnv({ ...paths(), account: { accountName: "other-co" } })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "other-acct",
      CLOUDFLARE_API_TOKEN: "other-token",
    });
    expect(cloudflareEnv(paths()).CLOUDFLARE_ACCOUNT_ID).toBe("default-acct");
  });

  test("a named file that does not exist resolves to no credentials, never to the unnamed one", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "default-acct", CLOUDFLARE_API_TOKEN: "default-token" });
    expect(cloudflareEnv({ ...paths(), account: { accountName: "leed" } })).toEqual({});
  });

  test("the environment overlay still fills a named file's gaps, per key", async () => {
    await writeFile(join(dir, "cloudflare.leed.json"), JSON.stringify({ CLOUDFLARE_API_TOKEN: "leed-token" }));
    expect(
      cloudflareEnv({ ...paths({ CLOUDFLARE_ACCOUNT_ID: "from-env" }), account: { accountName: "leed" } }),
    ).toEqual({ CLOUDFLARE_API_TOKEN: "leed-token", CLOUDFLARE_ACCOUNT_ID: "from-env" });
  });

  test("a store id is recorded into the file the project selected", async () => {
    const account = { accountName: "leed" };
    await writeCloudflareConfig({ CLOUDFLARE_API_TOKEN: "leed-token" }, { ...paths(), account });
    await writeCloudflareConfig({ SECRETS_STORE_ID: "store-leed" }, { ...paths(), account });
    expect(JSON.parse(await readFile(join(dir, "cloudflare.leed.json"), "utf8"))).toMatchObject({
      CLOUDFLARE_API_TOKEN: "leed-token",
      SECRETS_STORE_ID: "store-leed",
    });
    expect(cloudflareEnv(paths())).toEqual({});
  });

  test("the credential split is read from the selected file, not from the unnamed one", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "default-acct", CLOUDFLARE_API_TOKEN: "default-token" });
    await writeFile(join(dir, "cloudflare.leed.json"), JSON.stringify({ CLOUDFLARE_API_TOKEN: "leed-token" }));
    expect(
      cloudflareCredentialSplit({ ...paths({ CLOUDFLARE_ACCOUNT_ID: "from-env" }), account: { accountName: "leed" } }),
    ).toEqual({ fromFile: ["CLOUDFLARE_API_TOKEN"], fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"] });
  });
});

/**
 * The pin. `cloudflare.<name>.json` is a local file whose nickname means whatever each machine says it
 * means, so the repository is the only thing that can hold a nickname to an account.
 */
describe("cloudflare.accountId, the pin", () => {
  test("credentials that match the pin resolve exactly as they would without one", async () => {
    await writeFile(
      join(dir, "cloudflare.leed.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "leed-acct", CLOUDFLARE_API_TOKEN: "leed-token" }),
    );
    const account = { accountName: "leed", accountId: "leed-acct" };
    expect(cloudflareEnv({ ...paths(), account }).CLOUDFLARE_ACCOUNT_ID).toBe("leed-acct");
  });

  test("a file naming another account refuses, and the refusal names both ids and the file", async () => {
    await writeFile(
      join(dir, "cloudflare.leed.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "someone-elses", CLOUDFLARE_API_TOKEN: "leed-token" }),
    );
    const account = { accountName: "leed", accountId: "leed-acct" };
    const thrown = (() => {
      try {
        cloudflareEnv({ ...paths(), account });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(PithyError);
    const message = (thrown as PithyError).payload.message;
    expect(message).toContain("leed-acct");
    expect(message).toContain("someone-elses");
    expect(message).toContain(join(dir, "cloudflare.leed.json"));
  });

  test("an overlaid account id is verified too — the CI job configured for the wrong account", () => {
    // No file at all, which is how CI runs: the pair comes from the environment, and the pin is the only
    // thing in the repository that can disagree with it.
    const account = { accountId: "leed-acct" };
    expect(() =>
      cloudflareEnv({
        ...paths({ CLOUDFLARE_ACCOUNT_ID: "wrong-acct", CLOUDFLARE_API_TOKEN: "tok" }),
        account,
      }),
    ).toThrow(PithyError);
    expect(resolveCloudflare({ ...paths({ CLOUDFLARE_ACCOUNT_ID: "wrong-acct" }), account }).mismatch).toMatchObject({
      pinned: "leed-acct",
      resolved: "wrong-acct",
      source: "environment",
    });
  });

  test("a pin with nothing resolved is not a mismatch — unconfigured is not wrong", () => {
    expect(resolveCloudflare({ ...paths(), account: { accountId: "leed-acct" } }).mismatch).toBeNull();
    expect(cloudflareEnv({ ...paths(), account: { accountId: "leed-acct" } })).toEqual({});
  });

  test("resolveCloudflare never throws, so a diagnostic can report the mismatch rather than die of it", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "someone-elses" });
    const resolved = resolveCloudflare({ ...paths(), account: { accountId: "leed-acct" } });
    expect(resolved.path).toBe(join(dir, "cloudflare.json"));
    expect(resolved.accountName).toBeNull();
    expect(resolved.mismatch).toMatchObject({ pinned: "leed-acct", resolved: "someone-elses", source: "file" });
  });
});

describe("CI, which has no file and no account name", () => {
  test("resolves the whole pair from the environment, unchanged", () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: "ci-acct", CLOUDFLARE_API_TOKEN: "ci-token" };
    expect(cloudflareEnv(paths(env))).toEqual(env);
    expect(cloudflareConfigPath(paths(env))).toBe(join(dir, "cloudflare.json"));
    expect(resolveCloudflare(paths(env)).mismatch).toBeNull();
  });

  test("the overlay is untouched when nothing asks for offline — the whole point of keeping it (#182)", () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: "ci-acct", CLOUDFLARE_API_TOKEN: "ci-token" };
    const resolved = resolveCloudflare(paths(env));
    expect(resolved.offline).toBe(false);
    expect(resolved.vars).toEqual(env);
    expect(resolved.credentialSource).toBe("environment");
  });
});

/**
 * `PITHY_OFFLINE` (#218). The overlay is correct and stays; this is the one way to say "not from the
 * environment, and not over the wire" — the sentence `PITHY_CONFIG_DIR` was mistaken for.
 */
describe("PITHY_OFFLINE", () => {
  test("suppresses the environment overlay, so an exported pair reaches nothing", () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: "ambient-acct", CLOUDFLARE_API_TOKEN: "ambient-token", PITHY_OFFLINE: "1" };
    expect(cloudflareEnv(paths(env))).toEqual({});
    expect(resolveCloudflare(paths(env)).offline).toBe(true);
    expect(resolveCloudflare(paths(env)).credentialSource).toBeNull();
  });

  test("keeps the file, because a credential you wrote down is not one you forgot you exported", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
    expect(cloudflareEnv(paths({ CLOUDFLARE_API_TOKEN: "ambient", PITHY_OFFLINE: "1" }))).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    });
  });

  test("a scratch config directory plus offline resolves nothing at all — the isolation people assumed", () => {
    // The two together are the guarantee: no file to read, and the environment refused. Nothing in the
    // CLI can authenticate as anybody, because there is no credential anywhere for it to use.
    const env = { CLOUDFLARE_ACCOUNT_ID: "real-acct", CLOUDFLARE_API_TOKEN: "real-token", PITHY_OFFLINE: "1" };
    expect(cloudflareEnv(paths(env))).toEqual({});
  });

  test("blank is no override, exactly as every other variable here treats blank", () => {
    const env = { CLOUDFLARE_API_TOKEN: "ambient", PITHY_OFFLINE: "" };
    expect(pithyOffline(env)).toBe(false);
    expect(cloudflareEnv(paths(env)).CLOUDFLARE_API_TOKEN).toBe("ambient");
    expect(pithyOffline({ PITHY_OFFLINE: "   " })).toBe(false);
    expect(pithyOffline({ PITHY_OFFLINE: "1" })).toBe(true);
    expect(pithyOffline({})).toBe(false);
  });

  test("the option forces it with no variable set, which is what a --offline flag passes", () => {
    const env = { CLOUDFLARE_API_TOKEN: "ambient", CLOUDFLARE_ACCOUNT_ID: "ambient-acct" };
    expect(cloudflareEnv({ ...paths(env), offline: true })).toEqual({});
    expect(resolveCloudflare({ ...paths(env), offline: true }).offline).toBe(true);
    // And `offline: false` is a caller saying so, not an absence — the variable does not override it.
    expect(cloudflareEnv({ ...paths({ ...env, PITHY_OFFLINE: "1" }), offline: false })).toEqual(env);
  });

  test("reports no split, because nothing was overlaid to split against", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "from-file" });
    expect(cloudflareCredentialSplit(paths({ CLOUDFLARE_ACCOUNT_ID: "from-env", PITHY_OFFLINE: "1" }))).toBeNull();
  });

  test("a pin the file itself contradicts is still caught — that fault needs no network and no environment", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "someone-elses", CLOUDFLARE_API_TOKEN: "tok" });
    const resolved = resolveCloudflare({ ...paths({ PITHY_OFFLINE: "1" }), account: { accountId: "leed-acct" } });
    expect(resolved.mismatch).toMatchObject({ pinned: "leed-acct", resolved: "someone-elses", source: "file" });
  });
});

/**
 * Where the pair that would authenticate actually came from (#218). The report has always named the *file
 * it resolved*, which in CI — and in the sandbox that prompted this — is a file that does not exist.
 */
describe("credentialSource", () => {
  test("a complete file is `file`", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
    expect(resolveCloudflare(paths()).credentialSource).toBe("file");
  });

  test("no file and an exported pair is `environment` — CI, and the sandbox that started this", () => {
    expect(
      resolveCloudflare(paths({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" })).credentialSource,
    ).toBe("environment");
  });

  test("half and half is `mixed`, which is the split the same run already warns about", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "tok" });
    expect(resolveCloudflare(paths({ CLOUDFLARE_ACCOUNT_ID: "from-env" })).credentialSource).toBe("mixed");
  });

  test("nothing resolved is `null` — no source is an answer, not a default", () => {
    expect(resolveCloudflare(paths()).credentialSource).toBeNull();
  });

  test("the group is the account pair alone, as everything else about these two keys is", () => {
    // A store id from the environment says nothing about which account the run authenticates as.
    expect(resolveCloudflare(paths({ SECRETS_STORE_ID: "store" })).credentialSource).toBeNull();
  });
});

describe("cloudflareEnv", () => {
  test("reads the account's credentials out of cloudflare.json", () => {
    // Written synchronously below rather than through the async helper, since the reader is sync.
    return config({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", SECRETS_STORE_ID: "store" }).then(
      () => {
        expect(cloudflareEnv(paths())).toEqual({
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_API_TOKEN: "tok",
          SECRETS_STORE_ID: "store",
        });
      },
    );
  });

  test("falls back to the environment for every key when there is no file at all — how CI runs", () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: "from-env-acct",
      CLOUDFLARE_API_TOKEN: "from-env-token",
      SECRETS_STORE_ID: "from-env-store",
    };
    expect(cloudflareEnv(paths(env))).toEqual(env);
  });

  test("overlays R2_CREDENTIALS from the environment, so CI can pass R2 keys with no file", () => {
    const blob = '{"accessKeyId":"ak","secretAccessKey":"sk"}';
    expect(cloudflareEnv(paths({ R2_CREDENTIALS: blob })).R2_CREDENTIALS).toBe(blob);
  });

  test("the overlay is per key: the file's value wins, the environment fills the rest", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "from-file" });
    expect(cloudflareEnv(paths({ CLOUDFLARE_API_TOKEN: "from-env", CLOUDFLARE_ACCOUNT_ID: "from-env" }))).toEqual({
      CLOUDFLARE_API_TOKEN: "from-file",
      CLOUDFLARE_ACCOUNT_ID: "from-env",
    });
  });

  test("an empty value in the file counts as unset, so the environment still fills it", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "" });
    expect(cloudflareEnv(paths({ CLOUDFLARE_API_TOKEN: "from-env" })).CLOUDFLARE_API_TOKEN).toBe("from-env");
  });

  test("a malformed file resolves to no credentials rather than to half of somebody else's", async () => {
    await writeFile(join(dir, CLOUDFLARE_CONFIG_FILE_NAME), "{ not json");
    expect(cloudflareEnv(paths())).toEqual({});
  });

  test("a non-string value is not passed through to a Cloudflare client", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: 12345 });
    expect(cloudflareEnv(paths())).toEqual({});
  });

  test("nothing in the project directory is read — the credentials are account-scoped", async () => {
    const project = await mkdtemp(join(tmpdir(), "pithy-cf-project-"));
    await writeFile(join(project, ".dev.vars"), "CLOUDFLARE_API_TOKEN=in-the-checkout\n");
    expect(cloudflareEnv(paths()).CLOUDFLARE_API_TOKEN).toBeUndefined();
    await rm(project, { recursive: true, force: true });
  });
});

describe("parseCloudflareConfig", () => {
  test("keeps only the credential keys, so another tenant's data never reaches a client", () => {
    expect(parseCloudflareConfig('{"CLOUDFLARE_API_TOKEN":"tok","somethingElse":"x"}')).toEqual({
      CLOUDFLARE_API_TOKEN: "tok",
    });
  });
});

describe("writeCloudflareConfig", () => {
  test("creates the file owner-only, in an owner-only directory", async () => {
    const nested = join(dir, "deeper");
    await writeCloudflareConfig({ CLOUDFLARE_API_TOKEN: "tok" }, { env: { PITHY_CONFIG_DIR: nested }, account: null });
    expect((await stat(join(nested, CLOUDFLARE_CONFIG_FILE_NAME))).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  test("merges rather than replaces, so appending the store id keeps the token", async () => {
    await writeCloudflareConfig({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" }, paths());
    await writeCloudflareConfig({ SECRETS_STORE_ID: "store" }, paths());
    expect(cloudflareEnv(paths())).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
      SECRETS_STORE_ID: "store",
    });
  });

  test("keeps another tenant's key, because this file is read-modify-written", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "tok", futureTenant: { keep: true } });
    await writeCloudflareConfig({ SECRETS_STORE_ID: "store" }, paths());
    const written: unknown = JSON.parse(await readFile(join(dir, CLOUDFLARE_CONFIG_FILE_NAME), "utf8"));
    expect(written).toMatchObject({ CLOUDFLARE_API_TOKEN: "tok", futureTenant: { keep: true } });
  });

  /**
   * The `catchall` says another tenant's key is "read and written back untouched", and for one key that
   * was not true. `JSON.parse` gives `__proto__` an own property; Zod skips it while building the object
   * it returns; the write puts back what it was handed. Input has it, output does not, nothing was said.
   *
   * Refused rather than preserved, for {@link statesNoVanishingKey}'s reason: `__proto__` is not a name a
   * future tenant will be called, and this file holds a live API token — the one place a silent deletion
   * must not be answered with a shrug.
   */
  test("refuses to rewrite a file stating a key the read would lose", async () => {
    const path = join(dir, CLOUDFLARE_CONFIG_FILE_NAME);
    // Raw bytes, because an object literal with a `__proto__` key sets the prototype and writes no own
    // property — `JSON.stringify` of one would produce a document without the key under test.
    const document = '{"CLOUDFLARE_API_TOKEN":"tok","__proto__":{"other":"tenant"}}';
    await writeFile(path, document, { mode: 0o600 });
    const before = await readFile(path, "utf8");

    await expect(writeCloudflareConfig({ SECRETS_STORE_ID: "store" }, paths())).rejects.toThrow(/__proto__/);
    // The refusal has to leave the file alone: a write that refuses and truncates is the same loss.
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("the promise it now keeps: a tenant key beside the refused one is what survives a write", async () => {
    // The paired half. Refusing everything would also pass the test above, and would break the
    // read-modify-write this file exists for.
    await config({ CLOUDFLARE_API_TOKEN: "tok", futureTenant: { keep: true } });
    await writeCloudflareConfig({ SECRETS_STORE_ID: "store" }, paths());
    const written: unknown = JSON.parse(await readFile(join(dir, CLOUDFLARE_CONFIG_FILE_NAME), "utf8"));
    expect(written).toMatchObject({ futureTenant: { keep: true }, SECRETS_STORE_ID: "store" });
  });

  test("refuses to rewrite a file it could not read — only ENOENT is 'no file'", async () => {
    const path = join(dir, CLOUDFLARE_CONFIG_FILE_NAME);
    await config({ CLOUDFLARE_API_TOKEN: "tok" });
    await rm(path);
    // A directory at the path is the portable stand-in for "present and will not open as a file".
    await writeFile(join(dir, "decoy"), "x");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path);
    await expect(writeCloudflareConfig({ SECRETS_STORE_ID: "store" }, paths())).rejects.toThrow(
      /could not read what is already in it/,
    );
  });
});

describe("cloudflareCredentialSplit", () => {
  test("a file with only the token, over an ambient account id, is a split", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "tok" });
    expect(cloudflareCredentialSplit(paths({ CLOUDFLARE_ACCOUNT_ID: "from-env" }))).toEqual({
      fromFile: ["CLOUDFLARE_API_TOKEN"],
      fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });

  test("a file with only the account id, over an ambient token, is the same split the other way round", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct" });
    expect(cloudflareCredentialSplit(paths({ CLOUDFLARE_API_TOKEN: "from-env" }))).toEqual({
      fromFile: ["CLOUDFLARE_ACCOUNT_ID"],
      fromEnvironment: ["CLOUDFLARE_API_TOKEN"],
    });
  });

  test("a complete file is silent, even when the environment holds a different account's pair", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "mine", CLOUDFLARE_API_TOKEN: "mine-tok" });
    const env = { CLOUDFLARE_ACCOUNT_ID: "other", CLOUDFLARE_API_TOKEN: "other-tok" };
    expect(cloudflareCredentialSplit(paths(env))).toBeNull();
  });

  test("no file at all is silent — CI passes the whole pair as environment variables", () => {
    expect(cloudflareCredentialSplit(paths({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" }))).toBeNull();
  });

  test("half a file with nothing in the environment is silent — that is unconfigured, not a split", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "tok" });
    expect(cloudflareCredentialSplit({ env: { PITHY_CONFIG_DIR: dir }, account: null })).toBeNull();
  });

  test("an empty value in the file counts as unset, exactly as the overlay treats it", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "tok" });
    expect(cloudflareCredentialSplit(paths({ CLOUDFLARE_ACCOUNT_ID: "from-env" }))).toEqual({
      fromFile: ["CLOUDFLARE_API_TOKEN"],
      fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });

  test("the group is the account pair alone — a store id or R2 keys from elsewhere are not a split", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
    const env = { SECRETS_STORE_ID: "store", R2_CREDENTIALS: '{"accessKeyId":"ak"}' };
    expect(cloudflareCredentialSplit(paths(env))).toBeNull();
  });
});

/**
 * What vouches for the account, when the project pins nothing to compare against (#378).
 *
 * The mismatch check above is real and it is narrow: it needs a pin. Everything below is the case it
 * cannot see — and the one this suite cares most about is `ambient`, where the id came out of a shell
 * variable and nothing in the repository or on disk agrees with it.
 */
describe("resolveCloudflare confirmation", () => {
  test("a pin the credentials agree with is the strong form", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct-ours", CLOUDFLARE_API_TOKEN: "tok" });
    const resolved = resolveCloudflare({ ...paths(), account: { accountId: "acct-ours" } });
    expect(resolved.confirmation).toBe("pinned");
    expect(resolved.mismatch).toBeNull();
  });

  test("a pin vouches for an id the environment supplied too — the repository named it either way", async () => {
    const resolved = resolveCloudflare({
      env: { PITHY_CONFIG_DIR: dir, CLOUDFLARE_ACCOUNT_ID: "acct-ours", CLOUDFLARE_API_TOKEN: "tok" },
      account: { accountId: "acct-ours" },
    });
    expect(resolved.confirmation).toBe("pinned");
  });

  test("the project's named file supplying the id is `named`", async () => {
    await writeFile(
      join(dir, "cloudflare.leed.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "acct-leed", CLOUDFLARE_API_TOKEN: "tok" }),
      { mode: 0o600 },
    );
    const resolved = resolveCloudflare({ ...paths(), account: { accountName: "leed" } });
    expect(resolved.confirmation).toBe("named");
    expect(resolved.vars.CLOUDFLARE_ACCOUNT_ID).toBe("acct-leed");
  });

  test("a named file that supplies only a token leaves the account to the shell — that is `ambient`", async () => {
    await writeFile(join(dir, "cloudflare.leed.json"), JSON.stringify({ CLOUDFLARE_API_TOKEN: "tok" }), {
      mode: 0o600,
    });
    const resolved = resolveCloudflare({
      env: { PITHY_CONFIG_DIR: dir, CLOUDFLARE_ACCOUNT_ID: "acct-stranger" },
      account: { accountName: "leed" },
    });
    expect(resolved.confirmation).toBe("ambient");
    expect(resolved.vars.CLOUDFLARE_ACCOUNT_ID).toBe("acct-stranger");
  });

  test("the default file on a single-account machine is `recorded` — nothing here needed a second account", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct-only", CLOUDFLARE_API_TOKEN: "tok" });
    expect(resolveCloudflare(paths()).confirmation).toBe("recorded");
  });

  test("an id from the environment with no pin and no file is `ambient` — the 2026-08-15 shape", async () => {
    const resolved = resolveCloudflare({
      env: { PITHY_CONFIG_DIR: dir, CLOUDFLARE_ACCOUNT_ID: "acct-stranger", CLOUDFLARE_API_TOKEN: "tok" },
      account: null,
    });
    expect(resolved.confirmation).toBe("ambient");
    // And nothing else could have said so: with no pin there is no disagreement to find.
    expect(resolved.mismatch).toBeNull();
  });

  test("an environment id overlaid on a file that set none is `ambient`, whatever else the file holds", async () => {
    await config({ SECRETS_STORE_ID: "store-1" });
    const resolved = resolveCloudflare({
      env: { PITHY_CONFIG_DIR: dir, CLOUDFLARE_ACCOUNT_ID: "acct-stranger", CLOUDFLARE_API_TOKEN: "tok" },
      account: null,
    });
    expect(resolved.confirmation).toBe("ambient");
  });

  test("nothing resolved at all is `ambient` — an absent account vouches for nothing", () => {
    expect(resolveCloudflare(paths()).confirmation).toBe("ambient");
  });

  test("`cloudflareAccountConfirmation` reads the same answer without a second resolution path", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct-only", CLOUDFLARE_API_TOKEN: "tok" });
    expect(cloudflareAccountConfirmation(paths())).toBe("recorded");
  });
});

describe("describeUnconfirmedCloudflareAccount", () => {
  test("names the account the operator is about to change, and nothing else", () => {
    expect(describeUnconfirmedCloudflareAccount("acct-stranger")).toBe(
      "Nothing states that Cloudflare account acct-stranger is this project's.",
    );
  });
});

/**
 * **A signed-in session, bound to the directory a command runs in (#759).** The third source, and the
 * one that wins: a profile bound here supplies the pair, and an exported credential that disagrees is
 * refused with both named rather than silently preferred in either direction.
 */
describe("a bound profile's session", () => {
  const SESSION = {
    profile: "pithy",
    accountId: "acct-session",
    accountName: "pithy.",
    email: "jim@pithy.sh",
    accessToken: "session-access-token",
    refreshToken: "RT",
    expiresAt: "2026-10-15T13:00:00.000Z",
    scope: "user-details.read",
  };
  const BEFORE_EXPIRY = () => new Date("2026-10-15T12:00:00.000Z");

  /** A project directory under the temp config, bound to `pithy`, with the session written. */
  async function signedIn(): Promise<string> {
    const project = join(dir, "project");
    await mkdir(project, { recursive: true });
    await bindProfile(project, "pithy", { env: { PITHY_CONFIG_DIR: dir } });
    await writeSession(SESSION, { env: { PITHY_CONFIG_DIR: dir } });
    return project;
  }

  /** The action line of the PithyError `run` throws — where a remedy command belongs. */
  function actionOf(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      if (error instanceof PithyError) return error.payload.action ?? "";
      throw error;
    }
    throw new Error("expected a refusal");
  }

  function here(cwd: string, env: Record<string, string> = {}): CloudflareConfigOptions {
    return { ...paths(env), cwd, now: BEFORE_EXPIRY };
  }

  test("supplies the pair, over a token in the credentials file, and says the session is the source", async () => {
    const cwd = await signedIn();
    await config({ CLOUDFLARE_API_TOKEN: "file-token", CLOUDFLARE_ACCOUNT_ID: "acct-file", SECRETS_STORE_ID: "store" });
    const resolved = resolveCloudflare(here(cwd));
    expect(resolved.vars).toMatchObject({
      CLOUDFLARE_API_TOKEN: "session-access-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-session",
    });
    // That file is another account's, so its store id would address the wrong store: it is not carried.
    expect(resolved.vars.SECRETS_STORE_ID).toBeUndefined();
    expect(resolved.credentialSource).toBe("session");
    expect(resolved.session).toMatchObject({
      profile: "pithy",
      via: "directory",
      email: "jim@pithy.sh",
      expired: false,
    });
  });

  test("the account's other keys come from a file about the same account, or one that names none", async () => {
    const cwd = await signedIn();
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct-session", SECRETS_STORE_ID: "store" });
    expect(resolveCloudflare(here(cwd)).vars.SECRETS_STORE_ID).toBe("store");
    await config({ SECRETS_STORE_ID: "store-unnamed" });
    expect(resolveCloudflare(here(cwd)).vars.SECRETS_STORE_ID).toBe("store-unnamed");
  });

  test("a store id dropped as another account's gives way to one exported for this run", async () => {
    const cwd = await signedIn();
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct-file", SECRETS_STORE_ID: "other-accounts-store" });
    expect(resolveCloudflare(here(cwd, { SECRETS_STORE_ID: "exported-store" })).vars.SECRETS_STORE_ID).toBe(
      "exported-store",
    );
  });

  test("a pair a pithy exported to its own child for this profile is not a conflict, even after a renewal", async () => {
    // A nested `pithy` inherits its parent's export. The hourly renewal changes the file, not the child's
    // environment — refusing then would tell the person to unset a variable Pithy set.
    const cwd = await signedIn();
    const inherited = "the-token-before-the-renewal";
    const nested = here(cwd, {
      CLOUDFLARE_API_TOKEN: inherited,
      CLOUDFLARE_ACCOUNT_ID: "acct-session",
      PITHY_SESSION_PROFILE: sessionMark("pithy", inherited),
    });
    expect(cloudflareEnv(nested).CLOUDFLARE_API_TOKEN).toBe("session-access-token");
    // A mark for another profile excuses nothing.
    expect(() =>
      cloudflareEnv({ ...nested, env: { ...nested.env, PITHY_SESSION_PROFILE: sessionMark("other", inherited) } }),
    ).toThrow(PithyError);
    // Nor does the inherited mark excuse a *different* token exported beside it: that is the override.
    expect(() =>
      cloudflareEnv({ ...nested, env: { ...nested.env, CLOUDFLARE_API_TOKEN: "cfat_someone-elses" } }),
    ).toThrow(PithyError);
  });

  test("offline, an expired session is not refused with a sign-in that cannot run offline", async () => {
    const cwd = await signedIn();
    const late = { ...here(cwd, { PITHY_OFFLINE: "1" }), now: () => new Date("2026-10-15T14:00:00.000Z") };
    expect(cloudflareEnv(late).CLOUDFLARE_API_TOKEN).toBe("session-access-token");
  });

  test("offline, a bound profile with no session resolves no credentials — and never a file's", async () => {
    const project = join(dir, "unsigned-offline");
    await mkdir(project, { recursive: true });
    await bindProfile(project, "pithy", { env: { PITHY_CONFIG_DIR: dir } });
    await config({ CLOUDFLARE_API_TOKEN: "file-token", CLOUDFLARE_ACCOUNT_ID: "acct-file" });
    const vars = cloudflareEnv(here(project, { PITHY_OFFLINE: "1" }));
    expect(vars.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(vars.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
  });

  test("an exported CLOUDFLARE_API_TOKEN does not override it: the command refuses and names both", async () => {
    const cwd = await signedIn();
    const failure = (() => {
      try {
        cloudflareEnv(here(cwd, { CLOUDFLARE_API_TOKEN: "exported" }));
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/pithy/);
    expect((failure as PithyError).payload.message).toMatch(/CLOUDFLARE_API_TOKEN/);
  });

  test("an exported pair that agrees with the session is not a conflict", async () => {
    const cwd = await signedIn();
    expect(
      cloudflareEnv(here(cwd, { CLOUDFLARE_API_TOKEN: "session-access-token", CLOUDFLARE_ACCOUNT_ID: "acct-session" }))
        .CLOUDFLARE_API_TOKEN,
    ).toBe("session-access-token");
  });

  test("offline, the exported token is refused anyway, so there is nothing to conflict with", async () => {
    const cwd = await signedIn();
    expect(
      cloudflareEnv(here(cwd, { CLOUDFLARE_API_TOKEN: "exported", PITHY_OFFLINE: "1" })).CLOUDFLARE_API_TOKEN,
    ).toBe("session-access-token");
  });

  test("a bound profile with no session refuses rather than falling back to whatever the shell exports", async () => {
    const project = join(dir, "unsigned");
    await mkdir(project, { recursive: true });
    await bindProfile(project, "pithy", { env: { PITHY_CONFIG_DIR: dir } });
    expect(
      actionOf(() => cloudflareEnv(here(project, { CLOUDFLARE_API_TOKEN: "exported", CLOUDFLARE_ACCOUNT_ID: "a" }))),
    ).toMatch(/pithy cloudflare connect --profile pithy/);
  });

  test("an expired session refuses with the sign-in that fixes it", async () => {
    const cwd = await signedIn();
    expect(actionOf(() => cloudflareEnv({ ...here(cwd), now: () => new Date("2026-10-15T14:00:00.000Z") }))).toMatch(
      /pithy cloudflare connect --profile pithy/,
    );
  });

  test("a pin the session's account contradicts is a mismatch, sourced to the session", async () => {
    const cwd = await signedIn();
    const resolved = resolveCloudflare({ ...here(cwd), account: { accountId: "acct-pinned" } });
    expect(resolved.mismatch).toMatchObject({ pinned: "acct-pinned", resolved: "acct-session", source: "session" });
  });

  test("an account no pin names is vouched for by the binding, never ambient", async () => {
    const cwd = await signedIn();
    expect(cloudflareAccountConfirmation(here(cwd))).toBe("bound");
  });

  test("a session supplies the whole pair, so a half-written credentials file is not reported as a split", async () => {
    const cwd = await signedIn();
    await config({ CLOUDFLARE_API_TOKEN: "file-token" });
    expect(cloudflareCredentialSplit(here(cwd, { CLOUDFLARE_ACCOUNT_ID: "acct-session" }))).toBeNull();
  });

  test("with nothing bound, resolution is exactly what it was", async () => {
    await config({ CLOUDFLARE_API_TOKEN: "file-token", CLOUDFLARE_ACCOUNT_ID: "acct-file" });
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const resolved = resolveCloudflare(here(elsewhere));
    expect(resolved.vars.CLOUDFLARE_API_TOKEN).toBe("file-token");
    expect(resolved.session).toBeNull();
    expect(resolved.credentialSource).toBe("file");
  });
});
