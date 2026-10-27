// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { ARTIFACTS_MIGRATION_ORDER, artifacts, isArtifactsCapability } from "./capability";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

describe("artifacts()", () => {
  test("requires the app database and an artifacts binding, and nothing else", () => {
    expect(artifacts().requiredBindings).toEqual([
      { type: "d1", name: "DB", optional: false },
      { type: "artifacts", name: "ARTIFACTS", optional: false },
    ]);
    expect(artifacts({ binding: "REPOS" }).requiredBindings[1]).toEqual({
      type: "artifacts",
      name: "REPOS",
      optional: false,
    });
  });

  test("declares the power it gates on only once the adopter names one", () => {
    expect(artifacts().powers).toBeUndefined();
    expect(artifacts({ managePower: "repos:manage" }).powers).toEqual(["repos:manage"]);
  });

  test("migrates the app database at its allocated order, and reports its own version", () => {
    const capability = artifacts();
    expect(capability.databases?.app?.migrationOrder).toBe(ARTIFACTS_MIGRATION_ORDER);
    expect(Object.keys(capability.databases?.app?.migrations ?? {})).toEqual(["0001_init", "0002_tokens"]);
    expect(capability.version).toBe(PACKAGE_VERSION);
    expect(capability.package).toBe(PACKAGE_NAME);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(manifest.version);
  });

  test("refuses a TTL above the ceiling at assembly, before anything mounts", () => {
    expect(() => artifacts({ tokenTtlSeconds: 7200 })).toThrow(PithyError);
  });

  test("is recognized by name and shape", () => {
    expect(isArtifactsCapability(artifacts())).toBe(true);
  });
});
