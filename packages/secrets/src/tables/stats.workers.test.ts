// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { secrets_0002_tables } from "../migrations/0002_tables";
import { secretTableMigration } from "./migration";
import { secretTableStats } from "./stats";

const db = () => createDatabase(env.SECRETS, secretsTables);

async function row(table: string, name: string, keyVersion: number, owner: Record<string, string>): Promise<void> {
  const columns = Object.keys(owner).map((key) => key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`));
  await env.SECRETS.prepare(
    `insert into ${table} (name, encrypted_value, iv, key_version, value_type, created_at, updated_at, ${columns.join(", ")}) values (?, 'c', 'i', ?, 'text', 1, 1, ${columns.map(() => "?").join(", ")})`,
  )
    .bind(name, keyVersion, ...Object.values(owner))
    .run();
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

describe("secretTableStats", () => {
  test("counts each registered table's rows per secret name and key version, and never reads a value", async () => {
    await secretTableMigration({
      from: null,
      to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY", "WEBHOOK_SIG"] },
    }).up(db());
    await secretTableMigration({
      from: null,
      to: { table: "connection", keys: ["installationId"], secrets: ["SIGNING_KEY"] },
    }).up(db());
    for (let user = 0; user < 3; user++) {
      await row("pithy_secrets_customer_secrets", "STRIPE_KEY", 4, { userId: `u${user}`, organizationId: "o" });
    }
    await row("pithy_secrets_customer_secrets", "STRIPE_KEY", 3, { userId: "u9", organizationId: "o" });
    await row("pithy_secrets_connection_secrets", "SIGNING_KEY", 4, { installationId: "i1" });
    await env.SECRETS.prepare(
      "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values ('x', 'c', 'i', 4, 'text', 1, 1)",
    ).run();

    expect(await secretTableStats(db())).toEqual({
      newestKeyVersion: 4,
      tables: [
        {
          table: "connection",
          keys: ["installationId"],
          secrets: [{ name: "SIGNING_KEY", rows: 1, keyVersions: { "4": 1 } }],
        },
        {
          table: "customer",
          keys: ["userId", "organizationId"],
          secrets: [
            { name: "STRIPE_KEY", rows: 4, keyVersions: { "3": 1, "4": 3 } },
            { name: "WEBHOOK_SIG", rows: 0, keyVersions: {} },
          ],
        },
      ],
    });
  });

  test("an empty vault has no newest version, and a vault before the registry has no tables", async () => {
    expect(await secretTableStats(db())).toEqual({ newestKeyVersion: null, tables: [] });
    await env.SECRETS.prepare("drop table pithy_secrets_tables").run();
    expect(await secretTableStats(db())).toEqual({ newestKeyVersion: null, tables: [] });
  });
});
