// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CfSecretsStore } from "@pithy-sh/cloudflare/src/secrets/secretsStores";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { cloudflareEnv } from "./config";
import { ensureSecretsStoreId } from "./storeId";

/**
 * `pithy add secrets` records the account's Secrets Store id **once**, so nothing after it asks
 * Cloudflare where the store is (#182).
 *
 * Every case here passes the `listStores` seam. The default reaches a real account, and a unit test that
 * forgot would list the operator's — `vitest.config.ts` blanks the credential keys for exactly that
 * reason, and this is the belt to that brace.
 */

let dir: string;

function paths(env: Record<string, string> = {}): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: dir, ...env } };
}

/** A store as the account lists it. Only `id` and `name` matter to any assertion below. */
function store(id: string, name: string): CfSecretsStore {
  return { id, name, created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:00:00.000Z") };
}

/** The credentials the resolver needs before it will ask anything. */
const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: "tok-1" };

async function config(values: Record<string, string>): Promise<void> {
  await writeFile(join(dir, "cloudflare.json"), JSON.stringify(values, null, 2), { mode: 0o600 });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-store-id-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ensureSecretsStoreId", () => {
  test("records the account's one store, and says where it put it", async () => {
    const listStores = vi.fn(async () => [store("store-abc", "default")]);

    const notes = await ensureSecretsStoreId({ paths: paths(CREDENTIALS), listStores });

    expect(cloudflareEnv(paths(CREDENTIALS)).SECRETS_STORE_ID).toBe("store-abc");
    expect(notes.join(" ")).toContain("Recorded SECRETS_STORE_ID");
    expect(notes.join(" ")).toContain(join(dir, "cloudflare.json"));
    expect(listStores).toHaveBeenCalledWith({ accountId: "acct-1", apiToken: "tok-1" });
  });

  test("the file it writes is owner-only, in an owner-only directory", async () => {
    const nested = join(dir, "deeper");
    await ensureSecretsStoreId({
      paths: { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: nested, ...CREDENTIALS } },
      listStores: async () => [store("store-abc", "default")],
    });
    expect(((await stat(join(nested, "cloudflare.json"))).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(nested)).mode & 0o777).toString(8)).toBe("700");
  });

  test("the credential pair already in the file survives — this is a merge, not a rewrite", async () => {
    await config(CREDENTIALS);

    await ensureSecretsStoreId({ paths: paths(), listStores: async () => [store("store-abc", "default")] });

    expect(cloudflareEnv(paths())).toEqual({ ...CREDENTIALS, SECRETS_STORE_ID: "store-abc" });
  });

  test("a recorded id is never overwritten, and a matching one says nothing at all", async () => {
    await config({ ...CREDENTIALS, SECRETS_STORE_ID: "store-abc" });

    expect(
      await ensureSecretsStoreId({ paths: paths(), listStores: async () => [store("store-abc", "default")] }),
    ).toEqual([]);
  });

  test("a recorded id the account disagrees with is reported, and still not overwritten", async () => {
    // The recorded one may be the deliberate one. Replacing it would point every later `pithy secrets
    // set` at another store without anybody asking for that.
    await config({ ...CREDENTIALS, SECRETS_STORE_ID: "store-deliberate" });

    const notes = await ensureSecretsStoreId({
      paths: paths(),
      listStores: async () => [store("store-abc", "default")],
    });

    expect(notes.join(" ")).toContain("store-deliberate");
    expect(notes.join(" ")).toContain("store-abc");
    expect(notes.join(" ")).toContain("Nothing was changed");
    expect(cloudflareEnv(paths()).SECRETS_STORE_ID).toBe("store-deliberate");
  });

  test("two stores are named and neither is chosen", async () => {
    // One store per account is the rule that makes an automatic write defensible. Two means somebody
    // made a second, and guessing which holds their production secrets is not a choice a tool makes.
    const notes = await ensureSecretsStoreId({
      paths: paths(CREDENTIALS),
      listStores: async () => [store("store-a", "default"), store("store-b", "staging")],
    });

    expect(notes.join(" ")).toContain("default (store-a)");
    expect(notes.join(" ")).toContain("staging (store-b)");
    expect(cloudflareEnv(paths(CREDENTIALS)).SECRETS_STORE_ID).toBeUndefined();
  });

  test("an account with no store yet is told to create one", async () => {
    const notes = await ensureSecretsStoreId({ paths: paths(CREDENTIALS), listStores: async () => [] });

    expect(notes.join(" ")).toContain("no Secrets Store yet");
    expect(notes.join(" ")).toContain("pithy add secrets again");
    expect(cloudflareEnv(paths(CREDENTIALS)).SECRETS_STORE_ID).toBeUndefined();
  });

  test("a listing that fails is a sentence, never a throw — add must still finish its real job", async () => {
    const notes = await ensureSecretsStoreId({
      paths: paths(CREDENTIALS),
      listStores: async () => {
        throw new Error("network down");
      },
    });

    expect(notes.join(" ")).toContain("Could not reach Cloudflare");
    expect(notes.join(" ")).toContain(join(dir, "cloudflare.json"));
  });

  test("no credentials asks nothing at all, and says what would supply them", async () => {
    const listStores = vi.fn(async () => [store("store-abc", "default")]);

    const notes = await ensureSecretsStoreId({ paths: paths(), listStores });

    expect(listStores).not.toHaveBeenCalled();
    expect(notes.join(" ")).toContain("pithy init");
  });

  test("no credentials and an id already recorded is silent — there is nothing left to do", async () => {
    await config({ SECRETS_STORE_ID: "store-abc" });

    expect(await ensureSecretsStoreId({ paths: paths(), listStores: async () => [] })).toEqual([]);
  });

  test("an id supplied by the environment counts as recorded — CI has no file", async () => {
    const listStores = vi.fn(async () => [store("store-abc", "default")]);

    const notes = await ensureSecretsStoreId({
      paths: paths({ ...CREDENTIALS, SECRETS_STORE_ID: "store-abc" }),
      listStores,
    });

    expect(notes).toEqual([]);
    // Nothing was written: the overlay already answers, and a file conjured here would be one more
    // place the id has to be kept in step.
    await expect(readFile(join(dir, "cloudflare.json"), "utf8")).rejects.toThrow();
  });
});
