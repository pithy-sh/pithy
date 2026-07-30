// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareInvalidResponseError, CloudflareRequestError } from "../client/errors";
import { CloudflareVectorizeProvisioner } from "./vectorizeProvisioner";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockGet = vi.fn();
const mockList = vi.fn();
const mockMetaCreate = vi.fn();
const mockMetaDelete = vi.fn();
const mockMetaList = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    vectorize = {
      indexes: {
        create: mockCreate,
        delete: mockDelete,
        get: mockGet,
        list: mockList,
        metadataIndex: { create: mockMetaCreate, delete: mockMetaDelete, list: mockMetaList },
      },
    };
  },
}));

const INDEX = { name: "pithy-vector-staging", config: { dimensions: 768, metric: "cosine" } };

describe("CloudflareVectorizeProvisioner", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareVectorizeProvisioner;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareVectorizeProvisioner(config);
  });

  it("createIndex sends an explicit dimensions/metric config and strips extra response fields", async () => {
    mockCreate.mockResolvedValue({ ...INDEX, created_on: "2026-01-01", modified_on: "2026-01-02" });
    expect(await manager.createIndex("pithy-vector-staging", { dimensions: 768, metric: "cosine" })).toEqual(INDEX);
    expect(mockCreate).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: "pithy-vector-staging",
      config: { dimensions: 768, metric: "cosine" },
    });
  });

  it("createIndex sends a preset config, and a description only when given", async () => {
    mockCreate.mockResolvedValue({ ...INDEX, description: "Search embeddings." });
    const created = await manager.createIndex(
      "pithy-vector-staging",
      { preset: "@cf/baai/bge-base-en-v1.5" },
      { description: "Search embeddings." },
    );
    expect(created.description).toBe("Search embeddings.");
    expect(mockCreate).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: "pithy-vector-staging",
      config: { preset: "@cf/baai/bge-base-en-v1.5" },
      description: "Search embeddings.",
    });
  });

  it("createIndex rejects a response missing its config (loud, not silently shapeless)", async () => {
    mockCreate.mockResolvedValue({ name: "pithy-vector-staging" });
    await expect(
      manager.createIndex("pithy-vector-staging", { dimensions: 768, metric: "cosine" }),
    ).rejects.toBeInstanceOf(CloudflareInvalidResponseError);
  });

  it("deleteIndex deletes by name within the account", async () => {
    mockDelete.mockResolvedValue({});
    await manager.deleteIndex("pithy-vector-staging");
    expect(mockDelete).toHaveBeenCalledWith("pithy-vector-staging", { account_id: "acct-1" });
  });

  it("deleteIndex swallows a not-found error (idempotent teardown)", async () => {
    mockDelete.mockRejectedValue({ status: 404 });
    await expect(manager.deleteIndex("index-missing")).resolves.toBeUndefined();
  });

  it("deleteIndex still fails on a non-404", async () => {
    mockDelete.mockRejectedValue({ status: 403 });
    await expect(manager.deleteIndex("pithy-vector-staging")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("listIndexes drains the paginated list and decodes every entry", async () => {
    mockList.mockReturnValue([INDEX, { name: "other", config: { dimensions: 32, metric: "euclidean" } }]);
    expect(await manager.listIndexes()).toEqual([
      INDEX,
      { name: "other", config: { dimensions: 32, metric: "euclidean" } },
    ]);
    expect(mockList).toHaveBeenCalledWith({ account_id: "acct-1" });
  });

  it("findIndexByName reads the one index by name", async () => {
    mockGet.mockResolvedValue(INDEX);
    expect(await manager.findIndexByName("pithy-vector-staging")).toEqual(INDEX);
    expect(mockGet).toHaveBeenCalledWith("pithy-vector-staging", { account_id: "acct-1" });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("findIndexByName returns null when the index is absent", async () => {
    mockGet.mockRejectedValue({ status: 404 });
    expect(await manager.findIndexByName("nope")).toBeNull();
  });

  // Live Vectorize answers a deleted index with 410, not 404. A find-then-create provisioner must read that
  // as absent, or `pithy vector provision` throws on exactly the case it exists to repair.
  it("findIndexByName returns null for a deleted index, which Vectorize reports as 410 Gone", async () => {
    mockGet.mockRejectedValue({ status: 410 });
    expect(await manager.findIndexByName("deleted")).toBeNull();
  });

  it("deleteIndex swallows a 410 too, so teardown re-runs cleanly", async () => {
    mockDelete.mockRejectedValue({ status: 410 });
    await expect(manager.deleteIndex("deleted")).resolves.toBeUndefined();
  });

  it("findIndexByName still fails on a non-404", async () => {
    mockGet.mockRejectedValue(new Error("rate limited"));
    await expect(manager.findIndexByName("pithy-vector-staging")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  it("createMetadataIndex names the index, property, and type", async () => {
    mockMetaCreate.mockResolvedValue({ mutationId: "mut-1" });
    await manager.createMetadataIndex("pithy-vector-staging", "tenantId", "string");
    expect(mockMetaCreate).toHaveBeenCalledWith("pithy-vector-staging", {
      account_id: "acct-1",
      indexType: "string",
      propertyName: "tenantId",
    });
  });

  it("listMetadataIndexes decodes the indexed properties", async () => {
    mockMetaList.mockResolvedValue({
      metadataIndexes: [
        { propertyName: "tenantId", indexType: "string" },
        { propertyName: "score", indexType: "number" },
      ],
    });
    expect(await manager.listMetadataIndexes("pithy-vector-staging")).toEqual([
      { propertyName: "tenantId", indexType: "string" },
      { propertyName: "score", indexType: "number" },
    ]);
    expect(mockMetaList).toHaveBeenCalledWith("pithy-vector-staging", { account_id: "acct-1" });
  });

  // The casing live Cloudflare actually answers with. This mock lied for a while: it fed the lowercase form
  // the create endpoint takes, so the decode passed here and threw `cloudflare/invalid_response` against the
  // real API. Pinned in both casings so it cannot drift back.
  it("listMetadataIndexes lowercases the capitalized types Cloudflare returns", async () => {
    mockMetaList.mockResolvedValue({
      metadataIndexes: [
        { propertyName: "tenantId", indexType: "String" },
        { propertyName: "score", indexType: "Number" },
        { propertyName: "published", indexType: "Boolean" },
      ],
    });
    expect(await manager.listMetadataIndexes("pithy-vector-staging")).toEqual([
      { propertyName: "tenantId", indexType: "string" },
      { propertyName: "score", indexType: "number" },
      { propertyName: "published", indexType: "boolean" },
    ]);
  });

  it("listMetadataIndexes returns an empty array when the index has none", async () => {
    mockMetaList.mockResolvedValue({});
    expect(await manager.listMetadataIndexes("pithy-vector-staging")).toEqual([]);
  });

  it("deleteMetadataIndex names the property, and swallows a not-found error", async () => {
    mockMetaDelete.mockResolvedValue({ mutationId: "mut-2" });
    await manager.deleteMetadataIndex("pithy-vector-staging", "tenantId");
    expect(mockMetaDelete).toHaveBeenCalledWith("pithy-vector-staging", {
      account_id: "acct-1",
      propertyName: "tenantId",
    });

    mockMetaDelete.mockRejectedValue({ status: 404 });
    await expect(manager.deleteMetadataIndex("pithy-vector-staging", "gone")).resolves.toBeUndefined();
  });

  it("deleteMetadataIndex swallows Vectorize's real absence signal, which is 400/40005 and not 404", async () => {
    // Verified live on 2026-07-28: deleting a metadata index that is not there answers `400` with error
    // code 40005, so the plain not-found check left this method throwing on the one case its documented
    // idempotency exists for — and teardown could not re-run.
    mockMetaDelete.mockRejectedValue({
      status: 400,
      errors: [{ code: 40005, message: "metadata index with name=tenantId does not exist" }],
    });
    await expect(manager.deleteMetadataIndex("pithy-vector-staging", "tenantId")).resolves.toBeUndefined();
  });

  it("deleteMetadataIndex still surfaces a 400 that is not an absence", async () => {
    // The narrow check earns its keep here: a malformed request must stay an error rather than becoming a
    // silent no-op that reports success while changing nothing.
    mockMetaDelete.mockRejectedValue({
      status: 400,
      errors: [{ code: 1004, message: "invalid property name" }],
    });
    await expect(manager.deleteMetadataIndex("pithy-vector-staging", "bad name")).rejects.toBeInstanceOf(
      CloudflareRequestError,
    );
  });

  it("wraps an SDK failure as CloudflareRequestError", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited"));
    await expect(manager.createIndex("x", { dimensions: 768, metric: "cosine" })).rejects.toBeInstanceOf(
      CloudflareRequestError,
    );
  });

  it("only ever throws PithyError from public methods", async () => {
    mockList.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(manager.listIndexes()).rejects.toHaveProperty("payload.code", "cloudflare/request_failed");
  });

  it("validateServiceAccess is true on a successful list, false otherwise", async () => {
    mockList.mockReturnValue([]);
    expect(await manager.validateServiceAccess()).toBe(true);
    mockList.mockImplementation(() => {
      throw new Error("403");
    });
    expect(await manager.validateServiceAccess()).toBe(false);
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Vectorize (control plane)");
  });

  it("throws cloudflare/not_configured without an account id", () => {
    expect(() => new CloudflareVectorizeProvisioner({ accountId: "", apiToken: "tok-1" })).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
    );
  });
});
