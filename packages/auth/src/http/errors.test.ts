import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { APIError } from "better-auth/api";
import { describe, expect, test } from "vitest";
import { apiErrorToPithy } from "./errors";

describe("apiErrorToPithy", () => {
  test.each([
    ["BAD_REQUEST", 400, "auth/invalid_token", "validation/invalid_input"],
    ["UNAUTHORIZED", 401, "x", "auth/invalid_token"],
    ["FORBIDDEN", 403, "x", "auth/forbidden"],
    ["NOT_FOUND", 404, "x", "core/not_found"],
    ["CONFLICT", 409, "x", "core/conflict"],
    ["TOO_MANY_REQUESTS", 429, "x", "rate_limit/exceeded"],
    ["INTERNAL_SERVER_ERROR", 500, "x", "core/internal"],
  ])("maps a Better-Auth %s to %s → PithyError %s", (status, _code, _ignore, expectedCode) => {
    const pithy = apiErrorToPithy(new APIError(status as never, { message: "boom", code: "SOME_CODE" }));
    expect(pithy).toBeInstanceOf(PithyError);
    expect(pithy.payload.code).toBe(expectedCode);
  });

  test("surfaces the Better-Auth message for 4xx but keeps status/code in detail", () => {
    const pithy = apiErrorToPithy(new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" }));
    expect(pithy.payload.message).toBe("Invalid OTP");
    expect(pithy.payload.detail).toContain("INVALID_OTP");
  });

  test("uses a generic public message for 5xx (no leak), detail carries specifics", () => {
    const pithy = apiErrorToPithy(new APIError("INTERNAL_SERVER_ERROR", { message: "db exploded", code: "DB" }));
    expect(pithy.payload.message).toBe("Authentication failed.");
    expect(pithy.payload.detail).toContain("db exploded");
  });

  test("passes a PithyError through unchanged and wraps unknown throws as internal", () => {
    const existing = apiErrorToPithy(new APIError("FORBIDDEN", { message: "no" }));
    expect(apiErrorToPithy(existing)).toBe(existing);
    expect(apiErrorToPithy(new Error("weird")).payload.code).toBe("core/internal");
  });
});
