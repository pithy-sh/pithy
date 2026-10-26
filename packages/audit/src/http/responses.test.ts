// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { AccessHistoryRow } from "../accessHistory";
import type { AuditEventRow } from "../data/auditEvent";
import {
  AccessChangeView,
  AccessHistoryResponse,
  AuditEventDetailView,
  AuditEventResponse,
  AuditEventsResponse,
  AuditEventView,
} from "./responses";
import { accessChangeView, auditEventDetailView, auditEventView } from "./views";

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
  actorKind: null,
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
  tenant: "org-42",
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
  tenant: null,
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

  test("the listing view carries the tenant — a trail you cannot attribute is not one", () => {
    // In the listing, not only the detail read. The pane this serves draws one tenant's history, so a
    // client that could filter by tenant but never see which tenant a row belongs to would have to take
    // the filter on trust — and a row shown under the wrong heading is the failure the column exists to
    // prevent. It is an opaque id the adopter already holds, not personal data, so it is not one of the
    // three fields the detail scope gates.
    expect(Object.keys(AuditEventView.shape)).toContain("tenant");
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

/** One access change as the statement answers it, every column set, so a view proves what it keeps and drops. */
const CHANGE: AccessHistoryRow = {
  id: 7,
  eventId: "e0e0f6a2-8b0c-4a1e-9f3d-2c1b0a998877",
  occurredAt: new Date("2026-06-10T12:00:00.000Z"),
  action: "organization/member_role_changed",
  actorType: "user",
  actorId: "user_ada",
  actorKind: null,
  subject: "member",
  recorded: true,
  organizationId: "org-42",
  membershipId: "mem_bob",
  userId: "user_bob",
  roleBefore: "admin",
  roleAfter: "member",
  connectionId: null,
  connectionKind: null,
  purpose: null,
  principal: null,
  scopesBefore: null,
  scopesAfter: null,
  replacedConnectionId: null,
  keyId: null,
  keyChange: null,
};

describe("access-history views (#831)", () => {
  test("a member change carries the member's fields and no other subject's", () => {
    const view = accessChangeView(CHANGE);
    accepts(AccessChangeView, view);
    expect(view).toEqual({
      eventId: CHANGE.eventId,
      occurredAt: "2026-06-10T12:00:00.000Z",
      action: "organization/member_role_changed",
      actorType: "user",
      actorId: "user_ada",
      actorKind: null,
      detail: "recorded",
      subject: "member",
      organizationId: "org-42",
      membershipId: "mem_bob",
      userId: "user_bob",
      roleBefore: "admin",
      roleAfter: "member",
    });
  });

  test("a connection change carries its kind, purpose, principal and scopes", () => {
    const view = accessChangeView({
      ...CHANGE,
      action: "controlplane/connection_updated",
      actorType: "user",
      subject: "connection",
      connectionId: "conn-1",
      connectionKind: "agent",
      purpose: "Triage.",
      principal: "ada@example.com",
      scopesBefore: ["a:b:read", "c:d:read"],
      scopesAfter: ["a:b:read"],
    });
    accepts(AccessChangeView, view);
    expect(view).toMatchObject({
      subject: "connection",
      scopesBefore: ["a:b:read", "c:d:read"],
      principal: "ada@example.com",
    });
    expect(Object.keys(view)).not.toContain("roleBefore");
  });

  test("a registration that started a connection over names the connection it ended", () => {
    const view = accessChangeView({
      ...CHANGE,
      action: "controlplane/connection_registered",
      subject: "connection",
      connectionId: "conn-2",
      scopesAfter: ["a:b:read"],
      replacedConnectionId: "conn-1",
    });
    accepts(AccessChangeView, view);
    expect(view).toMatchObject({ subject: "connection", connectionId: "conn-2", replacedConnectionId: "conn-1" });
  });

  test("a key change carries its key and what happened to it, and an unrecorded one says so", () => {
    const view = accessChangeView({
      ...CHANGE,
      action: "controlplane/connection_updated",
      subject: "key",
      recorded: false,
      connectionId: "conn-1",
      keyId: null,
      keyChange: "revoked",
    });
    accepts(AccessChangeView, view);
    expect(view).toMatchObject({ subject: "key", change: "revoked", keyId: null, detail: "not_recorded" });
    expect(Object.keys(view)).not.toContain("scopesBefore");
  });

  test("a key change with no change is refused, never guessed", () => {
    expect(() => accessChangeView({ ...CHANGE, subject: "key", keyChange: null })).toThrow();
  });

  test("the envelope accepts what the route returns", () => {
    accepts(AccessHistoryResponse, {
      since: "2026-06-01T00:00:00.000Z",
      until: "2026-06-10T12:00:00.000Z",
      changes: [accessChangeView(CHANGE)],
      nextCursor: null,
    });
  });
});
