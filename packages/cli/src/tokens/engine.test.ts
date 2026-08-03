// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountTokenSummary, MintedAccountToken } from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import { resolveProfile, resolveTokenProfiles } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
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
} {
  const state = {
    minted: [] as string[],
    rolled: [] as string[],
    deletedById: [] as string[],
    deletedByName: [] as string[],
  };
  return {
    ...state,
    mintToken: vi.fn(async (name: string): Promise<MintedAccountToken> => {
      state.minted.push(name);
      return { id: `new-${name}`, value: `value-${name}`, name };
    }),
    rollToken: vi.fn(async (name: string): Promise<MintedAccountToken> => {
      state.rolled.push(name);
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
    tokens,
    profiles: resolveTokenProfiles([secretsCap]),
    ...extra,
  };
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
    expect(result.sink).toEqual({ sink: "dev-vars", location: ".dev.vars.staging" });
    expect(await readFile(join(dir, ".dev.vars.staging"), "utf8")).toContain(
      "CF_TOKEN_CI_SYSTEM=value-acme-staging-ci-system",
    );
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
    await writeFile(join(dir, ".dev.vars.staging"), "CF_TOKEN_CI_SYSTEM=old-narrow-token\n");
    const tokens = fakeControl({
      findTokenByName: vi.fn(async () => ({ id: "tok-1", name: "acme-staging-ci-system", status: "active" as const })),
    });

    const result = await mintProfileToken(engineWith(dir, tokens), "ci-system", "staging");

    expect(tokens.rolled).toEqual(["acme-staging-ci-system"]); // re-minted with current scope
    expect(result.value).toBe("value-acme-staging-ci-system"); // not the stale on-disk value
    expect(await readFile(join(dir, ".dev.vars.staging"), "utf8")).toContain(
      "CF_TOKEN_CI_SYSTEM=value-acme-staging-ci-system",
    );
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
      { profile: "ci-system", env: "staging", name: "acme-staging-ci-system", tokenId: "t1", status: "active" },
    ]);
    expect(JSON.stringify(list)).not.toContain("value");
  });

  test("never lists another project's token, even for the same profile and env", async () => {
    // The account token list is account-wide. Anything listed here is something the CLI offers to
    // rotate and revoke, so a neighbouring project's credential must never appear in it.
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
    expect(list).toEqual([{ profile: long, env: "staging", name: wireName, tokenId: "t1", status: "active" }]);
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
