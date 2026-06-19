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

  // Turnstile is a humanity check applied as composable middleware, never a route's identity
  // strategy (CLAUDE.md §HTTP). It must never re-enter this union — a bot check answers "is this a
  // human?", never "who is this?". This meta-test guards the removal so the contradiction can't return.
  test("does not include turnstile — it is middleware, not an identity strategy", () => {
    expect(() => VerificationStrategy.parse("turnstile")).toThrow();
    const literals = VerificationStrategy.options.map((option) => option.value);
    expect(literals).not.toContain("turnstile");
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
