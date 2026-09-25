// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { accountResource, zoneResources } from "./accountTokensManager";
import {
  CI_SYSTEM_PROFILE,
  permissionsForKeys,
  profilePermissions,
  resolveProfile,
  resolveTokenProfiles,
  routePermissions,
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

describe("routePermissions", () => {
  test("scopes the Workers Routes group to exactly the zones it is given", () => {
    expect(routePermissions(["z1", "z2"])).toEqual([
      {
        permissionGroupNames: ["Workers Routes Write"],
        resources: {
          "com.cloudflare.api.account.zone.z1": "*",
          "com.cloudflare.api.account.zone.z2": "*",
        },
      },
    ]);
  });

  test("no zones, no policy — a project with no declared domain attaches no route", () => {
    expect(routePermissions([])).toEqual([]);
  });

  test("never account-wide, and never every zone on the account", () => {
    const resources = routePermissions(["z1"])[0]?.resources ?? {};
    for (const key of Object.keys(resources)) {
      expect(key.startsWith("com.cloudflare.api.account.zone.")).toBe(true);
    }
    expect(resources).not.toHaveProperty("com.cloudflare.api.account.zone.*");
    expect(resources).toEqual(zoneResources(["z1"]));
  });

  test("grants routes on a zone and nothing that alters the zone", () => {
    expect(routePermissions(["z1"])[0]?.permissionGroupNames).not.toContain("Zone Write");
  });
});

describe("zone-scoped keys in a profile", () => {
  test("ci-system declares none, so its one policy stays account-scoped", () => {
    const profile = resolveProfile(resolveTokenProfiles([]), CI_SYSTEM_PROFILE);
    expect(profile.permissions).not.toContain("routes:write");
    expect(profilePermissions(profile, "acct-1")).toEqual([
      {
        permissionGroupNames: [
          "Workers Scripts Write",
          "D1 Read",
          "D1 Write",
          "Secrets Store Read",
          "Secrets Store Write",
        ],
        resources: accountResource("acct-1"),
      },
    ]);
  });

  test("a zone-scoped key named by hand is refused — zones come from the declared domains", () => {
    // Handing a zone-level group the account resource mints a token Cloudflare accepts and then refuses
    // the call on. The one silent mis-scope this whole change exists to make impossible.
    const profile = {
      ...resolveProfile(resolveTokenProfiles([]), CI_SYSTEM_PROFILE),
      permissions: ["routes:write" as const],
    };
    const failure = (() => {
      try {
        profilePermissions(profile, "acct-1");
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/routes:write/);
    expect((failure as PithyError).payload.action).toMatch(/domains/);
  });

  test("permissionsForKeys refuses one too — the --permission flag reaches it", () => {
    expect(() => permissionsForKeys(["routes:write"], "acct-1")).toThrow(/routes:write/);
  });
});
