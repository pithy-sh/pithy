// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CfSecretsStore } from "@pithy-sh/cloudflare/src/secrets/secretsStores";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CloudflareConfigOptions, cloudflareEnv } from "./config";
import { bindProfile } from "./session/bindings";
import { writeSession } from "./session/store";
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

function paths(env: Record<string, string> = {}): CloudflareConfigOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: dir, ...env }, account: null };
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

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
      paths: paths(CREDENTIALS),
      listStores,
    });

    expect(cloudflareEnv(paths(CREDENTIALS)).SECRETS_STORE_ID).toBe("store-abc");
    expect(notes.join(" ")).toContain("Recorded SECRETS_STORE_ID");
    expect(notes.join(" ")).toContain(join(dir, "cloudflare.json"));
    expect(listStores).toHaveBeenCalledWith({ accountId: "acct-1", apiToken: "tok-1" });
  });

  test("the file it writes is owner-only, in an owner-only directory", async () => {
    const nested = join(dir, "deeper");
    await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
      paths: {
        platform: "linux",
        homedir: "/home/nobody",
        env: { PITHY_CONFIG_DIR: nested, ...CREDENTIALS },
        account: null,
      },
      listStores: async () => [store("store-abc", "default")],
    });
    expect(((await stat(join(nested, "cloudflare.json"))).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(nested)).mode & 0o777).toString(8)).toBe("700");
  });

  test("the credential pair already in the file survives — this is a merge, not a rewrite", async () => {
    await config(CREDENTIALS);

    await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
      paths: paths(),
      listStores: async () => [store("store-abc", "default")],
    });

    expect(cloudflareEnv(paths())).toEqual({ ...CREDENTIALS, SECRETS_STORE_ID: "store-abc" });
  });

  test("a recorded id is never overwritten, and a matching one says nothing at all", async () => {
    await config({ ...CREDENTIALS, SECRETS_STORE_ID: "store-abc" });

    expect(
      await ensureSecretsStoreId({
        again: "`pithy add secrets --worker api`",
        paths: paths(),
        listStores: async () => [store("store-abc", "default")],
      }),
    ).toEqual([]);
  });

  test("a recorded id the account disagrees with is reported, and still not overwritten", async () => {
    // The recorded one may be the deliberate one. Replacing it would point every later `pithy secrets
    // set` at another store without anybody asking for that.
    await config({ ...CREDENTIALS, SECRETS_STORE_ID: "store-deliberate" });

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
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
      again: "`pithy add secrets --worker api`",
      paths: paths(CREDENTIALS),
      listStores: async () => [store("store-a", "default"), store("store-b", "staging")],
    });

    expect(notes.join(" ")).toContain("default (store-a)");
    expect(notes.join(" ")).toContain("staging (store-b)");
    expect(cloudflareEnv(paths(CREDENTIALS)).SECRETS_STORE_ID).toBeUndefined();
  });

  test("an account with no store yet is told to create one", async () => {
    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
      paths: paths(CREDENTIALS),
      listStores: async () => [],
    });

    expect(notes.join(" ")).toContain("no Secrets Store yet");
    expect(notes.join(" ")).toContain(
      "This account has no Secrets Store yet, so SECRETS_STORE_ID was not recorded. Create one in the Cloudflare dashboard (Secrets Store), then run `pithy add secrets --worker api` again.",
    );
    expect(cloudflareEnv(paths(CREDENTIALS)).SECRETS_STORE_ID).toBeUndefined();
  });

  test("a listing that fails is a sentence, never a throw — add must still finish its real job", async () => {
    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
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

    const notes = await ensureSecretsStoreId({ again: "`pithy add secrets --worker api`", paths: paths(), listStores });

    expect(listStores).not.toHaveBeenCalled();
    // Not `pithy init`, which is refused inside a project for the files it would write (#711).
    expect(notes.join(" ")).toBe(
      "SECRETS_STORE_ID is not recorded, and there are no Cloudflare credentials to resolve it with. Run pithy cloudflare connect, or export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this project's account. Then run `pithy add secrets --worker api` again.",
    );
    expect(notes.join(" ")).not.toContain("pithy init");
  });

  test("no credentials and an id already recorded is silent — there is nothing left to do", async () => {
    await config({ SECRETS_STORE_ID: "store-abc" });

    expect(
      await ensureSecretsStoreId({
        again: "`pithy add secrets --worker api`",
        paths: paths(),
        listStores: async () => [],
      }),
    ).toEqual([]);
  });

  test("an id supplied by the environment counts as recorded — CI has no file", async () => {
    const listStores = vi.fn(async () => [store("store-abc", "default")]);

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
      paths: paths({ ...CREDENTIALS, SECRETS_STORE_ID: "store-abc" }),
      listStores,
    });

    expect(notes).toEqual([]);
    // Nothing was written: the overlay already answers, and a file conjured here would be one more
    // place the id has to be kept in step.
    await expect(readFile(join(dir, "cloudflare.json"), "utf8")).rejects.toThrow();
  });
});

/**
 * One store per account, so the store id belongs to whichever account the *project* uses — not to
 * whichever account happens to own `cloudflare.json` (#206).
 */
describe("ensureSecretsStoreId, for a project that names its account", () => {
  test("records the store id into the file the project selected, never into cloudflare.json", async () => {
    await writeFile(join(dir, "cloudflare.leed.json"), JSON.stringify(CREDENTIALS), { mode: 0o600 });
    await config({ CLOUDFLARE_ACCOUNT_ID: "other-acct", CLOUDFLARE_API_TOKEN: "other-tok" });
    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
      paths: { ...paths(), account: { accountName: "leed" } },
      listStores: async () => [store("store-leed", "leed-store")],
    });

    expect(notes.join(" ")).toContain(join(dir, "cloudflare.leed.json"));
    expect(JSON.parse(await readFile(join(dir, "cloudflare.leed.json"), "utf8"))).toMatchObject({
      SECRETS_STORE_ID: "store-leed",
    });
    expect(JSON.parse(await readFile(join(dir, "cloudflare.json"), "utf8")).SECRETS_STORE_ID).toBeUndefined();
  });

  test("a pinned account the credentials do not match is a sentence, never a throw", async () => {
    // `pithy add secrets` must keep working in exactly the state it is reporting: recording the store id
    // is a convenience riding on the command, and a convenience that fails the command is not one.
    await config({ CLOUDFLARE_ACCOUNT_ID: "someone-elses", CLOUDFLARE_API_TOKEN: "tok-1" });
    const listStores = vi.fn(async () => [store("store-abc", "default")]);

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets --worker api`",
      paths: { ...paths(), account: { accountId: "acct-1" } },
      listStores,
    });

    expect(notes.join(" ")).toContain("acct-1");
    expect(notes.join(" ")).toContain("someone-elses");
    // Nothing was asked of Cloudflare and nothing was written: the credentials are not this project's.
    expect(listStores).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(dir, "cloudflare.json"), "utf8")).SECRETS_STORE_ID).toBeUndefined();
  });
});

/**
 * Under a bound profile the store id is the profile's, so it is written where the profile reads it:
 * `cloudflare.<profile>.json`, never `cloudflare.json` (#788). Written anywhere else, the next read would
 * not find what was just recorded.
 */
describe("ensureSecretsStoreId, under a bound profile", () => {
  /** A project directory bound to profile `work`, signed in to `acct-1` (or `accountId`). */
  async function signedIn(env: Record<string, string> = {}, accountId = "acct-1"): Promise<CloudflareConfigOptions> {
    const project = join(dir, "project");
    await mkdir(project, { recursive: true });
    await bindProfile(project, "work", { env: { PITHY_CONFIG_DIR: dir } });
    await writeSession(
      {
        profile: "work",
        accountId,
        accountName: "Work",
        email: null,
        accessToken: "session-token",
        refreshToken: null,
        expiresAt: "2999-01-01T00:00:00.000Z",
        scope: "s",
      },
      { env: { PITHY_CONFIG_DIR: dir } },
    );
    return { ...paths(env), cwd: project };
  }

  test("writes cloudflare.<profile>.json, says so, and leaves cloudflare.json untouched", async () => {
    const options = await signedIn();
    const before = `${JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "other-acct", CLOUDFLARE_API_TOKEN: "other-tok" })}\n`;
    await writeFile(join(dir, "cloudflare.json"), before, { mode: 0o600 });
    const listStores = vi.fn(async () => [store("store-work", "default")]);

    const notes = await ensureSecretsStoreId({ again: "`pithy add secrets`", paths: options, listStores });

    expect(listStores).toHaveBeenCalledWith({ accountId: "acct-1", apiToken: "session-token" });
    expect(notes.join(" ")).toContain(join(dir, "cloudflare.work.json"));
    expect(JSON.parse(await readFile(join(dir, "cloudflare.work.json"), "utf8"))).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "acct-1",
      SECRETS_STORE_ID: "store-work",
    });
    expect(((await stat(join(dir, "cloudflare.work.json"))).mode & 0o777).toString(8)).toBe("600");
    expect(await readFile(join(dir, "cloudflare.json"), "utf8")).toBe(before);
    // And the next read finds it.
    expect(cloudflareEnv(options).SECRETS_STORE_ID).toBe("store-work");
  });

  test("a store id in cloudflare.json is not this profile's, so it neither counts as recorded nor is touched", async () => {
    const options = await signedIn();
    await config({ SECRETS_STORE_ID: "someone-elses-store" });

    await ensureSecretsStoreId({
      again: "`pithy add secrets`",
      paths: options,
      listStores: async () => [store("store-work", "default")],
    });

    expect(JSON.parse(await readFile(join(dir, "cloudflare.work.json"), "utf8")).SECRETS_STORE_ID).toBe("store-work");
    expect(JSON.parse(await readFile(join(dir, "cloudflare.json"), "utf8"))).toEqual({
      SECRETS_STORE_ID: "someone-elses-store",
    });
  });

  test("a sentence that sends the operator to a file names the profile's file", async () => {
    const options = await signedIn();
    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets`",
      paths: options,
      listStores: async () => [store("a", "one"), store("b", "two")],
    });
    expect(notes.join(" ")).toContain(join(dir, "cloudflare.work.json"));
    expect(notes.join(" ")).not.toContain(join(dir, "cloudflare.json"));
  });

  test("an exported store id is not a recorded one, so the account's store is still written to the profile's file", async () => {
    const options = await signedIn({ SECRETS_STORE_ID: "store-work" });

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets`",
      paths: options,
      listStores: async () => [store("store-work", "default")],
    });

    expect(notes.join(" ")).toContain("Recorded SECRETS_STORE_ID");
    expect(JSON.parse(await readFile(join(dir, "cloudflare.work.json"), "utf8")).SECRETS_STORE_ID).toBe("store-work");
  });

  test("an exported store id the account disagrees with is named as the export, and nothing is written", async () => {
    const options = await signedIn({ SECRETS_STORE_ID: "store-stale" });

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets`",
      paths: options,
      listStores: async () => [store("store-work", "default")],
    });

    const said = notes.join(" ");
    expect(said).toContain("store-stale");
    expect(said).toContain("exported");
    expect(said).not.toContain("fix it in");
    await expect(readFile(join(dir, "cloudflare.work.json"), "utf8")).rejects.toThrow();
  });

  test("an exported store id is no reason to stay silent when the lookup fails", async () => {
    const options = await signedIn({ SECRETS_STORE_ID: "store-work" });

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets`",
      paths: options,
      listStores: async () => {
        throw new Error("offline");
      },
    });

    const said = notes.join(" ");
    expect(said).toContain("Could not reach Cloudflare");
    expect(said).toContain(join(dir, "cloudflare.work.json"));
    await expect(readFile(join(dir, "cloudflare.work.json"), "utf8")).rejects.toThrow();
  });

  test("an exported store id is no reason to stay silent when the account has no store", async () => {
    const options = await signedIn({ SECRETS_STORE_ID: "store-work" });

    const notes = await ensureSecretsStoreId({
      again: "`pithy add secrets`",
      paths: options,
      listStores: async () => [],
    });

    expect(notes.join(" ")).toContain("no Secrets Store");
    await expect(readFile(join(dir, "cloudflare.work.json"), "utf8")).rejects.toThrow();
  });

  test("the account it records is written beside the store id, so a profile re-signed to another account drops it", async () => {
    const options = await signedIn();
    await ensureSecretsStoreId({
      again: "`pithy add secrets`",
      paths: options,
      listStores: async () => [store("store-work", "default")],
    });

    const resigned = await signedIn({}, "acct-2");
    expect(cloudflareEnv(resigned).CLOUDFLARE_ACCOUNT_ID).toBe("acct-2");
    expect(cloudflareEnv(resigned).SECRETS_STORE_ID).toBeUndefined();
  });

  test("a profile file about another account is neither overwritten nor merged into, and the sentence names both", async () => {
    const options = await signedIn();
    const before = `${JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "acct-other", SECRETS_STORE_ID: "store-other" })}\n`;
    await writeFile(join(dir, "cloudflare.work.json"), before, { mode: 0o600 });
    const listStores = vi.fn(async () => [store("store-work", "default")]);

    const notes = await ensureSecretsStoreId({ again: "`pithy add secrets`", paths: options, listStores });

    expect(await readFile(join(dir, "cloudflare.work.json"), "utf8")).toBe(before);
    const said = notes.join(" ");
    expect(said).toContain("acct-other");
    expect(said).toContain("acct-1");
    expect(said).toContain(join(dir, "cloudflare.work.json"));
    expect(said).toContain("not recorded");
  });
});
