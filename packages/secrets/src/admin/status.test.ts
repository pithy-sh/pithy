// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SecretRotation } from "@pithy-sh/core/src/capability/secretOrigin";
import { describe, expect, test } from "vitest";
import {
  SecretRotateResponse,
  SecretRotationOutcomeView,
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
  // Added by #372, and this is the argument the list demands. **No value fits in it.** `rotation` is
  // core's `SecretRotation` — a kind, an issuer from a closed vocabulary, and an `https:` documentation
  // URL — copied verbatim from a registry entry `defineSecretRegistry` already validated. It is the field
  // a client branches on to decide whether a rotation control exists at all, and without it every client's
  // only conservative reading is to offer none: `rotatable` answers a different question (whether the
  // stored envelope may accumulate versions) and two secrets in this repository prove they disagree.
  "rotation",
  "rotationCount",
  "updatedAt",
  "valueType",
];

/**
 * Every field of the rotation **outcome** a client receives from `POST {base}/admin/status/:name/rotate`.
 *
 * Asserted exactly for the same reason the two above are, and with one field of the core's own
 * `SecretRotationOutcome` deliberately missing: `cause`. It is typed `unknown`, it holds whatever the store
 * threw, and an exception raised where a value was in scope is the classic way a value reaches a place
 * nobody meant it to. It has no key here, so no projection can forward it.
 */
const ROTATE_FIELDS = ["attempts", "kind", "name", "reason", "recorded", "rollFailed", "rolled", "status", "stranded"];

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

  test("one rotation outcome carries exactly these fields, and `cause` is not among them", () => {
    expect(Object.keys(SecretRotationOutcomeView.shape).sort()).toEqual(ROTATE_FIELDS);
    expect(Object.keys(SecretRotationOutcomeView.shape)).not.toContain("cause");
  });

  test("the rotation declaration a status read publishes is a kind, an issuer and a page — and nothing else", () => {
    // The one field #372 added, and the only reason it is safe to add: **every member** of the union it
    // carries is metadata by construction, so there is no shape of declaration that could put a value on
    // this surface. Asserted over each member rather than over the union, because a union passes a
    // property check on the strength of its narrowest member, and `local` is a single literal.
    const allowed = ["documentation", "issuer", "kind"];
    for (const member of SecretRotation.options) {
      const keys = Object.keys(member.shape).sort();
      expect(
        keys.filter((key) => !allowed.includes(key)),
        String(member.shape.kind.value),
      ).toEqual([]);
    }
    // Not vacuous — the member that carries the most is found, so a union emptied of its issuer would fail
    // rather than pass for holding less.
    expect(SecretRotation.options.map((member) => Object.keys(member.shape).length).sort()).toEqual([1, 3, 3]);
  });

  test("a status read reports the declaration, and reports null when there is none", () => {
    // Null is a third answer, not a missing one: `manual` means somebody said a human replaces this, and
    // null means nobody has said anything. A client that renders the two identically tells an operator a
    // secret needs a console visit on the strength of an empty registry entry.
    const row = {
      name: "gitlab-token",
      backend: "d1",
      valueType: "text",
      rotatable: true,
      rotation: { kind: "manual", issuer: "gitlab", documentation: "https://gitlab.example/settings/tokens" },
      keyVersion: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastRotatedAt: null,
      rotationCount: 0,
      rotateEveryDays: null,
      overdue: null,
    };
    expect(SecretStatus.parse(row).rotation).toEqual({
      kind: "manual",
      issuer: "gitlab",
      documentation: "https://gitlab.example/settings/tokens",
    });
    expect(SecretStatus.parse({ ...row, rotation: null }).rotation).toBeNull();
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
      SecretRotationOutcomeView: SecretRotationOutcomeView.shape,
      SecretRotateResponse: SecretRotateResponse.shape,
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
