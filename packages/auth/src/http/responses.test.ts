// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { Session, User } from "../data/betterAuth";
import type { Device } from "../data/device";
import {
  AccountDeleteResponse,
  AdminDeviceRevokeResponse,
  AdminDevicesResponse,
  AdminDeviceView,
  AdminRevokeResponse,
  AdminSessionView,
  AdminUserDeleteResponse,
  AdminUserExportResponse,
  AdminUserReinstateResponse,
  AdminUserResponse,
  AdminUserRestoreResponse,
  AdminUserSuspendResponse,
  AdminUsersResponse,
  AdminUserView,
  AuthUserExport,
} from "./responses";
import {
  accountDeletionView,
  authUserExportView,
  deletionView,
  deviceView,
  exportView,
  reinstatementView,
  restorationView,
  sessionView,
  suspensionView,
  userView,
} from "./views";

/**
 * The response schemas against what the projections actually produce.
 *
 * **Equality, not `.parse()` alone.** A Zod object strips unknown keys, so a bare parse passes a
 * projection that has grown a field the schema never heard of — which is exactly the drift this
 * exists to catch. Comparing the parsed value with the input fails in both directions.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const USER: User = {
  id: "u-1",
  email: "ada@example.test",
  name: "Ada",
  emailVerified: true,
  image: "https://cdn.example/ada.png",
  locale: "es-AR",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

/** The instant every standing below is judged at. */
const NOW = new Date("2026-10-23T12:00:00.000Z");

const SESSION: Session = {
  id: "s-1",
  userId: "u-1",
  token: "session-token-must-not-leak",
  deviceId: "d-1",
  familyId: "f-1",
  authenticatedAt: new Date("2026-09-11T12:00:00Z"),
  ipAddress: "203.0.113.9",
  userAgent: "Pithy/1.0",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  expiresAt: new Date("2026-07-01T00:00:00.000Z"),
};

const DEVICE: Device = {
  id: "d-1",
  userId: "u-1",
  platform: "ios",
  name: "Ada's iPhone",
  model: "iPhone17,2",
  osVersion: "26.1",
  appVersion: "1.4.0",
  pushToken: "apns-push-credential-must-not-leak",
  lastIp: "203.0.113.9",
  lastSeenAt: new Date("2026-06-02T00:00:00.000Z"),
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
};

describe("the deletion lifecycle's responses (#622)", () => {
  const at = new Date("2026-10-20T12:00:00.000Z");
  const later = new Date("2026-11-19T12:00:00.000Z");

  test("the deletion projection is exactly what its schema declares, every outcome and purge", () => {
    const soft = deletionView(
      "u-1",
      "soft",
      { changed: true, mailed: true, outcome: "deleted", deletedAt: at, purgeAfter: later },
      "scheduled",
      2,
    );
    accepts(AdminUserDeleteResponse, soft);
    expect(soft).toEqual({
      userId: "u-1",
      state: "deleted",
      mode: "soft",
      outcome: "deleted",
      deletedAt: at.toISOString(),
      purgeAfter: later.toISOString(),
      purge: "scheduled",
      sessionsRevoked: 2,
      mailed: true,
    });
    for (const purge of ["started", "pending"] as const) {
      for (const outcome of ["deleted", "brought_forward", "unchanged"] as const) {
        accepts(
          AdminUserDeleteResponse,
          deletionView(
            "u-1",
            "hard",
            { changed: false, mailed: false, outcome, deletedAt: at, purgeAfter: at },
            purge,
            0,
          ),
        );
      }
    }
  });

  test("the restoration projection is exactly what its schema declares, both outcomes and both states", () => {
    const restored = restorationView("u-1", { changed: true, mailed: false, state: "suspended" });
    accepts(AdminUserRestoreResponse, restored);
    expect(restored).toEqual({ userId: "u-1", state: "suspended", outcome: "restored" });
    accepts(AdminUserRestoreResponse, restorationView("u-1", { changed: false, mailed: false, state: "active" }));
  });

  test("the self-service projection says when, and whether the person was mailed — and names nobody", () => {
    const own = accountDeletionView({
      changed: true,
      mailed: true,
      outcome: "deleted",
      deletedAt: at,
      purgeAfter: later,
    });
    accepts(AccountDeleteResponse, own);
    expect(own).toEqual({ state: "deleted", purgeAfter: later.toISOString(), mailed: true });
  });

  test("none of them carries the reason", () => {
    for (const schema of [AdminUserDeleteResponse, AdminUserRestoreResponse, AccountDeleteResponse]) {
      expect(Object.keys(schema.shape)).not.toContain("reason");
    }
  });

  test("auth's export is exactly what its schema declares, and carries no credential", () => {
    const exported = authUserExportView({
      now: NOW,
      user: { ...USER, deletedAt: at, purgeAfter: later, suspendedAt: null, suspendedUntil: null },
      sessions: [SESSION],
      accounts: [{ providerId: "google", createdAt: at }],
      devices: [DEVICE],
      history: [
        {
          id: 1,
          userId: "u-1",
          action: "deleted",
          actorType: "control-plane",
          actorId: "ops@dashboard.test",
          reason: "Asked by email.",
          suspendedUntil: null,
          step: null,
          notify: null,
          createdAt: at,
        },
      ],
    });
    accepts(AuthUserExport, exported);
    expect(exported.user).toMatchObject({
      state: "deleted",
      deletedAt: at.toISOString(),
      purgeAfter: later.toISOString(),
    });
    expect(exported.history).toEqual([
      {
        action: "deleted",
        actorType: "control-plane",
        reason: "Asked by email.",
        suspendedUntil: null,
        createdAt: at.toISOString(),
      },
    ]);
    const wire = JSON.stringify(exported);
    for (const secret of ["session-token-must-not-leak", "apns-push-credential-must-not-leak", "ops@dashboard.test"]) {
      expect(wire).not.toContain(secret);
    }
  });

  test("the export document is exactly what its schema declares, every entry state included", () => {
    const document = exportView("u-1", at, [
      { capability: "auth", summary: "Deletes the account.", state: "exported", data: { user: { id: "u-1" } } },
      { capability: "media", summary: "Deletes the uploads.", state: "not_exported" },
      { capability: "app", summary: "Erases the drafts.", state: "unavailable" },
    ]);
    accepts(AdminUserExportResponse, document);
    expect(document.subject).toEqual({ type: "user", id: "u-1" });
    expect(document.exportedAt).toBe(at.toISOString());
    // An unread part carries no `data`, so it cannot be rendered as a capability that holds nothing.
    expect(
      AdminUserExportResponse.parse({
        ...document,
        capabilities: [{ capability: "x", summary: "y", state: "unavailable", data: {} }],
      }).capabilities[0],
    ).not.toHaveProperty("data");
  });
});

describe("auth admin response schemas", () => {
  test("the suspension projection is exactly what its schema declares, both outcomes (#621)", () => {
    const at = new Date("2026-10-20T12:00:00.000Z");
    const until = new Date("2026-10-27T12:00:00.000Z");
    const suspended = suspensionView(
      "u-1",
      { changed: true, updated: false, mailed: true, suspendedAt: at, suspendedUntil: null },
      2,
    );
    accepts(AdminUserSuspendResponse, suspended);
    expect(suspended).toEqual({
      userId: "u-1",
      state: "suspended",
      outcome: "suspended",
      suspendedAt: at.toISOString(),
      suspendedUntil: null,
      sessionsRevoked: 2,
      mailed: true,
    });
    const restated = suspensionView(
      "u-1",
      { changed: false, updated: true, mailed: false, suspendedAt: at, suspendedUntil: until },
      0,
    );
    accepts(AdminUserSuspendResponse, restated);
    expect(restated).toMatchObject({ outcome: "updated", suspendedUntil: until.toISOString(), mailed: false });
  });

  test("the reinstatement projection is exactly what its schema declares, both outcomes (#621)", () => {
    const lifted = reinstatementView("u-1", { changed: true, mailed: true });
    accepts(AdminUserReinstateResponse, lifted);
    expect(lifted).toEqual({ userId: "u-1", state: "active", outcome: "reinstated", mailed: true });
    const nothing = reinstatementView("u-1", { changed: false, mailed: false });
    accepts(AdminUserReinstateResponse, nothing);
    expect(nothing).toEqual({ userId: "u-1", state: "active", outcome: "unchanged", mailed: false });
  });

  test("neither lifecycle response carries the reason, which the caller wrote and the trail keeps", () => {
    expect(Object.keys(AdminUserSuspendResponse.shape)).not.toContain("reason");
    expect(Object.keys(AdminUserReinstateResponse.shape)).not.toContain("reason");
  });

  test("each projection is exactly what its schema declares", () => {
    accepts(AdminUserView, userView(USER, NOW));
    accepts(AdminUserView, userView({ ...USER, image: null }, NOW));
    accepts(AdminSessionView, sessionView(SESSION));
    accepts(AdminSessionView, sessionView({ ...SESSION, deviceId: null, ipAddress: null, userAgent: null }));
    accepts(AdminDeviceView, deviceView(DEVICE));
    accepts(
      AdminDeviceView,
      deviceView({ ...DEVICE, name: null, model: null, osVersion: null, appVersion: null, lastIp: null }),
    );
  });

  test("no credential is declared on any view", () => {
    // The schema is a second lock on the door the projections closed. A session token is the user, and
    // a push token puts a notification on their lock screen; a client validating against these must
    // never be told either is part of the contract.
    expect(Object.keys(AdminSessionView.shape)).not.toContain("token");
    expect(Object.keys(AdminSessionView.shape)).not.toContain("familyId");
    expect(Object.keys(AdminDeviceView.shape)).not.toContain("pushToken");
  });

  test("the envelopes accept what the routes return", () => {
    accepts(AdminUsersResponse, { users: [userView(USER, NOW)], nextCursor: null });
    accepts(AdminUsersResponse, { users: [], nextCursor: "eyJpZCI6MX0" });
    accepts(AdminUserResponse, {
      user: userView(USER, NOW),
      providers: { state: "read", items: ["apple", "google"] },
      sessions: { state: "read", items: [sessionView(SESSION)], truncated: false },
      devices: { state: "read", items: [deviceView(DEVICE)], truncated: true },
    });
    // And the state each list takes when its read failed (#380): no rows, no truncation flag, no
    // reason. A client that reached for `items` here would not compile.
    accepts(AdminUserResponse, {
      user: userView(USER, NOW),
      providers: { state: "unavailable" },
      sessions: { state: "unavailable" },
      devices: { state: "unavailable" },
    });
    accepts(AdminDevicesResponse, { devices: [deviceView(DEVICE)], nextCursor: null });
    accepts(AdminRevokeResponse, { revoked: 3 });
    accepts(AdminDeviceRevokeResponse, { revoked: 1, removed: true });
  });

  test("a revocation reports a count and nothing about whose it was", () => {
    // A revoke scope is not a read scope. The owning user reaches the audit trail; the response says
    // only how many sessions ended, and the schema is what a client may rely on.
    expect(Object.keys(AdminRevokeResponse.shape)).toEqual(["revoked"]);
  });
});

/**
 * A Worker one release behind still renders its pane (#450).
 *
 * These schemas are read across a version boundary: the dashboard validates every response with the
 * capability's own exported schema, against *other people's* Workers at whatever kit version each is
 * on. So a field added as a required key fails `safeParse` for everyone below that release and takes
 * the whole pane with it — on the day the dashboard deploys, not on any day the customer acted.
 *
 * `locale` was the second one to do it. It went unnoticed the first time because the kit and the
 * dashboard were upgraded in one step, by one person, on one afternoon.
 */
describe("a response from a Worker that predates a field", () => {
  test("parses, and the field reads as absent rather than failing the envelope", () => {
    const { locale: _dropped, ...before } = userView(USER, NOW);
    const parsed = AdminUserView.safeParse(before);
    expect(parsed.success, parsed.error?.message).toBe(true);
    expect(parsed.success && "locale" in parsed.data).toBe(false);
  });

  test("and absent is distinguishable from null, which is a different fact", () => {
    // `null` is "this reader has never chosen." Absent is "this Worker cannot say." Collapsing them
    // would report every reader on an older Worker as having declined to pick a language.
    const withNull = AdminUserView.safeParse({ ...userView(USER, NOW), locale: null });
    expect(withNull.success && withNull.data.locale).toBeNull();
  });

  test("a current Worker still sends it", () => {
    // `.optional()` relaxes the reader, never the producer.
    expect(userView(USER, NOW)).toHaveProperty("locale");
  });
});

/**
 * Where the user stands, on both reads that return them (#813) — the organization view's shape, from
 * `accountStanding`, so a pane can offer suspend or reinstate without sending a write to find out.
 */
describe("AdminUserView's standing", () => {
  const HOUR = 60 * 60 * 1000;
  const later = new Date(NOW.getTime() + HOUR);
  const earlier = new Date(NOW.getTime() - HOUR);

  test("an active account", () => {
    const view = userView(USER, NOW);
    accepts(AdminUserView, view);
    expect(view).toMatchObject({ state: "active", suspendedUntil: null, purgeAfter: null });
  });

  test("an open-ended suspension has no end", () => {
    const view = userView({ ...USER, suspendedAt: earlier, suspendedUntil: null }, NOW);
    accepts(AdminUserView, view);
    expect(view).toMatchObject({ state: "suspended", suspendedUntil: null, purgeAfter: null });
  });

  test("a timed suspension names its end", () => {
    const view = userView({ ...USER, suspendedAt: earlier, suspendedUntil: later }, NOW);
    accepts(AdminUserView, view);
    expect(view).toMatchObject({ state: "suspended", suspendedUntil: later.toISOString(), purgeAfter: null });
  });

  test("a suspension past its end reads active, as enforcement reads it", () => {
    const view = userView({ ...USER, suspendedAt: new Date(earlier.getTime() - HOUR), suspendedUntil: earlier }, NOW);
    expect(view).toMatchObject({ state: "active", suspendedUntil: null, purgeAfter: null });
  });

  test("a deleted account names the last day it can be restored, and outranks a suspension", () => {
    const view = userView(
      { ...USER, suspendedAt: earlier, suspendedUntil: later, deletedAt: earlier, purgeAfter: later },
      NOW,
    );
    accepts(AdminUserView, view);
    expect(view).toMatchObject({ state: "deleted", suspendedUntil: null, purgeAfter: later.toISOString() });
  });

  test("a Worker from before the fields sends none, and the user still parses", () => {
    const { state: _s, suspendedUntil: _u, purgeAfter: _p, ...before } = userView(USER, NOW);
    const parsed = AdminUserView.safeParse(before);
    expect(parsed.success, parsed.error?.message).toBe(true);
    const schema = AdminUserView.toJSONSchema() as { required?: string[] };
    for (const key of ["state", "suspendedUntil", "purgeAfter"]) expect(schema.required).not.toContain(key);
  });

  test("no reason and no actor: the reason is on the trail, and the trail is audit's", () => {
    for (const key of Object.keys(AdminUserView.shape)) expect(key).not.toMatch(/reason|actor/i);
  });
});
