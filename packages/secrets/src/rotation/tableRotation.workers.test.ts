// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { KyselyPlugin } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { EncryptionConfig } from "../crypto/envelope";
import { secretsTables } from "../data/tables";
import type { SecretsStoreEnv } from "../env/bindings";
import { secrets_0001_init } from "../migrations/0001_init";
import { secrets_0002_tables } from "../migrations/0002_tables";
import { defineSecretRegistry } from "../registry";
import { secretsStore } from "../secretsStore";
import { RotationTracker } from "../store/rotationTracker";
import { defineSecretTable } from "../tables/defineSecretTable";
import { secretTableMigration } from "../tables/migration";
import { StubConfigStore } from "../test-utils/stubConfigWriter";
import { runAtRestKeyRotation, type StepRunner } from "./atRestKeyRotation";
import { countOnKeyVersions, reencryptBatch } from "./keyRotation";
import { reencryptTableBatch, registeredSecretTables } from "./tableRotation";

/**
 * The at-rest rotation reaches every declared table — the property the whole design rests on. A table the
 * cron never visits is a set of rows that quietly cannot be opened after the prune, so it is proven here
 * against a real D1, not assumed.
 */

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const config: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": keyB64() },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

const envFor = (master: EncryptionConfig): SecretsStoreEnv =>
  ({ SECRETS: env.SECRETS, SECRETS_ENCRYPTION_KEYS: JSON.stringify(master) }) as unknown as SecretsStoreEnv;

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: {
    userId: z.string().describe("The user."),
    organizationId: z.string().describe("The organization."),
  },
  secrets: { STRIPE_KEY: { valueType: "text", rotatable: true } },
});

const ConnectionSecrets = defineSecretTable({
  name: "connection",
  keys: { installationId: z.string().describe("The installation.") },
  secrets: { SIGNING_KEY: { valueType: "text", rotatable: true } },
});

const registry = defineSecretRegistry({
  "app-signing-key": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
});

const syncStep: StepRunner = { do: (_name, fn) => fn(), sleep: async () => undefined };

const db = () => createDatabase(env.SECRETS, secretsTables);

async function migrate(table: "customer" | "connection"): Promise<void> {
  const keys = table === "customer" ? ["userId", "organizationId"] : ["installationId"];
  const secrets = table === "customer" ? ["STRIPE_KEY"] : ["SIGNING_KEY"];
  await secretTableMigration({ from: null, to: { table, keys, secrets } }).up(db());
}

async function keyVersions(table: string): Promise<number[]> {
  const rows = await env.SECRETS.prepare(`select key_version as v from ${table} order by id`).all<{ v: number }>();
  return rows.results.map((row) => row.v);
}

async function rotate(master: EncryptionConfig, at: string) {
  const store = new StubConfigStore({ bound: master });
  const result = await runAtRestKeyRotation(
    {
      db: db(),
      config: master,
      configWriter: store.writer,
      configReader: store.reader,
      tracker: RotationTracker.fromD1(env.SECRETS),
    },
    syncStep,
    { now: new Date(at), readBackDelayMs: 0 },
  );
  return { result, left: store.boundConfig };
}

beforeEach(async () => {
  for (const name of [
    "pithy_secrets_customer_secrets",
    "pithy_secrets_connection_secrets",
    "pithy_secrets_tables",
    "pithy_secrets_rotations",
    "pithy_secrets_system_secrets",
  ]) {
    await env.SECRETS.prepare(`drop table if exists ${name}`).run();
  }
  await secrets_0001_init.up(db());
  await secrets_0002_tables.up(db());
});

describe("at-rest rotation over declared tables", () => {
  test("re-encrypts every row in every registered table, not just the system table", async () => {
    await migrate("customer");
    await migrate("connection");
    const accessor = await secretsStore(envFor(config), registry);
    const customers = accessor.table(CustomerSecrets);
    for (let user = 0; user < 7; user++) {
      await customers.put(
        { userId: `u${user}`, organizationId: user < 4 ? "org_a" : "org_b" },
        "STRIPE_KEY",
        `sk_${user}`,
      );
    }
    await accessor.table(ConnectionSecrets).put({ installationId: "inst_1" }, "SIGNING_KEY", "signing-one");

    const { result, left } = await rotate(config, "2026-02-01T00:00:00.000Z");

    expect(result).toMatchObject({ rotated: 8, failed: 0, newCurrentVersion: 2 });
    expect(await keyVersions("pithy_secrets_customer_secrets")).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(await keyVersions("pithy_secrets_connection_secrets")).toEqual([2]);
    // And every row still opens, for its own owner, under the key set the rotation left bound.
    const after = await secretsStore(envFor(left), registry);
    expect(await after.table(CustomerSecrets).get({ userId: "u5", organizationId: "org_b" }, "STRIPE_KEY")).toBe(
      "sk_5",
    );
    expect(await after.table(ConnectionSecrets).get({ installationId: "inst_1" }, "SIGNING_KEY")).toBe("signing-one");
  });

  test("re-encrypts in batches that span tables, and stops when nothing is left", async () => {
    await migrate("customer");
    const customers = (await secretsStore(envFor(config), registry)).table(CustomerSecrets);
    for (let user = 0; user < 5; user++) {
      await customers.put({ userId: `u${user}`, organizationId: "org_a" }, "STRIPE_KEY", `sk_${user}`);
    }
    const promoted: EncryptionConfig = {
      ...config,
      currentVersion: "2",
      versions: { ...config.versions, "2": keyB64() },
    };
    expect(await reencryptBatch(db(), promoted, 2)).toEqual({ rotated: 2, failed: 0 });
    expect(await reencryptBatch(db(), promoted, 2)).toEqual({ rotated: 2, failed: 0 });
    expect(await reencryptBatch(db(), promoted, 2)).toEqual({ rotated: 1, failed: 0 });
    expect(await reencryptBatch(db(), promoted, 2)).toEqual({ rotated: 0, failed: 0 });
  });

  test("rows that never decrypt in one table do not starve the tables after it", async () => {
    await migrate("customer");
    await migrate("connection");
    // Two system rows and two customer rows that no key opens — each enough to fill a batch of two.
    await env.SECRETS.prepare(
      "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values ('broken-a', 'Y29ycnVwdA==', 'aXZpdml2aXZpdml2', 1, 'text', 1, 1), ('broken-b', 'Y29ycnVwdA==', 'aXZpdml2aXZpdml2', 1, 'text', 1, 1)",
    ).run();
    await env.SECRETS.prepare(
      "insert into pithy_secrets_customer_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at, user_id, organization_id) values ('STRIPE_KEY', 'Y29ycnVwdA==', 'aXZpdml2aXZpdml2', 1, 'text', 1, 1, 'u1', 'o1'), ('STRIPE_KEY', 'Y29ycnVwdA==', 'aXZpdml2aXZpdml2', 1, 'text', 1, 1, 'u2', 'o1')",
    ).run();
    const connections = (await secretsStore(envFor(config), registry)).table(ConnectionSecrets);
    for (let install = 0; install < 3; install++) {
      await connections.put({ installationId: `inst_${install}` }, "SIGNING_KEY", `signing-${install}`);
    }

    const store = new StubConfigStore({ bound: config });
    const result = await runAtRestKeyRotation(
      {
        db: db(),
        config,
        configWriter: store.writer,
        configReader: store.reader,
        tracker: RotationTracker.fromD1(env.SECRETS),
      },
      syncStep,
      { now: new Date("2026-02-01T00:00:00.000Z"), readBackDelayMs: 0, batchSize: 2 },
    );

    expect(result).toMatchObject({ rotated: 3, newCurrentVersion: 2 });
    expect(await keyVersions("pithy_secrets_connection_secrets")).toEqual([2, 2, 2]);
    const after = await secretsStore(envFor(store.boundConfig), registry);
    expect(await after.table(ConnectionSecrets).get({ installationId: "inst_2" }, "SIGNING_KEY")).toBe("signing-2");
  });

  test("a table registered after the manager was deployed rotates on the next run, with no re-provision", async () => {
    // The first pass runs before any table exists — the manager as deployed, knowing nothing of it.
    const first = await rotate(config, "2026-02-01T00:00:00.000Z");
    expect(first.result.rotated).toBe(0);

    await migrate("customer");
    const customers = (await secretsStore(envFor(first.left), registry)).table(CustomerSecrets);
    await customers.put({ userId: "u1", organizationId: "org_a" }, "STRIPE_KEY", "sk_1");
    expect(await keyVersions("pithy_secrets_customer_secrets")).toEqual([2]);

    const second = await rotate(first.left, "2026-03-01T00:00:00.000Z");
    expect(second.result).toMatchObject({ rotated: 1, failed: 0, newCurrentVersion: 3 });
    expect(await keyVersions("pithy_secrets_customer_secrets")).toEqual([3]);
  });

  test("the prune gate counts declared rows, so a key a table row still needs is never retired", async () => {
    await migrate("customer");
    const customers = (await secretsStore(envFor(config), registry)).table(CustomerSecrets);
    await customers.put({ userId: "u1", organizationId: "org_a" }, "STRIPE_KEY", "sk_1");
    expect(await countOnKeyVersions(db(), ["1"])).toBe(1);
    expect(await countOnKeyVersions(db(), ["2"])).toBe(0);
  });

  test("a row written between the batch's read and its update keeps the write — the stale copy is dropped", async () => {
    await migrate("customer");
    const owner = { userId: "u1", organizationId: "org_a" };
    await (await secretsStore(envFor(config), registry)).table(CustomerSecrets).put(owner, "STRIPE_KEY", "sk_old");
    const promoted: EncryptionConfig = {
      ...config,
      currentVersion: "2",
      versions: { ...config.versions, "2": keyB64() },
    };
    // A request replaces the value after the batch selected the row and before it writes the re-encryption.
    let fired = false;
    const writeBetween: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        if (!fired) {
          fired = true;
          await (await secretsStore(envFor(config), registry))
            .table(CustomerSecrets)
            .put(owner, "STRIPE_KEY", "sk_new", { replace: true });
        }
        return args.result;
      },
    };
    const [customer] = await registeredSecretTables(db());
    if (!customer) throw new Error("expected the customer table to be registered");
    expect(await reencryptTableBatch(db().withPlugin(writeBetween), promoted, customer, 10)).toEqual({
      rotated: 0,
      failed: 0,
    });
    expect(await (await secretsStore(envFor(promoted), registry)).table(CustomerSecrets).get(owner, "STRIPE_KEY")).toBe(
      "sk_new",
    );
    // Left on the key it was written under, for the next batch to move.
    expect(await keyVersions("pithy_secrets_customer_secrets")).toEqual([1]);
    expect(await reencryptTableBatch(db(), promoted, customer, 10)).toEqual({ rotated: 1, failed: 0 });
  });

  test("a store with no registry table yet rotates as it always did", async () => {
    await env.SECRETS.prepare("drop table pithy_secrets_tables").run();
    expect(await registeredSecretTables(db())).toEqual([]);
    expect((await rotate(config, "2026-02-01T00:00:00.000Z")).result).toMatchObject({ rotated: 0, failed: 0 });
  });

  test("a registration naming something that is not a legal table or key is skipped, never interpolated", async () => {
    await env.SECRETS.prepare(
      "insert into pithy_secrets_tables (name, keys, secrets, created_at, updated_at) values ('x; drop table pithy_secrets_system_secrets', '[\"userId\"]', '[]', 1, 1), ('ok', '[\"user id\"]', '[]', 1, 1)",
    ).run();
    expect(await registeredSecretTables(db())).toEqual([]);
  });
});
