// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields, type PurgeContext } from "@pithy-sh/core/src/capability/purge";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { organization } from "../capability";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import { defineRoles } from "../roles/roles";
import { ORGANIZATION_USER_PURGE_SUMMARY, organizationUserPurge } from "./contribution";

/**
 * This capability's part of a person's purge and export (#814), over real D1 migrated by its own set: their
 * memberships, selections, ownership offers and the invitations addressed to them are exported — never an
 * invitation's token digest — and then erased, and nobody else's row is touched.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const GAMMA = "33333333-3333-4333-8333-333333333333";
const ADA_IN_ACME = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB_IN_ACME = "bbbbbbbb-0000-4000-8000-000000000002";
const ADA_IN_BETA = "aaaaaaaa-0000-4000-8000-000000000003";
const SESSION = "cccccccc-0000-4000-8000-000000000004";
const DAN_IN_GAMMA = "dddddddd-0000-4000-8000-000000000007";
const T = 1_700_000_000_000;

const TABLES = [
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

const purge = organizationUserPurge("DB");
const context = (address: string | null): PurgeContext => ({
  subject: { type: "user", id: "ada" },
  env: { DB: env.DB },
  address: async () => address,
});

async function exportOf(input: PurgeContext): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

async function run(statement: string, ...values: unknown[]): Promise<void> {
  await env.DB.prepare(statement)
    .bind(...values)
    .run();
}

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n ?? 0;
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  for (const [id, slug] of [
    [ACME, "acme"],
    [BETA, "beta"],
    [GAMMA, "gamma"],
  ] as const) {
    await run(
      "insert into pithy_organization_organizations (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)",
      id,
      slug.toUpperCase(),
      slug,
      T,
      T,
    );
  }
  const member =
    "insert into pithy_organization_memberships (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)";
  await run(member, ADA_IN_ACME, ACME, "ada", "owner", T);
  await run(member, BOB_IN_ACME, ACME, "bob", "member", T);
  await run(member, ADA_IN_BETA, BETA, "ada", "member", T + 1);
  await run(member, DAN_IN_GAMMA, GAMMA, "dan", "member", T);
  await run(
    "insert into pithy_organization_acting (session_id, user_id, organization_id, chosen, chosen_at) values (?, 'ada', ?, 1, ?)",
    SESSION,
    ACME,
    T,
  );
  // Ada offered Acme's ownership to Bob, Beta offered its ownership to Ada, and Gamma's offer to Dan is not hers.
  const offer =
    "insert into pithy_organization_ownership_nominations (organization_id, membership_id, nominated_by_user_id, expires_at, created_at) values (?, ?, ?, ?, ?)";
  await run(offer, ACME, BOB_IN_ACME, "ada", T + 1e9, T);
  await run(offer, BETA, ADA_IN_BETA, "cy", T + 1e9, T);
  await run(offer, GAMMA, DAN_IN_GAMMA, "cy", T + 1e9, T);
  const invite =
    "insert into pithy_organization_invitations (id, organization_id, email, role, invited_by_user_id, token_digest, status, expires_at, created_at) values (?, ?, ?, 'member', ?, ?, 'pending', ?, ?)";
  await run(
    invite,
    "dddddddd-0000-4000-8000-000000000005",
    BETA,
    "ada@example.test",
    "cy",
    "digest-to-ada",
    T + 1e9,
    T,
  );
  await run(
    invite,
    "eeeeeeee-0000-4000-8000-000000000006",
    ACME,
    "dan@example.test",
    "ada",
    "digest-to-dan",
    T + 1e9,
    T,
  );
});

describe("the organization user purge", () => {
  test("organization() declares it for the user subject beside the organization's own, with an export", () => {
    const roles = defineRoles({
      roles: {
        owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
      },
      administrativePower: "organization:manage",
    });
    const declared =
      organization({ roles, baseUrl: "https://app.example.test", sendInvitationEmail: false }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["organization", "user"]);
    expect(declared[1]?.summary).toBe(ORGANIZATION_USER_PURGE_SUMMARY);
    expect(typeof declared[1]?.export).toBe("function");
  });

  test("exports the person's memberships, selections, offers and invitations, and never a token digest", async () => {
    const data = await exportOf(context("Ada@Example.test"));
    expect(data.memberships).toEqual([
      expect.objectContaining({ id: ADA_IN_ACME, organizationId: ACME, role: "owner", organizationName: "ACME" }),
      expect.objectContaining({ id: ADA_IN_BETA, organizationId: BETA, role: "member", organizationSlug: "beta" }),
    ]);
    expect(data.selections).toEqual([expect.objectContaining({ sessionId: SESSION, organizationId: ACME })]);
    expect((data.ownershipOffers as unknown[]).length).toBe(2);
    expect(data.invitations).toEqual([expect.objectContaining({ email: "ada@example.test", organizationId: BETA })]);
    expect(credentialFields(data)).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("digest-to");
  });

  test("erases them, and leaves Bob's and Dan's memberships, Gamma's offer to Dan and the invitation Ada sent Dan", async () => {
    await purge.erase(context("ada@example.test"));
    expect(await exportOf(context("ada@example.test"))).toEqual({
      memberships: [],
      selections: [],
      ownershipOffers: [],
      invitations: [],
    });
    expect(await count("pithy_organization_memberships")).toBe(2);
    expect(await count("pithy_organization_invitations")).toBe(1);
    expect(await count("pithy_organization_organizations")).toBe(3);
    // The export cannot see an offer made to her once her memberships are gone, so read what is left directly:
    // the offer she made and the one made to her are gone, and Gamma's offer to Dan stays.
    const offers = await env.DB.prepare(
      "select organization_id from pithy_organization_ownership_nominations order by organization_id",
    ).all<{ organization_id: string }>();
    expect(offers.results.map((row) => row.organization_id)).toEqual([GAMMA]);
  });

  test("with no address to read, the invitations addressed to them are not reachable, and the rest still goes", async () => {
    await purge.erase(context(null));
    expect(await count("pithy_organization_memberships")).toBe(2);
    expect(await count("pithy_organization_invitations")).toBe(2);
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada@example.test"));
    await expect(purge.erase(context("ada@example.test"))).resolves.toBeUndefined();
  });
});
