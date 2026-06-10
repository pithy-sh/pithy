import { describe, expect, test } from "vitest";
import { VerificationStrategy } from "./verification";

describe("VerificationStrategy", () => {
  test("accepts each known strategy", () => {
    for (const s of ["bearer", "session", "signed-webhook", "control-plane", "public"]) {
      expect(VerificationStrategy.parse(s)).toBe(s);
    }
  });

  test("rejects an unknown strategy", () => {
    expect(() => VerificationStrategy.parse("magic")).toThrow();
  });
});

describe("VerificationStrategy descriptions", () => {
  test("every option carries a non-empty description", () => {
    expect(VerificationStrategy.options).toHaveLength(5);
    for (const option of VerificationStrategy.options) {
      expect(option.description).toBeTruthy();
    }
  });
});
