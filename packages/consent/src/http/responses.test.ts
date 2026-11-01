// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { ExpiringGrant } from "../record/expiring";
import { ConsentAdminPurposesResponse, ConsentExpiringGrantView, ConsentExpiringResponse } from "./responses";
import { expiringGrantView, versionCountView } from "./views";

/**
 * The control plane's response schemas against what the projections produce. Equality, not `.parse()` alone: a
 * Zod object strips unknown keys, so only comparing the parsed value with the input fails a projection that grew
 * a field its schema never heard of.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const GRANT: ExpiringGrant = {
  recordId: "00000000-0000-4000-8000-000000000001",
  subject: { kind: "account", id: "user-ada" },
  purpose: "clinic.records",
  noticeVersion: 2,
  method: "typed",
  expiresAt: new Date("2026-11-20T00:00:00.000Z"),
  expired: false,
  documentHash: "a".repeat(64),
};

const PURPOSE = {
  id: "clinic.records",
  summary: "Keep my health record.",
  noticeVersion: 2,
  classes: ["phi"],
  explicit: true,
  minimumMethod: "typed",
  writtenWithdrawal: true,
} as const;

describe("consent control-plane response schemas", () => {
  test("an expiring grant is exactly what its schema declares, and carries no typed name or representative", () => {
    const view = expiringGrantView(GRANT);
    accepts(ConsentExpiringGrantView, view);
    expect(view).toEqual({
      recordId: GRANT.recordId,
      subject: GRANT.subject,
      purpose: "clinic.records",
      noticeVersion: 2,
      method: "typed",
      expiresAt: "2026-11-20T00:00:00.000Z",
      expired: false,
      documentHash: "a".repeat(64),
    });
    expect(Object.keys(view)).not.toContain("typedName");
    expect(Object.keys(view)).not.toContain("representative");
    accepts(ConsentExpiringResponse, { grants: [view], nextCursor: null });
  });

  test("a version's counts carry `expired` on this release", () => {
    const view = versionCountView({
      purpose: "clinic.records",
      noticeVersion: 2,
      grants: 3,
      withdrawals: 1,
      expired: 2,
    });
    expect(view).toEqual({ noticeVersion: 2, grants: 3, withdrawals: 1, expired: 2 });
    accepts(ConsentAdminPurposesResponse, { purposes: [{ purpose: PURPOSE, versions: [view] }] });
  });

  test("a Worker on an older release, which sends no `expired`, still parses", () => {
    accepts(ConsentAdminPurposesResponse, {
      purposes: [{ purpose: PURPOSE, versions: [{ noticeVersion: 2, grants: 3, withdrawals: 1 }] }],
    });
  });
});
