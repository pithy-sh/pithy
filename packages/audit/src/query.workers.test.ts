// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { queryAuditEvents } from "./query";
import { recordAuditEvent } from "./recorder";

const T0 = 1_700_000_000_000;

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  await audit_0001_init.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);

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
    const origin = { project: "acme", environment: "prod", worker: "api" };
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
