// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { renderTerminal } from "@pithy-sh/core/src/error/terminal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareNotConfiguredError, CloudflareRequestError } from "../client/errors";
import { accountResource, CloudflareAccountTokensManager } from "./accountTokensManager";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockTokenList = vi.fn();
const mockTokenGet = vi.fn();
const mockVerify = vi.fn();
const mockPgList = vi.fn();
const mockValueUpdate = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    accounts = {
      tokens: {
        create: mockCreate,
        delete: mockDelete,
        get: mockTokenGet,
        list: mockTokenList,
        verify: mockVerify,
        permissionGroups: { list: mockPgList },
        value: { update: mockValueUpdate },
      },
    };
  },
}));

/** A mock SDK paginator over `items`, the `for await` shape every list endpoint returns. */
function paginator<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

const PERMISSION_GROUPS = [
  { id: "pg-read", name: "Secrets Store Read", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-write", name: "Secrets Store Write", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-other", name: "DNS Read", scopes: ["com.cloudflare.api.account.zone"] },
];

describe("accountResource", () => {
  it("builds the whole-account resource scope", () => {
    expect(accountResource("acct-1")).toEqual({ "com.cloudflare.api.account.acct-1": "*" });
  });
});

describe("CloudflareAccountTokensManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareAccountTokensManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareAccountTokensManager(config);
    mockPgList.mockReturnValue(paginator(PERMISSION_GROUPS));
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Cloudflare Account API Tokens");
  });

  it("listPermissionGroups returns id + name, dropping unparseable entries", async () => {
    mockPgList.mockReturnValue(paginator([...PERMISSION_GROUPS, { name: "no id, dropped" }]));
    const groups = await manager.listPermissionGroups();
    expect(groups).toEqual([
      { id: "pg-read", name: "Secrets Store Read" },
      { id: "pg-write", name: "Secrets Store Write" },
      { id: "pg-other", name: "DNS Read" },
    ]);
  });

  it("listTokens returns every token summary, dropping unparseable entries", async () => {
    mockTokenList.mockReturnValue(
      paginator([
        { id: "t1", name: "pithy-remote-migrate-staging", status: "active" },
        { id: "t2", name: "pithy-secrets-production", status: "active" },
        { name: "no id, dropped" },
      ]),
    );
    expect(await manager.listTokens()).toEqual([
      { id: "t1", name: "pithy-remote-migrate-staging", status: "active" },
      { id: "t2", name: "pithy-secrets-production", status: "active" },
    ]);
  });

  it("resolvePermissionGroups maps names to id references", async () => {
    expect(await manager.resolvePermissionGroups(["Secrets Store Read", "Secrets Store Write"])).toEqual([
      { id: "pg-read" },
      { id: "pg-write" },
    ]);
  });

  it("resolvePermissionGroups throws an actionable error on an unknown name", async () => {
    await expect(manager.resolvePermissionGroups(["Secrets Store Read", "Made Up"])).rejects.toBeInstanceOf(
      CloudflareNotConfiguredError,
    );
    await expect(manager.resolvePermissionGroups(["Made Up"])).rejects.toThrow(/Made Up/);
  });

  it("resolvePermissionGroups rejects an ambiguous name (same name, multiple scopes)", async () => {
    mockPgList.mockReturnValue(
      paginator([
        { id: "acct-id", name: "Dup Name", scopes: ["com.cloudflare.api.account"] },
        { id: "zone-id", name: "Dup Name", scopes: ["com.cloudflare.api.account.zone"] },
      ]),
    );
    const error = await manager.resolvePermissionGroups(["Dup Name"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareNotConfiguredError);
    expect((error as CloudflareNotConfiguredError).payload.message).toMatch(/Ambiguous/);
  });

  it("mintToken resolves names and creates a token with the built policy", async () => {
    mockCreate.mockResolvedValue({
      id: "tk-9",
      value: "secret-value",
      name: "pithy-secrets-manager",
      status: "active",
    });

    const minted = await manager.mintToken("pithy-secrets-manager", [
      { permissionGroupNames: ["Secrets Store Read", "Secrets Store Write"], resources: accountResource("acct-1") },
    ]);

    expect(minted).toEqual({ id: "tk-9", value: "secret-value", name: "pithy-secrets-manager", status: "active" });
    expect(mockCreate).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: "pithy-secrets-manager",
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "pg-read" }, { id: "pg-write" }],
          resources: { "com.cloudflare.api.account.acct-1": "*" },
        },
      ],
    });
  });

  it("mintToken decodes loudly when the create response has no value", async () => {
    mockCreate.mockResolvedValue({ id: "tk-9", status: "active" });
    await expect(
      manager.mintToken("t", [{ permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") }]),
    ).rejects.toThrow(/unexpected shape/);
  });

  it("mintToken turns a 403 into an actionable 'Account API Tokens Write' error", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 403 }));
    const error = await manager
      .mintToken("t", [{ permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") }])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareNotConfiguredError);
    expect((error as CloudflareNotConfiguredError).payload.action).toMatch(/Account API Tokens Write/);
  });

  it("mintToken wraps a non-auth failure as a request error", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
    await expect(
      manager.mintToken("t", [{ permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") }]),
    ).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("mintToken renders Cloudflare's own answer on a 401 — the status the token bootstrap fails under", async () => {
    // The whole of #534, on the command that meets it first. `isAuthorizationError` is 403-only and
    // stays that way (its other callers *swallow* a denial), so every 401 fell to the fallback throw —
    // which composed a `CloudflareRequestError` by hand and printed one sentence: "Failed to mint
    // account token 'pithy-prod-deploy'." No code, no sentence, no link, no action. A hand-built
    // `PithyError` is also invisible to `cloudflareRequest`'s wrapper, so this could not be repaired
    // from `client/errors.ts` at all.
    // The SDK is mocked in this file, so the throw is built the way the SDK builds one: `status` plus a
    // parsed `errors` array. `cloudflareApiErrors` is duck-typed on exactly that, never `instanceof`.
    mockCreate.mockRejectedValue(
      Object.assign(new Error("401 Authentication error"), {
        status: 401,
        errors: [
          {
            code: 10000,
            message: "Authentication error",
            documentation_url: "https://developers.cloudflare.com/api/resources/accounts/subresources/tokens",
          },
        ],
      }),
    );

    const error = await manager
      .mintToken("pithy-prod-deploy", [
        { permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") },
      ])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CloudflareRequestError);
    expect(renderTerminal((error as CloudflareRequestError).payload)).toBe(
      [
        "Failed to mint account token 'pithy-prod-deploy'. Cloudflare said: 10000 Authentication error — https://developers.cloudflare.com/api/resources/accounts/subresources/tokens",
        "A missing grant, a dead token and the wrong account all look the same here. Check the token for Account → API Tokens, then CLOUDFLARE_API_TOKEN, then CLOUDFLARE_ACCOUNT_ID.",
      ].join("\n"),
    );
  });

  it("mintToken's 403 keeps its diagnosis and Cloudflare's answer with it", async () => {
    // Round two moved the *fallback* throw onto the shared composer and left this branch composing its
    // own sentence, so the one status that carries a real diagnosis — the token got in and may not
    // create tokens — was also the one that dropped the API's `errors[]` on the floor. Both now.
    mockCreate.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), {
        status: 403,
        errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
      }),
    );
    const error = await manager
      .mintToken("t", [{ permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") }])
      .catch((e: unknown) => e);

    const { payload } = error as CloudflareNotConfiguredError;
    expect(payload.message).toBe(
      "The Cloudflare API token is not allowed to create account tokens. Cloudflare said: 9109 Unauthorized to access requested resource",
    );
    expect(payload.action).toMatch(/Account API Tokens Write/);
    expect(payload.params).toMatchObject({ apiCode: 9109, apiMessage: "Unauthorized to access requested resource" });
    expect(payload.message).not.toContain("\n");
  });

  /**
   * **The permission hint has to be on the call that refuses first, not on the one that names it.**
   *
   * `pithy token mint` is the command an under-scoped bootstrap token meets first, and it is
   * `rollToken → findTokenByName → listTokens`, then `listPermissionGroups`, and only then
   * `tokens.create`. Every one of those runs on the same credential, so a hint attached to the mint
   * alone is a hint the operator never reaches: round two put `permission: "API Tokens"` on `mintToken`
   * and the refusal an operator actually saw still said "Check the token's permission for this
   * product." Cloudflare's own docs link cannot supply it either — `accounts/tokens` yields the
   * `accounts` segment, which maps to no single product.
   */
  it.each([
    ["rollToken, which lists before it mints", (m: CloudflareAccountTokensManager) => m.rollToken("t", [])],
    ["listTokens", (m: CloudflareAccountTokensManager) => m.listTokens()],
    ["listPermissionGroups", (m: CloudflareAccountTokensManager) => m.listPermissionGroups()],
    ["rollTokenValue", (m: CloudflareAccountTokensManager) => m.rollTokenValue("tk-1")],
  ])("%s names Account → API Tokens on a 401", async (_label, call) => {
    const denial = Object.assign(new Error("401 Authentication error"), {
      status: 401,
      errors: [{ code: 10000, message: "Authentication error" }],
    });
    mockTokenList.mockImplementation(() => {
      throw denial;
    });
    mockPgList.mockImplementation(() => {
      throw denial;
    });
    mockValueUpdate.mockRejectedValue(denial);

    const error = await call(manager).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CloudflareRequestError);
    expect((error as CloudflareRequestError).payload.action).toContain("Check the token for Account → API Tokens");
  });

  it("mintToken keeps the 403 diagnosis, which says more than the generic refusal does", async () => {
    // Broadening `isAuthorizationError` to 401 would have been the wrong repair twice over: it would
    // report a *dead* token as a permission this project does not need, which is finding #3's false
    // dichotomy in another costume. 403 means the token got in and may not create tokens; 401 means it
    // did not get in, and only the three-way check above can answer that.
    mockCreate.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 403 }));
    const error = await manager
      .mintToken("t", [{ permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") }])
      .catch((e: unknown) => e);
    expect((error as CloudflareNotConfiguredError).payload.code).toBe("cloudflare/not_configured");
  });

  it("verifyToken verifies the calling token against the account, never the user endpoint", async () => {
    mockVerify.mockResolvedValue({ id: "tk-self", status: "active" });
    expect(await manager.verifyToken()).toEqual({ id: "tk-self", status: "active" });
    expect(mockVerify).toHaveBeenCalledWith({ account_id: "acct-1" });
  });

  it("getTokenName reads the token record within the account", async () => {
    mockTokenGet.mockResolvedValue({ id: "tk-self", name: "pithy-int-ci-system", status: "active" });
    expect(await manager.getTokenName("tk-self")).toBe("pithy-int-ci-system");
    expect(mockTokenGet).toHaveBeenCalledWith("tk-self", { account_id: "acct-1" });
  });

  it("getTokenName returns null when the caller may not read the token record", async () => {
    // A least-privilege minted token asking its own name: 403 is the expected answer, not a failure.
    mockTokenGet.mockRejectedValue(
      Object.assign(new Error("Unauthorized to access requested resource"), { status: 403 }),
    );
    expect(await manager.getTokenName("tk-self")).toBeNull();
  });

  it("getTokenName returns null when the record has no readable name", async () => {
    mockTokenGet.mockResolvedValue({ id: "tk-self", status: "active" });
    expect(await manager.getTokenName("tk-self")).toBeNull();
  });

  it("getTokenName still throws on a non-authorization failure", async () => {
    mockTokenGet.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
    await expect(manager.getTokenName("tk-self")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("findTokenByName returns the matching token, or null", async () => {
    mockTokenList.mockReturnValue(
      paginator([
        { id: "a", name: "other" },
        { id: "b", name: "pithy-secrets-manager" },
      ]),
    );
    expect(await manager.findTokenByName("pithy-secrets-manager")).toEqual({ id: "b", name: "pithy-secrets-manager" });

    mockTokenList.mockReturnValue(paginator([{ id: "a", name: "other" }]));
    expect(await manager.findTokenByName("pithy-secrets-manager")).toBeNull();
  });

  it("deleteToken deletes by id within the account", async () => {
    mockDelete.mockResolvedValue({ id: "tk-9" });
    await manager.deleteToken("tk-9");
    expect(mockDelete).toHaveBeenCalledWith("tk-9", { account_id: "acct-1" });
  });

  it("deleteTokensByName deletes every same-named token and counts them", async () => {
    mockTokenList.mockReturnValue(
      paginator([
        { id: "a", name: "dup" },
        { id: "b", name: "keep" },
        { id: "c", name: "dup" },
      ]),
    );
    mockDelete.mockResolvedValue({ id: "x" });

    expect(await manager.deleteTokensByName("dup")).toBe(2);
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith("a", { account_id: "acct-1" });
    expect(mockDelete).toHaveBeenCalledWith("c", { account_id: "acct-1" });
  });

  it("deleteTokensByName is a no-op when none match", async () => {
    mockTokenList.mockReturnValue(paginator([{ id: "a", name: "other" }]));
    expect(await manager.deleteTokensByName("dup")).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("rollTokenValue regenerates a token's secret in place", async () => {
    mockValueUpdate.mockResolvedValue("rolled-secret");
    expect(await manager.rollTokenValue("tk-1")).toBe("rolled-secret");
    expect(mockValueUpdate).toHaveBeenCalledWith("tk-1", { account_id: "acct-1", body: {} });
  });

  it("rollToken rolls an existing token's value in place, keeping its id", async () => {
    mockTokenList.mockReturnValue(paginator([{ id: "tk-existing", name: "pithy-secrets-manager", status: "active" }]));
    mockValueUpdate.mockResolvedValue("rolled-value");

    const rolled = await manager.rollToken("pithy-secrets-manager", [
      { permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") },
    ]);

    expect(mockValueUpdate).toHaveBeenCalledWith("tk-existing", { account_id: "acct-1", body: {} });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(rolled).toEqual({
      id: "tk-existing",
      value: "rolled-value",
      name: "pithy-secrets-manager",
      status: "active",
    });
  });

  it("rollToken mints a fresh token when none of that name exists", async () => {
    mockTokenList.mockReturnValue(paginator([{ id: "other", name: "unrelated" }]));
    mockCreate.mockResolvedValue({ id: "fresh", value: "new-value", name: "pithy-secrets-manager", status: "active" });

    const minted = await manager.rollToken("pithy-secrets-manager", [
      { permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") },
    ]);

    expect(mockValueUpdate).not.toHaveBeenCalled();
    expect(minted.id).toBe("fresh");
    expect(minted.value).toBe("new-value");
  });

  it("validateServiceAccess is true when listing groups works, false otherwise", async () => {
    expect(await manager.validateServiceAccess()).toBe(true);
    mockPgList.mockImplementation(() => {
      throw new Error("403");
    });
    expect(await manager.validateServiceAccess()).toBe(false);
  });

  it("errors are PithyErrors (the one family)", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    await expect(
      manager.mintToken("t", [{ permissionGroupNames: ["Secrets Store Read"], resources: accountResource("acct-1") }]),
    ).rejects.toBeInstanceOf(PithyError);
  });
});
