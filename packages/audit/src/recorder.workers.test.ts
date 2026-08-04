// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { createAuditEmit, recordAuditEvent } from "./recorder";

/** Migrate the audit table into the test `DB` before each test, from a clean slate. */
beforeEach(async () => {
  for (const table of ["pithy_audit_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await audit_0001_init.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
});

async function rowCount(): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from pithy_audit_events").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("recordAuditEvent", () => {
  test("persists an event as a queryable row before returning (emit → persisted row)", async () => {
    const db = auditDatabase(env.DB);
    await recordAuditEvent(db, {
      action: "auth/login",
      outcome: "success",
      actorType: "user",
      actorId: "user-1",
      sessionId: "sess-1",
      ip: "203.0.113.9",
      metadata: { provider: "google" },
    });

    const row = await env.DB.prepare(
      "select action, outcome, severity, actor_type, actor_id, ip, metadata from pithy_audit_events",
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      action: "auth/login",
      outcome: "success",
      severity: "info",
      actor_type: "user",
      actor_id: "user-1",
      ip: "203.0.113.9",
    });
    expect(JSON.parse(row?.metadata as string)).toEqual({ provider: "google" });
  });

  test("stamps a unique eventId per recorded event (the idempotency key)", async () => {
    const db = auditDatabase(env.DB);
    await recordAuditEvent(db, { action: "auth/login", outcome: "success", actorType: "system" });
    await recordAuditEvent(db, { action: "auth/login", outcome: "success", actorType: "system" });
    const rows = await env.DB.prepare("select event_id from pithy_audit_events").all<{ event_id: string }>();
    const ids = rows.results.map((r) => r.event_id);
    expect(ids).toHaveLength(2);
    // Each is a non-empty UUID, and the two distinct events get distinct keys.
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  test("stamps occurredAt when the emitter omits it", async () => {
    const before = Date.now();
    await recordAuditEvent(auditDatabase(env.DB), {
      action: "admin/config_changed",
      outcome: "success",
      actorType: "system",
    });
    const row = await env.DB.prepare("select occurred_at from pithy_audit_events").first<{ occurred_at: number }>();
    expect(row?.occurred_at).toBeGreaterThanOrEqual(before);
    expect(row?.occurred_at).toBeLessThanOrEqual(Date.now());
  });

  test("a denied authorization attempt is recorded as a first-class row", async () => {
    await recordAuditEvent(auditDatabase(env.DB), {
      action: "admin/config_changed",
      outcome: "denied",
      severity: "warning",
      actorType: "user",
      actorId: "user-9",
    });
    const row = await env.DB.prepare("select outcome, severity from pithy_audit_events").first<{
      outcome: string;
      severity: string;
    }>();
    expect(row).toEqual({ outcome: "denied", severity: "warning" });
  });

  test("a write failure is non-fatal: it resolves, records nothing, and reports audit/write_failed", async () => {
    // Drop the table out from under the recorder to force the insert to fail.
    await env.DB.prepare("drop table pithy_audit_events").run();
    const onError = vi.fn();

    await expect(
      recordAuditEvent(
        auditDatabase(env.DB),
        { action: "auth/login", outcome: "success", actorType: "system" },
        { onError },
      ),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].payload.code).toBe("audit/write_failed");
  });

  test("an invalid event is non-fatal: reported as audit/invalid_event, nothing persisted", async () => {
    const onError = vi.fn();
    await recordAuditEvent(
      auditDatabase(env.DB),
      // `action` is not a namespaced domain/reason code.
      { action: "nope", outcome: "success", actorType: "system" },
      { onError },
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].payload.code).toBe("audit/invalid_event");
    expect(await rowCount()).toBe(0);
  });

  test("createAuditEmit binds a recorder to a database", async () => {
    const emit = createAuditEmit(auditDatabase(env.DB));
    await emit({ action: "auth/token_refreshed", outcome: "success", actorType: "user", actorId: "u2" });
    expect(await rowCount()).toBe(1);
  });
});

/** Reads the writer-stamped columns off the single row a test wrote. */
async function originRow(): Promise<{
  project: string | null;
  environment: string | null;
  worker: string | null;
  version: string | null;
}> {
  const row = await env.DB.prepare("select project, environment, worker, version from pithy_audit_events").first<{
    project: string | null;
    environment: string | null;
    worker: string | null;
    version: string | null;
  }>();
  if (!row) throw new Error("expected a recorded row");
  return row;
}

describe("the origin columns", () => {
  const EVENT = { action: "auth/login", outcome: "success", actorType: "user", actorId: "u1" } as const;

  test("are stamped from the recorder's origin, not from the event", async () => {
    await recordAuditEvent(auditDatabase(env.DB), EVENT, {
      origin: { project: "acme", environment: "prod", worker: "api", version: null },
    });
    expect(await originRow()).toEqual({ project: "acme", environment: "prod", worker: "api", version: null });
  });

  test("an emitter cannot set them, and cannot override the recorder's", async () => {
    // The security property the column exists for. `AuditEvent` has no origin fields, so these are
    // stripped by the schema before the insert is built — a route cannot claim to be another Worker,
    // another environment, or another project. Asserted through the real parse path, not by reading
    // the type: a type says what the compiler allows, and the emitters here are `unknown` at runtime.
    await recordAuditEvent(
      auditDatabase(env.DB),
      { ...EVENT, project: "attacker", environment: "prod", worker: "admin", version: null } as never,
      { origin: { project: "acme", environment: "dev", worker: "api", version: null } },
    );
    expect(await originRow()).toEqual({ project: "acme", environment: "dev", worker: "api", version: null });
  });

  test("a forged origin cannot reach the row even when the recorder has none", async () => {
    // The same claim without a competing value to hide behind: with no `origin` option, an emitter's
    // own fields must still produce nulls rather than being written through.
    await recordAuditEvent(auditDatabase(env.DB), {
      ...EVENT,
      project: "attacker",
      worker: "admin",
      version: null,
    } as never);
    expect(await originRow()).toEqual({ project: null, environment: null, worker: null, version: null });
  });

  test("record as null when the recorder is given no origin", async () => {
    // An unstamped Worker: scaffolded without the vars, or running a hand-written wrangler.jsonc.
    await recordAuditEvent(auditDatabase(env.DB), EVENT);
    expect(await originRow()).toEqual({ project: null, environment: null, worker: null, version: null });
  });

  test("the build id is stamped by the recorder, and an emitter cannot claim another one", async () => {
    // `version` is a writer property, exactly like project/environment/worker: it is a fact about the
    // process that wrote the row, never about the action. That is the whole forensic value — "revoked
    // by this subject, against this exact build" is only worth anything if the build cannot be
    // asserted by the ~29 call sites that emit.
    await recordAuditEvent(auditDatabase(env.DB), { ...EVENT, version: "v-forged" } as never, {
      origin: { project: "acme", environment: "prod", worker: "api", version: "v-real" },
    });
    expect(await originRow()).toEqual({
      project: "acme",
      environment: "prod",
      worker: "api",
      version: "v-real",
    });
  });

  test("record a partial origin as far as it is known", async () => {
    // A Worker carrying PROJECT but scaffolded before WORKER existed. Two of three is worth keeping.
    await recordAuditEvent(auditDatabase(env.DB), EVENT, {
      origin: { project: "acme", environment: "prod", worker: null, version: null },
    });
    expect(await originRow()).toEqual({ project: "acme", environment: "prod", worker: null, version: null });
  });
});
