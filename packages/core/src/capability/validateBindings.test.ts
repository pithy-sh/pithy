// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { validateBindings } from "./validateBindings";

describe("validateBindings", () => {
  test("passes when all required bindings are present", () => {
    expect(() =>
      validateBindings({ DB: {}, SESSIONS: {} }, [
        { type: "d1", name: "DB", optional: false },
        { type: "kv", name: "SESSIONS", optional: false },
      ]),
    ).not.toThrow();
  });

  test("throws listing every missing required binding", () => {
    expect(() =>
      validateBindings({ DB: {} }, [
        { type: "d1", name: "DB", optional: false },
        { type: "kv", name: "SESSIONS", optional: false },
        { type: "email", name: "EMAIL", optional: false },
      ]),
    ).toThrow(/Missing required bindings: kv:SESSIONS, email:EMAIL/);
  });

  test("throws a typed PithyError (core/internal), not a plain Error", () => {
    try {
      validateBindings({}, [{ type: "d1", name: "DB", optional: false }]);
      throw new Error("expected validateBindings to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PithyError);
      expect((err as PithyError).payload.code).toBe("core/internal");
    }
  });

  test("ignores optional bindings", () => {
    expect(() => validateBindings({}, [{ type: "kv", name: "CACHE", optional: true }])).not.toThrow();
  });

  test("names the missing bindings in the action, so the fix is the line itself", () => {
    try {
      validateBindings({}, [{ type: "kv", name: "SESSIONS", optional: false }]);
      throw new Error("expected validateBindings to throw");
    } catch (err) {
      expect((err as PithyError).payload.action).toBe("Add kv:SESSIONS to wrangler.jsonc, then redeploy.");
    }
  });

  test("a provisioned binding is not sent to wrangler.jsonc — nobody hand-writes a Secrets Store entry", () => {
    try {
      validateBindings({}, [{ type: "secret", name: "SECRETS_ENCRYPTION_KEYS", optional: false }]);
      throw new Error("expected validateBindings to throw");
    } catch (err) {
      const action = (err as PithyError).payload.action ?? "";
      expect(action).not.toMatch(/Add .* to wrangler\.jsonc/);
      expect(action).toMatch(/Provision secret:SECRETS_ENCRYPTION_KEYS/);
      expect(action).toMatch(/\.dev\.vars/);
    }
  });

  test("a mixed set gets both answers, each naming only its own bindings", () => {
    try {
      validateBindings({}, [
        { type: "d1", name: "DB", optional: false },
        { type: "workflow", name: "EMAIL_SENDER", optional: false },
      ]);
      throw new Error("expected validateBindings to throw");
    } catch (err) {
      const action = (err as PithyError).payload.action ?? "";
      expect(action).toMatch(/Add d1:DB to wrangler\.jsonc/);
      expect(action).toMatch(/Provision workflow:EMAIL_SENDER/);
    }
  });
});
