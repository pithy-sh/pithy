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
