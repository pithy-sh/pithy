// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import {
  CLOUDFLARE_CONFIG_FILE_NAME,
  cloudflareConfigPath,
  cloudflareCredentialSplit,
  cloudflareEnv,
  parseCloudflareConfig,
  writeCloudflareConfig,
} from "./config";

/**
 * Every test here resolves against a temp `PITHY_CONFIG_DIR`. That is not tidiness: the real file holds
 * the operator's live Cloudflare API token, and a suite that read or wrote it would either leak it into
 * an assertion or destroy it.
 */
let dir: string;

function paths(env: Record<string, string> = {}): StatePathOptions {
  return { env: { PITHY_CONFIG_DIR: dir, ...env } };
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
    await writeCloudflareConfig({ CLOUDFLARE_API_TOKEN: "tok" }, { env: { PITHY_CONFIG_DIR: nested } });
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
    expect(cloudflareCredentialSplit({ env: { PITHY_CONFIG_DIR: dir } })).toBeNull();
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
