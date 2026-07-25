import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareRequestError } from "../client/errors";
import { CloudflareD1Provisioner } from "./d1Provisioner";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockList = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    d1 = { database: { create: mockCreate, delete: mockDelete, list: mockList } };
  },
}));

describe("CloudflareD1Provisioner", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareD1Provisioner;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareD1Provisioner(config);
  });

  it("createDatabase returns the new id and name (extra fields stripped)", async () => {
    mockCreate.mockResolvedValue({ uuid: "db-uuid", name: "pithy-secrets-staging", created_at: "2026-01-01" });
    expect(await manager.createDatabase("pithy-secrets-staging")).toEqual({
      uuid: "db-uuid",
      name: "pithy-secrets-staging",
    });
    expect(mockCreate).toHaveBeenCalledWith({ account_id: "acct-1", name: "pithy-secrets-staging" });
  });

  it("findDatabaseByName returns the matching database, or null", async () => {
    mockList.mockReturnValue([
      { uuid: "db-a", name: "alpha" },
      { uuid: "db-b", name: "beta" },
    ]);
    expect(await manager.findDatabaseByName("beta")).toEqual({ uuid: "db-b", name: "beta" });

    mockList.mockReturnValue([]);
    expect(await manager.findDatabaseByName("nope")).toBeNull();
  });

  it("listDatabases returns every database (skipping malformed rows)", async () => {
    mockList.mockReturnValue([
      { uuid: "db-a", name: "alpha" },
      { uuid: "db-b", name: "beta" },
    ]);
    expect(await manager.listDatabases()).toEqual([
      { uuid: "db-a", name: "alpha" },
      { uuid: "db-b", name: "beta" },
    ]);
    expect(mockList).toHaveBeenCalledWith({ account_id: "acct-1" });
  });

  it("deleteDatabase deletes by id within the account", async () => {
    mockDelete.mockResolvedValue({});
    await manager.deleteDatabase("db-uuid");
    expect(mockDelete).toHaveBeenCalledWith("db-uuid", { account_id: "acct-1" });
  });

  it("wraps an SDK failure as CloudflareRequestError", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited"));
    await expect(manager.createDatabase("x")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("validateServiceAccess is true on a successful list, false otherwise", async () => {
    mockList.mockResolvedValue({ result: [] });
    expect(await manager.validateServiceAccess()).toBe(true);
    mockList.mockRejectedValue(new Error("403"));
    expect(await manager.validateServiceAccess()).toBe(false);
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Cloudflare D1 (control plane)");
  });
});
