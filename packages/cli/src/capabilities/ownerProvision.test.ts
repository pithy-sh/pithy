// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { EmailTheme } from "@pithy-sh/email/src/templates/theme";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { KIT_ROOT } from "../test-utils/kitRoot";
import { CloudflareEmailProvisioner } from "./emailProvisioner";
import { CloudflareMediaProvisioner } from "./mediaProvisioner";
import { CloudflarePaymentsProvisioner } from "./paymentsProvisioner";
import { CloudflareStorageProvisioner } from "./storageProvisioner";
import { CloudflareSupportProvisioner } from "./supportProvisioner";
import { CloudflareTestersProvisioner } from "./testersProvisioner";
import { CloudflareVectorProvisioner } from "./vectorProvisioner";

/** Every config `deployHostWorker` was handed, in order. */
const deployed = vi.hoisted(() => [] as WorkflowHostTemplate[]);
vi.mock("./hostDeploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hostDeploy")>()),
  deployHostWorker: async (options: { config: WorkflowHostTemplate }) => {
    deployed.push(options.config);
    return { worker: options.config.name, outcome: "deployed" };
  },
  kitPackageVersion: async () => "0.0.0",
}));

const account = { accountId: "acct-1", confirmation: "pinned" } as const;
const cf = {
  workers: () => ({ getWorkerVars: async () => null }),
  r2Provisioner: () => ({ findBucketByName: async (name: string) => ({ name }) }),
} as unknown as CloudflareClients;

beforeEach(() => {
  deployed.length = 0;
});

/**
 * **`--worker two`, where `two` owns `DB`, deploys two's own host.** The shared host is the one every other Worker
 * reaches; a provision run for an owning Worker must never redeploy it bound to that Worker's database.
 */
describe("pithy <capability> provision for a Worker that owns a binding its host binds", () => {
  test("email deploys the owner's host, named for it, over the database its stanza names", async () => {
    const provisioner = new CloudflareEmailProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf,
      account,
      apiToken: "tok",
      storeId: "store-1",
      theme: {} as EmailTheme,
      messages: {},
      owner: { worker: "two", bindings: ["DB"] },
      resolveEnv: async () => ({ appDatabaseId: "two-db", secretsDatabaseId: "sec", baseUrl: "https://two.acme" }),
      audit: async () => {},
    });
    await provisioner.deployWorker("staging", "sup");
    expect(deployed[0]?.name).toBe("acme-staging-two---email");
    expect(deployed[0]?.d1_databases?.find((entry) => entry.binding === "DB")?.database_id).toBe("two-db");
    expect(deployed[0]?.workflows?.every((workflow) => workflow.name.startsWith("acme-staging-two---email-"))).toBe(
      true,
    );
  });

  test("a Worker that shares the host deploys the shared one", async () => {
    const provisioner = new CloudflareEmailProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf,
      account,
      apiToken: "tok",
      storeId: "store-1",
      theme: {} as EmailTheme,
      messages: {},
      resolveEnv: async () => ({ appDatabaseId: "db", secretsDatabaseId: "sec", baseUrl: "https://acme" }),
      audit: async () => {},
    });
    await provisioner.deployWorker("staging", "sup");
    expect(deployed[0]?.name).toBe("acme-staging-email");
  });

  test("media binds the bucket provision created for an owner of MEDIA_BUCKET", async () => {
    const provisioner = new CloudflareMediaProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf,
      account,
      apiToken: "tok",
      storeId: "store-1",
      owner: { worker: "two", bindings: ["DB", "MEDIA_BUCKET"] },
    } as unknown as ConstructorParameters<typeof CloudflareMediaProvisioner>[0]);
    expect(await provisioner.ensureBucket("staging")).toEqual({ bucketName: "acme-staging-two---media-bucket" });
  });

  /** Each deployed Workflow, and the host it is registered on, carry the owner. */
  const ownedBy = (config: WorkflowHostTemplate | undefined, capability: string) => {
    expect(config?.name).toBe(`acme-staging-two---${capability}`);
    expect(
      (config?.workflows ?? []).every((workflow) => workflow.name.startsWith(`acme-staging-two---${capability}-`)),
    ).toBe(true);
  };

  test("storage binds the bucket provision created for an owner of STORAGE_BUCKET, and deploys its own host", async () => {
    const provisioner = new CloudflareStorageProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf,
      account,
      apiToken: "tok",
      storeId: "store-1",
      storageConfig: {},
      owner: { worker: "two", bindings: ["DB", "STORAGE_BUCKET"] },
      resolveEnv: async () => ({ appDatabaseId: "two-db", secretsDatabaseId: "sec" }),
    } as unknown as ConstructorParameters<typeof CloudflareStorageProvisioner>[0]);
    const { bucketName } = await provisioner.ensureBucket("staging");
    expect(bucketName).toBe("acme-staging-two---storage-bucket");
    await provisioner.deployWorker("staging", { bucketName } as never);
    ownedBy(deployed[0], "storage");
    expect(deployed[0]?.d1_databases?.find((entry) => entry.binding === "DB")?.database_id).toBe("two-db");
    expect(JSON.stringify(deployed[0]?.r2_buckets ?? [])).toContain("acme-staging-two---storage-bucket");
  });

  test("testers deploys the owner's host over its own database", async () => {
    const provisioner = new CloudflareTestersProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf,
      account,
      apiToken: "tok",
      testersConfig: {},
      owner: async () => ({ worker: "two", bindings: ["DB"] }),
      resolveEnv: async () => ({ appDatabaseId: "two-db", suppressionDatabaseId: "sup" }),
    } as unknown as ConstructorParameters<typeof CloudflareTestersProvisioner>[0]);
    await provisioner.deployWorker("staging");
    ownedBy(deployed[0], "testers");
    expect(deployed[0]?.d1_databases?.find((entry) => entry.binding === "DB")?.database_id).toBe("two-db");
  });

  test("payments deploys the owner's host, and an on-demand reconcile runs there", async () => {
    const dispatched: string[] = [];
    const provisioner = new CloudflarePaymentsProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf,
      account,
      apiToken: "tok",
      storeId: "store-1",
      paymentsConfig: {},
      owner: { worker: "two", bindings: ["DB"] },
      resolveEnv: async () => ({ appDatabaseId: "two-db", secretsDatabaseId: "sec" }),
      workflows: { dispatchAndPoll: async (name: string) => void dispatched.push(name) },
    } as unknown as ConstructorParameters<typeof CloudflarePaymentsProvisioner>[0]);
    await provisioner.deployWorker("staging");
    ownedBy(deployed[0], "payments");
    await provisioner.reconcile("staging", {});
    expect(dispatched).toEqual(["acme-staging-two---payments-reconcile"]);
  });

  test("vector deploys the owner's host over indexes of its own, and reprocesses there", async () => {
    const dispatched: string[] = [];
    const provisioner = new CloudflareVectorProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf,
      accountId: "acct-1",
      apiToken: "tok",
      config: { indexes: {} },
      owner: { worker: "two", bindings: ["DB"] },
      resolveEnv: async () => ({ appDatabaseId: "two-db" }),
      workflows: { dispatchAndPoll: async (name: string) => void dispatched.push(name) },
    } as unknown as ConstructorParameters<typeof CloudflareVectorProvisioner>[0]);
    await provisioner.deployWorker("staging", {});
    ownedBy(deployed[0], "vector");
    await provisioner.reprocess("staging", "notes", {});
    expect(dispatched).toEqual(["acme-staging-two---vector-reprocess"]);
  });

  test("support fills an index of the owner's own and backfills it through the owner's reprocess", async () => {
    const created: string[] = [];
    const started: string[] = [];
    const provisioner = new CloudflareSupportProvisioner({
      projectDir: KIT_ROOT,
      project: "acme",
      cf: {
        ...cf,
        vectorizeProvisioner: () => ({
          findIndexByName: async () => null,
          createIndex: async (name: string) => void created.push(name),
        }),
      },
      account,
      apiToken: "tok",
      supportConfig: { search: { semantic: true } },
      owner: { worker: "two", bindings: ["DB"] },
      resolveEnv: async () => ({ appDatabaseId: "two-db" }),
      workflows: { createInstance: async (name: string) => void started.push(name) },
    } as unknown as ConstructorParameters<typeof CloudflareSupportProvisioner>[0]);
    const { indexName, created: fresh } = await provisioner.ensureSemanticIndex("staging");
    expect(indexName).toBe("acme-staging-two---support-messages");
    expect(created).toEqual(["acme-staging-two---support-messages"]);
    await provisioner.settleSemanticIndex("staging", fresh);
    expect(started).toEqual(["acme-staging-two---support-reprocess"]);
  });
});
