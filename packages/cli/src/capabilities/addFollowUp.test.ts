// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PITHY_OFFLINE_ENV, writeCloudflareConfig } from "../cloudflare/config";
import type { ProjectLedger } from "../migrations/run";
import type { BindingProvisioning, UnprovisionedBinding } from "../provision/unprovisioned";
import { accountReachable, addFollowUp, readyEnvironments } from "./addFollowUp";

/**
 * **What `pithy add` leaves an environment that was ready before it (#697).** The facts behind `add`'s
 * `next`, gathered: which declared environments a provision had readied before the add, which of
 * those lost that, and how many migrations the add brought that a provisioned environment has not applied.
 * Every account read goes through a seam, so nothing here reaches Cloudflare; the stanzas `pithy init`
 * writes are read from a project on disk, because that shape is the one a stub would get wrong.
 */

const binding = (worker: string, name: string): UnprovisionedBinding => ({ worker, kind: "d1", binding: name });

/** Unprovisioned bindings per environment, as the stanza would read. */
const stanzas =
  (byEnv: Record<string, UnprovisionedBinding[]>) =>
  async (env: string): Promise<UnprovisionedBinding[]> =>
    byEnv[env] ?? [];

const read = (pending: number): ProjectLedger => ({ state: "read", pending, undeclared: [] });

const provisioning =
  (byEnv: Record<string, BindingProvisioning>) =>
  async (env: string): Promise<BindingProvisioning> =>
    byEnv[env] ?? { missing: [], provisioned: 0 };

/** A Worker under `apps/` in a fresh temp project, with the given wrangler config. */
async function projectWith(wrangler: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-add-follow-up-"));
  const workerDir = join(dir, "apps", "api");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`);
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": {} }\n');
  return dir;
}

/** The environment stanzas `pithy init` writes (`project/scaffold.ts`): bindings start empty. */
const SCAFFOLDED = {
  name: "demo-api",
  d1_databases: [{ binding: "DB", database_name: "demo-dev-db" }],
  env: {
    staging: { name: "demo-staging-api", d1_databases: [], kv_namespaces: [] },
    prod: { name: "demo-prod-api", d1_databases: [], kv_namespaces: [] },
  },
};

describe("readyEnvironments", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("a declared environment a provision readied is ready; dev never is one", async () => {
    const ready = await readyEnvironments({
      projectDir: "/p",
      environments: ["dev", "staging", "prod"],
      provisioning: provisioning({
        dev: { missing: [], provisioned: 1 },
        staging: { missing: [], provisioned: 1 },
        prod: { missing: [binding("api", "DB")], provisioned: 1 },
      }),
    });
    expect(ready).toEqual(["staging"]);
  });

  test("an environment with nothing missing and no id a provision wrote is not ready", async () => {
    const ready = await readyEnvironments({
      projectDir: "/p",
      environments: ["staging"],
      provisioning: provisioning({ staging: { missing: [], provisioned: 0 } }),
    });
    expect(ready).toEqual([]);
  });

  // The vacuous case, read from disk: every stanza `init` writes is empty, and empty is not provisioned.
  test("the empty stanzas pithy init scaffolds are ready nowhere", async () => {
    const dir = await projectWith(SCAFFOLDED);
    dirs.push(dir);
    expect(await readyEnvironments({ projectDir: dir, environments: ["dev", "staging", "prod"] })).toEqual([]);
  });

  test("a stanza a provision wrote ids into is ready, read from disk", async () => {
    const dir = await projectWith({
      ...SCAFFOLDED,
      env: {
        ...SCAFFOLDED.env,
        staging: { name: "demo-staging-api", d1_databases: [{ binding: "DB", database_id: "uuid" }] },
      },
    });
    dirs.push(dir);
    expect(await readyEnvironments({ projectDir: dir, environments: ["dev", "staging", "prod"] })).toEqual(["staging"]);
  });

  /**
   * The first `pithy add` on a project nobody provisioned: the add writes its bindings, with no id, into
   * every stanza. No environment was ready before, so no environment is the add's to report.
   */
  test("a never-provisioned project gaining bindings gets no next", async () => {
    const dir = await projectWith(SCAFFOLDED);
    dirs.push(dir);
    const ready = await readyEnvironments({ projectDir: dir, environments: ["dev", "staging", "prod"] });
    await writeFile(
      join(dir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({
        ...SCAFFOLDED,
        env: {
          staging: { name: "demo-staging-api", d1_databases: [{ binding: "AUTH_DB", database_name: "s" }] },
          prod: { name: "demo-prod-api", d1_databases: [{ binding: "AUTH_DB", database_name: "p" }] },
        },
      }),
    );
    let reads = 0;
    const next = await addFollowUp({
      projectDir: dir,
      account: null,
      worker: "api",
      capability: "auth",
      ready,
      brought: true,
      reachable: true,
      readLedger: async () => {
        reads += 1;
        return read(2);
      },
    });
    expect(next).toBeUndefined();
    expect(reads).toBe(0);
  });
});

/**
 * **Whether a deployed database may be asked, as the run resolves it.** The gate that keeps an offline
 * `pithy add --json` off the network: every case reaches `addFollowUp` with `reachable` left to default, and
 * asserts whether the ledger was read at all.
 */
describe("accountReachable", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** `addFollowUp` with `reachable` defaulted; how many ledger reads it made. */
  async function ledgerReads(account: Parameters<typeof accountReachable>[0] = null): Promise<number> {
    let reads = 0;
    await addFollowUp({
      projectDir: "/p",
      account,
      worker: "api",
      capability: "auth",
      ready: ["staging"],
      brought: true,
      unprovisioned: stanzas({}),
      readLedger: async () => {
        reads += 1;
        return read(1);
      },
    });
    return reads;
  }

  function credentials(accountId: string | undefined, apiToken: string | undefined): void {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", accountId);
    vi.stubEnv("CLOUDFLARE_API_TOKEN", apiToken);
  }

  test("both credentials, not offline, may ask", async () => {
    credentials("acc", "token");
    vi.stubEnv(PITHY_OFFLINE_ENV, undefined);
    expect(accountReachable(null)).toBe(true);
    expect(await ledgerReads()).toBe(1);
  });

  test("offline may not ask, credentials or not", async () => {
    credentials("acc", "token");
    vi.stubEnv(PITHY_OFFLINE_ENV, "1");
    expect(accountReachable(null)).toBe(false);
    expect(await ledgerReads()).toBe(0);
  });

  // Offline drops the environment's credentials on its own; a saved `cloudflare.json` it does not, so the
  // offline check is the only thing between that file and the network.
  test("offline may not ask with credentials saved in the config directory either", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "pithy-add-follow-up-config-"));
    try {
      vi.stubEnv("PITHY_CONFIG_DIR", configDir);
      credentials(undefined, undefined);
      vi.stubEnv(PITHY_OFFLINE_ENV, undefined);
      await writeCloudflareConfig({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token" }, { account: null });
      expect(accountReachable(null)).toBe(true);
      vi.stubEnv(PITHY_OFFLINE_ENV, "1");
      expect(accountReachable(null)).toBe(false);
      expect(await ledgerReads()).toBe(0);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["no account id", undefined, "token"],
    ["no API token", "acc", undefined],
  ])("%s may not ask", async (_label, accountId, apiToken) => {
    credentials(accountId, apiToken);
    vi.stubEnv(PITHY_OFFLINE_ENV, undefined);
    expect(accountReachable(null)).toBe(false);
    expect(await ledgerReads()).toBe(0);
  });

  // A pin the credentials contradict is `cloudflareEnv`'s throw; it is no account to ask, not a failed add.
  test("an account selection the credentials contradict may not ask", async () => {
    credentials("acc", "token");
    vi.stubEnv(PITHY_OFFLINE_ENV, undefined);
    const pinned = { accountId: "another-account" };
    expect(accountReachable(pinned)).toBe(false);
    expect(await ledgerReads(pinned)).toBe(0);
  });
});

describe("addFollowUp", () => {
  const base = {
    projectDir: "/p",
    account: null,
    worker: "api",
    capability: "auth",
    reachable: true,
  } as const;

  test("an environment ready before the add and not after it names provision", async () => {
    const next = await addFollowUp({
      ...base,
      ready: ["staging"],
      brought: true,
      unprovisioned: stanzas({ staging: [binding("api", "SESSIONS")] }),
      readLedger: async () => read(2),
    });
    expect(next?.map((step) => step.command)).toEqual(["pithy provision --env staging --yes"]);
  });

  test("an environment the project declares production gets no provision step: the phrase is a person's", async () => {
    const options = {
      ...base,
      ready: ["live", "qa"],
      brought: false,
      unprovisioned: stanzas({ live: [binding("api", "SESSIONS")], qa: [binding("api", "SESSIONS")] }),
    };
    expect((await addFollowUp(options))?.map((step) => step.command)).toEqual([
      "pithy provision --env live --yes",
      "pithy provision --env qa --yes",
    ]);
    const next = await addFollowUp({ ...options, productionEnvironments: ["live"] });
    expect(next?.map((step) => step.command)).toEqual(["pithy provision --env qa --yes"]);
  });

  test("migrations the add brought, pending in a ready environment, name migrate for that worker's databases", async () => {
    const asked: { env: string; worker: string | undefined }[] = [];
    const next = await addFollowUp({
      ...base,
      ready: ["staging", "prod"],
      brought: true,
      unprovisioned: stanzas({}),
      readLedger: async (options) => {
        asked.push({ env: options.env, worker: options.worker });
        return options.env === "staging" ? read(2) : read(0);
      },
    });
    expect(next?.map((step) => step.command)).toEqual(["pithy migrate --env staging"]);
    expect(asked).toEqual([
      { env: "staging", worker: "api" },
      { env: "prod", worker: "api" },
    ]);
  });

  test("a partial ledger contributes what answered", async () => {
    const next = await addFollowUp({
      ...base,
      ready: ["staging"],
      brought: true,
      unprovisioned: stanzas({}),
      readLedger: async () => ({
        state: "partial",
        counted: { pending: 1, undeclared: [] },
        unreadable: [{ database: "app", binding: "DB" }],
      }),
    });
    expect(next?.map((step) => step.command)).toEqual(["pithy migrate --env staging"]);
  });

  test("an add that brought no migration reads no ledger at all", async () => {
    let reads = 0;
    const next = await addFollowUp({
      ...base,
      ready: ["staging"],
      brought: false,
      unprovisioned: stanzas({}),
      readLedger: async () => {
        reads += 1;
        return read(3);
      },
    });
    expect(next).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("no account to ask, a read that fails, or one that answered nothing, is no step", async () => {
    const options = { ...base, ready: ["staging"], brought: true, unprovisioned: stanzas({}) };
    expect(await addFollowUp({ ...options, reachable: false, readLedger: async () => read(2) })).toBeUndefined();
    expect(
      await addFollowUp({
        ...options,
        readLedger: async () => {
          throw new Error("planted: the database did not answer");
        },
      }),
    ).toBeUndefined();
    expect(await addFollowUp({ ...options, readLedger: async () => ({ state: "unavailable" }) })).toBeUndefined();
  });

  // The add has already succeeded: a stanza read that throws costs that environment's step, never the payload.
  test("a stanza read that throws is no step for that environment, and the others still get theirs", async () => {
    const asked: string[] = [];
    const next = await addFollowUp({
      ...base,
      ready: ["staging", "qa"],
      brought: true,
      unprovisioned: async (env) => {
        if (env === "staging") throw new Error("planted: wrangler.jsonc would not parse");
        return [];
      },
      readLedger: async (options) => {
        asked.push(options.env);
        return read(2);
      },
    });
    expect(next?.map((step) => step.command)).toEqual(["pithy migrate --env qa"]);
    expect(asked).toEqual(["qa"]);
  });

  test("an environment that was not ready before is not the add's to report", async () => {
    let reads = 0;
    const next = await addFollowUp({
      ...base,
      ready: [],
      brought: true,
      unprovisioned: stanzas({ staging: [binding("api", "DB")] }),
      readLedger: async () => {
        reads += 1;
        return read(2);
      },
    });
    expect(next).toBeUndefined();
    expect(reads).toBe(0);
  });
});
