// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { storeSecretMinter } from "../capabilities/mintSecrets";
import { featureHostCapabilities, featureHostScripts } from "../feature/hosts";
import { type ProvisionFeatureOptions, provisionFeature } from "../feature/provision";
import { migrateProject } from "../migrations/run";
import { Plan } from "../plan/plan";
import { createTable } from "../test-utils/migrateHarness";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { plannedFeatureHosts, plannedId, plannedProvisioners, plannedStore, planProvision } from "./dryRun";
import { type ProvisionWorker, provisionEnvironment } from "./environment";
import type { ResourceProvisioners } from "./resources";
import { secretsStoreBindings, workerSecretRegistry } from "./secretBindings";
import type { SecretsStore } from "./store";

/**
 * **`pithy provision --dry-run` runs the real provisioning against a copy and an account it only reads
 * (#697).** What exists is adopted by id, what does not is planned as a creation, nothing in the account
 * is created, nothing in the project is written, and the migrations are the ones the run's migrate would
 * apply — every one for a database it would create, only the pending ones for a database it adopts.
 */

const remote = vi.hoisted(() => ({ d1: undefined as unknown as () => unknown }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: async () => ({ d1: () => remote.d1() }),
}));

const app = defineCapability({
  name: "app",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "CACHE" },
  ] satisfies BindingSpecInput[],
  databases: {
    app: {
      binding: "DB",
      tables: {},
      migrations: { "0001_things": createTable("things"), "0002_more": createTable("more") },
      migrationOrder: 1000,
    },
  },
});

/** An account holding `existing` (name → id), recording every call that would change it. */
function account(existing: Record<string, string>) {
  const writes: string[] = [];
  const kind = () => ({
    find: async (name: string) => (existing[name] !== undefined ? { id: existing[name] as string } : null),
    create: async (name: string) => {
      writes.push(`create ${name}`);
      return { id: "made" };
    },
    delete: async (id: string) => {
      writes.push(`delete ${id}`);
    },
  });
  return { writes, provisioners: { d1: kind(), kv: kind(), r2: kind() } as ResourceProvisioners };
}

let dir: string;
let workerDir: string;
const scope = environmentScope("replay", "staging");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-provision-dry-"));
  workerDir = join(dir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), '{\n  "name": "replay-board"\n}\n');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const workers: ProvisionWorker[] = [];
beforeEach(() => {
  workers.length = 0;
  workers.push({ name: "replay-board", dir: workerDir, capabilities: [app] });
});

/** Plan a staging run over the fixture, with the account and store given. */
function plan(provisioners: ResourceProvisioners, store: SecretsStore | null = null, seed = false) {
  return planProvision({
    projectDir: dir,
    project: "replay",
    env: "staging",
    account: null,
    provisioners,
    store,
    seed,
    run: (seams) =>
      provisionEnvironment({
        projectDir: seams.projectDir,
        scope,
        capabilities: [app],
        provisioners: seams.provisioners,
        resolveWorkers: async () => seams.workers(workers),
        seedData: seed,
        administersItself: false,
        migrate: seams.migrate,
        seed: seams.seed,
        audit: seams.audit,
      }),
  });
}

describe("planProvision", () => {
  test("nothing exists: every resource is a creation, the stanza edit is planned, nothing is made or written", async () => {
    const { writes, provisioners } = account({});
    const before = await snapshotTree(dir);

    const { plan: planned, report } = await plan(provisioners);

    expect(Plan.parse(planned).resources).toEqual([
      { kind: "d1", name: "replay-staging-db", binding: "DB", env: "staging", action: "create" },
      { kind: "kv", name: "replay-staging-cache", binding: "CACHE", env: "staging", action: "create" },
    ]);
    expect(planned.files.map((file) => [file.path, file.action])).toEqual([["apps/board/wrangler.jsonc", "edit"]]);
    expect(planned.files[0]?.diff).toContain(plannedId("d1", "replay-staging-db"));
    expect(report.configs).toEqual([{ worker: "replay-board", path: "apps/board/wrangler.jsonc", ids: 2 }]);
    // A database the run would create has applied nothing, so every migration it carries is listed.
    expect(planned.migrations.map((migration) => [migration.env, migration.name, migration.direction])).toEqual([
      ["staging", "1000_app_0001_things", "up"],
      ["staging", "1000_app_0002_more", "up"],
    ]);
    expect(writes).toEqual([]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("what exists is adopted by id, and an adopted database lists only what it has not applied", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: { DB: "d1-real" } }),
    );
    try {
      const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
      remote.d1 = () => db;
      const once = defineCapability({
        name: "app",
        requiredBindings: [],
        databases: {
          app: {
            binding: "DB",
            tables: {},
            migrations: { "0001_things": createTable("things") },
            migrationOrder: 1000,
          },
        },
      });
      // An earlier run applied the first migration to the database this plan adopts.
      const applied = join(dir, "..", `${dir.split("/").at(-1)}-applied`);
      const appliedWorker = join(applied, "apps", "board");
      await mkdir(appliedWorker, { recursive: true });
      await writeFile(
        join(appliedWorker, "wrangler.jsonc"),
        JSON.stringify({ env: { staging: { d1_databases: [{ binding: "DB", database_id: "d1-real" }] } } }),
      );
      try {
        await migrateProject({
          projectDir: applied,
          project: "replay",
          account: null,
          env: "staging",
          workers: [{ name: "replay-board", dir: appliedWorker, capabilities: [once] }],
          remoteD1: () => db,
        });
      } finally {
        await rm(applied, { recursive: true, force: true });
      }
      const { writes, provisioners } = account({ "replay-staging-db": "d1-real" });

      const { plan: planned } = await plan(provisioners);

      expect(planned.resources[0]).toEqual({
        kind: "d1",
        name: "replay-staging-db",
        binding: "DB",
        env: "staging",
        action: "adopt",
        id: "d1-real",
      });
      expect(planned.resources[1]?.action).toBe("create");
      expect(planned.migrations.map((migration) => migration.name)).toEqual(["1000_app_0002_more"]);
      expect(writes).toEqual([]);
    } finally {
      await miniflare.dispose();
    }
  });

  test("secrets: one already in the store is bound, an absent mintable one is minted, and nothing is written", async () => {
    const vault = secrets({
      registry: {
        SIGNING_KEY: {
          backend: "cf-secrets-store",
          scope: "environment",
          rotatable: true,
          valueType: "text",
          devValue: "random",
        },
        // Somebody else issues this one, so an absent entry is reported missing and planned as nothing.
        STRIPE_SECRET_KEY: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
      },
    });
    const capabilities = [app, vault];
    workers[0] = { name: "replay-board", dir: workerDir, capabilities };
    const master = scope.secretEntry(MASTER_KEY_BINDING, "environment");
    const calls: string[] = [];
    const store: SecretsStore = {
      storeId: "store-1",
      exists: async (name) => {
        calls.push(`exists ${name}`);
        return name === master;
      },
      put: async () => {
        calls.push("put");
      },
      create: async () => {
        calls.push("create");
        return "created";
      },
      remove: async () => {
        calls.push("remove");
        return true;
      },
    };
    const { writes, provisioners } = account({});
    const before = await snapshotTree(dir);

    const { plan: planned } = await planProvision({
      projectDir: dir,
      project: "replay",
      env: "staging",
      account: null,
      provisioners,
      store,
      seed: false,
      run: (seams) =>
        provisionEnvironment({
          projectDir: seams.projectDir,
          scope,
          capabilities,
          provisioners: seams.provisioners,
          resolveWorkers: async () => seams.workers(workers),
          // The command's own seam: the registry each Worker composes, over the store the plan hands it.
          secretBindings: async (workerCapabilities) =>
            secretsStoreBindings({
              registry: workerSecretRegistry(workerCapabilities) ?? {},
              scope,
              storeId: (seams.store as SecretsStore).storeId,
              exists: (name) => (seams.store as SecretsStore).exists(name),
              mint: storeSecretMinter({ store: seams.store as SecretsStore, environment: "staging" }),
            }),
          seedData: false,
          administersItself: false,
          migrate: seams.migrate,
          seed: seams.seed,
          audit: seams.audit,
        }),
    });

    expect(Plan.parse(planned).secrets).toEqual([
      { name: MASTER_KEY_BINDING, env: "staging", action: "bind", where: master },
      {
        name: "SIGNING_KEY",
        env: "staging",
        action: "mint",
        where: scope.secretEntry("SIGNING_KEY", "environment"),
      },
    ]);
    // The store was asked about every one, and written to for none.
    expect(calls.filter((call) => !call.startsWith("exists "))).toEqual([]);
    expect(calls).toContain(`exists ${scope.secretEntry("STRIPE_SECRET_KEY", "global")}`);
    expect(writes).toEqual([]);
    expect(await snapshotTree(dir)).toEqual(before);
  });
});

describe("the seams a plan hands the run", () => {
  test("the account answers find and creates nothing; a delete is refused outright", async () => {
    const { writes, provisioners } = account({ "replay-staging-db": "d1-real" });
    const planned = plannedProvisioners(provisioners);

    expect(await planned.d1.find("replay-staging-db")).toEqual({ id: "d1-real" });
    expect(await planned.kv.create("replay-staging-cache")).toEqual({ id: "<new kv replay-staging-cache>" });
    // R2 has no id but its name, so the plan writes the name the run would.
    expect(await planned.r2.create("replay-staging-assets")).toEqual({ id: "replay-staging-assets" });
    await expect(planned.d1.delete("d1-real")).rejects.toBeInstanceOf(PithyError);
    expect(writes).toEqual([]);
  });

  test("the store answers exists, reports a mint as made, and writes nothing", async () => {
    const calls: string[] = [];
    const real: SecretsStore = {
      storeId: "store-1",
      exists: async (name) => {
        calls.push(`exists ${name}`);
        return false;
      },
      put: async () => {
        calls.push("put");
      },
      create: async () => {
        calls.push("create");
        return "created";
      },
      remove: async () => {
        calls.push("remove");
        return true;
      },
    };
    const store = plannedStore(real);

    expect(store.storeId).toBe("store-1");
    expect(await store.exists("replay-staging-key")).toBe(false);
    expect(await store.create("replay-staging-key", "value")).toBe("created");
    await expect(store.put("replay-staging-key", "value")).rejects.toBeInstanceOf(PithyError);
    await expect(store.remove("replay-staging-key")).rejects.toBeInstanceOf(PithyError);
    expect(calls).toEqual(["exists replay-staging-key"]);
  });
});

describe("a feature's kit Workers, which a plan names and does not upload", () => {
  const identity = { project: "replay", issue: "42", slug: "maps" };

  test("one upload per host the feature composes, and the master key when a store is in reach", () => {
    const secrets = defineCapability({ name: "secrets", requiredBindings: [] });
    const planned = plannedFeatureHosts(identity, [app, secrets], { store: true });

    expect(planned.resources).toEqual([
      {
        kind: "worker",
        name: expect.stringContaining("replay-f42-maps"),
        env: "feature",
        action: "upload",
        reason: "The secrets kit Worker this feature composes.",
      },
    ]);
    expect(planned.notes).toEqual([
      "Creates this feature's master key in the Secrets Store first, if it is absent.",
      "Then binds each app Worker to the kit Workers that deploy, and creates the indexes and d1 secrets they need.",
    ]);
  });

  /**
   * **The plan's half and the run's half cannot drift apart unseen (#697).** A dry run stops `provisionFeature` at
   * its resources, because everything after them uploads or writes to the account, and `plannedFeatureHosts` names
   * what it stopped short of. That is a second description of the run's host phase, so this holds the two
   * together: the real run, every host seam a recorder, is handed exactly the uploads the plan names and must
   * finish on them; the master key is a step in the run exactly when it is a note in the plan; and the options the
   * run reads are pinned. A new step in the host phase reads a new option, and fails here until the plan names it.
   */
  test("the plan names exactly the host phase provisionFeature runs", async () => {
    const secretsHost = defineCapability({ name: "secrets", requiredBindings: [] });
    const capabilities = [app, secretsHost];
    const planned = plannedFeatureHosts(identity, capabilities, { store: true });
    const capabilityOf = new Map(featureHostScripts(identity).map((host) => [host.script, host.capability]));
    const steps: string[] = [];
    const read = new Set<string>();
    const store: SecretsStore = {
      storeId: "store",
      exists: async () => false,
      create: async () => "created",
      put: async () => {},
      remove: async () => false,
    };
    const options: ProvisionFeatureOptions = {
      projectDir: dir,
      capabilities,
      identity,
      provisioners: account({}).provisioners,
      administersItself: false,
      resolveWorkers: async () => [{ name: "replay-board", dir: workerDir, capabilities }],
      migrate: async () => {},
      seed: async () => {},
      store,
      secrets: {
        ensureMasterKey: async () => {
          steps.push("master key");
          return { storeId: "store" };
        },
      },
      indexes: { ensure: async (index) => void steps.push(`index ${index.name}`), remove: async () => false },
      deployHosts: async () => {
        steps.push("deploy hosts");
        return {
          workers: planned.resources.map((resource) => ({
            capability: capabilityOf.get(resource.name) ?? resource.name,
            worker: resource.name,
            outcome: "deployed" as const,
            reason: "Planned.",
          })),
          problems: [],
        };
      },
    };

    await provisionFeature(
      new Proxy(options, {
        get(target, key, receiver) {
          if (typeof key === "string") read.add(key);
          return Reflect.get(target, key, receiver);
        },
      }),
    );

    expect(planned.resources.map((resource) => resource.name)).toEqual([
      ...featureHostScripts(identity)
        .filter((host) => featureHostCapabilities(capabilities).includes(host.capability))
        .map((host) => host.script),
    ]);
    expect(steps).toEqual(["master key", "deploy hosts"]);
    expect(planned.notes.some((note) => note.includes("master key"))).toBe(steps.includes("master key"));
    // Every option the run reads. A new one is a new step: name it in `plannedFeatureHosts`, then here.
    expect([...read].sort()).toEqual([
      "administersItself",
      "audit",
      "capabilities",
      "deployHosts",
      "identity",
      "indexes",
      "managers",
      "migrate",
      "onProgress",
      "projectDir",
      "provisioners",
      "resolveWorkers",
      "secrets",
      "seed",
      "store",
      "workersSubdomain",
    ]);
  });

  test("a feature composing no host plans no upload and says nothing", () => {
    expect(plannedFeatureHosts(identity, [app], { store: true })).toEqual({ resources: [], notes: [] });
  });
});
