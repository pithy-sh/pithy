// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { Session, User } from "../data/betterAuth";
import type { Device } from "../data/device";
import {
  AdminDeviceRevokeResponse,
  AdminDevicesResponse,
  AdminDeviceView,
  AdminRevokeResponse,
  AdminSessionView,
  AdminUserResponse,
  AdminUsersResponse,
  AdminUserView,
} from "./responses";
import { deviceView, sessionView, userView } from "./views";

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

const SESSION: Session = {
  id: "s-1",
  userId: "u-1",
  token: "session-token-must-not-leak",
  deviceId: "d-1",
  familyId: "f-1",
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

describe("auth admin response schemas", () => {
  test("each projection is exactly what its schema declares", () => {
    accepts(AdminUserView, userView(USER));
    accepts(AdminUserView, userView({ ...USER, image: null }));
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
    accepts(AdminUsersResponse, { users: [userView(USER)], nextCursor: null });
    accepts(AdminUsersResponse, { users: [], nextCursor: "eyJpZCI6MX0" });
    accepts(AdminUserResponse, {
      user: userView(USER),
      providers: { state: "read", items: ["apple", "google"] },
      sessions: { state: "read", items: [sessionView(SESSION)], truncated: false },
      devices: { state: "read", items: [deviceView(DEVICE)], truncated: true },
    });
    // And the state each list takes when its read failed (#380): no rows, no truncation flag, no
    // reason. A client that reached for `items` here would not compile.
    accepts(AdminUserResponse, {
      user: userView(USER),
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
