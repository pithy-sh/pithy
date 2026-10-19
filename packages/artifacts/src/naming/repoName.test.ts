// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { describe, expect, test } from "vitest";
import { assertRepoName, generatedRepoName, REPO_NAME_CHARSET } from "./repoName";

describe("a repository's physical name", () => {
  test("a generated one is a UUID, inside Cloudflare's charset and the cap", () => {
    for (let i = 0; i < 200; i += 1) {
      const name = generatedRepoName();
      expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(name).toMatch(REPO_NAME_CHARSET);
      expect(name.length).toBeGreaterThanOrEqual(NAMESPACE_LIMITS.artifactsRepo.minLength);
      expect(name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.artifactsRepo.maxLength);
      expect(() => assertRepoName(name)).not.toThrow();
    }
  });

  test("two generated names never collide", () => {
    const names = new Set(Array.from({ length: 500 }, generatedRepoName));
    expect(names.size).toBe(500);
  });

  test("a supplied one outside the charset is refused, naming the rule, and never rewritten", () => {
    for (const bad of ["-leading", ".leading", "has/slash", "has space", "üñî", "a..b/../c"]) {
      let caught: unknown;
      try {
        assertRepoName(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught, bad).toBeInstanceOf(PithyError);
      expect((caught as PithyError).payload.code).toBe("artifacts/invalid_name");
      expect((caught as PithyError).payload.message).toMatch(/letter or digit/);
    }
  });

  test("a supplied one outside the cap is refused, naming the cap, and never truncated", () => {
    for (const bad of ["a", "a".repeat(64)]) {
      let caught: unknown;
      try {
        assertRepoName(bad);
      } catch (error) {
        caught = error;
      }
      expect((caught as PithyError).payload.code).toBe("artifacts/invalid_name");
      expect((caught as PithyError).payload.message).toMatch(/2 to 63 characters/);
    }
    expect(assertRepoName("a".repeat(63))).toBe("a".repeat(63));
    expect(assertRepoName("Docs_v2.1-final")).toBe("Docs_v2.1-final");
  });
});
