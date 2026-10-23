// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { auditedLifecycleCall, recordLifecycleRefusal } from "./audited";

/**
 * Every lifecycle call is audited, the ones that changed nothing included (#621). A transition that moved the
 * account audits itself, beside its history row; this covers the two kinds of call it does not: a refusal,
 * and a call that found the account already where it was asked to put it.
 */

const CALL = {
  action: "auth/admin_user_suspended",
  subject: "ops@dashboard.test",
  connectionId: "c-1",
  userId: "u-1",
  reason: "Chargeback under review.",
  ip: "203.0.113.7",
  userAgent: "Ops/1",
  requestId: "ray-1",
};

function recorder(): { events: AuditEventInput[]; emit: (event: AuditEventInput) => Promise<void> } {
  const events: AuditEventInput[] = [];
  return { events, emit: async (event) => void events.push(event) };
}

describe("auditedLifecycleCall", () => {
  test("a call that changed the account writes nothing more: the transition already audited it", async () => {
    const { events, emit } = recorder();
    const result = await auditedLifecycleCall(
      emit,
      CALL,
      async () => ({ changed: true }),
      () => false,
    );
    expect(result).toEqual({ changed: true });
    expect(events).toEqual([]);
  });

  test("a call that changed nothing is still recorded, as a success that changed nothing", async () => {
    const { events, emit } = recorder();
    await auditedLifecycleCall(
      emit,
      CALL,
      async () => ({ changed: false }),
      (result) => !result.changed,
    );
    expect(events).toEqual([
      expect.objectContaining({
        action: CALL.action,
        outcome: "success",
        actorType: "control-plane",
        actorId: CALL.subject,
        resourceType: "user",
        resourceId: CALL.userId,
        ip: CALL.ip,
        userAgent: CALL.userAgent,
        requestId: CALL.requestId,
        metadata: { connectionId: "c-1", reason: CALL.reason, changed: false },
      }),
    ]);
  });

  test("a refusal is recorded as denied with its code, and still thrown", async () => {
    const { events, emit } = recorder();
    for (const error of [new NotFoundError({ message: "No such account." }), new ConflictError({ message: "x" })]) {
      await expect(
        auditedLifecycleCall(
          emit,
          CALL,
          async () => {
            throw error;
          },
          () => false,
        ),
      ).rejects.toBe(error);
    }
    expect(events.map((event) => [event.outcome, event.metadata])).toEqual([
      ["denied", { connectionId: "c-1", reason: CALL.reason, changed: false, code: "core/not_found" }],
      ["denied", { connectionId: "c-1", reason: CALL.reason, changed: false, code: "core/conflict" }],
    ]);
  });

  test("a fault is a failure, not a refusal, and so is anything that is not a PithyError", async () => {
    const { events, emit } = recorder();
    for (const error of [new InternalError({ message: "x" }), new TypeError("d1 went away")]) {
      await expect(
        auditedLifecycleCall(
          emit,
          CALL,
          async () => {
            throw error;
          },
          () => false,
        ),
      ).rejects.toBe(error);
    }
    expect(events.map((event) => [event.outcome, (event.metadata as { code?: string }).code])).toEqual([
      ["failure", "core/internal"],
      ["failure", "core/internal"],
    ]);
  });

  test("an audit write that fails breaks nothing it records", async () => {
    const emit = async (): Promise<void> => {
      throw new Error("audit is down");
    };
    await expect(
      auditedLifecycleCall(
        emit,
        CALL,
        async () => ({ changed: false }),
        () => true,
      ),
    ).resolves.toEqual({ changed: false });
  });
});

describe("recordLifecycleRefusal", () => {
  const FALLBACK = { code: "validation/invalid_input", outcome: "denied" } as const;

  test("a refused body is denied with its own code, and the reason it carried, or null", async () => {
    const { events, emit } = recorder();
    await recordLifecycleRefusal(emit, { ...CALL, reason: null }, new NotFoundError({ message: "x" }), FALLBACK);
    expect(events).toEqual([
      expect.objectContaining({
        action: CALL.action,
        outcome: "denied",
        resourceId: CALL.userId,
        metadata: { connectionId: CALL.connectionId, reason: null, changed: false, code: "core/not_found" },
      }),
    ]);
  });

  test("a throw with no code of its own, such as a body that is not JSON, takes the fallback's", async () => {
    const { events, emit } = recorder();
    await recordLifecycleRefusal(emit, CALL, new Error("Malformed JSON in request body"), FALLBACK);
    await recordLifecycleRefusal(emit, CALL, new Error("no fallback"));
    expect(events.map((event) => [event.outcome, (event.metadata as { code?: string }).code])).toEqual([
      ["denied", "validation/invalid_input"],
      ["failure", "core/internal"],
    ]);
  });
});
