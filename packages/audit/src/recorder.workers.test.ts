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
