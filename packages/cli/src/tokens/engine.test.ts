// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type {
  AccountTokenSummary,
  MintedAccountToken,
  TokenPermission,
} from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import { resolveProfile, resolveTokenProfiles } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { secretsTokenProfile } from "@pithy-sh/secrets/src/capability";
import { managerCfApiTokenSecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AccountTokenControl,
  listProfileTokens,
  mintProfileToken,
  revokeProfileToken,
  rotateProfileToken,
  type TokenAuditEvent,
  type TokenEngine,
  tokenName,
  tokenPrefix,
  tokenStoreEntryName,
} from "./engine";

function fakeControl(overrides: Partial<AccountTokenControl> = {}): AccountTokenControl & {
  minted: string[];
  rolled: string[];
  deletedById: string[];
  deletedByName: string[];
  policies: TokenPermission[][];
} {
  const state = {
    minted: [] as string[],
    rolled: [] as string[],
    deletedById: [] as string[],
    deletedByName: [] as string[],
    // Every policy set handed to Cloudflare, mint or roll — the token's actual scope, which is the
    // thing #651 was wrong about and the only thing worth asserting on.
    //
    // **Recording a roll's permissions is a true statement about the real control plane, and was not
    // always.** `rollToken` used to roll the value and drop the policy set on the floor, so this fake
    // recorded a scope change Cloudflare never saw and every assertion here passed over the defect. The
    // fake is not what fixed that — `accountTokensManager.test.ts` now holds the real manager to
    // applying the policies through `accounts.tokens.update` against a mocked SDK, and this fake is
    // only allowed to model the contract that file proves.
    policies: [] as TokenPermission[][],
  };
  return {
    ...state,
    // `Workers Routes Write` is the only name the engine resolves; anything else is a caller's bug.
    resolvePermissionGroups: vi.fn(async (names: string[]) => names.map((name) => ({ id: `pg:${name}` }))),
    mintToken: vi.fn(async (name: string, permissions: TokenPermission[]): Promise<MintedAccountToken> => {
      state.minted.push(name);
      state.policies.push(permissions);
      return { id: `new-${name}`, value: `value-${name}`, name };
    }),
    rollToken: vi.fn(async (name: string, permissions: TokenPermission[]): Promise<MintedAccountToken> => {
      state.rolled.push(name);
      state.policies.push(permissions);
      return { id: `rolled-${name}`, value: `value-${name}`, name };
    }),
    findTokenByName: vi.fn(async (): Promise<AccountTokenSummary | null> => null),
    listTokens: vi.fn(async (): Promise<AccountTokenSummary[]> => []),
    deleteToken: vi.fn(async (id: string) => {
      state.deletedById.push(id);
    }),
    deleteTokensByName: vi.fn(async (name: string): Promise<number> => {
      state.deletedByName.push(name);
      return 1;
    }),
    ...overrides,
  };
}

/**
 * A capability declaring a worker-consumer profile stored in CF Secrets Store. It uses the **real**
 * `secretsTokenProfile`, not a copy, so a change to the manager token's declared secret or scope shows
 * up here as a failing store-entry assertion rather than as a mint quietly writing to a dead entry.
 */
const secretsCap = defineCapability({
  name: "secrets",
  requiredBindings: [],
  tokenProfiles: { secrets: secretsTokenProfile },
});

/** The project every engine in this suite is scoped to. */
const PROJECT = "acme";

function engineWith(dir: string, tokens: AccountTokenControl, extra: Partial<TokenEngine> = {}): TokenEngine {
  return {
    accountId: "acct-1",
    project: PROJECT,
    projectDir: dir,
    // A minted token goes to `<config>/<project>/tokens.json` now (#182), so the config directory is the
    // seam that keeps this suite off the operator's real one — which holds their live Cloudflare tokens.
    paths: { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: join(dir, "config") } },
    tokens,
    profiles: resolveTokenProfiles([secretsCap]),
    ...extra,
  };
}

/** Where a minted `dev-vars` token lands for this fixture. */
function tokensFile(dir: string): string {
  return join(dir, "config", PROJECT, "tokens.json");
}

describe("tokenName", () => {
  test("is a stable <project>-<env>-<profile> identity", () => {
    expect(tokenName(PROJECT, "staging", "ci-system")).toBe("acme-staging-ci-system");
  });

  test("two projects in one account never share a token name", () => {
    // `revoke` deletes every account token of the name it computes, so a collision here would make one
    // project's revoke take out the other's live CI credential.
    expect(tokenName("acme", "staging", "ci-system")).not.toBe(tokenName("globex", "staging", "ci-system"));
  });
});

describe("tokenPrefix", () => {
  test("is the ownership filter every one of a project's env tokens starts with", () => {
    expect(tokenPrefix(PROJECT, "staging")).toBe("acme-staging-");
    expect(tokenName(PROJECT, "staging", "ci-system").startsWith(tokenPrefix(PROJECT, "staging"))).toBe(true);
    expect(tokenName("globex", "staging", "ci-system").startsWith(tokenPrefix(PROJECT, "staging"))).toBe(false);
  });
});

describe("tokenStoreEntryName", () => {
  test("a global profile resolves the same entry provisioning wrote, in every environment", () => {
    // `pithy token mint secrets` and `pithy secrets provision` must land on one entry — the one the
    // manager's CLOUDFLARE_API_TOKEN binding reads. Diverge and the operator rolls a credential the
    // manager never sees.
    const profile = resolveProfile(resolveTokenProfiles([secretsCap]), "secrets");
    for (const env of ["staging", "prod"]) {
      expect(tokenStoreEntryName(PROJECT, env, profile)).toBe(managerCfApiTokenSecretName(PROJECT));
    }
  });

  test("an environment-scoped profile gets one entry per environment, scoped to the project", () => {
    const profile = resolveProfile(resolveTokenProfiles([secretsCap]), "ci-system");
    expect(tokenStoreEntryName(PROJECT, "staging", profile)).toBe("acme-staging-cf-token-ci-system");
    expect(tokenStoreEntryName(PROJECT, "prod", profile)).toBe("acme-prod-cf-token-ci-system");
    // The `.dev.vars` variable key is untouched — CI reads it by name.
    expect(profile.secret).toBe("CF_TOKEN_CI_SYSTEM");
  });
});

describe("mintProfileToken", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-engine-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("mints the ci-system token, writes it to dev-vars (its default), and audits success", async () => {
    const tokens = fakeControl();
    const audited: TokenAuditEvent[] = [];
    const result = await mintProfileToken(
      engineWith(dir, tokens, { audit: async (e) => void audited.push(e) }),
      "ci-system",
      "staging",
    );

    expect(tokens.rolled).toEqual(["acme-staging-ci-system"]);
    expect(result.sink).toEqual({ sink: "dev-vars", location: tokensFile(dir) });
    expect(JSON.parse(await readFile(tokensFile(dir), "utf8"))).toEqual({
      staging: { CF_TOKEN_CI_SYSTEM: "value-acme-staging-ci-system" },
    });
    expect(audited[0]).toMatchObject({
      action: "cloudflare/token_minted",
      outcome: "success",
      profile: "ci-system",
      store: "dev-vars",
    });
  });

  test("a worker-consumer profile writes to CF Secrets Store under the project-scoped entry name", async () => {
    const tokens = fakeControl();
    const putSecret = vi.fn(async () => {});
    const result = await mintProfileToken(engineWith(dir, tokens, { putSecret }), "secrets", "prod");

    // The entry provisioning wrote and the manager binds — not the profile's `.dev.vars` variable key.
    expect(putSecret).toHaveBeenCalledWith(managerCfApiTokenSecretName(PROJECT), "value-acme-prod-secrets");
    expect(putSecret).not.toHaveBeenCalledWith(secretsTokenProfile.secret, expect.anything());
    expect(result.sink.sink).toBe("secrets-store");
  });

  test("rolls to the current scope even when a token already exists — extensibility takes effect", async () => {
    // A prior token's value is on disk, but mint still rolls: adding a capability's ciPermissions must
    // take effect on the next mint, so reusing the old (narrower) token is exactly what we must not do.
    await mkdir(join(dir, "config", PROJECT), { recursive: true });
    await writeFile(tokensFile(dir), JSON.stringify({ staging: { CF_TOKEN_CI_SYSTEM: "old-narrow-token" } }));
    const tokens = fakeControl({
      findTokenByName: vi.fn(async () => ({ id: "tok-1", name: "acme-staging-ci-system", status: "active" as const })),
    });

    const result = await mintProfileToken(engineWith(dir, tokens), "ci-system", "staging");

    expect(tokens.rolled).toEqual(["acme-staging-ci-system"]); // re-minted with current scope
    expect(result.value).toBe("value-acme-staging-ci-system"); // not the stale on-disk value
    expect(JSON.parse(await readFile(tokensFile(dir), "utf8"))).toEqual({
      staging: { CF_TOKEN_CI_SYSTEM: "value-acme-staging-ci-system" },
    });
  });

  test("a profile with no store and no declared secret backend fails with actionable guidance", async () => {
    const tokens = fakeControl();
    // A capability profile with no defaultStore; secretBackend returns undefined (not declared).
    const cap = defineCapability({
      name: "widgets",
      requiredBindings: [],
      tokenProfiles: { widgets: { permissions: ["d1:read"] } },
    });
    const engine: TokenEngine = {
      accountId: "acct-1",
      project: PROJECT,
      projectDir: dir,
      tokens,
      profiles: resolveTokenProfiles([cap]),
      secretBackend: () => undefined,
    };
    await expect(mintProfileToken(engine, "widgets", "staging")).rejects.toThrow(PithyError);
  });

  test("--store override redirects the destination (e.g. ephemeral)", async () => {
    const tokens = fakeControl();
    const result = await mintProfileToken(engineWith(dir, tokens), "ci-system", "staging", { store: "ephemeral" });
    expect(tokens.rolled).toEqual(["acme-staging-ci-system"]);
    expect(result.sink.sink).toBe("ephemeral");
  });

  test("audits a failure and rethrows when minting fails; a missing audit sink is a no-op", async () => {
    const tokens = fakeControl({ rollToken: vi.fn(async () => Promise.reject(new Error("mint boom"))) });
    const audited: TokenAuditEvent[] = [];
    await expect(
      mintProfileToken(engineWith(dir, tokens, { audit: async (e) => void audited.push(e) }), "ci-system", "staging"),
    ).rejects.toThrow("mint boom");
    expect(audited[0]).toMatchObject({ action: "cloudflare/token_minted", outcome: "failure" });

    const plain = fakeControl();
    await expect(mintProfileToken(engineWith(dir, plain), "ci-system", "staging")).resolves.toBeDefined();
  });
});

describe("listProfileTokens", () => {
  test("returns only this project's tokens for this env, mapped to profile, with no values", async () => {
    const tokens = fakeControl({
      listTokens: vi.fn(async () => [
        { id: "t1", name: "acme-staging-ci-system", status: "active" as const },
        { id: "t2", name: "acme-prod-secrets", status: "active" as const },
        { id: "t3", name: "some-other-token", status: "active" as const },
      ]),
    });
    const list = await listProfileTokens(engineWith(".", tokens), "staging");
    expect(list).toEqual([
      {
        profile: "ci-system",
        env: "staging",
        name: "acme-staging-ci-system",
        tokenId: "t1",
        status: "active",
        // No declared domain in this fixture, so there is no route to attach and no zone to scope.
        routeScope: "not-required",
      },
    ]);
    expect(JSON.stringify(list)).not.toContain("value");
  });

  test("never lists another project's token, even for the same profile and env", async () => {
    // The account token list is account-wide. Anything listed here is something the CLI offers to
    // rotate and revoke, so a neighboring project's credential must never appear in it.
    const tokens = fakeControl({
      listTokens: vi.fn(async () => [
        { id: "t1", name: "acme-staging-ci-system", status: "active" as const },
        { id: "t2", name: "globex-staging-ci-system", status: "active" as const },
      ]),
    });
    const list = await listProfileTokens(engineWith(".", tokens), "staging");
    expect(list.map((token) => token.name)).toEqual(["acme-staging-ci-system"]);
  });

  test("a profile that fits is carried whole — a token label has no Cloudflare cap to hash against", () => {
    // This used to come back as `acme-staging-secrets-manage-2f8e11`: hashed at 63, R2's number,
    // against a namespace that publishes no length limit at all. A token name nobody can read is a
    // token nobody revokes.
    const profile = "secrets-manager-cloudflare-api-token-consumer";
    expect(tokenName(PROJECT, "staging", profile)).toBe(`${PROJECT}-staging-${profile}`);
  });

  test("recovers the profile by reverse lookup, so a truncated name still resolves", async () => {
    // Past the API-token budget the trailing segment is truncated and hashed, so the segment on the
    // wire is not the profile name. Slicing the prefix off would return that mangled string; composing
    // each known profile's name and matching exactly is what survives. Sized off the budget, not a
    // literal, so it keeps testing truncation if the ceiling moves.
    const long = "a-worker-consumer-profile-".repeat(NAMESPACE_LIMITS.apiToken.maxLength).slice(0, 200);
    const cap = defineCapability({
      name: "verbose",
      requiredBindings: [],
      tokenProfiles: { [long]: { permissions: ["d1:read"], defaultStore: "ephemeral" } },
    });
    const wireName = tokenName(PROJECT, "staging", long);
    expect(wireName).not.toContain(long); // truncated — the slice-based parse could not recover this
    const tokens = fakeControl({
      listTokens: vi.fn(async () => [{ id: "t1", name: wireName, status: "active" as const }]),
    });

    const list = await listProfileTokens(engineWith(".", tokens, { profiles: resolveTokenProfiles([cap]) }), "staging");
    expect(list).toEqual([
      { profile: long, env: "staging", name: wireName, tokenId: "t1", status: "active", routeScope: "not-required" },
    ]);
  });
});

describe("rotateProfileToken", () => {
  test("creates a new token, stores it, and deletes the prior one (two-step); keepPrevious retains it", async () => {
    const tokens = fakeControl({
      listTokens: vi.fn(async () => [{ id: "old-1", name: "acme-staging-ci-system", status: "active" as const }]),
    });
    const audited: TokenAuditEvent[] = [];
    const result = await rotateProfileToken(
      engineWith(".", tokens, { audit: async (e) => void audited.push(e) }),
      "ci-system",
      "staging",
      { store: "ephemeral" },
    );
    expect(tokens.minted).toEqual(["acme-staging-ci-system"]);
    expect(tokens.deletedById).toEqual(["old-1"]);
    expect(result.tokenId).toBe("new-acme-staging-ci-system");
    expect(audited[0]).toMatchObject({ action: "cloudflare/token_rotated", outcome: "success" });

    const kept = fakeControl({
      listTokens: vi.fn(async () => [{ id: "old-2", name: "acme-staging-ci-system", status: "active" as const }]),
    });
    await rotateProfileToken(engineWith(".", kept), "ci-system", "staging", { store: "ephemeral", keepPrevious: true });
    expect(kept.deletedById).toEqual([]);
  });
});

describe("revokeProfileToken", () => {
  test("deletes every token of the profile's name and audits the revoke", async () => {
    const tokens = fakeControl();
    const audited: TokenAuditEvent[] = [];
    const result = await revokeProfileToken(
      engineWith(".", tokens, { audit: async (e) => void audited.push(e) }),
      "ci-system",
      "prod",
    );
    expect(tokens.deletedByName).toEqual([tokenName(PROJECT, "prod", "ci-system")]);
    expect(result.revoked).toBe(1);
    expect(audited[0]).toMatchObject({
      action: "cloudflare/token_revoked",
      outcome: "success",
      profile: "ci-system",
      env: "prod",
    });
  });
});

/**
 * Which operations actually need `engine.profiles` — the property `pithy token`'s refusal is built on.
 *
 * When the project's capability set is unknowable, `buildEngine` makes `profiles` a getter that throws, so
 * the refusal lands on the operations that read it and nowhere else. That is only safe while this split
 * holds, and the split is not obvious from the call sites: `revoke` is one line away from reaching for a
 * profile it does not need. Asserted directly, in both directions, so a later edit that adds a `profiles`
 * read to `revoke` fails here rather than silently taking `pithy token revoke` away from an operator in a
 * credential leak — the shape `#454` is about, with no `--local-only` to fall back on.
 */
describe("which operations read the profile registry", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-token-profiles-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An engine whose profile registry is unreadable — exactly what an unknowable capability set produces. */
  function engineWithUnreadableProfiles(tokens: AccountTokenControl): TokenEngine {
    const engine = engineWith(dir, tokens);
    return Object.defineProperty(engine, "profiles", {
      get(): never {
        // The same class `tokenProfiles` refuses with, so this stands in for the real getter exactly.
        throw new ValidationError({
          message: "This project's capability set is unknown, so token permissions cannot be derived.",
        });
      },
    }) as TokenEngine;
  }

  test("**revoke does not — it deletes by a name composed from the root config alone**", async () => {
    const tokens = fakeControl();
    const result = await revokeProfileToken(engineWithUnreadableProfiles(tokens), "ci-system", "prod");

    expect(result.revoked).toBe(1);
    expect(tokens.deletedByName).toEqual([tokenName(PROJECT, "prod", "ci-system")]);
  });

  test("mint, rotate and list do — each resolves a profile before anything else", async () => {
    const engine = engineWithUnreadableProfiles(fakeControl());

    await expect(mintProfileToken(engine, "ci-system", "prod")).rejects.toThrow(/capability set is unknown/);
    await expect(rotateProfileToken(engine, "ci-system", "prod")).rejects.toThrow(/capability set is unknown/);
    await expect(listProfileTokens(engine, "prod")).rejects.toThrow(/capability set is unknown/);
  });
});

/**
 * #651 — the CI token and the route it could not attach.
 *
 * `pithy deploy` of an environment with a declared domain ends in `POST /zones/<zone>/workers/routes`.
 * The `ci-system` token carried one account-scoped policy and no zone resource, so that call answered
 * "No access to the specified resource" and no CI deploy of a custom domain could ever work.
 *
 * Asserted on the policy sets handed to Cloudflare, because that is the token.
 */
describe("mintProfileToken — route zones", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-routezones-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A route-zone resolver over a fixed answer, counted. */
  function zonesResolving(zoneIds: string[]) {
    return vi.fn(async () =>
      zoneIds.map((zoneId, index) => ({
        worker: `w${index}`,
        domain: `staging.w${index}.example.com`,
        zone: "example.com",
        zoneId,
      })),
    );
  }

  test("a project declaring a domain mints ci-system with the route group scoped to that zone", async () => {
    const tokens = fakeControl();
    await mintProfileToken(engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a"]) }), "ci-system", "staging");

    expect(tokens.policies[0]).toEqual([
      {
        permissionGroupNames: [
          "Workers Scripts Write",
          "D1 Read",
          "D1 Write",
          "Secrets Store Read",
          "Secrets Store Write",
        ],
        resources: { "com.cloudflare.api.account.acct-1": "*" },
      },
      {
        permissionGroupNames: ["Workers Routes Write"],
        resources: { "com.cloudflare.api.account.zone.zone-a": "*" },
      },
    ]);
  });

  test("two Workers on one zone name it once; two zones are both named", async () => {
    const tokens = fakeControl();
    await mintProfileToken(
      engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a", "zone-b", "zone-a"]) }),
      "ci-system",
      "staging",
    );
    expect(tokens.policies[0]?.[1]?.resources).toEqual({
      "com.cloudflare.api.account.zone.zone-a": "*",
      "com.cloudflare.api.account.zone.zone-b": "*",
    });
  });

  test("the route policy grants routes on a zone and nothing that alters one", async () => {
    const tokens = fakeControl();
    await mintProfileToken(engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a"]) }), "ci-system", "staging");
    const names = (tokens.policies[0] ?? []).flatMap((policy) => policy.permissionGroupNames);
    expect(names.filter((name) => name.startsWith("Zone "))).toEqual([]);
    // And no policy is account-wide except the account one.
    const zonePolicies = (tokens.policies[0] ?? []).filter((policy) =>
      policy.permissionGroupNames.includes("Workers Routes Write"),
    );
    for (const policy of zonePolicies) {
      for (const key of Object.keys(policy.resources)) {
        expect(key.startsWith("com.cloudflare.api.account.zone.")).toBe(true);
      }
    }
  });

  test("a project declaring no domain mints exactly what it minted before", async () => {
    const withNone = fakeControl();
    await mintProfileToken(engineWith(dir, withNone, { routeZones: vi.fn(async () => []) }), "ci-system", "staging");
    const unaware = fakeControl();
    await mintProfileToken(engineWith(dir, unaware), "ci-system", "staging");

    expect(withNone.policies[0]).toHaveLength(1);
    expect(withNone.policies[0]).toEqual(unaware.policies[0]);
  });

  test("an unresolvable zone fails the mint before any token is written, and audits the failure", async () => {
    const tokens = fakeControl();
    const audited: TokenAuditEvent[] = [];
    const engine = engineWith(dir, tokens, {
      audit: async (e) => void audited.push(e),
      routeZones: vi.fn(async () => {
        throw new CloudflareNotConfiguredError({
          message: "This account holds no zone `other.com`.",
          action: "Add the zone, or fix `domains`.",
        });
      }),
    });

    await expect(mintProfileToken(engine, "ci-system", "staging")).rejects.toBeInstanceOf(CloudflareNotConfiguredError);
    // Nothing was minted or rolled — the whole point of resolving before the write.
    expect(tokens.rolled).toEqual([]);
    expect(tokens.minted).toEqual([]);
    expect(audited[0]).toMatchObject({ action: "cloudflare/token_minted", outcome: "failure" });
  });

  test("an explicit --permission narrowing means exactly what it says — no route policy rides along", async () => {
    // The route policy is part of the profile's *default* set, not a rider on every mint. An operator
    // narrowing `ci-system` by hand is making a statement about what this credential may do, and
    // silently adding a zone grant to it would make `--permission` a suggestion.
    const tokens = fakeControl();
    const routeZones = zonesResolving(["zone-a"]);
    await mintProfileToken(engineWith(dir, tokens, { routeZones }), "ci-system", "staging", {
      permissions: ["d1:read"],
    });
    expect(tokens.policies[0]).toEqual([
      { permissionGroupNames: ["D1 Read"], resources: { "com.cloudflare.api.account.acct-1": "*" } },
    ]);
    // And the zones are never even resolved: an override cannot fail a mint on a zone it will not use.
    expect(routeZones).not.toHaveBeenCalled();
  });

  test("a standing pithy.config.ts override narrows too — and the listing says why", async () => {
    // It still suppresses the route policy: a standing override is the adopter stating this
    // credential's permanent shape. What changed (#651 round three) is that the listing no longer
    // prints a re-mint remedy that this same override would undo.
    const tokens = fakeControl();
    await mintProfileToken(
      engineWith(dir, tokens, {
        routeZones: zonesResolving(["zone-a"]),
        override: (profile) => (profile === "ci-system" ? { permissions: ["d1:read"] } : undefined),
      }),
      "ci-system",
      "staging",
    );
    expect(tokens.policies[0]).toHaveLength(1);
  });

  test("a --permission narrowing of a token that already exists is refused", async () => {
    // The mint replaces an existing token's policy set now, so a one-off flag permanently re-scopes the
    // credential CI deploys with — a contractor handed a read-only token for an hour takes the deploy
    // token's route grant with them. Refusing is the only answer that cannot silently break a pipeline.
    const tokens = fakeControl({
      findTokenByName: vi.fn(async () => ({ id: "t1", name: "acme-staging-ci-system", status: "active" as const })),
    });
    const failure = await mintProfileToken(
      engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a"]) }),
      "ci-system",
      "staging",
      { permissions: ["d1:read"] },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/--permission/);
    expect((failure as PithyError).payload.action).toMatch(/tokens\.overrides|pithy token rotate/);
    // Nothing was written: the refusal lands before the roll.
    expect(tokens.rolled).toEqual([]);
    expect(tokens.policies).toEqual([]);
  });

  test("a --permission narrowing of a token that does not exist yet is allowed", async () => {
    // Nothing to strip. This is the case the flag is actually for.
    const tokens = fakeControl();
    await mintProfileToken(
      engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a"]) }),
      "ci-system",
      "staging",
      {
        permissions: ["d1:read"],
      },
    );
    expect(tokens.policies[0]).toHaveLength(1);
  });

  test("an unnarrowed mint of an existing token is untouched by the refusal", async () => {
    const tokens = fakeControl({
      findTokenByName: vi.fn(async () => ({ id: "t1", name: "acme-staging-ci-system", status: "active" as const })),
    });
    await mintProfileToken(engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a"]) }), "ci-system", "staging");
    expect(tokens.policies[0]).toHaveLength(2);
  });

  test("an override of something other than the permissions keeps the route policy", async () => {
    // `--store` says nothing about scope, so it must not narrow one.
    const tokens = fakeControl();
    await mintProfileToken(
      engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a"]) }),
      "ci-system",
      "staging",
      {
        store: "ephemeral",
      },
    );
    expect(tokens.policies[0]).toHaveLength(2);
  });

  test("a worker-consumer profile gets no route policy — it does not deploy", async () => {
    const tokens = fakeControl();
    const routeZones = zonesResolving(["zone-a"]);
    await mintProfileToken(
      engineWith(dir, tokens, { routeZones, putSecret: vi.fn(async () => {}) }),
      "secrets",
      "prod",
    );
    expect(tokens.policies[0]).toHaveLength(1);
    expect(routeZones).not.toHaveBeenCalled();
  });

  test("rotate carries the same route scope as mint", async () => {
    const tokens = fakeControl();
    await rotateProfileToken(
      engineWith(dir, tokens, { routeZones: zonesResolving(["zone-a"]) }),
      "ci-system",
      "staging",
    );
    expect(tokens.policies[0]?.[1]).toEqual({
      permissionGroupNames: ["Workers Routes Write"],
      resources: { "com.cloudflare.api.account.zone.zone-a": "*" },
    });
  });
});

describe("listProfileTokens — route scope", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-routescope-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const routeZones = vi.fn(async () => [
    { worker: "api", domain: "staging.api.example.com", zone: "example.com", zoneId: "zone-a" },
  ]);

  function listing(policies?: AccountTokenSummary["policies"]) {
    return fakeControl({
      listTokens: vi.fn(
        async (): Promise<AccountTokenSummary[]> => [
          { id: "t1", name: "acme-staging-ci-system", status: "active", ...(policies ? { policies } : {}) },
        ],
      ),
    });
  }

  test("a token minted before route scoping reads as stale, so doctor and the operator can see it", async () => {
    // The whole record is the token's own policies. A `ci-system` token with only the account policy is
    // one minted before #651, and it will fail the next deploy of a domain.
    const tokens = listing([
      { permission_groups: [{ id: "pg:D1 Read" }], resources: { "com.cloudflare.api.account.acct-1": "*" } },
    ]);
    const rows = await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging");
    expect(rows[0]).toMatchObject({ profile: "ci-system", routeScope: "stale" });
  });

  test("a token carrying every required zone reads as scoped", async () => {
    const tokens = listing([
      { permission_groups: [{ id: "pg:D1 Read" }], resources: { "com.cloudflare.api.account.acct-1": "*" } },
      {
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.zone.zone-a": "*" },
      },
    ]);
    const rows = await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging");
    expect(rows[0]?.routeScope).toBe("scoped");
  });

  test("a project declaring no domain needs no route scope", async () => {
    const tokens = listing([
      { permission_groups: [{ id: "pg:D1 Read" }], resources: { "com.cloudflare.api.account.acct-1": "*" } },
    ]);
    const rows = await listProfileTokens(engineWith(dir, tokens, { routeZones: vi.fn(async () => []) }), "staging");
    expect(rows[0]?.routeScope).toBe("not-required");
  });

  test("a token whose policies Cloudflare did not return says unknown rather than stale", async () => {
    const rows = await listProfileTokens(engineWith(dir, listing(), { routeZones }), "staging");
    expect(rows[0]?.routeScope).toBe("unknown");
  });

  test("a zone-scoped policy that is not a route grant is not coverage", async () => {
    // The shape: a pre-#651 token somebody hand-widened in the dashboard with a zone-scoped read on the
    // same zone. The resource key matches and the token still cannot attach a route, so reading
    // coverage from resources alone calls it `scoped` and the notice falls silent.
    const tokens = listing([
      { permission_groups: [{ id: "pg:Zone Read" }], resources: { "com.cloudflare.api.account.zone.zone-a": "*" } },
    ]);
    const rows = await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging");
    expect(rows[0]?.routeScope).toBe("stale");
  });

  test("the route grant on the right zone is coverage", async () => {
    const tokens = listing([
      {
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.zone.zone-a": "*" },
      },
    ]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe("scoped");
  });

  test("the route grant on a different zone is not coverage for this one", async () => {
    const tokens = listing([
      {
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.zone.other": "*" },
      },
    ]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe("stale");
  });

  test("a policy that did not say which groups it grants cannot be judged", async () => {
    const tokens = listing([{ resources: { "com.cloudflare.api.account.zone.zone-a": "*" } }]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe(
      "unknown",
    );
  });

  test("a token that names the zone nowhere is stale, whatever its groups say", async () => {
    // The regression #651 round three caught: requiring `permission_groups` to judge anything turned the
    // *original* stale token — one account policy, no zone resource at all — into `unknown`, and the
    // remedy stopped printing for exactly the shape it was written for. Absence of the resource is
    // decisive on its own; only a zone that IS named needs its groups read.
    const tokens = listing([{ resources: { "com.cloudflare.api.account.acct-1": "*" } }]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe("stale");
  });

  test("a deny naming the route group on the zone is not coverage", async () => {
    const tokens = listing([
      {
        effect: "deny",
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.zone.zone-a": "*" },
      },
    ]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe("stale");
  });

  test("a deny beside an allow on the same zone still denies", async () => {
    const tokens = listing([
      {
        effect: "allow",
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.zone.zone-a": "*" },
      },
      {
        effect: "deny",
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.zone.zone-a": "*" },
      },
    ]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe("stale");
  });

  test("Cloudflare's nested zone-inside-account resource form is coverage", async () => {
    // `{ "com.cloudflare.api.account.<id>": { "com.cloudflare.api.account.zone.<zid>": "*" } }` — the
    // form Cloudflare's own docs give. Scanning only top-level keys read a working token as stale and
    // told the operator to re-mint something that already worked.
    const tokens = listing([
      {
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.acct-1": { "com.cloudflare.api.account.zone.zone-a": "*" } },
      },
    ]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe("scoped");
  });

  test("an all-zones grant covers the declared zone", async () => {
    const tokens = listing([
      {
        permission_groups: [{ id: "pg:Workers Routes Write" }],
        resources: { "com.cloudflare.api.account.acct-1": { "com.cloudflare.api.account.zone.*": "*" } },
      },
    ]);
    expect((await listProfileTokens(engineWith(dir, tokens, { routeZones }), "staging"))[0]?.routeScope).toBe("scoped");
  });

  test("a standing override that strips the grant reads `overridden`, not `stale`", async () => {
    // The state where "run pithy token mint" is a lie: the mint would re-scope the token to exactly what
    // it has now, because the override removes the route policy from every mint.
    const tokens = listing([{ resources: { "com.cloudflare.api.account.acct-1": "*" } }]);
    const rows = await listProfileTokens(
      engineWith(dir, tokens, {
        routeZones,
        override: (profile) => (profile === "ci-system" ? { permissions: ["d1:read"] } : undefined),
      }),
      "staging",
    );
    expect(rows[0]?.routeScope).toBe("overridden");
  });

  test("an override of something other than the permissions is not an override of the grant", async () => {
    const tokens = listing([{ resources: { "com.cloudflare.api.account.acct-1": "*" } }]);
    const rows = await listProfileTokens(
      engineWith(dir, tokens, { routeZones, override: () => ({ store: "ephemeral" as const }) }),
      "staging",
    );
    expect(rows[0]?.routeScope).toBe("stale");
  });
});

/**
 * `pithy token list` must survive the condition it exists to report.
 *
 * Its job is to say which tokens exist and whether the CI one is scoped. Zone resolution is how it
 * answers the second half — and a typo'd zone, a zone the account lost, or a caller with no Zone Read
 * makes that resolution throw. Letting the throw out takes the whole listing down, including every row
 * that had nothing to do with zones, at exactly the moment somebody is trying to find out what is
 * wrong. `RouteScope` already has the word for it.
 */
describe("listProfileTokens — reporting never fails on what it reports", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-routescope-fail-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const twoTokens = () =>
    fakeControl({
      listTokens: vi.fn(
        async (): Promise<AccountTokenSummary[]> => [
          {
            id: "t1",
            name: "acme-staging-ci-system",
            status: "active",
            policies: [{ resources: { "com.cloudflare.api.account.acct-1": "*" } }],
          },
          { id: "t2", name: "acme-staging-secrets", status: "active" },
        ],
      ),
    });

  test("an unresolvable zone makes one row unknown, and lists every row", async () => {
    const tokens = twoTokens();
    const rows = await listProfileTokens(
      engineWith(dir, tokens, {
        routeZones: vi.fn(async (): Promise<never> => {
          throw new CloudflareNotConfiguredError({
            message: "This account holds no zone `other.com`.",
            action: "Add the zone, or fix `domains`.",
          });
        }),
      }),
      "staging",
    );
    expect(rows.map((row) => row.profile)).toEqual(["ci-system", "secrets"]);
    expect(rows[0]?.routeScope).toBe("unknown");
  });

  test("a caller with no Zone Read still gets the listing", async () => {
    const rows = await listProfileTokens(
      engineWith(dir, twoTokens(), {
        routeZones: vi.fn(async (): Promise<never> => {
          throw new Error("Cloudflare API: list zones — Authentication error [10000]");
        }),
      }),
      "staging",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.routeScope).toBe("unknown");
  });

  test("a permission-group lookup that fails is unknown too, never stale", async () => {
    const tokens = twoTokens();
    tokens.resolvePermissionGroups = vi.fn(async (): Promise<never> => {
      throw new Error("Cloudflare API: list account token permission groups — 403");
    });
    const rows = await listProfileTokens(
      engineWith(dir, tokens, {
        routeZones: vi.fn(async () => [
          { worker: "api", domain: "staging.api.example.com", zone: "example.com", zoneId: "zone-a" },
        ]),
      }),
      "staging",
    );
    expect(rows[0]?.routeScope).toBe("unknown");
  });

  test("a mint still fails loudly on the same unresolvable zone — reporting is lenient, minting is not", async () => {
    // The two answers are deliberately different. A listing that refused would hide what exists; a mint
    // that shrugged would hand over a credential that cannot deploy.
    const tokens = twoTokens();
    await expect(
      mintProfileToken(
        engineWith(dir, tokens, {
          routeZones: vi.fn(async (): Promise<never> => {
            throw new CloudflareNotConfiguredError({ message: "no zone", action: "fix it" });
          }),
        }),
        "ci-system",
        "staging",
      ),
    ).rejects.toBeInstanceOf(CloudflareNotConfiguredError);
  });
});
