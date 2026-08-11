// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { audit_0002_tenant } from "./migrations/0002_tenant";
import { queryAuditEvents } from "./query";
import { recordAuditEvent } from "./recorder";

const T0 = 1_700_000_000_000;

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  await audit_0001_init.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
  await audit_0002_tenant.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);

  const db = auditDatabase(env.DB);
  await recordAuditEvent(db, {
    action: "auth/login",
    outcome: "success",
    severity: "info",
    actorType: "user",
    actorId: "user-1",
    resourceType: "user",
    resourceId: "user-1",
    occurredAt: new Date(T0),
  });
  await recordAuditEvent(db, {
    action: "auth/login",
    outcome: "denied",
    severity: "warning",
    actorType: "user",
    actorId: "user-2",
    occurredAt: new Date(T0 + 1000),
  });
  await recordAuditEvent(db, {
    action: "admin/config_changed",
    outcome: "success",
    severity: "critical",
    actorType: "service",
    actorId: "ci",
    resourceType: "config",
    resourceId: "flags",
    occurredAt: new Date(T0 + 2000),
  });
});

describe("queryAuditEvents", () => {
  test("returns the whole trail newest-first when the filter is empty", async () => {
    const events = await queryAuditEvents(auditDatabase(env.DB));
    expect(events.map((e) => e.action)).toEqual(["admin/config_changed", "auth/login", "auth/login"]);
    // Rows decode to the app shape: occurredAt is a Date.
    expect(events[0]?.occurredAt).toBeInstanceOf(Date);
  });

  test("filters by action", async () => {
    const events = await queryAuditEvents(auditDatabase(env.DB), { action: "auth/login" });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.action === "auth/login")).toBe(true);
  });

  test("filters by actor (type and id)", async () => {
    const events = await queryAuditEvents(auditDatabase(env.DB), { actorType: "user", actorId: "user-2" });
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("denied");
  });

  test("filters by outcome and by severity", async () => {
    expect(await queryAuditEvents(auditDatabase(env.DB), { outcome: "denied" })).toHaveLength(1);
    expect(await queryAuditEvents(auditDatabase(env.DB), { severity: "critical" })).toHaveLength(1);
  });

  test("filters by resource", async () => {
    const events = await queryAuditEvents(auditDatabase(env.DB), { resourceType: "config", resourceId: "flags" });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("admin/config_changed");
  });

  test("filters by an inclusive time range", async () => {
    const events = await queryAuditEvents(auditDatabase(env.DB), {
      from: new Date(T0 + 1000),
      to: new Date(T0 + 2000),
    });
    expect(events.map((e) => e.actorId)).toEqual(["ci", "user-2"]);
  });

  test("caps the result set with limit", async () => {
    const events = await queryAuditEvents(auditDatabase(env.DB), { limit: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("admin/config_changed");
  });

  test("filters by origin — project, environment, and worker", async () => {
    // The question these columns exist to answer: two Workers in one project share a database, so
    // `worker` is the only thing separating their events.
    const db = auditDatabase(env.DB);
    const origin = { project: "acme", environment: "prod", worker: "api", version: null };
    await recordAuditEvent(
      db,
      { action: "auth/login", outcome: "success", actorType: "user", actorId: "o-api" },
      { origin },
    );
    await recordAuditEvent(
      db,
      { action: "auth/login", outcome: "success", actorType: "user", actorId: "o-admin" },
      { origin: { ...origin, worker: "admin" } },
    );
    await recordAuditEvent(
      db,
      { action: "auth/login", outcome: "success", actorType: "user", actorId: "o-staging" },
      { origin: { ...origin, environment: "staging" } },
    );
    await recordAuditEvent(
      db,
      { action: "auth/login", outcome: "success", actorType: "user", actorId: "o-other" },
      { origin: { ...origin, project: "other" } },
    );

    const inProject = await queryAuditEvents(db, { project: "acme" });
    expect(inProject.map((e) => e.actorId).sort()).toEqual(["o-admin", "o-api", "o-staging"]);
    const inProd = await queryAuditEvents(db, { project: "acme", environment: "prod" });
    expect(inProd.map((e) => e.actorId).sort()).toEqual(["o-admin", "o-api"]);
    const onApi = await queryAuditEvents(db, { project: "acme", environment: "prod", worker: "api" });
    expect(onApi.map((e) => e.actorId)).toEqual(["o-api"]);
  });

  test("an origin filter excludes rows that recorded none", async () => {
    // A null origin is not a wildcard. The seeded rows above carry none, so they must not answer a
    // question about a specific project.
    const events = await queryAuditEvents(auditDatabase(env.DB), { project: "acme" });
    expect(events.every((event) => event.project === "acme")).toBe(true);
  });
});

describe("filtering by tenant", () => {
  /** One person administering two tenants, plus an action belonging to neither. */
  async function twoTenants(): Promise<void> {
    const db = auditDatabase(env.DB);
    await recordAuditEvent(db, {
      action: "admin/config_changed",
      outcome: "success",
      actorType: "user",
      actorId: "ada",
      tenant: "org-a",
      occurredAt: new Date(T0 + 10_000),
    });
    await recordAuditEvent(db, {
      action: "admin/config_changed",
      outcome: "success",
      actorType: "user",
      actorId: "ada",
      tenant: "org-b",
      occurredAt: new Date(T0 + 11_000),
    });
    await recordAuditEvent(db, {
      action: "secrets/rotated",
      outcome: "success",
      actorType: "system",
      occurredAt: new Date(T0 + 12_000),
    });
  }

  test("returns one tenant's trail, and not the other's", async () => {
    // The question the column exists to answer, and the one nothing on the row could answer before it:
    // in a multi-tenant app `project`, `environment` and `worker` are constant across every row.
    await twoTenants();
    const events = await queryAuditEvents(auditDatabase(env.DB), { tenant: "org-a" });
    expect(events.map((event) => event.tenant)).toEqual(["org-a"]);
    expect(events[0]?.actorId).toBe("ada");
  });

  test("the actor is not the tenant — filtering by actor returns both tenants' history", async () => {
    // Why this is a column and not a query over `actorId`. One person acts in two tenants; every event
    // they produce carries the same actor, so an actor-scoped read leaks across the boundary.
    await twoTenants();
    const byActor = await queryAuditEvents(auditDatabase(env.DB), { actorId: "ada" });
    expect(byActor.map((event) => event.tenant).sort()).toEqual(["org-a", "org-b"]);
  });

  test("filters for null — the events that belong to no tenant", async () => {
    // A first-class value, not a gap: a CLI-originated action and a fleet-wide operator action have no
    // tenant, and "show me what was done outside any customer's account" is a real question. Without
    // this an adopter writes SQL against the capability's own table to ask it.
    await twoTenants();
    const events = await queryAuditEvents(auditDatabase(env.DB), { tenant: null });
    expect(events.every((event) => event.tenant === null)).toBe(true);
    expect(events.map((event) => event.action)).toContain("secrets/rotated");
    // The seeded rows from `beforeEach` carry no tenant either, so this is the whole untenanted trail.
    expect(events).toHaveLength(4);
  });

  test("an absent filter is not a null filter", async () => {
    // `undefined` means "do not filter" and `null` means "match the rows that have none". Collapsing
    // the two would make the whole trail unreadable or the null read a full scan.
    await twoTenants();
    const all = await queryAuditEvents(auditDatabase(env.DB));
    expect(all).toHaveLength(6);
  });

  test("combines with a time range — the (tenant, time) read the index serves", async () => {
    await twoTenants();
    const events = await queryAuditEvents(auditDatabase(env.DB), {
      tenant: "org-b",
      from: new Date(T0 + 11_000),
      to: new Date(T0 + 11_000),
    });
    expect(events.map((event) => event.tenant)).toEqual(["org-b"]);
  });

  test("a tenant filter excludes rows recorded before the column existed", async () => {
    // They read as null, and null is not a wildcard. Nothing back-fills them, because the tenant of an
    // action is a fact at the time of the action and no membership table can answer it retroactively.
    await twoTenants();
    const events = await queryAuditEvents(auditDatabase(env.DB), { tenant: "org-a" });
    expect(events.every((event) => event.tenant === "org-a")).toBe(true);
  });
});
