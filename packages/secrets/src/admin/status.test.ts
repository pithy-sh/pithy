// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  SecretRotationsResponse,
  SecretRotationView,
  SecretStatusView,
  SecretsStatusResponse,
} from "../http/responses";
import { overdueAgainst, SecretRotationRecord, SecretStatus } from "./status";

/**
 * The gate on the exposed shape.
 *
 * `SECRET_STATUS_CARRIES_NO_VALUE` and `SECRET_RESPONSES_CARRY_NO_VALUE` already fail the *typecheck*
 * if a value-bearing field is added, and they are the stronger of the two checks — a compile error
 * cannot be merged. These tests exist for the case that guard cannot cover: a field that is not on the
 * banned list at all.
 *
 * **The field sets are asserted exactly, so any addition fails here.** That is deliberate friction. A
 * new fact on this surface is a new thing a management credential learns about somebody's production
 * secrets, and the review it deserves is somebody editing this list and saying why. A `toContain` check
 * would let a field arrive unread, which is precisely how `metadataSnapshot` would have arrived.
 */

const STATUS_FIELDS = [
  "backend",
  "createdAt",
  "keyVersion",
  "lastRotatedAt",
  "name",
  "overdue",
  "rotatable",
  "rotateEveryDays",
  "rotationCount",
  "updatedAt",
  "valueType",
];

const ROTATION_FIELDS = ["completedAt", "rotatedBy", "startedAt", "status", "trigger"];

/** Every spelling of a value, an envelope around one, or free text written where one is in scope. */
const NEVER = [
  "encryptedValue",
  "encrypted_value",
  "iv",
  "value",
  "plaintext",
  "secret",
  "metadataSnapshot",
  "metadata_snapshot",
  "errorMessage",
  "error_message",
];

describe("the status shape", () => {
  test("one secret's status carries exactly these fields", () => {
    expect(Object.keys(SecretStatus.shape).sort()).toEqual(STATUS_FIELDS);
    expect(Object.keys(SecretStatusView.shape).sort()).toEqual(STATUS_FIELDS);
  });

  test("one rotation carries exactly these fields", () => {
    expect(Object.keys(SecretRotationRecord.shape).sort()).toEqual(ROTATION_FIELDS);
    expect(Object.keys(SecretRotationView.shape).sort()).toEqual(ROTATION_FIELDS);
  });

  test("no shape on this surface names a value, a ciphertext, a snapshot, or a failure message", () => {
    // The runtime half of the compile-time tripwire, stated over the wire objects a client actually
    // receives — including the envelopes, so a field cannot be smuggled in beside the array.
    const shapes = {
      SecretStatus: SecretStatus.shape,
      SecretStatusView: SecretStatusView.shape,
      SecretRotationRecord: SecretRotationRecord.shape,
      SecretRotationView: SecretRotationView.shape,
      SecretsStatusResponse: SecretsStatusResponse.shape,
      SecretRotationsResponse: SecretRotationsResponse.shape,
    };
    for (const [name, shape] of Object.entries(shapes)) {
      for (const banned of NEVER) expect(Object.keys(shape), `${name}.${banned}`).not.toContain(banned);
    }
  });

  test("an unknown column is stripped rather than passed through", () => {
    // The third layer: even a query that selected too much cannot reach a client, because the row is
    // parsed through the shape and Zod drops what the shape does not name.
    const parsed = SecretRotationRecord.parse({
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      status: "success",
      trigger: "cron",
      rotatedBy: "wf-1",
      errorMessage: "decrypt failed for value sk_live_oops",
      metadataSnapshot: '{"value":"sk_live_oops"}',
    });
    expect(JSON.stringify(parsed)).not.toContain("sk_live_oops");
    expect(Object.keys(parsed).sort()).toEqual(ROTATION_FIELDS);
  });
});

describe("overdue", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  test("is null when no cadence is declared — the capability has said nothing, so nothing is late", () => {
    expect(overdueAgainst(daysAgo(4000), null, now)).toBeNull();
  });

  test("is null when there is no date to measure from, rather than a comfortable false", () => {
    expect(overdueAgainst(null, 90, now)).toBeNull();
  });

  test("is false inside the cadence and true past it", () => {
    expect(overdueAgainst(daysAgo(89), 90, now)).toBe(false);
    expect(overdueAgainst(daysAgo(91), 90, now)).toBe(true);
  });

  test("the boundary itself is not yet late", () => {
    // Exactly 90 days on a 90-day cadence is the last moment it is in date; a strict comparison is what
    // keeps a daily job from reporting overdue one run early, every cycle, forever.
    expect(overdueAgainst(daysAgo(90), 90, now)).toBe(false);
  });
});
