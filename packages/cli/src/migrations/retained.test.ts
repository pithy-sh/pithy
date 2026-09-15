// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { RetainedBudget } from "@pithy-sh/core/src/migrations/retained";
import { dropMigrations, rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { environmentScope, type SecretNameScope } from "@pithy-sh/core/src/naming/provisionScope";
import { email } from "@pithy-sh/email/src/capability";
import {
  EMAIL_LINK_SIGNING_KEY,
  emailSigningRegistry,
  resolveSigningKeys,
} from "@pithy-sh/email/src/crypto/signingKey";
import { mintToken, verifyToken } from "@pithy-sh/email/src/crypto/token";
import { secrets } from "@pithy-sh/secrets/src/capability";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { deprovisionSecrets, masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import {
  aggregateSecretRegistries,
  configureSharedSecrets,
  resetSharedSecrets,
} from "@pithy-sh/secrets/src/sharedSecretsStore";
import { storeEntryText } from "@pithy-sh/secrets/src/store/entryText";
import { SystemSecretsStore } from "@pithy-sh/secrets/src/store/systemSecretsStore";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import type { Migration } from "kysely/migration";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultRemoveSteps } from "../capabilities/remove";
import { CloudflareSecretsDeprovisioner } from "../capabilities/secretsProvisioner";
import { seedProjectDevSecrets } from "../devSecrets/seed";
import { localDevStorePath } from "../devSecrets/store";
import type { StatePathOptions } from "../notifier/state";
import { appCapability, createTable, migrateHarness } from "../test-utils/migrateHarness";
import { rollbackConfirmPhrase } from "./confirm";
import { dropCapabilityTables, migrateProject, previewReset, resetProject } from "./run";

/**
 * **#588: a rollback emptied a vault.**
 *
 * `pithy migrate --rollback` steps back one migration in *every* composed database, and the secrets
 * database's whole history is one migration whose `down` drops `pithy_secrets_system_secrets`. So any
 * rollback, on any environment, destroyed every stored secret in place — and because
 * `EMAIL_SUPPRESSIONS` is bound by every environment, a staging rollback also emptied production's
 * suppression list.
 *
 * The cases below are the reproduction from the investigation, each asserting whether the stored rows
 * survived. They are written against the real `secrets()` and `email()` capabilities, so what they prove is
 * that the tables those capabilities ship are declared retained — not that a fixture declared something.
 */

/** The local Miniflare store `pithy migrate` persists to for this project. */
function persistDir(projectDir: string): string {
  return join(projectDir, ".wrangler", "state", "v3", "d1");
}

/** Run `body` against the project's local D1 for `binding`, then release the store. */
async function withLocal<T>(projectDir: string, binding: string, body: (db: D1Database) => Promise<T>): Promise<T> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { D: binding },
    d1Persist: persistDir(projectDir),
  });
  try {
    return await body((await mf.getD1Database("D")) as unknown as D1Database);
  } finally {
    await mf.dispose();
  }
}

/** Store `count` sealed secrets, the way the vault holds them. */
async function storeSecrets(db: D1Database, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await db
      .prepare(
        "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values (?, 'sealed', 'iv', 1, 'text', 1, 1)",
      )
      .bind(`secret-${index}`)
      .run();
  }
}

/** How many rows a table holds, or `null` when the table is gone. */
async function rowsIn(db: D1Database, table: string): Promise<number | null> {
  const present = await db
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .bind(table)
    .first<{ name: string }>();
  if (!present) return null;
  return (await db.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n ?? 0;
}

/** The applied migration names in a database's ledger. */
async function ledgerOf(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("select name from pithy_migrations order by name").all<{ name: string }>();
  return results.map((row) => row.name);
}

/** What a rejected promise threw, as a `PithyError` — or a failed assertion when it resolved. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(PithyError);
  return outcome as PithyError;
}

/** The kit's real secrets capability, with nothing but its own master key declared. */
const vault = (): Capability => secrets({ registry: {} });

/** A capability on its own binding whose `down` always throws — the "later database fails" case. */
function brokenDown(): Capability {
  const broken: Migration = {
    up: createTable("widgets").up,
    down: async () => {
      throw new Error("down refuses");
    },
  };
  return defineCapability({
    name: "widgets",
    requiredBindings: [],
    databases: {
      widgets: { binding: "WIDGETS", tables: {}, migrations: { "0001_widgets": broken }, migrationOrder: 900 },
    },
  });
}

/**
 * A capability that shares the secrets database — `databases.secrets`, bound to `SECRETS` — and declares
 * nothing retained. Its `down` drops its own table, and with `dropsVault` the vault's as well: contrived, and
 * exactly what the database-wide claim exists to refuse without inspecting a `down`.
 */
function sharer(options: { dropsVault: boolean }): Capability {
  const rooms: Migration = {
    up: createTable("rooms").up,
    down: async (db) => {
      await db.schema.dropTable("rooms").execute();
      if (options.dropsVault) await db.schema.dropTable("pithy_secrets_system_secrets").execute();
    },
  };
  return defineCapability({
    name: "sharer",
    requiredBindings: [],
    databases: {
      secrets: { binding: "SECRETS", tables: {}, migrations: { "0001_rooms": rooms }, migrationOrder: 500 },
    },
  });
}

describe("the reproduction (#588)", () => {
  const h = migrateHarness();
  const base = () => ({ account: null, projectDir: h.projectDir, env: "dev", project: "acme" });

  test("migrate → rollback → migrate: the rollback refuses, naming the table and the count, and the vault survives", async () => {
    const workers = [h.api([vault(), appCapability()])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 5));

    const error = await refusal(migrateProject({ ...base(), workers, rollback: true }));
    expect(error.payload.message).toContain("pithy_secrets_system_secrets");
    expect(error.payload.message).toContain("5");
    expect(error.payload.action).toContain("--destroy-retained 5");

    // Nothing moved, in any database: the refusal comes before the first write.
    await withLocal(h.projectDir, "SECRETS", async (db) => {
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(5);
      expect(await ledgerOf(db)).toEqual(["0100_secrets_0001_init"]);
    });
    await withLocal(h.projectDir, "DB", async (db) => expect(await ledgerOf(db)).toEqual(["1000_app_0001_things"]));

    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(5),
    );
  });

  test("the vault composed last: every database is counted before the first one moves", async () => {
    // The runner's own guard refuses at the vault's `down`, which in fan-out order comes after the app
    // database has already stepped back. The preflight is what makes the refusal arrive before anything.
    const workers = [h.api([appCapability(), vault()])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 1));

    await refusal(migrateProject({ ...base(), workers, rollback: true }));
    await withLocal(h.projectDir, "DB", async (db) => expect(await ledgerOf(db)).toEqual(["1000_app_0001_things"]));
  });

  test("rollback with pending app migrations: still refused, still intact", async () => {
    await migrateProject({ ...base(), workers: [h.api([vault(), appCapability()])] });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 2));

    const grown = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: {
        app: {
          binding: "DB",
          tables: {},
          migrations: {
            "0001_things": appCapability().databases?.app?.migrations?.["0001_things"] as Migration,
            "0002_more": createTable("more"),
          },
          migrationOrder: 1000,
        },
      },
    });
    await refusal(migrateProject({ ...base(), workers: [h.api([vault(), grown])], rollback: true }));
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(2),
    );
  });

  test("a later database whose down throws: the vault was never the first thing destroyed", async () => {
    const workers = [h.api([vault(), brokenDown()])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 3));

    await refusal(migrateProject({ ...base(), workers, rollback: true }));
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(3),
    );
  });

  test("the override is the printed count, exactly — a different number refuses", async () => {
    const workers = [h.api([vault()])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 2));

    const wrong = await refusal(migrateProject({ ...base(), workers, rollback: true, destroyRetained: 3 }));
    expect(wrong.payload.action).toContain("--destroy-retained 2");
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(2),
    );

    const runs = await migrateProject({ ...base(), workers, rollback: true, destroyRetained: 2 });
    expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0100_secrets_0001_init"]);
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBeNull(),
    );
  });

  test("an empty vault rolls back without an override — there is nothing retained to lose", async () => {
    const workers = [h.api([vault()])];
    await migrateProject({ ...base(), workers });
    const runs = await migrateProject({ ...base(), workers, rollback: true });
    expect(runs[0]?.databases[0]?.results.map((r) => r.direction)).toEqual(["Down"]);
  });

  test("seed --redo's reset refuses too, and so does remove --drop", async () => {
    const workers = [h.api([vault(), appCapability()])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 4));

    const reset = await refusal(resetProject({ ...base(), workers }));
    expect(reset.payload.message).toContain("pithy_secrets_system_secrets");
    const dropped = await refusal(
      dropCapabilityTables({
        ...base(),
        persistRoot: h.projectDir,
        workerDir: workers[0]?.dir ?? "",
        capability: vault(),
        composition: workers[0]?.capabilities ?? [],
      }),
    );
    expect(dropped.payload.message).toContain("4");
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(4),
    );

    await resetProject({ ...base(), workers, destroyRetained: 4 });
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(0),
    );
  });

  /**
   * The review's reproduction. `remove --drop` reversed one capability's migrations with a provider built from
   * that capability alone, so the preflight and the runner's floor both counted what *it* declared — nothing
   * — while the vault it shares a database with held rows. Its `down` ran, and here it took the vault.
   */
  test("remove --drop of a capability sharing the vault's database is counted database-wide", async () => {
    const workers = [h.api([vault(), sharer({ dropsVault: true })])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 1));

    const drop = (destroyRetained?: number) =>
      dropCapabilityTables({
        ...base(),
        persistRoot: h.projectDir,
        workerDir: workers[0]?.dir ?? "",
        capability: sharer({ dropsVault: true }),
        composition: workers[0]?.capabilities ?? [],
        ...(destroyRetained !== undefined ? { destroyRetained } : {}),
      });
    const error = await refusal(drop());
    expect(error.payload.message).toContain("pithy_secrets_system_secrets on SECRETS (1 row)");
    await withLocal(h.projectDir, "SECRETS", async (db) => {
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(1);
      expect(await ledgerOf(db)).toEqual(["0100_secrets_0001_init", "0500_sharer_0001_rooms"]);
    });
  });

  test("and through the step `pithy remove` builds, which counts over the Worker's loaded composition", async () => {
    const workers = [h.api([vault(), sharer({ dropsVault: true })])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 2));

    const steps = defaultRemoveSteps({
      account: null,
      projectDir: h.projectDir,
      workerDir: workers[0]?.dir ?? "",
      loadCapabilities: async () => workers[0]?.capabilities ?? [],
      project: "acme",
    });
    const error = await refusal(steps.dropTables(sharer({ dropsVault: true }), "dev"));
    expect(error.payload.action).toContain("--destroy-retained 2");
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(2),
    );
  });

  test("the drop reverses only its own capability, and a count lets it through", async () => {
    const workers = [h.api([vault(), sharer({ dropsVault: false })])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 2));

    const runs = await dropCapabilityTables({
      ...base(),
      persistRoot: h.projectDir,
      workerDir: workers[0]?.dir ?? "",
      capability: sharer({ dropsVault: false }),
      composition: workers[0]?.capabilities ?? [],
      destroyRetained: 2,
    });
    expect(runs.map((run) => [run.binding, run.results.map((r) => r.migrationName)])).toEqual([
      ["SECRETS", ["0500_sharer_0001_rooms"]],
    ]);
    await withLocal(h.projectDir, "SECRETS", async (db) => {
      expect(await rowsIn(db, "rooms")).toBeNull();
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(2);
      expect(await ledgerOf(db)).toEqual(["0100_secrets_0001_init"]);
    });
  });

  test("dropping a capability on another database is not refused by the vault", async () => {
    const workers = [h.api([vault(), appCapability()])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 3));

    const runs = await dropCapabilityTables({
      ...base(),
      persistRoot: h.projectDir,
      workerDir: workers[0]?.dir ?? "",
      capability: appCapability(),
      composition: workers[0]?.capabilities ?? [],
    });
    expect(runs.map((run) => [run.binding, run.results.map((r) => r.migrationName)])).toEqual([
      ["DB", ["1000_app_0001_things"]],
    ]);
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(3),
    );
  });

  test("a rollback narrowed to one binding leaves every other database alone", async () => {
    const workers = [h.api([vault(), appCapability()])];
    await migrateProject({ ...base(), workers });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 1));

    const runs = await migrateProject({ ...base(), workers, worker: "api", binding: "DB", rollback: true });
    expect(runs[0]?.databases.map((d) => [d.binding, d.results.map((r) => r.migrationName)])).toEqual([
      ["DB", ["1000_app_0001_things"]],
    ]);
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await ledgerOf(db)).toEqual(["0100_secrets_0001_init"]),
    );

    const unknown = await refusal(migrateProject({ ...base(), workers, binding: "NOPE", rollback: true }));
    expect(unknown.payload.message).toContain("NOPE");
  });

  test("the runner's own guard refuses retained rows, however the provider was built", async () => {
    // Beneath the fan-out: a caller reaching core's runner directly, with a provider written by hand that
    // spreads the capability's migration into a new record — the shape every capability's own migration
    // test has. The declaration is on the migration's `down`, so it is still there.
    const migration = vault().databases?.secrets?.migrations?.["0001_init"];
    if (!migration) throw new Error("the secrets capability ships no 0001_init");
    const handBuilt = { getMigrations: async () => ({ "0100_secrets_0001_init": { ...migration } }) };
    const reversals = [
      rollbackMigration,
      (db: D1Database) => dropMigrations(db, { database: handBuilt, reverse: handBuilt }),
    ];
    for (const reverse of reversals) {
      await withLocal(h.projectDir, "SECRETS", async (db) => {
        await runMigrations(db, handBuilt);
        await storeSecrets(db, 1);
        const error = await refusal(reverse(db, handBuilt));
        expect(error.payload.action).toContain("--destroy-retained 1");
        expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(1);
        await db.prepare("delete from pithy_secrets_system_secrets").run();
        await rollbackMigration(db, handBuilt);
      });
    }
  });

  test("a failed rollback's remedy never invites a second rollback", async () => {
    const workers = [h.api([brokenDown()])];
    await migrateProject({ ...base(), workers });
    const error = await refusal(migrateProject({ ...base(), workers, rollback: true }));
    expect(error.payload.action).not.toMatch(/--rollback/);
  });
});

describe("what the kit's capabilities declare retained", () => {
  test("secrets retains both vault tables; email retains the suppression list", () => {
    expect(secrets({ registry: {} }).databases?.secrets?.retained).toEqual([
      "pithySecretsSystemSecrets",
      "pithySecretsRotations",
    ]);
    const mail = email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
    expect(mail.databases?.emailSuppressions?.retained).toEqual(["pithyEmailSuppressions"]);
  });
});

describe("a database other environments bind (#588)", () => {
  const h = migrateHarness();

  /** staging and prod bind one suppression database, as every scaffold writes it. */
  async function writeStanzas(): Promise<void> {
    const stanza = (env: string) => ({
      d1_databases: [
        { binding: "DB", database_id: `${env}-db` },
        { binding: "EMAIL_SUPPRESSIONS", database_id: "global-suppressions" },
      ],
    });
    await writeFile(
      join(h.projectDir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({ env: { staging: stanza("staging"), prod: stanza("prod") } }),
    );
  }

  async function remotes(): Promise<{ mf: Miniflare; byId: (id: string) => D1Database }> {
    const mf = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { STAGING: "staging-db", GLOBAL: "global-suppressions" },
    });
    const staging = (await mf.getD1Database("STAGING")) as unknown as D1Database;
    const global = (await mf.getD1Database("GLOBAL")) as unknown as D1Database;
    return { mf, byId: (id) => (id === "global-suppressions" ? global : staging) };
  }

  const mail = (): Capability => email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });

  test("a staging rollback reverses staging's database and keeps the one prod binds too", async () => {
    await writeStanzas();
    const { mf, byId } = await remotes();
    try {
      const options = {
        account: null,
        projectDir: h.projectDir,
        env: "staging",
        project: "acme",
        workers: [h.api([mail()])],
        remoteD1: ({ databaseId }: { databaseId: string }) => byId(databaseId),
      };
      await migrateProject(options);

      const runs = await migrateProject({
        ...options,
        rollback: true,
        confirmRollback: rollbackConfirmPhrase("staging"),
      });
      const kept = runs[0]?.databases.find((d) => d.binding === "EMAIL_SUPPRESSIONS");
      expect(kept?.results).toEqual([]);
      expect(kept?.boundBy).toEqual(["prod"]);
      expect(await ledgerOf(byId("global-suppressions"))).toEqual(["0100_email_0001_suppressions"]);
      expect(await rowsIn(byId("global-suppressions"), "pithy_email_suppressions")).toBe(0);

      // Named explicitly, it is refused rather than quietly skipped.
      const named = await refusal(
        migrateProject({
          ...options,
          binding: "EMAIL_SUPPRESSIONS",
          rollback: true,
          confirmRollback: rollbackConfirmPhrase("staging"),
        }),
      );
      expect(named.payload.message).toContain("prod");

      // And seed --redo's reset keeps it the same way.
      await migrateProject(options);
      const preview = await previewReset(options);
      expect(preview.find((entry) => entry.binding === "EMAIL_SUPPRESSIONS")?.boundBy).toEqual(["prod"]);
      await resetProject(options);
      expect(await ledgerOf(byId("global-suppressions"))).toEqual(["0100_email_0001_suppressions"]);
    } finally {
      await mf.dispose();
    }
  });

  test("a rollback outside dev needs its confirmation phrase", async () => {
    await writeStanzas();
    const { mf, byId } = await remotes();
    try {
      const options = {
        account: null,
        projectDir: h.projectDir,
        env: "staging",
        project: "acme",
        workers: [h.api([appCapability()])],
        remoteD1: ({ databaseId }: { databaseId: string }) => byId(databaseId),
      };
      await migrateProject(options);
      const refused = await refusal(migrateProject({ ...options, rollback: true }));
      expect(refused.payload.action).toContain(rollbackConfirmPhrase("staging"));
      expect(await ledgerOf(byId("staging-db"))).toEqual(["1000_app_0001_things"]);

      await refusal(migrateProject({ ...options, rollback: true, confirmRollback: rollbackConfirmPhrase("prod") }));
      await migrateProject({ ...options, rollback: true, confirmRollback: rollbackConfirmPhrase("staging") });
      expect(await ledgerOf(byId("staging-db"))).toEqual([]);
    } finally {
      await mf.dispose();
    }
  });
});

/**
 * **#596: the link-signing key is in none of the databases a rollback, a reset or a teardown reaches.**
 *
 * The guards above refuse to destroy the vault by accident. They cannot help once somebody agrees to — an
 * exact `--destroy-retained` count is permission — and on 2026-09-14 the thing that went with staging's vault
 * was the one secret whose loss outlives the system: the key that signed every link already in an inbox.
 *
 * So this proves the other half. A project composing the real `secrets()` and `email()` capabilities is seeded
 * the way `pithy seed` seeds it, and then each destructive act is run to completion — agreed, not refused —
 * and the key is asked for afterwards the way a Worker asks: from its binding, through `resolveSigningKeys`,
 * verifying a link minted before the act. A vault gone and a key intact is the whole assertion.
 *
 * **What it covers and what it does not.** Rollback and `seed --redo`'s reset run against the project's real
 * local D1. Deprovision runs the real `CloudflareSecretsDeprovisioner` against a stubbed account, so it proves
 * the teardown names no Secrets Store entry but its own master key and token — not what Cloudflare does.
 */
describe("the link-signing key survives the vault (#596)", () => {
  const h = migrateHarness();
  let config = "";
  const paths = (): StatePathOptions => ({
    platform: "linux",
    homedir: "/home/nobody",
    env: { PITHY_CONFIG_DIR: config },
  });

  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), "pithy-596-config-"));
    await mkdir(join(config, "acme"), { recursive: true, mode: 0o700 });
    await writeFile(join(h.projectDir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    // A Worker is a directory with a config; the `.dev.vars` generator writes only to those.
    await writeFile(join(h.projectDir, "apps", "api", "wrangler.jsonc"), '{ "name": "api" }\n');
  });
  afterEach(async () => {
    await rm(config, { recursive: true, force: true });
  });

  const mail = (): Capability => email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
  const composed = (): Capability[] => [vault(), mail(), appCapability()];
  const masterKey = devEncryptionKeys();
  const base = () => ({ account: null, projectDir: h.projectDir, env: "dev", project: "acme" });

  /** `pithy seed`'s dev-secrets half, against this project's real local `SECRETS` D1. */
  async function seed(): Promise<void> {
    await seedProjectDevSecrets({
      projectDir: h.projectDir,
      paths: paths(),
      targets: [
        { name: "api", dir: join(h.projectDir, "apps", "api"), registry: aggregateSecretRegistries(composed()) },
      ],
      openStore: async () => {
        const mf = new Miniflare({
          modules: true,
          script: "export default {};",
          d1Databases: { D: "SECRETS" },
          d1Persist: persistDir(h.projectDir),
        });
        const db = (await mf.getD1Database("D")) as unknown as D1Database;
        return {
          ready: true,
          store: await SystemSecretsStore.fromEnv({ SECRETS: db, SECRETS_ENCRYPTION_KEYS: masterKey }),
          persistPath: localDevStorePath(h.projectDir),
          dispose: () => mf.dispose(),
        };
      },
    });
  }

  /** What the Worker is handed for the key: its generated `.dev.vars`, the dev face of its Secrets Store binding. */
  async function bound(): Promise<string | undefined> {
    const text = await readFile(join(h.projectDir, "apps", "api", ".dev.vars"), "utf8").catch(() => "");
    return parseDevVars(text)[EMAIL_LINK_SIGNING_KEY];
  }

  /** Verify `token` the way the callback route does — the key resolved from its binding, the vault as it now is. */
  async function verifies(token: string, binding: string): Promise<boolean> {
    return withLocal(h.projectDir, "SECRETS", async (db) => {
      configureSharedSecrets({ registry: aggregateSecretRegistries(composed()) });
      try {
        const keys = await resolveSigningKeys({
          SECRETS: db,
          SECRETS_ENCRYPTION_KEYS: masterKey,
          [EMAIL_LINK_SIGNING_KEY]: binding,
        } as SecretsStoreEnv);
        await verifyToken(token, keys, new Date(), AUDIENCE);
        return true;
      } finally {
        resetSharedSecrets();
      }
    });
  }

  const AUDIENCE = "https://api.acme.test";

  /** A link minted now, under the key the Worker currently binds. */
  async function mintedUnder(binding: string): Promise<string> {
    const envelope = JSON.parse(binding) as { currentVersion: string; versions: Record<string, string> };
    return mintToken(
      { kind: "unsubscribe", jobId: "job-1", recipient: "u@example.com" },
      {
        key: envelope.versions[envelope.currentVersion] ?? "",
        kid: envelope.currentVersion,
        expiresAt: new Date(Date.now() + 86_400_000),
        audience: AUDIENCE,
      },
    );
  }

  test("seeded, the key is bound to the Worker and absent from the vault", async () => {
    await migrateProject({ ...base(), workers: [h.api(composed())] });
    await seed();
    expect(await bound()).toBeDefined();
    await withLocal(h.projectDir, "SECRETS", async (db) => {
      const row = await db
        .prepare("select name from pithy_secrets_system_secrets where name = ?")
        .bind(EMAIL_LINK_SIGNING_KEY)
        .first();
      expect(row).toBeNull();
    });
  });

  test("a rollback that destroys the vault leaves the key, and a link minted before it still verifies", async () => {
    const workers = [h.api(composed())];
    await migrateProject({ ...base(), workers });
    await seed();
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 3));
    const key = (await bound()) ?? "";
    const link = await mintedUnder(key);
    const held = (await withLocal(h.projectDir, "SECRETS", (db) => rowsIn(db, "pithy_secrets_system_secrets"))) ?? 0;

    await migrateProject({ ...base(), workers, rollback: true, destroyRetained: held });

    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBeNull(),
    );
    expect(await bound()).toBe(key);
    expect(await verifies(link, key)).toBe(true);
  });

  test("seed --redo, agreed, empties the vault and re-seeds without replacing the key", async () => {
    const workers = [h.api(composed())];
    await migrateProject({ ...base(), workers });
    await seed();
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 2));
    const key = (await bound()) ?? "";
    const link = await mintedUnder(key);
    const held = (await withLocal(h.projectDir, "SECRETS", (db) => rowsIn(db, "pithy_secrets_system_secrets"))) ?? 0;

    await resetProject({ ...base(), workers, destroyRetained: held });
    await withLocal(h.projectDir, "SECRETS", async (db) =>
      expect(await rowsIn(db, "pithy_secrets_system_secrets")).toBe(0),
    );
    await seed();

    expect(await bound()).toBe(key);
    expect(await verifies(link, key)).toBe(true);
  });

  test("a deprovision that deletes the vault and the master key leaves the key's Secrets Store entry", async () => {
    await migrateProject({ ...base(), workers: [h.api([vault()])] });
    await withLocal(h.projectDir, "SECRETS", (db) => storeSecrets(db, 2));

    const entry = environmentScope("acme", "staging").secretEntry(
      EMAIL_LINK_SIGNING_KEY,
      emailSigningRegistry[EMAIL_LINK_SIGNING_KEY].scope as SecretNameScope,
    );
    const store = new Map<string, string>([
      [masterKeySecretName("acme", "staging"), masterKey],
      [entry, storeEntryText({}, "the-staging-link-key")],
    ]);
    const databases = new Map([["acme-staging-secrets", "db-staging"]]);
    const mf = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { D: "SECRETS" },
      d1Persist: persistDir(h.projectDir),
    });
    try {
      const vaultDb = await mf.getD1Database("D");
      const cf = {
        secrets: () => ({
          exists: async (name: string) => store.has(name),
          deleteSecret: async (name: string) => void store.delete(name),
        }),
        accountTokens: () => ({ deleteTokensByName: async () => 0 }),
        d1Provisioner: () => ({
          findDatabaseByName: async (name: string) => {
            const uuid = databases.get(name);
            return uuid ? { uuid, name } : null;
          },
          deleteDatabase: async (uuid: string) => {
            for (const [name, id] of databases) if (id === uuid) databases.delete(name);
          },
        }),
        workers: () => ({ getWorker: async () => null, deleteWorker: async () => {} }),
        d1: () => vaultDb,
      } as unknown as CloudflareClients;

      await deprovisionSecrets(
        new CloudflareSecretsDeprovisioner({
          account: { accountId: "acct-1", confirmation: "pinned" },
          cf,
          project: "acme",
          storeId: "store-1",
          budget: new RetainedBudget(2),
        }),
        { environment: "staging", declared: ["staging", "prod"] },
        { deleteKeys: true, destroyRetained: 2 },
      );
    } finally {
      await mf.dispose();
    }

    expect(databases.size).toBe(0);
    expect(store.has(masterKeySecretName("acme", "staging"))).toBe(false);
    expect(store.get(entry)).toBe(storeEntryText({}, "the-staging-link-key"));
  });
});
