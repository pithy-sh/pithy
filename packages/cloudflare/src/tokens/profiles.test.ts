// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { accountResource } from "./accountTokensManager";
import {
  CI_SYSTEM_PROFILE,
  permissionsForKeys,
  profilePermissions,
  resolveProfile,
  resolveTokenProfiles,
  type TokenProfileSeamInput,
  tokenSecretName,
} from "./profiles";

describe("resolveTokenProfiles — ci-system aggregation", () => {
  test("ci-system carries the base CI permissions and defaults to the dev-vars store", () => {
    const profiles = resolveTokenProfiles([]);
    expect(profiles[CI_SYSTEM_PROFILE]).toMatchObject({
      name: "ci-system",
      permissions: ["workers:write", "d1:read", "d1:write", "secrets:read", "secrets:write"],
      secret: "CF_TOKEN_CI_SYSTEM",
      defaultStore: "dev-vars",
    });
  });

  test("a capability's ciPermissions union into ci-system (extensibility), de-duped", () => {
    const email = defineCapability({ name: "email", requiredBindings: [], ciPermissions: ["email:routing"] });
    const kv = defineCapability({ name: "kvmod", requiredBindings: [], ciPermissions: ["kv:write", "d1:read"] });

    const perms = resolveTokenProfiles([email, kv])[CI_SYSTEM_PROFILE]?.permissions ?? [];
    expect(perms).toContain("email:routing");
    expect(perms).toContain("kv:write");
    // d1:read was already in the base — not duplicated.
    expect(perms.filter((p) => p === "d1:read")).toHaveLength(1);
  });

  test("an unknown ciPermissions key fails loudly", () => {
    const bad = defineCapability({ name: "bad", requiredBindings: [], ciPermissions: ["d1:destroy"] });
    expect(() => resolveTokenProfiles([bad])).toThrow(PithyError);
  });
});

describe("resolveTokenProfiles — worker-consumer federation", () => {
  test("merges a capability's tokenProfiles slice alongside ci-system", () => {
    // Declared as its own const, the way a capability declares it — `secretScope` is additive on top
    // of core's structural seam, so an inline literal would trip the excess-property check.
    const managerProfile = {
      permissions: ["secrets:read", "secrets:write"],
      secret: "SECRETS_MANAGER_CF_API_TOKEN",
      secretScope: "global",
      defaultStore: "secrets-store",
      description: "The secrets manager runtime credential.",
    } as const satisfies TokenProfileSeamInput;
    const secrets = defineCapability({
      name: "secrets",
      requiredBindings: [],
      tokenProfiles: { secrets: managerProfile },
    });
    const profiles = resolveTokenProfiles([secrets]);
    expect(Object.keys(profiles).sort()).toEqual(["ci-system", "secrets"]);
    expect(profiles.secrets).toMatchObject({
      secret: "SECRETS_MANAGER_CF_API_TOKEN",
      // Carried through from the seam: it decides the environment segment of the Secrets Store entry
      // the minted value lands in, so losing it here would silently write to an entry nothing binds.
      secretScope: "global",
      defaultStore: "secrets-store",
    });
  });

  test("defaults secretScope to undefined (per-environment) and rejects an unknown one", () => {
    const plain = defineCapability({
      name: "widgets",
      requiredBindings: [],
      tokenProfiles: { widgets: { permissions: ["d1:read"] } },
    });
    expect(resolveTokenProfiles([plain]).widgets?.secretScope).toBeUndefined();

    const rogue = { permissions: ["d1:read"], secretScope: "worldwide" } as const satisfies TokenProfileSeamInput;
    const bad = defineCapability({ name: "bad", requiredBindings: [], tokenProfiles: { bad: rogue } });
    expect(() => resolveTokenProfiles([bad])).toThrow(PithyError);
  });

  test("a capability profile clashing with ci-system fails loudly", () => {
    const bad = defineCapability({
      name: "bad",
      requiredBindings: [],
      tokenProfiles: { "ci-system": { permissions: ["d1:read"] } },
    });
    expect(() => resolveTokenProfiles([bad])).toThrow(PithyError);
  });

  test("defaults a missing secret name to CF_TOKEN_<PROFILE>", () => {
    const cap = defineCapability({
      name: "widgets",
      requiredBindings: [],
      tokenProfiles: { widgets: { permissions: ["d1:read"] } },
    });
    expect(resolveTokenProfiles([cap]).widgets?.secret).toBe("CF_TOKEN_WIDGETS");
  });
});

describe("resolveProfile", () => {
  const profiles = resolveTokenProfiles([]);

  test("returns a registry profile and merges an override's permissions and store", () => {
    const overridden = resolveProfile(profiles, "ci-system", { permissions: ["workers:write"], store: "ephemeral" });
    expect(overridden.permissions).toEqual(["workers:write"]);
    expect(overridden.defaultStore).toBe("ephemeral");
  });

  test("an unknown profile name fails with an actionable error listing the known profiles", () => {
    const failure = (() => {
      try {
        resolveProfile(profiles, "nope");
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toMatch(/ci-system/);
  });
});

describe("permissions helpers", () => {
  test("permissionsForKeys builds one account-scoped policy from keys", () => {
    expect(permissionsForKeys(["secrets:read", "secrets:write"], "acct-1")).toEqual([
      { permissionGroupNames: ["Secrets Store Read", "Secrets Store Write"], resources: accountResource("acct-1") },
    ]);
  });

  test("profilePermissions builds the policy for a resolved profile", () => {
    const profiles = resolveTokenProfiles([]);
    expect(profilePermissions(resolveProfile(profiles, "ci-system"), "acct-1")[0]?.resources).toEqual(
      accountResource("acct-1"),
    );
  });

  test("tokenSecretName is CF_TOKEN_<PROFILE>", () => {
    expect(tokenSecretName("ci-system")).toBe("CF_TOKEN_CI_SYSTEM");
  });
});
