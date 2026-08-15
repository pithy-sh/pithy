// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkersProvisioner } from "./workersProvisioner";

const mockPut = vi.fn();
const mockSubdomainCreate = vi.fn();
const mockSettingsEdit = vi.fn();
const mockSecretsUpdate = vi.fn();
const mockRoutesCreate = vi.fn();
const mockRoutesList = vi.fn();
const mockBetaWorkersList = vi.fn();
const mockQueuesList = vi.fn();
const mockSubscriptionsCreate = vi.fn();

function asyncList<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    put = mockPut;
    workers = {
      scripts: {
        subdomain: { create: mockSubdomainCreate },
        settings: { edit: mockSettingsEdit },
        secrets: { update: mockSecretsUpdate },
      },
      routes: { create: mockRoutesCreate, list: mockRoutesList },
      beta: { workers: { list: mockBetaWorkersList } },
    };
    queues = { list: mockQueuesList, subscriptions: { create: mockSubscriptionsCreate } };
  },
}));

/** A CF REST envelope response, for the builds manager's raw fetch path. */
function envelopeResponse(result: unknown): Response {
  return new Response(JSON.stringify({ result, success: true, errors: [], messages: [] }), { status: 200 });
}

const REPO = {
  providerType: "gitlab" as const,
  repoId: "42",
  repoName: "group/repo",
  providerAccountId: "group:7",
  providerAccountName: "acme",
};

const REPO_CONNECTION_RESULT = {
  repo_connection_uuid: "rc-1",
  repo_id: "42",
  repo_name: "group/repo",
  provider_type: "gitlab",
  provider_account_id: "group:7",
  provider_account_name: "acme",
  created_on: "2026-01-02T00:00:00.000Z",
  modified_on: "2026-01-02T00:00:00.000Z",
};

const TRIGGER_RESULT = {
  trigger_uuid: "t-1",
  external_script_id: "hex-1",
  build_token_uuid: "bt-1",
  trigger_name: "Trigger",
  build_command: "build",
  deploy_command: "deploy",
  root_directory: "/",
  branch_includes: ["main"],
  created_on: "2026-02-01T00:00:00.000Z",
  modified_on: "2026-02-01T00:00:00.000Z",
};

describe("WorkersProvisioner", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let provisioner: WorkersProvisioner;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    provisioner = new WorkersProvisioner(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("createWorker", () => {
    it("creates the script, enables the subdomain + observability, and returns the script id", async () => {
      mockPut.mockResolvedValue({ result: { id: "script-1" } });
      mockSubdomainCreate.mockResolvedValue(undefined);
      mockSettingsEdit.mockResolvedValue(undefined);

      const id = await provisioner.createWorker("w1", { tag: "x" });
      expect(id).toBe("script-1");
      expect(mockSubdomainCreate).toHaveBeenCalledWith("w1", {
        account_id: "acct-1",
        enabled: true,
        previews_enabled: false,
      });
      expect(mockSettingsEdit).toHaveBeenCalledWith("w1", {
        account_id: "acct-1",
        observability: { enabled: true },
      });
    });

    it("throws not_configured when the created script has no id", async () => {
      mockPut.mockResolvedValue({ result: { id: "" } });
      await expect(provisioner.createWorker("w1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("addWorkerSecret / getWorkerInternalId", () => {
    it("delegates secret writes to the workers manager", async () => {
      mockSecretsUpdate.mockResolvedValue(undefined);
      await provisioner.addWorkerSecret("w1", "K", "v");
      expect(mockSecretsUpdate).toHaveBeenCalledWith(
        "w1",
        { account_id: "acct-1", name: "K", text: "v", type: "secret_text" },
        expect.any(Object),
      );
    });

    it("resolves the immutable worker id", async () => {
      mockBetaWorkersList.mockReturnValue(asyncList([{ id: "hex-1", name: "w1" }]));
      expect(await provisioner.getWorkerInternalId("w1")).toBe("hex-1");
    });
  });

  describe("setupBuildTrigger", () => {
    it("upserts repo connection + trigger + env vars and returns the trigger uuid", async () => {
      // 1. createRepoConnection (PUT), 2. listTriggersByScript is NOT called (POST succeeds),
      // beta workers list resolves the internal id, then upsertTrigger POST, then env vars PATCH.
      mockBetaWorkersList.mockReturnValue(asyncList([{ id: "hex-1", name: "w1" }]));
      fetchMock
        .mockResolvedValueOnce(envelopeResponse(REPO_CONNECTION_RESULT)) // createRepoConnection PUT
        .mockResolvedValueOnce(envelopeResponse(TRIGGER_RESULT)) // upsertTrigger POST
        .mockResolvedValueOnce(envelopeResponse(null)); // upsertTriggerEnvVars PATCH

      const triggerId = await provisioner.setupBuildTrigger({
        workerName: "w1",
        repo: REPO,
        buildTokenUuid: "bt-1",
        triggerName: "Trigger",
        branchIncludes: ["main"],
        buildCommand: "build",
        deployCommand: "deploy",
        envVars: [{ name: "A", value: "1", type: "plain_text" }],
      });

      expect(triggerId).toBe("t-1");
      // The trigger POST must use the resolved immutable id, not the worker name.
      const triggerPost = fetchMock.mock.calls[1];
      expect(JSON.parse(triggerPost?.[1].body).external_script_id).toBe("hex-1");
      // Env vars PATCH must have been issued.
      expect(fetchMock.mock.calls[2]?.[0]).toContain("/environment_variables");
    });

    it("skips the env-vars call when none are provided", async () => {
      mockBetaWorkersList.mockReturnValue(asyncList([{ id: "hex-1", name: "w1" }]));
      fetchMock
        .mockResolvedValueOnce(envelopeResponse(REPO_CONNECTION_RESULT))
        .mockResolvedValueOnce(envelopeResponse(TRIGGER_RESULT));

      await provisioner.setupBuildTrigger({
        workerName: "w1",
        repo: REPO,
        buildTokenUuid: "bt-1",
        triggerName: "Trigger",
        branchIncludes: ["main"],
        buildCommand: "build",
        deployCommand: "deploy",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("setupWorkerRoute", () => {
    it("creates the route and returns its id", async () => {
      mockRoutesList.mockReturnValue(asyncList([]));
      mockRoutesCreate.mockResolvedValue({ id: "r-1", pattern: "example.com/*" });
      const id = await provisioner.setupWorkerRoute("zone-1", "w1", "example.com");
      expect(id).toBe("r-1");
      expect(mockRoutesCreate).toHaveBeenCalledWith(
        { zone_id: "zone-1", pattern: "example.com/*", script: "w1" },
        expect.any(Object),
      );
    });
  });

  describe("setupBuildEventSubscription", () => {
    it("resolves the queue id and subscribes", async () => {
      mockQueuesList.mockReturnValue(asyncList([{ queue_name: "evts", queue_id: "q-1" }]));
      mockSubscriptionsCreate.mockResolvedValue({ id: "sub-1" });
      await provisioner.setupBuildEventSubscription("w1", "evts");
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "build-events-w1",
          destination: { type: "queues.queue", queue_id: "q-1" },
          source: { type: "workersBuilds.worker", worker_name: "w1" },
        }),
      );
    });

    it("throws not_configured when the queue does not exist", async () => {
      mockQueuesList.mockReturnValue(asyncList([]));
      await expect(provisioner.setupBuildEventSubscription("w1", "evts")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });
});
