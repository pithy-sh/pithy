import { describe, expect, test } from "vitest";
import { ErrorPayload, PublicErrorPayload, ValidationIssue } from "./payload";

describe("ErrorPayload (the closed taxonomy)", () => {
  test("accepts a well-formed member and narrows on `code`", () => {
    const parsed = ErrorPayload.parse({
      code: "auth/forbidden",
      status: 403,
      message: "Forbidden.",
    });
    expect(parsed.code).toBe("auth/forbidden");
    expect(parsed.status).toBe(403);
  });

  test("rejects an unknown code", () => {
    expect(() => ErrorPayload.parse({ code: "nope/unknown", status: 400, message: "x" })).toThrow();
  });

  test("rejects a status that does not match its code", () => {
    expect(() => ErrorPayload.parse({ code: "auth/forbidden", status: 401, message: "x" })).toThrow();
  });

  test("carries an optional internal `detail`", () => {
    const parsed = ErrorPayload.parse({
      code: "core/internal",
      status: 500,
      message: "Something unexpected happened.",
      detail: "stack-ish context",
    });
    expect(parsed.detail).toBe("stack-ish context");
  });

  test("the validation member carries field-level issues", () => {
    const parsed = ErrorPayload.parse({
      code: "validation/invalid_input",
      status: 400,
      message: "Invalid input.",
      issues: [{ path: ["email"], message: "Required", code: "invalid_type" }],
    });
    if (parsed.code !== "validation/invalid_input") throw new Error("narrowing failed");
    expect(parsed.issues[0]?.path).toEqual(["email"]);
  });

  test("covers every code in the initial taxonomy", () => {
    const taxonomy: Array<[string, number]> = [
      ["validation/invalid_input", 400],
      ["auth/invalid_token", 401],
      ["auth/forbidden", 403],
      ["core/not_found", 404],
      ["core/conflict", 409],
      ["rate_limit/exceeded", 429],
      ["core/internal", 500],
    ];
    for (const [code, status] of taxonomy) {
      const base: Record<string, unknown> = { code, status, message: "m" };
      if (code === "validation/invalid_input") base.issues = [];
      expect(() => ErrorPayload.parse(base)).not.toThrow();
    }
  });
});

describe("PublicErrorPayload (the wire shape)", () => {
  test("strips `detail` on parse — it is not part of the public shape", () => {
    const parsed = PublicErrorPayload.parse({
      code: "core/internal",
      status: 500,
      message: "Something unexpected happened.",
      detail: "secret context",
    });
    expect("detail" in parsed).toBe(false);
  });
});

describe("ValidationIssue", () => {
  test("validates a field-level failure", () => {
    const issue = ValidationIssue.parse({ path: ["user", 0, "email"], message: "Required", code: "invalid_type" });
    expect(issue.path).toEqual(["user", 0, "email"]);
  });
});
