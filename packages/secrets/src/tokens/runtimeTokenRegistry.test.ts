// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RUNTIME_PROFILE, RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { aggregateSecretRegistries } from "../sharedSecretsStore";
import { runtimeTokenRegistry } from "./runtimeTokenRegistry";

describe("the runtime token registry (#728)", () => {
  test("declares the runtime token as a per-environment store secret, read through its binding", () => {
    const registry = runtimeTokenRegistry(["secrets:read", "secrets:write"]);
    expect(Object.keys(registry)).toEqual([RUNTIME_TOKEN_SECRET]);
    expect(registry[RUNTIME_TOKEN_SECRET]).toMatchObject({
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "text",
    });
  });

  test("says what the declaring capability needs of the token, and that the mint is the runtime profile's", () => {
    const entry = runtimeTokenRegistry(["images:write", "analytics:read"])[RUNTIME_TOKEN_SECRET];
    expect(entry?.origin?.kind === "helped" && entry.origin.needs.cloudflare).toEqual([
      "images:write",
      "analytics:read",
    ]);
    expect(entry?.rotation).toMatchObject({ kind: "provider", issuer: "cloudflare" });
    expect(entry?.notes).toContain(`token mint ${RUNTIME_PROFILE}`);
  });

  test("two capabilities declaring it with different needs agree on every axis, so one Worker boots", () => {
    const secrets = defineCapability({
      name: "secrets",
      requiredBindings: [],
      secretRegistry: runtimeTokenRegistry(["secrets:read", "secrets:write"]),
    });
    const media = defineCapability({
      name: "media",
      requiredBindings: [],
      secretRegistry: runtimeTokenRegistry(["images:write"]),
    });
    expect(Object.keys(aggregateSecretRegistries([secrets, media]))).toEqual([RUNTIME_TOKEN_SECRET]);
  });
});
