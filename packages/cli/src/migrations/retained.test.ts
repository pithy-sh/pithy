// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { dropMigrations, rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import type { Migration } from "kysely/migration";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "vitest";
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
    for (const reverse of [rollbackMigration, dropMigrations]) {
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
