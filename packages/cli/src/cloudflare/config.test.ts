// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CLOUDFLARE_CONFIG_FILE_NAME,
  CloudflareAccountName,
  type CloudflareConfigOptions,
  cloudflareAccountFile,
  cloudflareConfigPath,
  cloudflareCredentialSplit,
  cloudflareEnv,
  parseCloudflareConfig,
  pithyOffline,
  resolveCloudflare,
  writeCloudflareConfig,
} from "./config";

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
