// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defineCapability } from "../capability/capability";
import type { AuditEventInput } from "./auditEvent";
import { composedAuditEmit } from "./composed";
import { noopEmit } from "./recorder";

const EVENT: AuditEventInput = { action: "auth/admin_user_purged", outcome: "success", actorType: "system" };

describe("composedAuditEmit (#622)", () => {
  test("records through the composed capability that provides a recorder, handed this env", async () => {
    const seen: { env: Record<string, unknown>; event: AuditEventInput }[] = [];
    const capabilities = [
      defineCapability({ name: "turnstile", requiredBindings: [] }),
      defineCapability({
        name: "audit",
        requiredBindings: [],
        auditRecorder: (env) => async (event) => void seen.push({ env, event: event as AuditEventInput }),
      }),
    ];
    const env = { DB: "the binding" };
    await composedAuditEmit(capabilities, env)(EVENT);
    expect(seen).toEqual([{ env, event: EVENT }]);
  });

  test("with no recorder composed it is the no-op, so a step can always record", () => {
    expect(composedAuditEmit([defineCapability({ name: "turnstile", requiredBindings: [] })], {})).toBe(noopEmit);
  });

  test("a recorder that throws is swallowed: an audit write never breaks what it records", async () => {
    const capabilities = [
      defineCapability({
        name: "audit",
        requiredBindings: [],
        auditRecorder: () => async () => {
          throw new Error("the audit table is gone");
        },
      }),
    ];
    await expect(composedAuditEmit(capabilities, {})(EVENT)).resolves.toBeUndefined();
  });
});
