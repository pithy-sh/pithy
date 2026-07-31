// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { HttpError } from "@pithy-sh/core/src/error/http";
import { PublicErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  TestersAlreadyOnRosterError,
  TestersCohortNotFoundError,
  TestersCopyNotAllowedError,
  TestersInvalidTokenError,
  TestersMemberNotFoundError,
  TestersNotConfiguredError,
  TestersNudgeCooldownError,
  TestersRosterFullError,
} from "./errors";

/** Every vehicle, with the code and status core's union pins for it. */
const FAMILY = [
  { error: TestersCohortNotFoundError, code: "testers/cohort_not_found", status: 404 },
  { error: TestersMemberNotFoundError, code: "testers/member_not_found", status: 404 },
  { error: TestersInvalidTokenError, code: "testers/invalid_token", status: 400 },
  { error: TestersRosterFullError, code: "testers/roster_full", status: 409 },
  { error: TestersAlreadyOnRosterError, code: "testers/already_on_roster", status: 409 },
  { error: TestersNudgeCooldownError, code: "testers/nudge_cooldown", status: 429 },
  { error: TestersCopyNotAllowedError, code: "testers/copy_not_allowed", status: 403 },
  { error: TestersNotConfiguredError, code: "testers/not_configured", status: 500 },
] as const;

describe("the testers error family", () => {
  test("each vehicle carries its code and the status core's union pins", () => {
    for (const { error: Vehicle, code, status } of FAMILY) {
      const thrown = new Vehicle();
      expect(thrown).toBeInstanceOf(PithyError);
      expect(thrown.payload.code).toBe(code);
      expect(thrown.payload.status).toBe(status);
    }
  });

  test("constructing one at all proves it is registered in core's closed union", () => {
    // `PithyError`'s constructor runs `ErrorPayload.parse`, so an unregistered code cannot be thrown.
    // That is what makes this file's existence a check rather than a declaration.
    for (const { error: Vehicle } of FAMILY) expect(() => new Vehicle()).not.toThrow();
  });

  test("every code is in the testers domain, matching the table prefix and the migration namespace", () => {
    for (const { code } of FAMILY) expect(code.startsWith("testers/")).toBe(true);
  });

  test("every default message and action is safe to hand a stranger", () => {
    // The opt-in route answers unauthenticated strangers, so anything it says is said to everyone.
    for (const { error: Vehicle } of FAMILY) {
      const { payload } = new Vehicle();
      expect(payload.message.length).toBeGreaterThan(0);
      expect(payload.action?.length ?? 0).toBeGreaterThan(0);
      expect(payload.message).not.toMatch(/@/); // no address
      expect(payload.message).not.toMatch(/cohort-|member-/); // no identifier
    }
  });

  test("`detail` never reaches the wire", () => {
    // The single security boundary. `detail` names which verification step a token failed; a client
    // that could read it would have an oracle for forging one.
    const thrown = new TestersInvalidTokenError({ detail: "token signature does not verify" });
    const wire = HttpError.encode(thrown.payload);
    expect(JSON.stringify(wire)).not.toContain("signature");
    expect(PublicErrorPayload.parse(wire)).not.toHaveProperty("detail");
  });

  test("every token failure produces one indistinguishable public message", () => {
    // A stranger holding a guess learns only that it did not work — not whether the signature was
    // wrong, whether it expired, or whether the cohort it named exists.
    const reasons = ["malformed", "expired", "bad signature", "unknown kid", "wrong purpose"];
    const messages = reasons.map((detail) => new TestersInvalidTokenError({ detail }).payload.message);
    expect(new Set(messages).size).toBe(1);
  });

  test("a caller may override the message and action, and the code stays fixed", () => {
    const thrown = new TestersRosterFullError({ message: "Full.", action: "Remove someone." });
    expect(thrown.payload.message).toBe("Full.");
    expect(thrown.payload.code).toBe("testers/roster_full");
  });

  test("a cause is preserved for the log without leaking into the payload", () => {
    const cause = new Error("underlying");
    const thrown = new TestersInvalidTokenError({ detail: "d" }, { cause });
    expect(thrown.cause).toBe(cause);
    expect(JSON.stringify(HttpError.encode(thrown.payload))).not.toContain("underlying");
  });
});
