// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { VectorConfig } from "@pithy-sh/vector/src/config/config";
import { filterable } from "@pithy-sh/vector/src/index/filter";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { KIT_ROOT } from "../test-utils/kitRoot";
import {
  CloudflareVectorProvisioner,
  METADATA_POLL_INTERVAL_MS,
  METADATA_SETTLE_BUDGET_MS,
  METADATA_STABLE_READS,
} from "./vectorProvisioner";

/** The project every provisioned name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "acme";

/**
 * The live provisioner against fake Cloudflare clients. The behavior worth pinning is the eventual
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

/**
 * A clock that only moves when the provisioner sleeps, so a five-minute budget runs in no real time and the
 * test can still say how long the provisioner thought it waited.
 */
function virtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    elapsed: () => now,
  };
}

function provisioner(
  cf: CloudflareClients,
  workflows: CloudflareWorkflowsClient,
  clock: ReturnType<typeof virtualClock> = virtualClock(),
) {
  return new CloudflareVectorProvisioner({
    projectDir: KIT_ROOT,
    project: PROJECT,
    cf,
    accountId: "acct-1",
    apiToken: "tok",
    config,
    resolveEnv: async () => ({ appDatabaseId: "db-1" }),
    workflows,
    // No real waiting: the poll's *shape* is what matters, and the clock moves only when it sleeps.
    sleep: clock.sleep,
    now: clock.now,
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

const OWNER = { propertyName: "ownerId", indexType: "string" };

describe("ensureMetadataIndexes", () => {
  test("the wait is sized from measured Vectorize latency: 300s, three agreeing reads, a 2s poll", () => {
    // A metadata index settled in about 97s on one live run and was still unsettled at 120s on the next
    // (#709). The ten one-second polls this replaced gave up on both.
    expect(METADATA_SETTLE_BUDGET_MS).toBe(300_000);
    expect(METADATA_STABLE_READS).toBe(3);
    expect(METADATA_POLL_INTERVAL_MS).toBe(2_000);
  });

  test("creates what is missing and waits for three agreeing reads, never assuming a write is live", async () => {
    const fake = fakeCf();
    // Accepted, then absent, then absent, then visible — exactly how Vectorize behaves.
    fake.listMetadataIndexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([OWNER]);

    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );

    expect(fake.createMetadataIndex).toHaveBeenCalledWith("pithy-vector-docs-dev", "ownerId", "string");
    expect(report.missing).toEqual(declared);
    // The read before creating, two misses, then three in a row that agree.
    expect(fake.listMetadataIndexes).toHaveBeenCalledTimes(6);
  });

  test("a read that flaps back to absent starts the count again", async () => {
    // The list is not monotonic: a live probe watched it report an index, then drop it 18s later.
    const fake = fakeCf();
    fake.listMetadataIndexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([OWNER])
      .mockResolvedValueOnce([OWNER])
      .mockResolvedValueOnce([])
      .mockResolvedValue([OWNER]);

    await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes("pithy-vector-docs-dev", declared);

    expect(fake.listMetadataIndexes).toHaveBeenCalledTimes(7);
  });

  test("a read that agrees on the count but not the names or types does not count", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ propertyName: "legacy", indexType: "string" }])
      .mockResolvedValueOnce([{ propertyName: "ownerId", indexType: "number" }])
      .mockResolvedValueOnce([{ propertyName: "legacy", indexType: "string" }])
      .mockResolvedValue([OWNER]);

    await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes("pithy-vector-docs-dev", declared);

    expect(fake.listMetadataIndexes).toHaveBeenCalledTimes(7);
  });

  test("is idempotent — everything present means nothing created, still confirmed across three reads", async () => {
    // One read is not a confirmation, on a re-run any more than on a first run: a re-run is what the
    // not-live-yet error tells the operator to do, and its "ready" is what they wait for.
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([OWNER]);

    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );

    expect(fake.createMetadataIndex).not.toHaveBeenCalled();
    expect(report.missing).toEqual([]);
    expect(fake.listMetadataIndexes).toHaveBeenCalledTimes(METADATA_STABLE_READS);
  });

  test("a re-run that finds an index present once then absent waits for it, rather than calling it ready", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValueOnce([OWNER]).mockResolvedValueOnce([]).mockResolvedValue([OWNER]);

    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );

    expect(fake.createMetadataIndex).not.toHaveBeenCalled();
    expect(report.missing).toEqual([]);
    expect(fake.listMetadataIndexes).toHaveBeenCalledTimes(5);
  });

  test("refuses a live metadata index of the wrong type rather than writing against it", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([{ propertyName: "ownerId", indexType: "number" }]);

    await expect(
      provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes("pithy-vector-docs-dev", declared),
    ).rejects.toThrow(/different type/);
    expect(fake.createMetadataIndex).not.toHaveBeenCalled();
  });

  test("waits the whole measured budget before it says an accepted index is not live yet", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([]);
    const clock = virtualClock();

    const thrown = await provisioner(fake.cf, fakeWorkflows().client, clock)
      .ensureMetadataIndexes("pithy-vector-docs-dev", declared)
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      payload: {
        message: "The metadata indexes on `pithy-vector-docs-dev` were accepted but are not live yet.",
        action: "Re-run `pithy vector provision` in a minute. Do not write vectors until it reports them ready.",
        detail: "waited 300s for ownerId",
      },
    });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(METADATA_SETTLE_BUDGET_MS);
    expect(clock.elapsed()).toBeLessThan(METADATA_SETTLE_BUDGET_MS + METADATA_POLL_INTERVAL_MS);
  });

  test("the re-run that error asks for finishes the job once the index is live", async () => {
    // The action names a command; this is that command, run as written, against an index the first run
    // created and Cloudflare has applied since. It creates nothing twice and reports the index ready.
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([]);
    await expect(
      provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes("pithy-vector-docs-dev", declared),
    ).rejects.toThrow(/not live yet/);
    expect(fake.createMetadataIndex).toHaveBeenCalledTimes(1);

    fake.listMetadataIndexes.mockResolvedValue([OWNER]);
    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );

    expect(report).toEqual({ missing: [], mismatched: [], extra: [] });
    expect(fake.createMetadataIndex).toHaveBeenCalledTimes(1);
  });

  test("a re-run whose create is refused because the first run's create landed carries on and waits", async () => {
    // The list can miss an index that exists, so a re-run can ask to create one twice. Whatever Cloudflare
    // answers to that, an index listed under its own name and type right after is the one the first run
    // created, and the re-run waits for it rather than failing on it.
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValueOnce([]).mockResolvedValue([OWNER]);
    fake.createMetadataIndex.mockRejectedValue(new Error("metadata index already exists"));

    const report = await provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes(
      "pithy-vector-docs-dev",
      declared,
    );

    expect(report.missing).toEqual(declared);
  });

  test("a create that is refused for any other reason still fails, with Cloudflare's answer", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([]);
    const refused = new Error("metadata index limit reached");
    fake.createMetadataIndex.mockRejectedValue(refused);

    await expect(
      provisioner(fake.cf, fakeWorkflows().client).ensureMetadataIndexes("pithy-vector-docs-dev", declared),
    ).rejects.toBe(refused);
  });

  test("reports a live metadata index the config does not declare — it still costs one of the ten slots", async () => {
    const fake = fakeCf();
    fake.listMetadataIndexes.mockResolvedValue([OWNER, { propertyName: "legacy", indexType: "string" }]);

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

    expect(workflows.dispatchAndPoll).toHaveBeenCalledWith("acme-staging-vector-reprocess", {
      index: "docs",
      all: true,
    });
    expect(report).toEqual({ reembedded: 3 });
  });

  test("passes a filter through and omits it when there is none", async () => {
    const fake = fakeCf();
    const workflows = fakeWorkflows();
    await provisioner(fake.cf, workflows.client).reprocess("dev", "docs", { filter: { ownerId: "ada" } });
    expect(workflows.dispatchAndPoll).toHaveBeenCalledWith("acme-dev-vector-reprocess", {
      index: "docs",
      filter: { ownerId: "ada" },
    });
  });
});
