import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountTokenSummary, MintedAccountToken } from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import { resolveTokenProfiles } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
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

/** A capability declaring a worker-consumer profile stored in CF Secrets Store. */
const secretsCap = defineCapability({
  name: "secrets",
  requiredBindings: [],
  tokenProfiles: {
    secrets: {
      permissions: ["secrets:read", "secrets:write"],
      secret: "GLOBAL_SECRETS_MANAGER_CF_API_TOKEN",
      defaultStore: "secrets-store",
      description: "manager token",
    },
  },
});

function engineWith(dir: string, tokens: AccountTokenControl, extra: Partial<TokenEngine> = {}): TokenEngine {
  return { accountId: "acct-1", projectDir: dir, tokens, profiles: resolveTokenProfiles([secretsCap]), ...extra };
}

describe("tokenName", () => {
  test("is a stable pithy-<profile>-<env> identity", () => {
    expect(tokenName("ci-system", "staging")).toBe("pithy-ci-system-staging");
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

    expect(tokens.rolled).toEqual(["pithy-ci-system-staging"]);
    expect(result.sink).toEqual({ sink: "dev-vars", location: ".dev.vars.staging" });
    expect(await readFile(join(dir, ".dev.vars.staging"), "utf8")).toContain(
      "CF_TOKEN_CI_SYSTEM=value-pithy-ci-system-staging",
    );
    expect(audited[0]).toMatchObject({
      action: "cloudflare/token_minted",
      outcome: "success",
      profile: "ci-system",
      store: "dev-vars",
    });
  });

  test("a worker-consumer profile writes to CF Secrets Store under its declared secret name", async () => {
    const tokens = fakeControl();
    const putSecret = vi.fn(async () => {});
    const result = await mintProfileToken(engineWith(dir, tokens, { putSecret }), "secrets", "production");

    expect(putSecret).toHaveBeenCalledWith("GLOBAL_SECRETS_MANAGER_CF_API_TOKEN", "value-pithy-secrets-production");
    expect(result.sink.sink).toBe("secrets-store");
  });

  test("rolls to the current scope even when a token already exists — extensibility takes effect", async () => {
    // A prior token's value is on disk, but mint still rolls: adding a capability's ciPermissions must
    // take effect on the next mint, so reusing the old (narrower) token is exactly what we must not do.
    await writeFile(join(dir, ".dev.vars.staging"), "CF_TOKEN_CI_SYSTEM=old-narrow-token\n");
    const tokens = fakeControl({
      findTokenByName: vi.fn(async () => ({ id: "tok-1", name: "pithy-ci-system-staging", status: "active" as const })),
    });

    const result = await mintProfileToken(engineWith(dir, tokens), "ci-system", "staging");

    expect(tokens.rolled).toEqual(["pithy-ci-system-staging"]); // re-minted with current scope
    expect(result.value).toBe("value-pithy-ci-system-staging"); // not the stale on-disk value
    expect(await readFile(join(dir, ".dev.vars.staging"), "utf8")).toContain(
      "CF_TOKEN_CI_SYSTEM=value-pithy-ci-system-staging",
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
    expect(tokens.rolled).toEqual(["pithy-ci-system-staging"]);
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
  test("returns only this env's pithy tokens, mapped to profile, with no values", async () => {
    const tokens = fakeControl({
      listTokens: vi.fn(async () => [
        { id: "t1", name: "pithy-ci-system-staging", status: "active" as const },
        { id: "t2", name: "pithy-secrets-production", status: "active" as const },
        { id: "t3", name: "some-other-token", status: "active" as const },
      ]),
    });
    const list = await listProfileTokens(engineWith(".", tokens), "staging");
    expect(list).toEqual([
      { profile: "ci-system", env: "staging", name: "pithy-ci-system-staging", tokenId: "t1", status: "active" },
    ]);
    expect(JSON.stringify(list)).not.toContain("value");
  });
});

describe("rotateProfileToken", () => {
  test("creates a new token, stores it, and deletes the prior one (two-step); keepPrevious retains it", async () => {
    const tokens = fakeControl({
      listTokens: vi.fn(async () => [{ id: "old-1", name: "pithy-ci-system-staging", status: "active" as const }]),
    });
    const audited: TokenAuditEvent[] = [];
    const result = await rotateProfileToken(
      engineWith(".", tokens, { audit: async (e) => void audited.push(e) }),
      "ci-system",
      "staging",
      { store: "ephemeral" },
    );
    expect(tokens.minted).toEqual(["pithy-ci-system-staging"]);
    expect(tokens.deletedById).toEqual(["old-1"]);
    expect(result.tokenId).toBe("new-pithy-ci-system-staging");
    expect(audited[0]).toMatchObject({ action: "cloudflare/token_rotated", outcome: "success" });

    const kept = fakeControl({
      listTokens: vi.fn(async () => [{ id: "old-2", name: "pithy-ci-system-staging", status: "active" as const }]),
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
      "production",
    );
    expect(tokens.deletedByName).toEqual(["pithy-ci-system-production"]);
    expect(result.revoked).toBe(1);
    expect(audited[0]).toMatchObject({
      action: "cloudflare/token_revoked",
      outcome: "success",
      profile: "ci-system",
      env: "production",
    });
  });
});
