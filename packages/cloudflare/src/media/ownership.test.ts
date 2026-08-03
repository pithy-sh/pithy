// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ASSET_ENV_KEY, ASSET_PROJECT_KEY, withAssetOwnership } from "./ownership";

describe("withAssetOwnership", () => {
  it("stamps the project and the environment onto an empty bag", () => {
    expect(withAssetOwnership({ project: "acme", env: "staging" })).toEqual({
      pithyProject: "acme",
      pithyEnv: "staging",
    });
  });

  it("uses the same two keys for both stores, so one query answers what a project owns", () => {
    expect(ASSET_PROJECT_KEY).toBe("pithyProject");
    expect(ASSET_ENV_KEY).toBe("pithyEnv");
  });

  it("carries a caller's own keys through untouched — no shape is imposed beyond the reserved two", () => {
    const stamped = withAssetOwnership({ project: "acme", env: "dev" }, { userId: "u-1", album: "holiday" });
    expect(stamped).toEqual({ userId: "u-1", album: "holiday", pithyProject: "acme", pithyEnv: "dev" });
  });

  it("a caller-supplied ownership key cannot displace the real one", () => {
    const stamped = withAssetOwnership(
      { project: "acme", env: "production" },
      { pithyProject: "globex", pithyEnv: "dev", keep: "me" },
    );
    expect(stamped).toEqual({ keep: "me", pithyProject: "acme", pithyEnv: "production" });
  });

  it("refuses an empty project — a blank stamp reads as owned and sweeps nothing", () => {
    expect(() => withAssetOwnership({ project: "", env: "dev" })).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
    );
  });

  it("refuses an empty environment for the same reason", () => {
    expect(() => withAssetOwnership({ project: "acme", env: "  " })).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
    );
  });
});
