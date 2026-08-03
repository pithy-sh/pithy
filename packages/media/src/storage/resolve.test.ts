// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { assetOwner, type StorageEnv } from "./resolve";

/**
 * The runtime half of the ownership stamp: which project and environment the Worker says it is.
 * Cloudflare Images and Stream have no local emulation — a `pithy dev` upload writes to the same
 * account-flat store prod does — so the answer has to be right in every environment, and a
 * guess is worse than a failure.
 */

const env = (vars: Partial<StorageEnv>) => vars as StorageEnv;

describe("assetOwner", () => {
  test("reads the project and environment the Worker was stamped with at provision", () => {
    expect(assetOwner(env({ PROJECT: "acme", ENVIRONMENT: "prod" }))).toEqual({
      project: "acme",
      env: "prod",
    });
  });

  test("an absent ENVIRONMENT is local dev — the same signal the secrets reader keys on", () => {
    expect(assetOwner(env({ PROJECT: "acme" }))).toEqual({ project: "acme", env: "dev" });
  });

  test("refuses to mint without PROJECT rather than writing an asset nothing can attribute", () => {
    expect(() => assetOwner(env({ ENVIRONMENT: "staging" }))).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "core/internal" }) }),
    );
  });

  test("the failure names the fix — the var, not the symptom", () => {
    expect(() => assetOwner(env({}))).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ action: expect.stringContaining("PROJECT") }) }),
    );
  });

  test("a blank PROJECT is refused too — it would stamp every asset as owned by nobody", () => {
    expect(() => assetOwner(env({ PROJECT: "   " }))).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "core/internal" }) }),
    );
  });
});
