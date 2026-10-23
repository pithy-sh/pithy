// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { Organization } from "../data/organization";
import { ACTING_TABLE, LIFECYCLE_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import type { OrganizationLifecycleHookEvent } from "./hooks";
import {
  completeOrganizationPurge,
  dueOrganizationPurges,
  type OrganizationLifecycleDeps,
  organizationPurgeSubject,
  recordOrganizationPurgeStep,
  reinstateOrganization,
  removeOrganization,
  restoreOrganization,
  suspendOrganization,
} from "./transitions";

/**
 * The organization transitions (#623), against real D1: each moves the columns and writes its history row in one
 * batch, says whether it moved anything, and fires its hook once per transition that happened.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const OPERATOR = { type: "control-plane", id: "operator-1" } as const;
const RESTORE = `POST /organizations/admin/organizations/${ACME}/restore`;

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

const db = () => organizationDatabase(env.DB);
let fired: { name: string; event: OrganizationLifecycleHookEvent }[] = [];

function deps(at: Date = NOW, hooks: OrganizationLifecycleDeps["hooks"] | null = null): OrganizationLifecycleDeps {
  return {
    db: db(),
    d1: env.DB,
    hooks: hooks ?? {
      onOrganizationSuspended: (event) => void fired.push({ name: "suspended", event }),
      onOrganizationReinstated: (event) => void fired.push({ name: "reinstated", event }),
      onOrganizationDeleted: (event) => void fired.push({ name: "deleted", event }),
      onOrganizationPurged: (event) => void fired.push({ name: "purged", event }),
    },
    now: () => at,
  };
}

async function history(organizationId = ACME): Promise<{ action: string; reason: string | null }[]> {
  return db()
    .selectFrom(LIFECYCLE_TABLE)
    .select(["action", "reason"])
    .where("organizationId", "=", organizationId)
    .orderBy("id", "asc")
    .execute();
}

async function columns(organizationId = ACME) {
  return db()
    .selectFrom(ORGANIZATIONS_TABLE)
    .select(["suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"])
    .where("id", "=", organizationId)
    .executeTakeFirstOrThrow();
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  for (const [id, slug] of [
    [ACME, "acme"],
    [BETA, "beta"],
  ] as const) {
    await db()
      .insertInto(ORGANIZATIONS_TABLE)
      .values(Organization.encode({ id, name: slug, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
      .execute();
  }
  fired = [];
});

describe("suspendOrganization", () => {
  test("moves the columns and writes the history row together, and fires once", async () => {
    const result = await suspendOrganization(deps(), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "r1",
      restoreRoute: RESTORE,
    });
    expect(result).toEqual({ changed: true, updated: false, suspendedAt: NOW, suspendedUntil: null });
    expect(await columns()).toMatchObject({ suspendedAt: NOW.getTime(), suspendedUntil: null });
    expect(await history()).toEqual([{ action: "suspended", reason: "r1" }]);
    expect(fired.map((hook) => hook.name)).toEqual(["suspended"]);
    expect(fired[0]?.event).toMatchObject({ organizationId: ACME, actor: OPERATOR, reason: "r1", at: NOW });
  });

  test("two at once: exactly one transitions, and the other restates it", async () => {
    const settled = await Promise.allSettled([
      suspendOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "a", restoreRoute: RESTORE }),
      suspendOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "b", restoreRoute: RESTORE }),
    ]);
    // The other restates it, or — when it read the organization before the first landed — is told to send again.
    expect(settled.filter((result) => result.status === "fulfilled" && result.value.changed)).toHaveLength(1);
    expect(fired).toHaveLength(1);
  });

  test("a suspension past its end is replaced by a new one, which is a transition", async () => {
    await suspendOrganization(deps(), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "short",
      until: new Date(NOW.getTime() + DAY),
      restoreRoute: RESTORE,
    });
    const later = new Date(NOW.getTime() + 2 * DAY);
    const result = await suspendOrganization(deps(later), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "again",
      restoreRoute: RESTORE,
    });
    expect(result).toMatchObject({ changed: true, suspendedAt: later, suspendedUntil: null });
  });

  test("a deleted organization is a conflict naming the restore route", async () => {
    await removeOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "gone", purgeAfterDays: 30 });
    await expect(
      suspendOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "x", restoreRoute: RESTORE }),
    ).rejects.toMatchObject({ payload: { code: "core/conflict", message: expect.stringContaining(RESTORE) } });
  });

  test("a throwing hook is swallowed, and the suspension stands", async () => {
    const result = await suspendOrganization(
      deps(NOW, {
        onOrganizationSuspended: () => {
          throw new Error("adopter bug");
        },
      }),
      { organizationId: ACME, actor: OPERATOR, reason: "r", restoreRoute: RESTORE },
    );
    expect(result.changed).toBe(true);
    expect((await columns()).suspendedAt).toBe(NOW.getTime());
  });
});

describe("reinstateOrganization", () => {
  test("lifts a suspension in force, once", async () => {
    await suspendOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "r", restoreRoute: RESTORE });
    expect(
      await reinstateOrganization(deps(), {
        organizationId: ACME,
        actor: OPERATOR,
        reason: "ok",
        restoreRoute: RESTORE,
      }),
    ).toEqual({
      changed: true,
    });
    expect(
      await reinstateOrganization(deps(), {
        organizationId: ACME,
        actor: OPERATOR,
        reason: "ok",
        restoreRoute: RESTORE,
      }),
    ).toEqual({
      changed: false,
    });
    expect(await columns()).toMatchObject({ suspendedAt: null, suspendedUntil: null });
    expect(fired.map((hook) => hook.name)).toEqual(["suspended", "reinstated"]);
  });

  test("a suspension that ran out is no suspension to lift", async () => {
    await suspendOrganization(deps(), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "r",
      until: new Date(NOW.getTime() + DAY),
      restoreRoute: RESTORE,
    });
    const later = deps(new Date(NOW.getTime() + 2 * DAY));
    expect(
      await reinstateOrganization(later, {
        organizationId: ACME,
        actor: OPERATOR,
        reason: "ok",
        restoreRoute: RESTORE,
      }),
    ).toEqual({
      changed: false,
    });
  });
});

describe("removeOrganization", () => {
  test("a soft deletion opens the window, clears every selection of it, and leaves its other rows", async () => {
    await env.DB.prepare(
      "insert into pithy_organization_acting (session_id, user_id, organization_id, chosen, chosen_at) values ('s1', 'u1', ?, 1, 0), ('s2', 'u2', ?, 1, 0)",
    )
      .bind(ACME, BETA)
      .run();
    const result = await removeOrganization(deps(), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "r",
      purgeAfterDays: 30,
    });
    expect(result).toEqual({ outcome: "deleted", deletedAt: NOW, purgeAfter: new Date(NOW.getTime() + 30 * DAY) });
    const acting = await db().selectFrom(ACTING_TABLE).select("organizationId").execute();
    expect(acting).toEqual([{ organizationId: BETA }]);
    expect(fired.map((hook) => [hook.name, hook.event.purgeAfter])).toEqual([["deleted", result.purgeAfter]]);
  });

  test("a hard deletion purges now; a second hard one is unchanged once its window has closed", async () => {
    const result = await removeOrganization(deps(), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "r",
      mode: "hard",
      purgeAfterDays: 30,
    });
    expect(result.purgeAfter).toEqual(NOW);
    const again = await removeOrganization(deps(), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "r",
      mode: "hard",
      purgeAfterDays: 30,
    });
    expect(again.outcome).toBe("unchanged");
    expect(fired).toHaveLength(1);
  });

  test("an unknown organization is the organization 404", async () => {
    await expect(
      removeOrganization(deps(), {
        organizationId: "99999999-9999-4999-8999-999999999999",
        actor: OPERATOR,
        reason: "r",
        purgeAfterDays: 30,
      }),
    ).rejects.toMatchObject({ payload: { code: "organization/not_found", status: 404 } });
  });
});

describe("restoreOrganization", () => {
  test("inside the window clears the deletion; outside it is a conflict", async () => {
    await removeOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "r", purgeAfterDays: 1 });
    await expect(
      restoreOrganization(deps(new Date(NOW.getTime() + 2 * DAY)), {
        organizationId: ACME,
        actor: OPERATOR,
        reason: "x",
      }),
    ).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    expect(await restoreOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "back" })).toEqual({
      changed: true,
      state: "active",
    });
    expect(await columns()).toMatchObject({ deletedAt: null, purgeAfter: null });
    expect((await history()).map((row) => row.action)).toEqual(["deleted", "restored"]);
  });

  test("an organization that is not deleted is no transition", async () => {
    expect(await restoreOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "x" })).toEqual({
      changed: false,
      state: "active",
    });
  });
});

describe("the purge's own records", () => {
  test("due only once deleted and past the window; gone once the row is", async () => {
    expect(await organizationPurgeSubject(deps(), ACME)).toBe("not_due");
    await removeOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "r", purgeAfterDays: 1 });
    expect(await organizationPurgeSubject(deps(), ACME)).toBe("not_due");
    const later = deps(new Date(NOW.getTime() + 2 * DAY));
    expect(await organizationPurgeSubject(later, ACME)).toBe("due");
    expect(await dueOrganizationPurges(later, 10)).toEqual([{ organizationId: ACME, deletedAt: NOW.getTime() }]);
    expect(await dueOrganizationPurges(deps(), 10)).toEqual([]);
    await env.DB.prepare("delete from pithy_organization_organizations where id = ?").bind(ACME).run();
    expect(await organizationPurgeSubject(later, ACME)).toBe("gone");
  });

  test("a step is recorded with its summary, and the purge completes once however often it is asked", async () => {
    await recordOrganizationPurgeStep(deps(), { organizationId: ACME, step: "media", summary: "Deletes media." });
    expect(await completeOrganizationPurge(deps(), { organizationId: ACME })).toEqual({ changed: true });
    expect(await completeOrganizationPurge(deps(), { organizationId: ACME })).toEqual({ changed: false });
    expect(await history()).toEqual([
      { action: "purge_step", reason: "Deletes media." },
      { action: "purged", reason: null },
    ]);
    expect(fired.map((hook) => hook.name)).toEqual(["purged"]);
  });
});
