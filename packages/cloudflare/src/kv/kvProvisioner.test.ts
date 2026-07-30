// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareRequestError } from "../client/errors";
import { CloudflareKVProvisioner } from "./kvProvisioner";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockList = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    kv = { namespaces: { create: mockCreate, delete: mockDelete, list: mockList } };
  },
}));

describe("CloudflareKVProvisioner", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareKVProvisioner;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareKVProvisioner(config);
  });

  it("createNamespace returns the new id and title (extra fields stripped)", async () => {
    mockCreate.mockResolvedValue({ id: "ns-1", title: "pithy-secrets-staging", supports_url_encoding: true });
    expect(await manager.createNamespace("pithy-secrets-staging")).toEqual({
      id: "ns-1",
      title: "pithy-secrets-staging",
    });
    expect(mockCreate).toHaveBeenCalledWith({ account_id: "acct-1", title: "pithy-secrets-staging" });
  });

  it("findNamespaceByTitle returns the matching namespace, or null", async () => {
    mockList.mockReturnValue([
      { id: "ns-a", title: "alpha" },
      { id: "ns-b", title: "beta" },
    ]);
    expect(await manager.findNamespaceByTitle("beta")).toEqual({ id: "ns-b", title: "beta" });

    mockList.mockReturnValue([]);
    expect(await manager.findNamespaceByTitle("nope")).toBeNull();
  });

  it("listNamespaces returns every namespace in the account", async () => {
    mockList.mockReturnValue([
      { id: "ns-a", title: "alpha" },
      { id: "ns-b", title: "beta" },
    ]);
    expect(await manager.listNamespaces()).toEqual([
      { id: "ns-a", title: "alpha" },
      { id: "ns-b", title: "beta" },
    ]);
    expect(mockList).toHaveBeenCalledWith({ account_id: "acct-1" });
  });

  it("deleteNamespace deletes by id within the account", async () => {
    mockDelete.mockResolvedValue({});
    await manager.deleteNamespace("ns-1");
    expect(mockDelete).toHaveBeenCalledWith("ns-1", { account_id: "acct-1" });
  });

  it("deleteNamespace swallows a not-found error (idempotent teardown)", async () => {
    mockDelete.mockRejectedValue({ status: 404 });
    await expect(manager.deleteNamespace("ns-missing")).resolves.toBeUndefined();
  });

  it("wraps an SDK failure as CloudflareRequestError", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited"));
    await expect(manager.createNamespace("x")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("validateServiceAccess is true on a successful list, false otherwise", async () => {
    mockList.mockResolvedValue({ result: [] });
    expect(await manager.validateServiceAccess()).toBe(true);
    mockList.mockRejectedValue(new Error("403"));
    expect(await manager.validateServiceAccess()).toBe(false);
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Cloudflare KV (control plane)");
  });
});
