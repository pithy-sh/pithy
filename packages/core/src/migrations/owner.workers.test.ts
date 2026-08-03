// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Migration } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { claimMigrationOwnership, readMigrationOwner } from "./owner";
import { createMigrationRegistry } from "./registry";
import { resetMigrations, rollbackMigration, runMigrations } from "./runner";

const createThings: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("things")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .execute();
  },
  down: async (db) => {
    await db.schema.dropTable("things").execute();
  },
};

/** The one provider the ownership suite migrates with — enough to prove the stamp outlives a reset. */
function provider() {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "app", order: 0, migrations: { "0001_things": createThings } },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("select name from sqlite_master where type = 'table' and name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

beforeEach(async () => {
  for (const table of ["things", "pithy_migrations", "pithy_migrations_lock", "pithy_migrations_owner"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("readMigrationOwner", () => {
  test("an unstamped database has no owner — and reading one creates nothing", async () => {
    expect(await readMigrationOwner(env.DB)).toBeUndefined();
    expect(await tableExists("pithy_migrations_owner")).toBe(false);
  });
});

describe("claimMigrationOwnership", () => {
  test("adopts an unstamped database, recording the project and when it was stamped", async () => {
    const before = Date.now();
    const claim = await claimMigrationOwnership(env.DB, { project: "acme" });

    expect(claim.outcome).toBe("adopted");
    expect(claim.project).toBe("acme");
    expect(claim.stampedAt.getTime()).toBeGreaterThanOrEqual(before);

    const owner = await readMigrationOwner(env.DB);
    expect(owner?.project).toBe("acme");
    expect(owner?.stampedAt).toBeInstanceOf(Date);
  });

  test("is idempotent — the same project re-claims without restamping", async () => {
    const first = await claimMigrationOwnership(env.DB, { project: "acme" });
    const second = await claimMigrationOwnership(env.DB, { project: "acme" });

    expect(second.outcome).toBe("confirmed");
    expect(second.project).toBe("acme");
    expect(second.stampedAt.getTime()).toBe(first.stampedAt.getTime());
  });

  test("refuses another project, naming both and telling the operator what to do", async () => {
    await claimMigrationOwnership(env.DB, { project: "acme" });

    const failure = await claimMigrationOwnership(env.DB, { project: "beta", binding: "DB" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PithyError);
    const payload = (failure as PithyError).payload;
    expect(payload.code).toBe("core/conflict");
    // Both names in the problem line: which project owns it, and which one asked.
    expect(payload.message).toContain("acme");
    expect(payload.message).toContain("beta");
    expect(payload.message).toContain("DB");
    expect(payload.action).toMatch(/acme|beta/);

    // The recorded owner is untouched — a refusal never restamps.
    expect((await readMigrationOwner(env.DB))?.project).toBe("acme");
  });

  test("names the database generically when no binding is given", async () => {
    await claimMigrationOwnership(env.DB, { project: "acme" });
    const failure = await claimMigrationOwnership(env.DB, { project: "beta" }).catch((error: unknown) => error);
    expect((failure as PithyError).payload.message).toMatch(/^This database belongs to project "acme", not "beta"\./);
  });

  test("refuses a blank project rather than stamping an empty owner", async () => {
    const failure = await claimMigrationOwnership(env.DB, { project: "  " }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.code).toBe("validation/invalid_input");
    expect(await tableExists("pithy_migrations_owner")).toBe(false);
  });

  test("the stamp outlives a rollback and a full reset — it is bookkeeping, not a migration", async () => {
    await claimMigrationOwnership(env.DB, { project: "acme" });
    await runMigrations(env.DB, provider());

    await rollbackMigration(env.DB, provider());
    expect((await readMigrationOwner(env.DB))?.project).toBe("acme");

    await resetMigrations(env.DB, provider());
    expect((await readMigrationOwner(env.DB))?.project).toBe("acme");
  });
});
