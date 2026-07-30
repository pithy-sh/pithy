// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareRequestError } from "../client/errors";
import { CloudflareR2Provisioner } from "./r2Provisioner";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockList = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    r2 = { buckets: { create: mockCreate, delete: mockDelete, list: mockList } };
  },
}));

describe("CloudflareR2Provisioner", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareR2Provisioner;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareR2Provisioner(config);
  });

  it("createBucket returns the new name (extra fields stripped)", async () => {
    mockCreate.mockResolvedValue({ name: "pithy-media-staging", creation_date: "2026-01-01", location: "wnam" });
    expect(await manager.createBucket("pithy-media-staging")).toEqual({ name: "pithy-media-staging" });
    expect(mockCreate).toHaveBeenCalledWith({ account_id: "acct-1", name: "pithy-media-staging" });
  });

  it("findBucketByName returns the matching bucket, or null", async () => {
    mockList
      .mockResolvedValueOnce({ buckets: [{ name: "alpha" }, { name: "beta" }] })
      .mockResolvedValue({ buckets: [] });
    expect(await manager.findBucketByName("beta")).toEqual({ name: "beta" });

    mockList.mockReset();
    mockList.mockResolvedValue({ buckets: [] });
    expect(await manager.findBucketByName("nope")).toBeNull();
  });

  it("listBuckets returns every bucket in the account, skipping entries with no name", async () => {
    mockList
      .mockResolvedValueOnce({ buckets: [{ name: "alpha" }, { name: "beta" }, { creation_date: "2026-01-01" }] })
      .mockResolvedValue({ buckets: [] });
    expect(await manager.listBuckets()).toEqual([{ name: "alpha" }, { name: "beta" }]);
    expect(mockList).toHaveBeenNthCalledWith(1, { account_id: "acct-1", per_page: 1000 });
  });

  it("listBuckets drains every page via start_after until a page comes back empty", async () => {
    mockList
      .mockResolvedValueOnce({ buckets: [{ name: "a" }, { name: "b" }] })
      .mockResolvedValueOnce({ buckets: [{ name: "c" }] })
      .mockResolvedValue({ buckets: [] });
    expect(await manager.listBuckets()).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
    // Page two and three page past the last-seen name.
    expect(mockList).toHaveBeenNthCalledWith(2, { account_id: "acct-1", per_page: 1000, start_after: "b" });
    expect(mockList).toHaveBeenNthCalledWith(3, { account_id: "acct-1", per_page: 1000, start_after: "c" });
  });

  it("deleteBucket deletes by name within the account", async () => {
    mockDelete.mockResolvedValue({});
    await manager.deleteBucket("pithy-media-staging");
    expect(mockDelete).toHaveBeenCalledWith("pithy-media-staging", { account_id: "acct-1" });
  });

  it("deleteBucket swallows a not-found error (idempotent teardown)", async () => {
    mockDelete.mockRejectedValue({ status: 404 });
    await expect(manager.deleteBucket("bucket-missing")).resolves.toBeUndefined();
  });

  it("wraps an SDK failure as CloudflareRequestError", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited"));
    await expect(manager.createBucket("x")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("validateServiceAccess is true on a successful list, false otherwise", async () => {
    mockList.mockResolvedValue({ buckets: [] });
    expect(await manager.validateServiceAccess()).toBe(true);
    mockList.mockRejectedValue(new Error("403"));
    expect(await manager.validateServiceAccess()).toBe(false);
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Cloudflare R2 (control plane)");
  });
});
