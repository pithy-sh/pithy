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
  tokenSecretName,
} from "./profiles";
import { RUNTIME_PROFILE, RUNTIME_TOKEN_SECRET } from "./runtime";

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

  test("a composed queue binding puts queues:write on ci-system, because provisioning creates the queue (#662)", () => {
    // `pithy provision` creates every queue a composition binds, in CI under this token, and a session's scopes
    // are derived from what the profiles carry — so the permission comes from the binding, not a list.
    const app = defineCapability({ name: "app", requiredBindings: [{ type: "queue", name: "JOBS" }] });
    const once = defineCapability({ name: "other", requiredBindings: [{ type: "queue", name: "MAIL" }] });
    const perms = resolveTokenProfiles([app, once])[CI_SYSTEM_PROFILE]?.permissions ?? [];
    expect(perms.filter((p) => p === "queues:write")).toEqual(["queues:write"]);
    expect(resolveTokenProfiles([])[CI_SYSTEM_PROFILE]?.permissions).not.toContain("queues:write");
    // Never on the runtime token: a Worker sends through its producer binding, which needs no API token.
    expect(resolveTokenProfiles([app])[RUNTIME_PROFILE]).toBeUndefined();
  });

  test("a composed artifacts binding puts artifacts:write on ci-system, because feature teardown reaps repos (#673)", () => {
    // `pithy feature destroy` lists and deletes a feature's repos under this token. The Worker reaches its repos
    // through the binding, which needs no API token, so the runtime token gains nothing.
    const app = defineCapability({ name: "app", requiredBindings: [{ type: "artifacts", name: "ARTIFACTS" }] });
    const twice = defineCapability({ name: "other", requiredBindings: [{ type: "artifacts", name: "REPOS" }] });
    const perms = resolveTokenProfiles([app, twice])[CI_SYSTEM_PROFILE]?.permissions ?? [];
    expect(perms.filter((p) => p === "artifacts:write")).toEqual(["artifacts:write"]);
    expect(resolveTokenProfiles([])[CI_SYSTEM_PROFILE]?.permissions).not.toContain("artifacts:write");
    expect(resolveTokenProfiles([app])[RUNTIME_PROFILE]).toBeUndefined();
  });

  test("an unknown ciPermissions key fails loudly", () => {
    const bad = defineCapability({ name: "bad", requiredBindings: [], ciPermissions: ["d1:destroy"] });
    expect(() => resolveTokenProfiles([bad])).toThrow(PithyError);
  });
});

describe("resolveTokenProfiles — the one runtime token (#728)", () => {
  const runtime = (name: string, runtimePermissions: string[]) =>
    defineCapability({ name, requiredBindings: [], runtimePermissions });
  const plain = defineCapability({ name: "widgets", requiredBindings: [] });

  test("a project composing nothing with runtimePermissions resolves ci-system alone", () => {
    expect(Object.keys(resolveTokenProfiles([]))).toEqual(["ci-system"]);
    expect(Object.keys(resolveTokenProfiles([plain]))).toEqual(["ci-system"]);
    // An empty declaration is the same as none: a capability configured to call nothing mints nothing.
    expect(Object.keys(resolveTokenProfiles([runtime("media", [])]))).toEqual(["ci-system"]);
  });

  test("secrets, media and a second claimant of analytics:read resolve exactly ci-system and runtime", () => {
    const profiles = resolveTokenProfiles([
      runtime("secrets", ["secrets:read", "secrets:write"]),
      runtime("media", ["images:write", "stream:write", "analytics:read"]),
      runtime("turnstile", ["analytics:read"]),
    ]);
    expect(Object.keys(profiles).sort()).toEqual(["ci-system", "runtime"]);
    expect(profiles[RUNTIME_PROFILE]).toMatchObject({
      name: "runtime",
      // The union, each key once, in first-declared order.
      permissions: ["secrets:read", "secrets:write", "images:write", "stream:write", "analytics:read"],
      secret: RUNTIME_TOKEN_SECRET,
      defaultStore: "secrets-store",
    });
  });

  test("runtime's secret is the one binding every Worker of an environment reads it through", () => {
    const profile = resolveTokenProfiles([runtime("secrets", ["secrets:write"])])[RUNTIME_PROFILE];
    expect(profile?.secret).toBe("RUNTIME_CF_API_TOKEN");
    expect(profile?.description).toMatch(/one Cloudflare API token/);
  });

  test("ci-system is unchanged by a runtime declaration — a Worker's needs add nothing to CI", () => {
    expect(resolveTokenProfiles([runtime("media", ["analytics:read"])])[CI_SYSTEM_PROFILE]).toEqual(
      resolveTokenProfiles([])[CI_SYSTEM_PROFILE],
    );
  });

  test("an unknown runtimePermissions key is refused, naming the capability and the key", () => {
    const bad = runtime("bad", ["analytics:write"]);
    expect(() => resolveTokenProfiles([bad])).toThrow(PithyError);
    expect(() => resolveTokenProfiles([bad])).toThrow(/bad.*analytics:write/);
  });

  test("a zone-scoped key is refused at assembly — a Worker's token is account-scoped", () => {
    expect(() => resolveTokenProfiles([runtime("bad", ["routes:write"])])).toThrow(/routes:write/);
  });

  test("its one policy is account-scoped and carries exactly the union", () => {
    const profiles = resolveTokenProfiles([runtime("media", ["images:write", "analytics:read"])]);
    expect(profilePermissions(resolveProfile(profiles, RUNTIME_PROFILE), "acct-1")).toEqual([
      { permissionGroupNames: ["Images Write", "Account Analytics Read"], resources: accountResource("acct-1") },
    ]);
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
