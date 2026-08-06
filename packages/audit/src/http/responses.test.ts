// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { AuditEventRow } from "../data/auditEvent";
import { AuditEventDetailView, AuditEventResponse, AuditEventsResponse, AuditEventView } from "./responses";
import { auditEventDetailView, auditEventView } from "./views";

/**
 * The response schemas against what the projections actually produce.
 *
 * **Equality, not `.parse()` alone.** A Zod object strips unknown keys, so a bare parse passes a
 * projection that has grown a field the schema never heard of — which is precisely the drift this
 * exists to catch. Comparing the parsed value to the input fails in both directions: a field the
 * schema does not declare is dropped and shows up as a difference, and a field it declares wrongly
 * fails the parse outright.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

/** A fully populated row — every nullable column set, so nothing is proven only by being absent. */
const ROW: AuditEventRow = {
  id: 41,
  eventId: "d0e0f6a2-8b0c-4a1e-9f3d-2c1b0a998877",
  occurredAt: new Date("2026-06-10T12:00:00.000Z"),
  action: "auth/login",
  outcome: "success",
  severity: "info",
  actorType: "user",
  actorId: "u-1",
  sessionId: "s-1",
  resourceType: "user",
  resourceId: "u-1",
  ip: "203.0.113.9",
  userAgent: "Dashboard/1.0",
  requestId: "cf-ray-1",
  metadata: { reason: "magic_link" },
  project: "acme",
  environment: "prod",
  worker: "api",
  version: "build-7",
};

/** The same event with every optional column empty — the shape a CLI-originated row actually has. */
const SPARSE: AuditEventRow = {
  ...ROW,
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
  version: null,
};

describe("audit response schemas", () => {
  test("the listing view is exactly what the listing schema declares", () => {
    accepts(AuditEventView, auditEventView(ROW));
    accepts(AuditEventView, auditEventView(SPARSE));
  });

  test("the detail view is exactly what the detail schema declares", () => {
    accepts(AuditEventDetailView, auditEventDetailView(ROW));
    accepts(AuditEventDetailView, auditEventDetailView(SPARSE));
  });

  test("the listing view carries no network identifier and no metadata bag", () => {
    // The projection decides this; the schema is what a client can rely on it. Both must agree, or a
    // management client validating against the schema would reject a legitimate response — or, worse,
    // accept an `ip` the listing scope was never meant to disclose.
    expect(Object.keys(AuditEventView.shape)).not.toContain("ip");
    expect(Object.keys(AuditEventView.shape)).not.toContain("userAgent");
    expect(Object.keys(AuditEventView.shape)).not.toContain("metadata");
    expect(Object.keys(AuditEventDetailView.shape)).toContain("metadata");
  });

  test("the envelopes accept what the routes return", () => {
    accepts(AuditEventsResponse, { events: [auditEventView(ROW), auditEventView(SPARSE)], nextCursor: null });
    accepts(AuditEventsResponse, { events: [], nextCursor: "eyJpZCI6MX0" });
    accepts(AuditEventResponse, { event: auditEventDetailView(ROW) });
  });

  test("the surrogate id is not projectable through either view", () => {
    // `id` is monotonic: publishing it tells a client how many events the project has recorded. The
    // schema is the second lock on the door the projection already closed.
    expect(AuditEventsResponse.parse({ events: [{ ...auditEventView(ROW), id: 41 }], nextCursor: null })).toEqual({
      events: [auditEventView(ROW)],
      nextCursor: null,
    });
  });
});
