// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { outsidePolicy, RECORD_VISIBILITIES, resolveVisibility, VisibilityPolicy } from "./visibility";

describe("VisibilityPolicy", () => {
  test("defaults to private, with every level allowed", () => {
    expect(VisibilityPolicy.parse({})).toEqual({ default: "private", allowed: [...RECORD_VISIBILITIES] });
  });

  test("a default outside allowed is refused at parse, naming both", () => {
    const result = VisibilityPolicy.safeParse({ default: "public", allowed: ["private", "organization"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("public");
    expect(result.error?.issues[0]?.message).toContain("private, organization");
    expect(result.error?.issues[0]?.path).toEqual(["default"]);
  });

  test("an empty allowed set is refused — a project must allow something", () => {
    expect(VisibilityPolicy.safeParse({ allowed: [] }).success).toBe(false);
  });

  test("a level it does not know is refused", () => {
    expect(VisibilityPolicy.safeParse({ default: "team" }).success).toBe(false);
  });

  test("[private, organization] is never public, and says so", () => {
    const policy = VisibilityPolicy.parse({ allowed: ["private", "organization"] });
    expect(policy.allowed).not.toContain("public");
  });
});

describe("resolveVisibility", () => {
  const policy = VisibilityPolicy.parse({ allowed: ["private", "organization"] });

  test("a write that names none takes the default", () => {
    expect(resolveVisibility(policy, undefined, "org-a")).toBe("private");
  });

  test("a write naming an allowed level keeps it", () => {
    expect(resolveVisibility(policy, "organization", "org-a")).toBe("organization");
  });

  test("a write naming a level outside allowed is refused with the allowed set named, never coerced", () => {
    let thrown: unknown;
    try {
      resolveVisibility(policy, "public", "org-a");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ payload: { code: "validation/invalid_input", status: 400 } });
    const payload = (thrown as { payload: { message: string; action: string } }).payload;
    expect(payload.message).toContain("private, organization");
    expect(payload.action).toContain("visibility.allowed");
  });

  test("organization with no organization in force is refused", () => {
    expect(() => resolveVisibility(policy, "organization", null)).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
    );
  });

  test("an organization default with no organization in force is refused too, not quietly made private", () => {
    const orgDefault = VisibilityPolicy.parse({ default: "organization" });
    expect(() => resolveVisibility(orgDefault, undefined, null)).toThrow();
  });
});

describe("outsidePolicy", () => {
  test("names the levels a narrowed policy no longer allows", () => {
    expect(outsidePolicy(VisibilityPolicy.parse({ allowed: ["private"] }))).toEqual(["organization", "public"]);
  });

  test("is empty when everything is allowed", () => {
    expect(outsidePolicy(VisibilityPolicy.parse({}))).toEqual([]);
  });
});
