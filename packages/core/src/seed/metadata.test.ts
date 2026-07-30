// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { buildAssetMetadata, PITHY_ENV_METADATA_KEY, STANDARD_ASSET_METADATA_KEYS } from "./metadata";

describe("buildAssetMetadata", () => {
  test("always stamps at least the environment", () => {
    expect(buildAssetMetadata("staging")).toEqual({ pithyEnv: "staging" });
    expect(PITHY_ENV_METADATA_KEY).toBe("pithyEnv");
    expect(STANDARD_ASSET_METADATA_KEYS).toContain("pithyEnv");
  });

  test("merges app-defined extra fields", () => {
    expect(buildAssetMetadata("production", { userId: "u1", kind: "avatar" })).toEqual({
      pithyEnv: "production",
      userId: "u1",
      kind: "avatar",
    });
  });

  test("the standard keys win — extra cannot override the scoping anchor", () => {
    expect(buildAssetMetadata("dev", { pithyEnv: "production" })).toEqual({ pithyEnv: "dev" });
  });
});
