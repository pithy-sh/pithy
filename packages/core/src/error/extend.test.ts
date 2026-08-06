// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defineErrorPayload, type ErrorPayloadOf, isErrorCode } from "./extend";
import { ErrorPayload } from "./payload";
import { PithyError, ValidationError } from "./pithyError";

describe("defineErrorPayload (the adopter's way into the union)", () => {
  test("returns a payload a PithyError carries like any other", () => {
    const err = new PithyError(
      defineErrorPayload({
        code: "connect/device_code_expired",
        status: 410,
        message: "That device code has expired.",
        action: "Run pithy dashboard connect again.",
        detail: "code 9f2c, issued 11m ago",
      }),
    );
    expect(err).toBeInstanceOf(PithyError);
    expect(err.message).toBe("That device code has expired.");
    expect(err.payload.code).toBe("connect/device_code_expired");
    expect(err.payload.status).toBe(410);
    expect(err.payload.detail).toBe("code 9f2c, issued 11m ago");
  });

  test("the payload it returns validates as an ErrorPayload", () => {
    const payload = defineErrorPayload({ code: "keys/rotation_locked", status: 409, message: "Rotation in progress." });
    expect(() => ErrorPayload.parse(payload)).not.toThrow();
  });

  test("refuses a code the kit already defines — and says so", () => {
    // @ts-expect-error — `auth/` is the kit's; the signature refuses it before the parse does.
    expect(() => defineErrorPayload({ code: "auth/forbidden", status: 403, message: "x" })).toThrow(PithyError);
    // @ts-expect-error — same, and the runtime message still names the offending code.
    expect(() => defineErrorPayload({ code: "auth/forbidden", status: 403, message: "x" })).toThrow(/auth\/forbidden/);
  });

  test("refuses a domain the kit reserves, even for a reason the kit never uses", () => {
    // @ts-expect-error — reserved domain, refused at the declaration.
    expect(() => defineErrorPayload({ code: "auth/my_own_reason", status: 403, message: "x" })).toThrow(PithyError);
    // @ts-expect-error — reserved domain, refused at the declaration.
    expect(() => defineErrorPayload({ code: "email/my_own_reason", status: 400, message: "x" })).toThrow(PithyError);
  });

  test("a kit domain does not compile — the mistake is caught before anything is thrown", () => {
    // The runtime guard above is the second gate. This is the first: a reserved domain is a type
    // error at the declaration, so it fails the build rather than the first request that hits it.
    // @ts-expect-error — `payments/` is the kit's.
    const reserved = () => defineErrorPayload({ code: "payments/my_own_reason", status: 402, message: "x" });
    expect(reserved).toThrow(PithyError);
  });

  test("refuses a code segment long enough to be a payload of its own", () => {
    expect(() => defineErrorPayload({ code: `connect/${"a".repeat(200)}`, status: 400, message: "x" })).toThrow(
      PithyError,
    );
  });

  test("refuses a code that is not `domain/reason`", () => {
    // A missing slash is a compile error too — the signature is the first gate, this is the second.
    // @ts-expect-error — deliberately unnamespaced
    expect(() => defineErrorPayload({ code: "rotationlocked", status: 409, message: "x" })).toThrow(PithyError);
    expect(() => defineErrorPayload({ code: "keys/Rotation Locked", status: 409, message: "x" })).toThrow(PithyError);
  });

  test("refuses a status that is not a 4xx or 5xx", () => {
    expect(() => defineErrorPayload({ code: "keys/rotation_locked", status: 200, message: "x" })).toThrow(PithyError);
    expect(() => defineErrorPayload({ code: "keys/rotation_locked", status: 700, message: "x" })).toThrow(PithyError);
  });

  test("an author error names the offending code publicly and never echoes the caller's detail", () => {
    try {
      // @ts-expect-error — reserved domain; the point here is what the runtime failure says.
      defineErrorPayload({ code: "auth/forbidden", status: 403, message: "x", detail: "tenant 42 secret" });
      throw new Error("expected a throw");
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      expect(error.payload.message).toContain("auth/forbidden");
      expect(JSON.stringify(error.payload)).not.toContain("tenant 42 secret");
    }
  });

  test("a rejected code is quoted into the public message bounded, never whole", () => {
    // `message` is the half that reaches a client. A caller who casts their way to a dynamic code
    // must not be able to reflect a megabyte of it back through a 500 body.
    try {
      defineErrorPayload({ code: `connect/${"a".repeat(5000)}`, status: 400, message: "x" });
      throw new Error("expected a throw");
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      expect(error.payload.message.length).toBeLessThan(200);
    }
  });
});

describe("narrowing (an adopter's code discriminates like a kit code)", () => {
  const expired = () =>
    defineErrorPayload({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
      detail: "code 9f2c",
    });

  test("isErrorCode narrows a caught payload to the adopter's member", () => {
    const payload: ErrorPayload = new PithyError(expired()).payload;
    if (!isErrorCode(payload, "connect/device_code_expired")) throw new Error("narrowing failed");
    expect(payload.detail).toBe("code 9f2c");
    expect(payload.status).toBe(410);
  });

  test("isErrorCode says no to a payload carrying another code", () => {
    const payload: ErrorPayload = new PithyError(expired()).payload;
    expect(isErrorCode(payload, "keys/rotation_locked")).toBe(false);
    expect(isErrorCode(payload, "core/internal")).toBe(false);
  });

  test("isErrorCode narrows a kit code to exactly its member", () => {
    const payload: ErrorPayload = new ValidationError({
      issues: [{ path: ["email"], message: "Required", code: "invalid_type" }],
    }).payload;
    if (!isErrorCode(payload, "validation/invalid_input")) throw new Error("narrowing failed");
    // `.issues` resolves only because the guard narrowed away every other member, the open one included.
    expect(payload.issues[0]?.path).toEqual(["email"]);
  });

  test("ErrorPayloadOf types a vehicle class, the way every kit subclass is typed", () => {
    class DeviceCodeExpiredError extends PithyError {
      declare readonly payload: ErrorPayloadOf<"connect/device_code_expired">;

      constructor(detail?: string) {
        super(
          defineErrorPayload({
            code: "connect/device_code_expired",
            status: 410,
            message: "That device code has expired.",
            detail,
          }),
        );
      }
    }

    const err = new DeviceCodeExpiredError("code 9f2c");
    // `status` on a `never` payload is a type error, which is what this line is really asserting.
    expect(err.payload.status).toBe(410);
    expect(err.payload.code).toBe("connect/device_code_expired");
  });
});
