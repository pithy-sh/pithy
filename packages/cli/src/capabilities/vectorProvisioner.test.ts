import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { VectorConfig } from "@pithy-sh/vector/src/config/config";
import { filterable } from "@pithy-sh/vector/src/index/filter";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { CloudflareVectorProvisioner } from "./vectorProvisioner";

/**
 * The live provisioner against fake Cloudflare clients. The behaviour worth pinning is the eventual
 * consistency handling: a created metadata index is *accepted*, not live, so `ensureMetadataIndexes` polls
 * until it is visible and refuses to return early. Returning early would hand the caller a green light to
 * deploy the worker that writes vectors — and a vector written before its metadata index exists is
 * permanently unfilterable, with no error anywhere.
 */

const metadata = z.object({
  ownerId: filterable(z.string().describe("Owner.")),
  title: z.string().describe("Title."),
});

const config = VectorConfig.parse({ indexes: { docs: { model: "m", dimensions: 768, metadata } } });

const declared = [{ propertyName: "ownerId", indexType: "string" as const }];

function fakeCf() {
  const findIndexByName = vi.fn();
  const createIndex = vi.fn();
  const deleteIndex = vi.fn();
  const listMetadataIndexes = vi.fn();
  const createMetadataIndex = vi.fn();
  const validateServiceAccess = vi.fn().mockResolvedValue(true);
  const accountSubdomain = vi.fn().mockResolvedValue("acme");
  const cf = {
    vectorizeProvisioner: () => ({
      findIndexByName,
      createIndex,
      deleteIndex,
      listMetadataIndexes,
      createMetadataIndex,
      validateServiceAccess,
    }),
    workers: () => ({ accountSubdomain }),
  } as unknown as CloudflareClients;
  return {
    cf,
    findIndexByName,
    createIndex,
    deleteIndex,
    listMetadataIndexes,
    createMetadataIndex,
    validateServiceAccess,
    accountSubdomain,
  };
}

function fakeWorkflows() {
  const dispatchAndPoll = vi.fn().mockResolvedValue({ reembedded: 3 });
  return { client: { dispatchAndPoll } as unknown as CloudflareWorkflowsClient, dispatchAndPoll };
}

function provisioner(cf: CloudflareClients, workflows: CloudflareWorkflowsClient) {
  return new CloudflareVectorProvisioner({
    cf,
    accountId: "acct-1",
    apiToken: "tok",
    config,
    resolveEnv: async () => ({ appDatabaseId: "db-1" }),
    workflows,
    // No real waiting: the poll's *shape* is what matters, not its clock.
    sleep: async () => {},
  });
}

describe("preflight", () => {
  test("refuses an account that cannot reach Vectorize", async () => {
    const fake = fakeCf();
    fake.validateServiceAccess.mockResolvedValue(false);
    await expect(provisioner(fake.cf, fakeWorkflows().client).preflight()).rejects.toThrow(/cannot reach Vectorize/);
  });

  test("refuses an account with no workers.dev subdomain, which Workflows require", async () => {
    const fake = fakeCf();
    fake.accountSubdomain.mockResolvedValue(null);
    await expect(provisioner(fake.cf, fakeWorkflows().client).preflight()).rejects.toThrow(/workers.dev/);
  });
});

describe("ensureIndex", () => {
  test("creates the index when it is absent", async () => {
    const fake = fakeCf();
    fake.findIndexByName.mockResolvedValue(null);
    fake.createIndex.mockResolvedValue({ name: "pithy-vector-docs-dev" });

    const result = await provisioner(fake.cf, fakeWorkflows().client).ensureIndex("pithy-vector-docs-dev", {
      dimensions: 768,
      metric: "cosine",
    });

    expect(result).toEqual({ name: "pithy-vector-docs-dev" });
    expect(fake.createIndex).toHaveBeenCalledWith("pithy-vector-docs-dev", { dimensions: 768, metric: "cosine" });
  });

  test("reuses an existing index — a re-run creates nothing", async () => {
    const fake = fakeCf();
    fake.findIndexByName.mockResolvedValue({
      name: "pithy-vector-docs-dev",
      config: { dimensions: 768, metric: "cosine" },
    });

    await provisioner(fake.cf, fakeWorkflows().client).ensureIndex("pithy-vector-docs-dev", {
      dimensions: 768,
      metric: "cosine",
    });
    expect(fake.createIndex).not.toHaveBeenCalled();
  });

  test("refuses an index whose live shape differs — dimensions and metric are fixed at creation", async () => {
    const fake = fakeCf();
    fake.findIndexByName.mockResolvedValue({
      name: "pithy-vector-docs-dev",
      config: { dimensions: 384, metric: "cosine" },
    });

    await expect(
      provisioner(fake.cf, fakeWorkflows().client).ensureIndex("pithy-vector-docs-dev", {
        dimensions: 768,
        metric: "cosine",
      }),
    ).rejects.toThrow(/different shape/);
  });
});

describe("ensureMetadataIndexes", () => {
  test("creates what is missing and waits until it is visible, never assuming a write is live", async () => {
    const fake = fakeCf();
    // Accepted, then absent, then absent, then visible — exactly how Vectorize behaves.
    fake.listMetadataIndexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ propertyName: "ownerId", indexType: "string" }]);

    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );

    expect(fake.createMetadataIndex).toHaveBeenCalledWith("pithy-vector-docs-dev", "ownerId", "string");
    expect(report.missing).toEqual(declared);
    expect(fake.listMetadataIndexes).toHaveBeenCalledTimes(3);
  });

  test("is idempotent — everything present means nothing created and no waiting", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([{ propertyName: "ownerId", indexType: "string" }]);

    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );

    expect(fake.createMetadataIndex).not.toHaveBeenCalled();
    expect(report.missing).toEqual([]);
    expect(fake.listMetadataIndexes).toHaveBeenCalledTimes(1);
  });

  test("refuses a live metadata index of the wrong type rather than writing against it", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([{ propertyName: "ownerId", indexType: "number" }]);

    await expect(
      provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes("pithy-vector-docs-dev", declared),
    ).rejects.toThrow(/different type/);
    expect(fake.createMetadataIndex).not.toHaveBeenCalled();
  });

  test("fails loudly when an accepted metadata index never becomes visible", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([]);

    await expect(
      provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes("pithy-vector-docs-dev", declared),
    ).rejects.toThrow(/not live yet/);
  });

  test("reports a live metadata index the config does not declare — it still costs one of the ten slots", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([
      { propertyName: "ownerId", indexType: "string" },
      { propertyName: "legacy", indexType: "string" },
    ]);

    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );
    expect(report.extra).toEqual([{ propertyName: "legacy", indexType: "string" }]);
  });
});

describe("deleteIndex", () => {
  test("delegates to the provisioner, which is already idempotent", async () => {
    const fake = fakeCf();
    await provisioner(fake.cf, fakeWorkflows().client).deleteIndex("pithy-vector-docs-dev");
    expect(fake.deleteIndex).toHaveBeenCalledWith("pithy-vector-docs-dev");
  });
});

describe("reprocess", () => {
  test("dispatches the environment's deployed Workflow and waits for it", async () => {
    const fake = fakeCf();
    const workflows = fakeWorkflows();

    const report = await provisioner(fake.cf, workflows.client).reprocess("staging", "docs", { all: true });

    expect(workflows.dispatchAndPoll).toHaveBeenCalledWith("pithy-vector-reprocess-staging", {
      index: "docs",
      all: true,
    });
    expect(report).toEqual({ reembedded: 3 });
  });

  test("passes a filter through and omits it when there is none", async () => {
    const fake = fakeCf();
    const workflows = fakeWorkflows();
    await provisioner(fake.cf, workflows.client).reprocess("dev", "docs", { filter: { ownerId: "ada" } });
    expect(workflows.dispatchAndPoll).toHaveBeenCalledWith("pithy-vector-reprocess-dev", {
      index: "docs",
      filter: { ownerId: "ada" },
    });
  });
});
