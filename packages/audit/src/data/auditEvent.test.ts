// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import { AuditEventRow } from "./auditEvent";

describe("AuditEventRow codec round-trip", () => {
  test("a SQLite row decodes to the app shape and re-encodes losslessly", () => {
    const row = {
      id: 7,
      eventId: "11111111-1111-1111-1111-111111111111",
      occurredAt: 1_700_000_000_000,
      action: "auth/login",
      outcome: "success",
      severity: "info",
      actorType: "user",
      actorId: "user-1",
      sessionId: "sess-1",
      resourceType: "user",
      resourceId: "user-1",
      ip: "203.0.113.7",
      userAgent: "pithy-cli/1.0",
      requestId: "req-1",
      metadata: JSON.stringify({ provider: "google" }),
      project: "acme",
      environment: "prod",
      worker: "api",
    } as const;

    const event = AuditEventRow.parse(row);
    expect(event.eventId).toBe("11111111-1111-1111-1111-111111111111");
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(event.occurredAt.getTime()).toBe(1_700_000_000_000);
    expect(event.metadata).toEqual({ provider: "google" });
    expect({ project: event.project, environment: event.environment, worker: event.worker }).toEqual({
      project: "acme",
      environment: "prod",
      worker: "api",
    });

    const encoded = AuditEventRow.encode(event);
    expect(encoded.occurredAt).toBe(1_700_000_000_000);
    expect(JSON.parse(encoded.metadata as string)).toEqual({ provider: "google" });
    // Plain text columns, so they survive the round trip unchanged — no codec to get wrong.
    expect([encoded.project, encoded.environment, encoded.worker]).toEqual(["acme", "prod", "api"]);
  });

  test("a row with no recorded origin still decodes", () => {
    // An unstamped Worker and every CLI-originated action land here, and nothing can back-fill an
    // origin that was never recorded. If the schema ever stopped accepting a null one, reading the
    // historical trail would throw — the one thing an audit log must not do.
    const event = AuditEventRow.parse({
      id: 2,
      eventId: "22222222-2222-2222-2222-222222222222",
      occurredAt: 1_700_000_000_000,
      action: "auth/login",
      outcome: "success",
      severity: "info",
      actorType: "system",
      actorId: null,
      sessionId: null,
      resourceType: null,
      resourceId: null,
      ip: null,
      userAgent: null,
      requestId: null,
      metadata: null,
      project: null,
      environment: null,
      worker: null,
    });
    expect([event.project, event.environment, event.worker]).toEqual([null, null, null]);
    const encoded = AuditEventRow.encode(event);
    expect([encoded.project, encoded.environment, encoded.worker]).toEqual([null, null, null]);
  });

  test("null correlation columns decode to null and round-trip", () => {
    const event = AuditEventRow.parse({
      id: 1,
      eventId: "22222222-2222-2222-2222-222222222222",
      occurredAt: 1_700_000_000_000,
      action: "admin/config_changed",
      outcome: "denied",
      severity: "critical",
      actorType: "anonymous",
      actorId: null,
      sessionId: null,
      resourceType: null,
      resourceId: null,
      ip: null,
      userAgent: null,
      requestId: null,
      metadata: null,
      project: null,
      environment: null,
      worker: null,
    });
    expect(event.actorId).toBeNull();
    expect(event.metadata).toBeNull();
    expect(AuditEventRow.encode(event).metadata).toBeNull();
  });

  test("rejects a malformed action code", () => {
    expect(() =>
      AuditEventRow.parse({
        id: 1,
        eventId: "33333333-3333-3333-3333-333333333333",
        occurredAt: 1,
        action: "NotNamespaced",
        outcome: "success",
        severity: "info",
        actorType: "system",
        actorId: null,
        sessionId: null,
        resourceType: null,
        resourceId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        metadata: null,
      }),
    ).toThrow();
  });

  test("rejects an unknown outcome", () => {
    expect(() =>
      AuditEventRow.parse({
        id: 1,
        eventId: "44444444-4444-4444-4444-444444444444",
        occurredAt: 1,
        action: "auth/login",
        outcome: "maybe",
        severity: "info",
        actorType: "system",
        actorId: null,
        sessionId: null,
        resourceType: null,
        resourceId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        metadata: null,
      }),
    ).toThrow();
  });
});
