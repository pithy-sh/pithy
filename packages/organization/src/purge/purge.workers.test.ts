// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { forgetComposition, recordComposition } from "@pithy-sh/core/src/capability/composition";
import type { PurgeStep } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { WorkflowStepLike } from "@pithy-sh/core/src/workflow/faults";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { organization } from "../capability";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { LIFECYCLE_TABLE, MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { organizationErasureReader } from "../lifecycle/erasure";
import { removeOrganization } from "../lifecycle/transitions";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import type { OrganizationDeleteSweep } from "../provision/provision";
import { defineRoles } from "../roles/roles";
import { ORGANIZATION_PURGE_SUMMARY, organizationPurgeContribution } from "./contribution";
import { organizationPurgeOps, purgeOrganization } from "./run";
import { ORGANIZATION_PURGE_BINDING } from "./specs";
import { organizationPurgeInstanceId } from "./start";
import { purgeAudit, runOrganizationPurge, runOrganizationPurgeDue } from "./workflow";

/**
 * The organization purge end to end over real D1 (#623): this capability's contribution, the adopter's sweep in
 * its batch, another capability's contribution that fails and retries alone, the record of every step that ran,
 * and the one `purged` row — with the step runner behaving as a Workflow's does.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-23T12:00:00.000Z");

const TABLES = [
  "pithy_organization_lifecycle",
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "adopter_projects",
  "pithy_migrations",
  "pithy_migrations_lock",
];

class Terminal extends Error {}

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
const deps = () => ({ db: db(), d1: env.DB, hooks: {}, now: () => NOW });

/** A Workflow's journal and retry loop, in miniature. */
function workflow(attempts = 3) {
  const journal = new Map<string, unknown>();
  const ran: string[] = [];
  const step: WorkflowStepLike & {
    do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T>;
  } = {
    async do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
      const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => Promise<T>;
      if (journal.has(name)) return journal.get(name) as T;
      let last: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        ran.push(name);
        try {
          const value = await fn();
          journal.set(name, value);
          return value;
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
  };
  return { step, ran };
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  await runMigrations(env.DB, provider());
  await env.DB.prepare("create table adopter_projects (id text primary key, organization_id text not null)").run();
  for (const [id, slug] of [
    [ACME, "acme"],
    [BETA, "beta"],
  ] as const) {
    await db()
      .insertInto(ORGANIZATIONS_TABLE)
      .values(Organization.encode({ id, name: slug, slug, logo: null, createdAt: NOW, updatedAt: NOW }))
      .execute();
    await db()
      .insertInto(MEMBERSHIPS_TABLE)
      .values(
        Membership.encode({ id: crypto.randomUUID(), organizationId: id, userId: "u1", role: "owner", createdAt: NOW }),
      )
      .execute();
    await env.DB.prepare("insert into adopter_projects (id, organization_id) values (?, ?)")
      .bind(`p-${slug}`, id)
      .run();
  }
});

/** The adopter's own sweep: their tenanted rows, in the purge's batch, over a Kysely of their own. */
const sweep: OrganizationDeleteSweep = (d1, organizationId) => [
  (createDatabase(d1, {}) as unknown as Kysely<Record<string, Record<string, unknown>>>)
    .deleteFrom("adopterProjects")
    .where("organizationId", "=", organizationId),
];

describe("the organization purge", () => {
  test("erases the organization and the adopter's rows, retries a failing contribution alone, and records what ran", async () => {
    await removeOrganization(deps(), {
      organizationId: ACME,
      actor: { type: "control-plane", id: "operator-1" },
      reason: "r",
      mode: "hard",
      purgeAfterDays: 30,
    });
    let mediaAttempts = 0;
    const media: PurgeStep = {
      step: "media",
      contribution: {
        subject: "organization",
        summary: "Deletes the organization's uploads.",
        erase: async () => {
          mediaAttempts += 1;
          if (mediaAttempts === 1) throw new Error("bucket unreachable");
        },
      },
    };
    const own: PurgeStep = { step: "organization", contribution: organizationPurgeContribution("DB", sweep) };
    const { step, ran } = workflow();
    const outcome = await purgeOrganization(
      { steps: [own, media], env: { DB: env.DB }, ops: organizationPurgeOps(deps()) },
      step,
      Terminal,
      { organizationId: ACME },
    );
    expect(outcome).toEqual({ organizationId: ACME, state: "purged", erased: ["media", "organization"], retained: [] });
    expect(ran).toEqual(["due", "erase media", "erase media", "erase organization", "complete"]);

    // Acme is gone, with its memberships and the adopter's rows. Beta is untouched.
    const organizations = await db().selectFrom(ORGANIZATIONS_TABLE).select("id").execute();
    expect(organizations).toEqual([{ id: BETA }]);
    const memberships = await db().selectFrom(MEMBERSHIPS_TABLE).select("organizationId").execute();
    expect(memberships).toEqual([{ organizationId: BETA }]);
    const { results } = await env.DB.prepare("select id from adopter_projects").all();
    expect(results).toEqual([{ id: "p-beta" }]);

    // The history outlives it: the deletion, one row per step with what it erased, and the end.
    const history = await db()
      .selectFrom(LIFECYCLE_TABLE)
      .select(["action", "step", "reason", "actorType"])
      .where("organizationId", "=", ACME)
      .orderBy("id", "asc")
      .execute();
    expect(history).toEqual([
      { action: "deleted", step: null, reason: "r", actorType: "control-plane" },
      { action: "purge_step", step: "media", reason: "Deletes the organization's uploads.", actorType: "system" },
      { action: "purge_step", step: "organization", reason: ORGANIZATION_PURGE_SUMMARY, actorType: "system" },
      { action: "purged", step: null, reason: null, actorType: "system" },
    ]);
  });

  test("a purge run again finds nothing to do, and an organization inside its window erases nothing", async () => {
    const own: PurgeStep = { step: "organization", contribution: organizationPurgeContribution("DB") };
    const run = { steps: [own], env: { DB: env.DB }, ops: organizationPurgeOps(deps()) };
    expect((await purgeOrganization(run, workflow().step, Terminal, { organizationId: BETA })).state).toBe("not_due");
    await removeOrganization(deps(), {
      organizationId: BETA,
      actor: { type: "control-plane", id: "operator-1" },
      reason: "r",
      purgeAfterDays: 30,
    });
    expect((await purgeOrganization(run, workflow().step, Terminal, { organizationId: BETA })).state).toBe("not_due");
    expect(await db().selectFrom(ORGANIZATIONS_TABLE).select("id").where("id", "=", BETA).executeTakeFirst()).toEqual({
      id: BETA,
    });
  });

  test("this capability's erase is idempotent: run twice, the second finds nothing and succeeds", async () => {
    const contribution = organizationPurgeContribution("DB");
    const context = { subject: { type: "organization" as const, id: ACME }, env: { DB: env.DB } };
    await contribution.erase(context);
    await expect(contribution.erase(context)).resolves.toBeUndefined();
    expect(
      await db().selectFrom(ORGANIZATIONS_TABLE).select("id").where("id", "=", ACME).executeTakeFirst(),
    ).toBeUndefined();
  });

  test("the audit event for a finished purge is written once, by whichever run finished it", async () => {
    const audited: string[] = [];
    const ops = organizationPurgeOps(deps(), {
      step: async () => {},
      failed: async () => {},
      purged: async (organizationId) => void audited.push(organizationId),
    });
    expect(await ops.complete(ACME)).toBe(true);
    expect(await ops.complete(ACME)).toBe(false);
    expect(audited).toEqual([ACME]);
  });
});

/**
 * The two bodies the adopter's Workflow classes call, through the composition a deployed Worker records: the payload
 * they parse, the capability they find, the database they refuse to run without, the one `purged` event they
 * write, and the starter the daily pass dispatches through.
 */
describe("the Workflow bodies", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const roles = defineRoles({
    roles: {
      owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
    },
    administrativePower: "organization:manage",
  });
  let recorded: AuditEventInput[] = [];

  /** A composed Worker: this capability, wired by its own `compose`, beside a capability that records the trail. */
  function composeWorker(): void {
    const trail = {
      name: "audit",
      requiredBindings: [],
      auditRecorder: () => async (event: AuditEventInput) => void recorded.push(event),
    } as unknown as Capability;
    const own = organization({ roles, baseUrl: "https://app.example.test", sendInvitationEmail: false });
    const capabilities = [trail, own];
    own.compose?.({ capabilities });
    recordComposition(capabilities);
  }

  /** Deleted at `at`, so the window has closed by the real clock the bodies read. */
  const deletedAt = (at: Date) => ({ db: db(), d1: env.DB, hooks: {}, now: () => at });

  beforeEach(() => {
    recorded = [];
    composeWorker();
  });

  afterEach(() => {
    forgetComposition();
  });

  test("runOrganizationPurge erases the organization the payload names, through the composed steps, and audits each step and the end", async () => {
    await removeOrganization(deletedAt(new Date(Date.now() - HOUR)), {
      organizationId: ACME,
      actor: { type: "control-plane", id: "operator-1" },
      reason: "r",
      mode: "hard",
      purgeAfterDays: 30,
    });
    const event = { payload: { organizationId: ACME }, workflowName: "organization-purge", instanceId: "i-1" };
    const outcome = await runOrganizationPurge({ DB: env.DB }, event, workflow().step, Terminal);
    expect(outcome).toEqual({ organizationId: ACME, state: "purged", erased: ["organization"], retained: [] });
    expect(await db().selectFrom(ORGANIZATIONS_TABLE).select("id").execute()).toEqual([{ id: BETA }]);
    expect(recorded).toEqual([
      {
        action: "organization/purge_step",
        outcome: "success",
        actorType: "system",
        actorId: null,
        tenant: ACME,
        resourceType: "organization",
        resourceId: ACME,
        metadata: { step: "organization", disposition: "erased" },
      },
      {
        action: "organization/purged",
        outcome: "success",
        actorType: "system",
        actorId: null,
        tenant: ACME,
        resourceType: "organization",
        resourceId: ACME,
        severity: "warning",
      },
    ]);

    // Run again, the organization is gone: nothing erased, and no second event.
    expect((await runOrganizationPurge({ DB: env.DB }, event, workflow().step, Terminal)).state).toBe("gone");
    expect(recorded).toHaveLength(2);
  });

  test("a payload that is not the purge's parameters is refused before anything runs", async () => {
    const { step, ran } = workflow();
    await expect(
      runOrganizationPurge({ DB: env.DB }, { payload: { organizationId: "acme" } }, step, Terminal),
    ).rejects.toThrow();
    await expect(runOrganizationPurge({ DB: env.DB }, {}, step, Terminal)).rejects.toThrow();
    await expect(runOrganizationPurgeDue({ DB: env.DB }, { payload: { limit: 0 } }, step, Terminal)).rejects.toThrow();
    expect(ran).toEqual([]);
  });

  test("with no DB bound, both bodies refuse with a wiring fault naming the binding, and run no step", async () => {
    const { step, ran } = workflow();
    await expect(runOrganizationPurge({}, { payload: { organizationId: ACME } }, step, Terminal)).rejects.toMatchObject(
      {
        payload: expect.objectContaining({ code: "core/internal", action: expect.stringContaining("DB") }),
      },
    );
    await expect(runOrganizationPurgeDue({ DB: "not a binding" }, {}, step, Terminal)).rejects.toMatchObject({
      payload: expect.objectContaining({ code: "core/internal" }),
    });
    expect(ran).toEqual([]);
  });

  test("with the capability not composed, the bodies say so rather than running on nothing", async () => {
    forgetComposition();
    await expect(
      runOrganizationPurge({ DB: env.DB }, { payload: { organizationId: ACME } }, workflow().step, Terminal),
    ).rejects.toMatchObject({ payload: expect.objectContaining({ action: expect.stringContaining("createBackend") }) });
  });

  test("runOrganizationPurgeDue starts a purge for each organization past its window, through the bound Workflow", async () => {
    const acmeDeleted = new Date(Date.now() - 40 * DAY);
    await removeOrganization(deletedAt(acmeDeleted), {
      organizationId: ACME,
      actor: { type: "control-plane", id: "operator-1" },
      reason: "r",
      purgeAfterDays: 30,
    });
    // Beta is deleted too, but inside its window: not due.
    await removeOrganization(deletedAt(new Date(Date.now() - DAY)), {
      organizationId: BETA,
      actor: { type: "control-plane", id: "operator-1" },
      reason: "r",
      purgeAfterDays: 30,
    });
    const created: { id?: string; params?: unknown }[] = [];
    const binding = {
      create: async (instance: { id?: string; params?: unknown }) => void created.push(instance),
      get: async (id: string) => ({ id }),
    };
    const { step, ran } = workflow();
    const outcome = await runOrganizationPurgeDue(
      { DB: env.DB, [ORGANIZATION_PURGE_BINDING]: binding },
      { payload: {} },
      step,
      Terminal,
    );
    expect(outcome).toEqual({ started: 1 });
    expect(ran).toEqual(["due", "start 1"]);
    expect(created).toHaveLength(1);
    expect(created[0]?.params).toEqual({ organizationId: ACME });
    // Under the id its deletion names, so a purge a hard deletion already started today is the same instance.
    expect(created[0]?.id).toBe(
      await organizationPurgeInstanceId({ organizationId: ACME, deletedAt: acmeDeleted.getTime(), at: new Date() }),
    );
  });

  test("a daily pass in a Worker that has not bound the purge starts nothing and counts nothing", async () => {
    await removeOrganization(deletedAt(new Date(Date.now() - 40 * DAY)), {
      organizationId: ACME,
      actor: { type: "control-plane", id: "operator-1" },
      reason: "r",
      purgeAfterDays: 30,
    });
    expect(await runOrganizationPurgeDue({ DB: env.DB }, {}, workflow().step, Terminal)).toEqual({ started: 0 });
  });
});

describe("the erasure record (#823)", () => {
  const OPERATOR = { type: "control-plane", id: "operator-1" } as const;
  const DAY = 86_400_000;

  test("a deletion's row keeps its mode and due instant; a failure and every step reach the history and the trail", async () => {
    const events: { action: string; metadata?: unknown }[] = [];
    const audit = purgeAudit(async (event) => void events.push({ action: event.action, metadata: event.metadata }));
    await removeOrganization(deps(), { organizationId: ACME, actor: OPERATOR, reason: "Closed.", purgeAfterDays: 30 });
    const later = { ...deps(), now: () => new Date(NOW.getTime() + DAY) };
    await removeOrganization(later, {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "Now.",
      mode: "hard",
      purgeAfterDays: 30,
    });
    const ops = organizationPurgeOps(deps(), audit);
    await ops.recordStep(ACME, "media", "Erases uploads.");
    await ops.recordRetained(ACME, "books", "Kept for tax records.");
    await ops.fail(ACME, "storage");
    const rows = await organizationErasureReader(db()).history([ACME, BETA]);
    expect(rows.map((row) => [row.action, row.mode, row.purgeAfter?.getTime() ?? null, row.step])).toEqual([
      ["deleted", "soft", NOW.getTime() + 30 * DAY, null],
      ["deleted", "hard", NOW.getTime() + DAY, null],
      ["purge_step", null, null, "media"],
      ["purge_retained", null, null, "books"],
      ["purge_failed", null, null, "storage"],
    ]);
    expect(events).toEqual([
      { action: "organization/purge_step", metadata: { step: "media", disposition: "erased" } },
      { action: "organization/purge_step", metadata: { step: "books", disposition: "retained" } },
      { action: "organization/purge_failed", metadata: { step: "storage" } },
    ]);
  });

  test("the period lists an organization by its purge's activity or its due instant in the window", async () => {
    await removeOrganization(
      { ...deps(), now: () => new Date(NOW.getTime() - 25 * DAY) },
      { organizationId: ACME, actor: OPERATOR, reason: "x", purgeAfterDays: 30 },
    );
    await removeOrganization(deps(), { organizationId: BETA, actor: OPERATOR, reason: "x", purgeAfterDays: 30 });
    const reader = organizationErasureReader(db());
    const window = [new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + 10 * DAY)] as const;
    expect(await reader.subjectsIn(...window)).toEqual([ACME]);
    await organizationPurgeOps(deps()).recordStep(BETA, "media", "x");
    expect(await reader.subjectsIn(...window)).toEqual([ACME, BETA]);
    expect(await reader.history([])).toEqual([]);
  });

  test("the period lists an organization whose purge came due before the window and has done nothing since", async () => {
    const at = (offset: number) => ({ ...deps(), now: () => new Date(NOW.getTime() + offset) });
    // Due 70 days before now and never started: outstanding through the whole window.
    await removeOrganization(at(-100 * DAY), {
      organizationId: ACME,
      actor: OPERATOR,
      reason: "x",
      purgeAfterDays: 30,
    });
    // Due as long ago, and finished before the window opened.
    await removeOrganization(at(-100 * DAY), {
      organizationId: BETA,
      actor: OPERATOR,
      reason: "x",
      purgeAfterDays: 30,
    });
    await organizationPurgeOps(at(-60 * DAY)).complete(BETA);
    const reader = organizationErasureReader(db());
    const window = [new Date(NOW.getTime() - 10 * DAY), new Date(NOW.getTime() + 10 * DAY)] as const;
    expect(await reader.subjectsIn(...window)).toEqual([ACME]);
    // A deletion recorded before its due instant was: no purgeAfter, and no purge since.
    await db().updateTable(LIFECYCLE_TABLE).set({ purgeAfter: null }).where("organizationId", "=", ACME).execute();
    expect(await reader.subjectsIn(...window)).toEqual([ACME]);
  });
});
