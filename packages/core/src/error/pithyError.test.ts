// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ErrorPayload } from "./payload";
import {
  ConflictError,
  ForbiddenError,
  fromZodError,
  InternalError,
  NotFoundError,
  PithyError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "./pithyError";

describe("PithyError (the throw/catch vehicle)", () => {
  test("is a real Error carrying a validated payload", () => {
    const err = new PithyError({ code: "core/not_found", status: 404, message: "Not found." });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PithyError");
    expect(err.message).toBe("Not found.");
    expect(err.payload.code).toBe("core/not_found");
  });

  test("validates its payload — a malformed payload throws at construction", () => {
    // @ts-expect-error — deliberately invalid code/status pairing
    expect(() => new PithyError({ code: "auth/forbidden", status: 401, message: "x" })).toThrow();
  });

  test("preserves the cause", () => {
    const cause = new Error("root");
    const err = new PithyError({ code: "core/internal", status: 500, message: "boom" }, { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("subclasses (sugar over the same payload)", () => {
  const cases = [
    { Cls: ValidationError, code: "validation/invalid_input", status: 400 },
    { Cls: UnauthorizedError, code: "auth/invalid_token", status: 401 },
    { Cls: ForbiddenError, code: "auth/forbidden", status: 403 },
    { Cls: NotFoundError, code: "core/not_found", status: 404 },
    { Cls: ConflictError, code: "core/conflict", status: 409 },
    { Cls: RateLimitError, code: "rate_limit/exceeded", status: 429 },
    { Cls: InternalError, code: "core/internal", status: 500 },
  ] as const;

  test("every subclass is both a PithyError and its own type, with matching code/status", () => {
    for (const { Cls, code, status } of cases) {
      const err = new Cls();
      expect(err).toBeInstanceOf(PithyError);
      expect(err).toBeInstanceOf(Cls);
      expect(err.payload.code).toBe(code);
      expect(err.payload.status).toBe(status);
    }
  });

  test("META: no subclass drifts from its union member (defaults parse as a valid ErrorPayload)", () => {
    for (const { Cls, code, status } of cases) {
      const parsed = ErrorPayload.parse(new Cls().payload);
      expect(parsed.code).toBe(code);
      expect(parsed.status).toBe(status);
    }
  });

  test("accepts a custom message, action, and internal detail", () => {
    const err = new ForbiddenError({ message: "No.", action: "Ask an admin.", detail: "user 5 lacks role:admin" });
    expect(err.payload.message).toBe("No.");
    expect(err.payload.action).toBe("Ask an admin.");
    expect(err.payload.detail).toBe("user 5 lacks role:admin");
  });

  test("ValidationError narrows to carry issues", () => {
    const err = new ValidationError({ issues: [{ path: ["email"], message: "Required", code: "invalid_type" }] });
    expect(err.payload.issues[0]?.path).toEqual(["email"]);
  });
});

describe("fromZodError", () => {
  test("maps a ZodError to a validation/invalid_input PithyError with field-level issues", () => {
    const schema = z.object({ email: z.string(), age: z.number() });
    const parsed = schema.safeParse({ age: "old" });
    if (parsed.success) throw new Error("expected a failure");

    const err = fromZodError(parsed.error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.payload.code).toBe("validation/invalid_input");
    expect(err.payload.status).toBe(400);
    const paths = err.payload.issues.map((i) => i.path.join("."));
    expect(paths).toContain("email");
    expect(paths).toContain("age");
  });
});
