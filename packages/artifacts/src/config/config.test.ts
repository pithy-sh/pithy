// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { ArtifactsConfig, MAX_TOKEN_TTL_SECONDS, parseArtifactsConfig } from "./config";

describe("ArtifactsConfig", () => {
  test("defaults: mounted at /artifacts, a fifteen-minute token, no supplied names, binding ARTIFACTS", () => {
    expect(parseArtifactsConfig({})).toEqual({
      basePath: "/artifacts",
      tokenTtlSeconds: 900,
      acceptRepoName: false,
      binding: "ARTIFACTS",
    });
  });

  test("the ceiling is an hour, and a TTL above it is refused at boot, naming the ceiling", () => {
    expect(MAX_TOKEN_TTL_SECONDS).toBe(3600);
    expect(parseArtifactsConfig({ tokenTtlSeconds: 3600 }).tokenTtlSeconds).toBe(3600);
    let caught: unknown;
    try {
      parseArtifactsConfig({ tokenTtlSeconds: 30 * 24 * 3600 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PithyError);
    const payload = (caught as PithyError).payload;
    expect(payload.code).toBe("artifacts/invalid_config");
    expect(payload.message).toContain("3600");
    expect(payload.message).toMatch(/revocation window/);
  });

  test("a TTL below Cloudflare's minute is refused too, because Cloudflare would refuse every mint", () => {
    expect(() => parseArtifactsConfig({ tokenTtlSeconds: 59 })).toThrow(PithyError);
    expect(() => parseArtifactsConfig({ tokenTtlSeconds: 60.5 })).toThrow(PithyError);
  });

  test("the TTL's description states that it is the revocation window", () => {
    const field = ArtifactsConfig.shape.tokenTtlSeconds;
    expect(field.description).toMatch(/revocation window/);
    expect(field.description).toMatch(/revoked person keeps pushing/);
  });

  test("refuses a basePath that is not absolute, and a managePower that is empty", () => {
    expect(() => parseArtifactsConfig({ basePath: "artifacts" })).toThrow(PithyError);
    expect(() => parseArtifactsConfig({ managePower: "" })).toThrow(PithyError);
    expect(parseArtifactsConfig({ managePower: "repos:manage" }).managePower).toBe("repos:manage");
  });
});
