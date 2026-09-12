// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { ORGANIZATION_MIGRATION_ORDER, organization_0001_init } from "./0001_init";

/**
 * The one migration, both ways, against real D1.
 *
 * **`down` had no caller at all until this file existed**, which is the failure mode `CLAUDE.md` names
 * outright: every migration's `up` **and** `down` is tested. Every suite in this package builds its
 * schema through `up` and tears it down with `drop table if exists`, so the `down` was dead code with an
 * argued comment on it — and an argued comment nothing runs is the shape a claim takes just before it
 * stops being true.
 */

/** `createDatabase(env.DB, {})` — the empty map is the idiom for handing a migration an untyped Kysely. */
const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

/**
 * Every object the migration creates, in `sqlite_master` name order — five tables and six indexes.
 *
 * Written out rather than counted. An index a read was planned around is part of that read's contract:
 * the gate's `(userId, organizationId)`, the administrator count's `(organizationId, role)`, and the
 * partial unique index that makes one-live-offer-per-address a property of storage rather than of
 * whoever writes the handler. Losing one silently is exactly what a count would permit.
 *
 * **The three `addUniqueConstraint` names are deliberately absent, and that is SQLite's doing rather
 * than an omission.** A named unique constraint in `CREATE TABLE` becomes an auto-index SQLite names
 * `sqlite_autoindex_<table>_<n>` — the name in the DDL is not carried into `sqlite_master` at all — so
 * the slug, the `(organizationId, userId)` pair and the token digest are enforced under names this
 * prefix query cannot see. `uniqueness` below asserts them by behavior instead, which is the only way
 * to assert them at all.
 */
const EXPECTED_CATALOG = [
  "pithy_organization_acting",
  "pithy_organization_acting_org_idx",
  "pithy_organization_invitations",
  "pithy_organization_invitations_one_live_idx",
  "pithy_organization_invitations_org_status_idx",
  "pithy_organization_memberships",
  "pithy_organization_memberships_org_role_idx",
  "pithy_organization_memberships_user_idx",
  "pithy_organization_organizations",
  "pithy_organization_ownership_nominations",
  "pithy_organization_ownership_nominations_membership_idx",
];

/** Every object SQLite knows under this capability's prefix. Proves the prefix rather than trusting it. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_organization_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

beforeEach(async () => {
  for (const name of EXPECTED_CATALOG) {
    await env.DB.prepare(`drop table if exists ${name}`).run();
  }
});

describe("up", () => {
  test("creates every table and index, and nothing outside the prefix", async () => {
    await organization_0001_init.up(db());
    expect(await catalog()).toEqual(EXPECTED_CATALOG);
  });

  test("the order it sorts at is the one the CLI allocated", () => {
    // Stable forever: renumbering renames the composed key (`1400_organization_0001_init`), which makes
    // Kysely treat an applied migration as unapplied and re-run it.
    expect(ORGANIZATION_MIGRATION_ORDER).toBe(1400);
  });
});

describe("down", () => {
  test("takes every object back out", async () => {
    await organization_0001_init.up(db());
    await organization_0001_init.down?.(db());
    expect(await catalog()).toEqual([]);
  });

  test("drops children before the table they name", async () => {
    // The argued property, asserted rather than asserted-in-a-comment. A partial `down` on a database D1
    // cannot roll back must leave nothing pointing at a table that is already gone — so the acting rows
    // and the nominations go before the organizations and memberships they reference.
    const dropped: string[] = [];
    const recording = {
      schema: {
        dropTable(name: string) {
          dropped.push(name);
          return { ifExists: () => ({ execute: async () => {} }) };
        },
      },
    } as unknown as Kysely<unknown>;
    await organization_0001_init.down?.(recording);

    expect(dropped).toEqual([
      "pithyOrganizationActing",
      "pithyOrganizationOwnershipNominations",
      "pithyOrganizationInvitations",
      "pithyOrganizationMemberships",
      "pithyOrganizationOrganizations",
    ]);
  });

  test("is idempotent, so a partial rollback can be finished", async () => {
    await organization_0001_init.up(db());
    await organization_0001_init.down?.(db());
    await expect(organization_0001_init.down?.(db())).resolves.not.toThrow();
  });

  test("up after down is clean, which is what makes a rollback recoverable", async () => {
    await organization_0001_init.up(db());
    await organization_0001_init.down?.(db());
    await organization_0001_init.up(db());
    expect(await catalog()).toEqual(EXPECTED_CATALOG);
  });
});

describe("the constraints SQLite hides", () => {
  /*
    Three uniques are declared in `CREATE TABLE` and therefore live under `sqlite_autoindex_*` names the
    catalog check above cannot see. Each is load-bearing, and each is asserted by trying to break it.
  */

  beforeEach(async () => {
    await organization_0001_init.up(db());
  });

  test("a slug addresses one account", async () => {
    const insert = (id: string, slug: string) =>
      env.DB.prepare(
        "insert into pithy_organization_organizations (id, name, slug, logo, created_at, updated_at) values (?, ?, ?, null, 0, 0)",
      )
        .bind(id, "Acme", slug)
        .run();
    await insert("11111111-1111-4111-8111-111111111111", "acme");
    await expect(insert("22222222-2222-4222-8222-222222222222", "acme")).rejects.toThrow();
  });

  test("one membership per person per organization", async () => {
    // What makes a second invitation to somebody already inside an idempotent no-op at the storage layer
    // rather than only in the handler. Two rows would make "what may they do here" a question with two
    // answers.
    const insert = (id: string) =>
      env.DB.prepare(
        "insert into pithy_organization_memberships (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, 0)",
      )
        .bind(id, "org-1", "user-ada", "member")
        .run();
    await insert("33333333-3333-4333-8333-333333333333");
    await expect(insert("44444444-4444-4444-8444-444444444444")).rejects.toThrow();
  });

  test("a token digest is unique across every organization, not within one", async () => {
    // The digest is the whole credential. A collision across accounts would let one person's link redeem
    // another's offer, which is why the constraint is not scoped to the organization.
    const insert = (id: string, organizationId: string) =>
      env.DB.prepare(
        "insert into pithy_organization_invitations (id, organization_id, email, role, invited_by_user_id, token_digest, status, expires_at, accepted_at, created_at) values (?, ?, ?, 'member', 'user-inviter', 'the-same-digest', 'accepted', 0, null, 0)",
      )
        .bind(id, organizationId, `${id}@example.com`)
        .run();
    await insert("55555555-5555-4555-8555-555555555555", "org-1");
    await expect(insert("66666666-6666-4666-8666-666666666666", "org-2")).rejects.toThrow();
  });
});
