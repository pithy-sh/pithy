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
});
