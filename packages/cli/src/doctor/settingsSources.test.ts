// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { composeFor } from "../project/composeFor";
import { settingsAccountConnection, settingsEnvironments } from "./settingsSources";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(environments: string[], wrangler: Record<string, unknown>): Promise<string> {
  await writeFile(
    join(dir, "pithy.config.ts"),
    `export default { name: "acme", environments: ${JSON.stringify(environments)} };\n`,
  );
  const workerDir = join(dir, "apps", "api");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(wrangler, null, 2));
  return workerDir;
}

describe("the environments a check is handed", () => {
  test("are the ones the root config declares, each with the origin that Worker answers on", async () => {
    const workerDir = await project(["staging", "prod"], {
      name: "acme-api",
      env: { staging: { routes: ["staging.acme.dev/*"] }, prod: { routes: ["api.acme.dev/*"] } },
    });
    expect(await settingsEnvironments(dir, workerDir)).toEqual([
      { name: "staging", origin: "https://staging.acme.dev" },
      { name: "prod", origin: "https://api.acme.dev" },
    ]);
  });

  /**
   * Each origin from its own environment's composition (#586). A config may name its domains from the
   * environment it is composed for, and the reader took the module cache — whichever environment this process
   * composed last — so every environment was handed that one's host.
   */
  test("each environment's origin is read from that environment's composition", async () => {
    const workerDir = await project(["staging", "prod"], { name: "acme-api" });
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        'const environment = process.env.ENVIRONMENT ?? "none";',
        'const domain = { pattern: [environment, "acme.dev"].join("."), zone: "acme.dev" };',
        "export default { domains: { staging: domain, prod: domain }, capabilities: [] };",
        "",
      ].join("\n"),
    );
    await composeFor("dev", (load) => load(workerDir));
    expect(await settingsEnvironments(dir, workerDir)).toEqual([
      { name: "staging", origin: "https://staging.acme.dev" },
      { name: "prod", origin: "https://prod.acme.dev" },
    ]);
  });

  test("an environment nothing serves carries a null origin rather than being dropped", async () => {
    const workerDir = await project(["prod"], { name: "acme-api" });
    expect(await settingsEnvironments(dir, workerDir)).toEqual([{ name: "prod", origin: null }]);
  });

  test("an unreadable wrangler.jsonc still yields the declared set, with no origin claimed", async () => {
    await writeFile(join(dir, "pithy.config.ts"), `export default { name: "acme", environments: ["prod"] };\n`);
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ not json");
    expect(await settingsEnvironments(dir, workerDir)).toEqual([{ name: "prod", origin: null }]);
  });
});

describe("reaching the account", () => {
  const connect = vi.fn();

  test("offline skips it before anything resolves", async () => {
    const answer = await settingsAccountConnection({
      projectDir: dir,
      account: null,
      project: "acme",
      offline: true,
      homedir: dir,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      connect,
    });
    expect(answer).toEqual({ state: "skipped", reason: "offline" });
    expect(connect).not.toHaveBeenCalled();
  });

  test("no credentials is its own reason — a project not set up yet is not an unreachable one", async () => {
    const answer = await settingsAccountConnection({
      projectDir: dir,
      account: null,
      project: "acme",
      offline: false,
      env: {},
      homedir: dir,
      connect,
    });
    expect(answer).toEqual({ state: "skipped", reason: "no-credentials" });
  });

  test("credentials resolve into a reader that asks Cloudflare once per question", async () => {
    const listDatabases = vi.fn(async () => [{ name: "acme-global-email-suppressions", uuid: "id" }]);
    const findZoneForHostname = vi.fn(async (hostname: string) => (hostname === "acme.dev" ? { id: "z" } : null));
    const secretProbe = vi.fn(async () => true);
    const answer = await settingsAccountConnection({
      projectDir: dir,
      account: null,
      project: "acme",
      offline: false,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      homedir: dir,
      connect: async () =>
        ({
          d1Provisioner: () => ({ listDatabases }),
          zones: () => ({ findZoneForHostname }),
        }) as never,
      probe: async () => ({ probe: secretProbe, carries: async () => false }),
    });
    if (answer.state !== "reachable") throw new Error(`expected reachable, got ${answer.reason}`);

    expect(await answer.reader.d1Databases()).toEqual(["acme-global-email-suppressions"]);
    expect(await answer.reader.d1Databases()).toEqual(["acme-global-email-suppressions"]);
    // Memoized: every capability asks the same question, and a doctor run must cost one listing.
    expect(listDatabases).toHaveBeenCalledTimes(1);

    expect(await answer.reader.zone("acme.dev")).toBe(true);
    expect(await answer.reader.zone("example.com")).toBe(false);
    expect(await answer.reader.vaultSecret({ name: "email-link-signing-key", environment: "prod" })).toBe(true);
    // Doctor judges every environment's composition of a capability, and each asks the manager this again.
    expect(await answer.reader.vaultSecret({ name: "email-link-signing-key", environment: "prod" })).toBe(true);
    expect(secretProbe).toHaveBeenCalledTimes(1);
  });

  test("a field and an account token are asked once each, of the manager and the token list (#728)", async () => {
    const carries = vi.fn(async () => true);
    const findTokenByName = vi.fn(async (name: string) =>
      name === "acme-global-secrets-manager" ? { id: "t" } : null,
    );
    const answer = await settingsAccountConnection({
      projectDir: dir,
      account: null,
      project: "acme",
      offline: false,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      homedir: dir,
      connect: async () => ({ accountTokens: () => ({ findTokenByName }) }) as never,
      probe: async () => ({ probe: async () => true, carries }),
    });
    if (answer.state !== "reachable") throw new Error("expected reachable");

    const field = { name: "media-storage-credentials", environment: "prod", field: "apiToken" };
    expect(await answer.reader.vaultSecretField(field)).toBe(true);
    expect(await answer.reader.vaultSecretField(field)).toBe(true);
    expect(carries).toHaveBeenCalledTimes(1);
    expect(carries).toHaveBeenCalledWith({ env: "prod", name: "media-storage-credentials", field: "apiToken" });

    expect(await answer.reader.accountToken("acme-global-secrets-manager")).toBe(true);
    expect(await answer.reader.accountToken("acme-global-secrets-manager")).toBe(true);
    expect(await answer.reader.accountToken("acme-prod-secrets")).toBe(false);
    expect(findTokenByName).toHaveBeenCalledTimes(2);
  });

  test("a Secrets Store entry is asked of the project's store, by the name it was created under", async () => {
    const exists = vi.fn(async (name: string) => name === "acme-prod-email-link-signing-key");
    const stores: string[] = [];
    const answer = await settingsAccountConnection({
      projectDir: dir,
      account: null,
      project: "acme",
      offline: false,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", SECRETS_STORE_ID: "store-1" },
      homedir: dir,
      connect: async () =>
        ({
          secrets: (storeId: string) => {
            stores.push(storeId);
            return { exists };
          },
        }) as never,
      probe: async () => ({ probe: async () => false, carries: async () => false }),
    });
    if (answer.state !== "reachable") throw new Error("expected reachable");
    expect(await answer.reader.storeEntry("acme-prod-email-link-signing-key")).toBe(true);
    expect(await answer.reader.storeEntry("acme-staging-email-link-signing-key")).toBe(false);
    // Asked again by the next environment's composition, and answered from the first listing.
    expect(await answer.reader.storeEntry("acme-prod-email-link-signing-key")).toBe(true);
    expect(exists).toHaveBeenCalledTimes(2);
    expect(stores.every((id) => id === "store-1")).toBe(true);
  });

  test("with no store id recorded, a store question is not answered at all", async () => {
    const answer = await settingsAccountConnection({
      projectDir: dir,
      account: null,
      project: "acme",
      offline: false,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      homedir: dir,
      connect: async () => ({ secrets: () => ({ exists: async () => false }) }) as never,
      probe: async () => ({ probe: async () => false, carries: async () => false }),
    });
    if (answer.state !== "reachable") throw new Error("expected reachable");
    // `false` would report every entry missing on a machine that simply never recorded the id. A refusal is
    // the runner's `unchecked`, which is the truth.
    const refusal = await answer.reader.storeEntry("acme-prod-email-link-signing-key").catch((error: unknown) => error);
    // …and its action never names an add that would be refused: this fixture has no Worker to name (#711).
    expect((refusal as PithyError).payload.action).toBe(
      "This project has no Worker to compose secrets into. Name one and create it with pithy worker add, then compose secrets into it.",
    );
  });

  test("a secret asked about an environment no manager owns is not a claim", async () => {
    const answer = await settingsAccountConnection({
      projectDir: dir,
      account: null,
      project: "acme",
      offline: false,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      homedir: dir,
      connect: async () => ({}) as never,
      probe: async () => ({
        probe: async () => {
          throw new Error("the probe should not be asked about dev");
        },
        carries: async () => {
          throw new Error("the probe should not be asked about dev");
        },
      }),
    });
    if (answer.state !== "reachable") throw new Error("expected reachable");
    // `dev` is local Miniflare — there is no manager Worker to ask, so the question is refused rather
    // than answered `false`, and the runner reports the capability's account tier as unchecked.
    await expect(answer.reader.vaultSecret({ name: "email-link-signing-key", environment: "dev" })).rejects.toThrow();
    await expect(
      answer.reader.vaultSecretField({ name: "media-storage-credentials", environment: "dev", field: "apiToken" }),
    ).rejects.toThrow(/dev secret cannot be asked/);
  });

  describe("appRows — a capability's own rows, named", () => {
    async function reachable(rows: { id: string }[] = []) {
      await project(["dev", "prod"], { env: { prod: { d1_databases: [{ binding: "DB", database_id: "db-prod" }] } } });
      const asked: { databaseId: string; sql: string; values: unknown[] }[] = [];
      const answer = await settingsAccountConnection({
        projectDir: dir,
        account: null,
        project: "acme",
        offline: false,
        env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
        homedir: dir,
        connect: async () =>
          ({
            d1: (databaseId: string) => ({
              prepare: (sql: string) => ({
                bind: (...values: unknown[]) => ({
                  all: async () => {
                    asked.push({ databaseId, sql, values });
                    return { results: rows };
                  },
                }),
              }),
            }),
          }) as never,
        probe: async () => ({ probe: async () => false, carries: async () => false }),
      });
      if (answer.state !== "reachable") throw new Error("expected reachable");
      return { reader: answer.reader, asked };
    }

    test("reads the Worker's own app database for that environment, with every value bound", async () => {
      const { reader, asked } = await reachable([{ id: "m1" }, { id: "m2" }]);
      const ids = await reader.appRows({
        environment: "prod",
        workerDirectory: "api",
        table: "pithy_media_assets",
        column: "visibility",
        values: ["public"],
      });
      expect(ids).toEqual(["m1", "m2"]);
      expect(asked).toEqual([
        {
          databaseId: "db-prod",
          sql: "SELECT id FROM pithy_media_assets WHERE visibility IN (?) ORDER BY id",
          values: ["public"],
        },
      ]);
    });

    test("refuses a table that is not the kit's, or a column it cannot name, before any statement", async () => {
      const { reader, asked } = await reachable();
      const ask = (table: string, column: string) =>
        reader.appRows({ environment: "prod", workerDirectory: "api", table, column, values: ["x"] });
      await expect(ask("users", "visibility")).rejects.toThrow();
      await expect(ask("pithy_media_assets; drop table x", "visibility")).rejects.toThrow();
      await expect(ask("pithy_media_assets", "visibility = 1 or 1")).rejects.toThrow();
      expect(asked).toEqual([]);
    });

    test("an environment with no app database is unchecked, not clean", async () => {
      const { reader } = await reachable();
      await expect(
        reader.appRows({
          environment: "staging",
          workerDirectory: "api",
          table: "pithy_media_assets",
          column: "visibility",
          values: ["public"],
        }),
      ).rejects.toThrow(/names no app database for staging/);
    });

    test("dev is refused — it has no deployed database", async () => {
      const { reader } = await reachable();
      await expect(
        reader.appRows({
          environment: "dev",
          workerDirectory: "api",
          table: "pithy_media_assets",
          column: "visibility",
          values: ["public"],
        }),
      ).rejects.toThrow();
    });
  });
});
