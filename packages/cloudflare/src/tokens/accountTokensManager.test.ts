import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareNotConfiguredError, CloudflareRequestError } from "../client/errors";
import { accountResource, CloudflareAccountTokensManager } from "./accountTokensManager";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockTokenList = vi.fn();
const mockPgList = vi.fn();
const mockValueUpdate = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    accounts = {
      tokens: {
        create: mockCreate,
        delete: mockDelete,
        list: mockTokenList,
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
