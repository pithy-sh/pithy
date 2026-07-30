// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { deriveIdentityFromBranch, parseFeatureBranch } from "./identity";
import type { GitRunner } from "./worktree";

describe("parseFeatureBranch", () => {
  test("parses a valid feature branch", () => {
    expect(parseFeatureBranch("feature/69-media-cli")).toEqual({
      issue: "69",
      slug: "media-cli",
      branch: "feature/69-media-cli",
    });
  });

  test.each([
    ["main", "not a feature branch at all"],
    ["feature/nope", "no issue number"],
    ["feature/69-", "no slug"],
    ["feature/69-Bad_Slug", "slug is not kebab-case"],
  ])("returns null for %s (%s)", (branch) => {
    expect(parseFeatureBranch(branch)).toBeNull();
  });
});

describe("deriveIdentityFromBranch", () => {
  test("derives the identity from a feature branch", async () => {
    const git: GitRunner = async () => "feature/69-media-cli";
    const identity = await deriveIdentityFromBranch("/repo", git);
    expect(identity).toEqual({ issue: "69", slug: "media-cli", branch: "feature/69-media-cli" });
  });

  test("throws a PithyError when not on a feature branch", async () => {
    const git: GitRunner = async () => "main";
    await expect(deriveIdentityFromBranch("/repo", git)).rejects.toBeInstanceOf(PithyError);
  });
});
