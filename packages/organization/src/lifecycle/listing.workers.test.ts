// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { Organization } from "../data/organization";
import { ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import { listOrganizations } from "./listing";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const MINUTE = 60_000;

const TABLES = [
  "pithy_organization_foundings",
  "pithy_organization_lifecycle",
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "pithy_migrations",
  "pithy_migrations_lock",
];

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "organization",
      order: ORGANIZATION_MIGRATION_ORDER,
      migrations: ORGANIZATION_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => organizationDatabase(env.DB);

let seeded = 0;

/** An organization created `ageMinutes` before `NOW`, its lifecycle columns as minutes relative to `NOW`, named by its slug. */
async function seed(
  slug: string,
  ageMinutes: number,
  lifecycle: { suspendedAt?: number; suspendedUntil?: number; deletedAt?: number } = {},
): Promise<void> {
  const created = new Date(NOW.getTime() - ageMinutes * MINUTE);
  const id = `00000000-0000-4000-8000-${String(++seeded).padStart(12, "0")}`;
  const at = (minutes: number | undefined) =>
    minutes === undefined ? null : new Date(NOW.getTime() + minutes * MINUTE);
  await db()
    .insertInto(ORGANIZATIONS_TABLE)
    .values(
      Organization.encode({
        id,
        name: slug,
        slug,
        logo: null,
        createdAt: created,
        updatedAt: created,
        suspendedAt: at(lifecycle.suspendedAt),
        suspendedUntil: at(lifecycle.suspendedUntil),
        deletedAt: at(lifecycle.deletedAt),
        purgeAfter: lifecycle.deletedAt === undefined ? null : at(lifecycle.deletedAt + 30 * 24 * 60),
      }),
    )
    .execute();
}

const ids = (page: { items: { slug: string }[] }) => page.items.map((organization) => organization.slug);

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  seeded = 0;
  await seed("active", 10);
  await seed("lapsed", 20, { suspendedAt: -60, suspendedUntil: -1 });
  await seed("edge", 25, { suspendedAt: -60, suspendedUntil: 0 });
  await seed("suspended", 30, { suspendedAt: -60 });
  await seed("timed", 40, { suspendedAt: -60, suspendedUntil: 60 });
  await seed("deleted", 50, { suspendedAt: -60, deletedAt: -30 });
});

describe("listOrganizations", () => {
  test("lists every organization newest first when nothing narrows it", async () => {
    expect(ids(await listOrganizations(db(), { now: NOW }))).toEqual([
      "active",
      "lapsed",
      "edge",
      "suspended",
      "timed",
      "deleted",
    ]);
  });

  test("state reads the columns as organizationStanding does: a suspension ends at its end, deleted outranks it", async () => {
    expect(ids(await listOrganizations(db(), { state: "active", now: NOW }))).toEqual(["active", "lapsed", "edge"]);
    expect(ids(await listOrganizations(db(), { state: "suspended", now: NOW }))).toEqual(["suspended", "timed"]);
    expect(ids(await listOrganizations(db(), { state: "deleted", now: NOW }))).toEqual(["deleted"]);
  });

  test("a narrowed listing pages on the cursor without repeating or skipping one", async () => {
    const first = await listOrganizations(db(), { state: "active", limit: 2, now: NOW });
    expect(ids(first)).toEqual(["active", "lapsed"]);
    const second = await listOrganizations(db(), {
      state: "active",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
      now: NOW,
    });
    expect(ids(second)).toEqual(["edge"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a malformed cursor is a first page, not an error", async () => {
    expect(ids(await listOrganizations(db(), { limit: 1, cursor: "garbage", now: NOW }))).toEqual(["active"]);
  });
});
