// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ancestorsOf, biomeCovers, globMatcher, oxlintIgnores, oxlintMatches, UnreadablePattern } from "./lintGlobs";

describe("globMatcher", () => {
  test("keeps `*` inside one segment and lets `**` span any number, none included", () => {
    expect(globMatcher("apps/*/src/*.ts")("apps/api/src/index.ts")).toBe(true);
    expect(globMatcher("apps/*/src/*.ts")("apps/api/src/deep/index.ts")).toBe(false);
    expect(globMatcher("**/apps/*/src/**/*.ts")("apps/api/src/index.ts")).toBe(true);
    expect(globMatcher("**/apps/*/src/**/*.ts")("apps/api/src/a/b/c.ts")).toBe(true);
    expect(globMatcher("./scripts/**")("scripts/x.ts")).toBe(true);
  });

  test("refuses a pattern it would have to guess at", () => {
    for (const glob of ["a?.ts", "[ab].ts", "{a,b}.ts", "a\\*.ts"]) {
      expect(() => globMatcher(glob)).toThrow(UnreadablePattern);
    }
  });
});

test("ancestorsOf lists each directory a path sits in, outermost first", () => {
  expect(ancestorsOf("apps/api/src/index.ts")).toEqual(["apps", "apps/api", "apps/api/src"]);
  expect(ancestorsOf("index.ts")).toEqual([]);
});

describe("biomeCovers", () => {
  test("lets the last matching pattern decide, and excludes a directory a negation names", () => {
    expect(biomeCovers(["**", "!**/*.test.ts"], "apps/a/src/x.ts")).toBe(true);
    expect(biomeCovers(["**", "!**/*.test.ts"], "apps/a/src/x.test.ts")).toBe(false);
    expect(biomeCovers(["**", "!**/src"], "apps/a/src/x.ts")).toBe(false);
  });

  test("refuses a list with no positive pattern, and a positive one naming only a directory", () => {
    expect(() => biomeCovers(["!**/dist"], "apps/a/src/x.ts")).toThrow(UnreadablePattern);
    expect(() => biomeCovers(["apps/a/src"], "apps/a/src/x.ts")).toThrow(UnreadablePattern);
    expect(() => biomeCovers("apps/**", "apps/a/src/x.ts")).toThrow(UnreadablePattern);
  });
});

describe("oxlintMatches", () => {
  test("matches a pattern with no slash against the file's name at any depth", () => {
    expect(oxlintMatches(["*.ts"], "apps/a/src/deep/y.ts")).toBe(true);
    expect(oxlintMatches(["*.test.ts"], "apps/a/src/x.ts")).toBe(false);
  });

  test("anchors a pattern with a slash at the config's directory", () => {
    expect(oxlintMatches(["apps/*/src/*.ts"], "apps/a/src/x.ts")).toBe(true);
    expect(oxlintMatches(["apps/*/src/*.ts"], "apps/a/src/deep/y.ts")).toBe(false);
    expect(oxlintMatches(["src/**"], "apps/a/src/x.ts")).toBe(false);
    expect(oxlintMatches(["/apps/**"], "apps/a/src/x.ts")).toBe(true);
  });

  test("refuses a negation, which Oxlint reads as everything that does not match", () => {
    expect(() => oxlintMatches(["**/*.ts", "!**/*.test.ts"], "apps/a/src/x.ts")).toThrow(UnreadablePattern);
    expect(() => oxlintMatches("**/*.ts", "apps/a/src/x.ts")).toThrow(UnreadablePattern);
  });
});

describe("oxlintIgnores", () => {
  test("reads gitignore-style: a bare name at any depth, a slashed path anchored, a trailing slash a directory", () => {
    expect(oxlintIgnores(["deep"], "apps/a/src/deep/y.ts")).toBe(true);
    expect(oxlintIgnores(["src/deep"], "apps/a/src/deep/y.ts")).toBe(false);
    expect(oxlintIgnores(["apps/a/src/deep"], "apps/a/src/deep/y.ts")).toBe(true);
    expect(oxlintIgnores(["*.test.ts"], "apps/a/src/x.test.ts")).toBe(true);
    expect(oxlintIgnores(["apps/a/src/deep/"], "apps/a/src/deep/y.ts")).toBe(true);
    expect(oxlintIgnores(["x.ts/"], "apps/a/src/x.ts")).toBe(false);
    expect(oxlintIgnores(["/apps"], "apps/a/src/x.ts")).toBe(true);
    expect(oxlintIgnores([], "apps/a/src/x.ts")).toBe(false);
  });

  test("refuses a negation", () => {
    expect(() => oxlintIgnores(["!apps/a/src/x.ts"], "apps/a/src/x.ts")).toThrow(UnreadablePattern);
  });
});
