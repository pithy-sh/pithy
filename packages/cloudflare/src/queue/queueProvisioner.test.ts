// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareRequestError } from "../client/errors";
import { CloudflareQueueProvisioner } from "./queueProvisioner";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockList = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    queues = { create: mockCreate, delete: mockDelete, list: mockList };
  },
}));

describe("CloudflareQueueProvisioner", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareQueueProvisioner;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareQueueProvisioner(config);
  });

  it("createQueue returns the new id and name (extra fields stripped)", async () => {
    mockCreate.mockResolvedValue({ queue_id: "q-1", queue_name: "acme-staging-jobs", producers_total_count: 0 });
    expect(await manager.createQueue("acme-staging-jobs")).toEqual({ id: "q-1", name: "acme-staging-jobs" });
    expect(mockCreate).toHaveBeenCalledWith({ account_id: "acct-1", queue_name: "acme-staging-jobs" });
  });

  it("findQueueByName returns the matching queue, or null", async () => {
    mockList.mockReturnValue([
      { queue_id: "q-a", queue_name: "alpha" },
      { queue_id: "q-b", queue_name: "beta" },
    ]);
    expect(await manager.findQueueByName("beta")).toEqual({ id: "q-b", name: "beta" });
    expect(mockList).toHaveBeenCalledWith({ account_id: "acct-1" });

    mockList.mockReturnValue([]);
    expect(await manager.findQueueByName("nope")).toBeNull();
  });

  it("deleteQueue deletes by id within the account", async () => {
    mockDelete.mockResolvedValue({});
    await manager.deleteQueue("q-1");
    expect(mockDelete).toHaveBeenCalledWith("q-1", { account_id: "acct-1" });
  });

  it("deleteQueue swallows a not-found error (idempotent teardown)", async () => {
    mockDelete.mockRejectedValue({ status: 404 });
    await expect(manager.deleteQueue("q-missing")).resolves.toBeUndefined();
  });

  it("wraps an SDK failure as CloudflareRequestError", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited"));
    await expect(manager.createQueue("x")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("validateServiceAccess is true on a successful list, false otherwise", async () => {
    mockList.mockResolvedValue({ result: [] });
    expect(await manager.validateServiceAccess()).toBe(true);
    mockList.mockRejectedValue(new Error("403"));
    expect(await manager.validateServiceAccess()).toBe(false);
  });
});
