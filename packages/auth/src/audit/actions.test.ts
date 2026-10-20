// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AuditAction } from "@pithy-sh/core/src/audit/auditEvent";
import { describe, expect, test } from "vitest";
import { AuthAuditActions } from "./actions";

describe("AuthAuditActions", () => {
  test("every action code is a valid core AuditAction in the auth domain", () => {
    for (const code of Object.values(AuthAuditActions)) {
      expect(AuditAction.parse(code)).toBe(code);
      expect(code.startsWith("auth/")).toBe(true);
    }
  });
});

describe("the account lifecycle actions (#620)", () => {
  test("all six are declared, under the names the lifecycle issues build on", () => {
    expect(AuthAuditActions).toMatchObject({
      adminUserSuspended: "auth/admin_user_suspended",
      adminUserReinstated: "auth/admin_user_reinstated",
      adminUserSoftDeleted: "auth/admin_user_soft_deleted",
      adminUserRestored: "auth/admin_user_restored",
      adminUserPurged: "auth/admin_user_purged",
      userSelfDeleted: "auth/user_self_deleted",
    });
  });
});
