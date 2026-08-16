// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareWorkersManager } from "./workersManager";

/**
 * The date these cases upload at. Written down rather than imported: `compatibility.ts` sits at the
 * repository root and `packages/cloudflare`'s `rootDir` is `src`, so no module here can reach it. A
 * fixture naming a date it then asserts passes through unchanged is right to name any date, which is
 * what `compatibilityDates.test.ts` says about fixtures in as many words — and after #396 the manager
 * has no default for a stale one here to hide.
 */
const KIT_DATE = "2026-06-01";

const mockScriptsList = vi.fn();
const mockPut = vi.fn();
const mockScriptsDelete = vi.fn();
const mockSubdomainCreate = vi.fn();
const mockSubdomainGet = vi.fn();
const mockSettingsEdit = vi.fn();
const mockVersionsList = vi.fn();
const mockVersionsGet = vi.fn();
const mockDeploymentsList = vi.fn();
const mockDeploymentsGet = vi.fn();
const mockDeploymentsCreate = vi.fn();
const mockSecretsUpdate = vi.fn();
const mockSecretsDelete = vi.fn();
const mockSecretsList = vi.fn();
const mockRoutesCreate = vi.fn();
const mockRoutesList = vi.fn();
const mockRoutesDelete = vi.fn();
const mockBetaWorkersList = vi.fn();
const mockQueuesList = vi.fn();
const mockSubscriptionsCreate = vi.fn();

/** Wrap an array as the SDK's async-iterable list result. */
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
        list: mockScriptsList,
        delete: mockScriptsDelete,
        subdomain: { create: mockSubdomainCreate },
        settings: { edit: mockSettingsEdit },
        versions: { list: mockVersionsList, get: mockVersionsGet },
        deployments: { list: mockDeploymentsList, get: mockDeploymentsGet, create: mockDeploymentsCreate },
        secrets: { update: mockSecretsUpdate, delete: mockSecretsDelete, list: mockSecretsList },
      },
      routes: { create: mockRoutesCreate, list: mockRoutesList, delete: mockRoutesDelete },
      subdomains: { get: mockSubdomainGet },
      beta: { workers: { list: mockBetaWorkersList } },
    };
    queues = {
      list: mockQueuesList,
      subscriptions: { create: mockSubscriptionsCreate },
    };
  },
}));

describe("CloudflareWorkersManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareWorkersManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareWorkersManager(config);
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Cloudflare Workers");
  });

  it("throws not_configured when apiToken is missing", () => {
    expect(() => new CloudflareWorkersManager({ accountId: "a", apiToken: "" })).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
    );
  });

  describe("accountSubdomain", () => {
    it("returns the registered subdomain", async () => {
      mockSubdomainGet.mockResolvedValue({ subdomain: "acme" });
      expect(await manager.accountSubdomain()).toBe("acme");
      expect(mockSubdomainGet).toHaveBeenCalledWith({ account_id: "acct-1" });
    });

    it("returns null when the account has no subdomain (the API errors)", async () => {
      mockSubdomainGet.mockRejectedValue(new Error("10007 no subdomain"));
      expect(await manager.accountSubdomain()).toBeNull();
    });
  });

  describe("listWorkers", () => {
    it("collects the async-iterable scripts list", async () => {
      mockScriptsList.mockReturnValue(asyncList([{ id: "a" }, { id: "b" }]));
      expect(await manager.listWorkers()).toEqual([{ id: "a" }, { id: "b" }]);
      expect(mockScriptsList).toHaveBeenCalledWith({ account_id: "acct-1" });
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause in detail", async () => {
      mockScriptsList.mockImplementation(() => {
        throw new Error("boom");
      });
      await expect(manager.listWorkers()).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "boom" }),
        }),
      );
    });
  });

  describe("getWorker", () => {
    it("finds a worker by id", async () => {
      mockScriptsList.mockReturnValue(asyncList([{ id: "a" }, { id: "b" }]));
      expect(await manager.getWorker("b")).toEqual({ id: "b" });
    });

    it("returns null when absent", async () => {
      mockScriptsList.mockReturnValue(asyncList([{ id: "a" }]));
      expect(await manager.getWorker("z")).toBeNull();
    });
  });

  describe("getWorkerInternalId", () => {
    it("returns the immutable id for a matching name", async () => {
      mockBetaWorkersList.mockReturnValue(
        asyncList([
          { id: "hex-1", name: "w1" },
          { id: "hex-2", name: "w2" },
        ]),
      );
      expect(await manager.getWorkerInternalId("w2")).toBe("hex-2");
      expect(mockBetaWorkersList).toHaveBeenCalledWith({ account_id: "acct-1" });
    });

    it("throws core/not_found when no worker matches the name", async () => {
      mockBetaWorkersList.mockReturnValue(asyncList([{ id: "hex-1", name: "w1" }]));
      await expect(manager.getWorkerInternalId("missing")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "core/not_found" }) }),
      );
    });
  });

  describe("createWorker", () => {
    /** The upload's path, its metadata part parsed, and every other part by name. #373 is a wire bug. */
    async function uploadSent(): Promise<{
      path: string;
      metadata: Record<string, unknown>;
      parts: Map<string, { body: string; type: string; filename: string | null }>;
    }> {
      const [path, options] = mockPut.mock.calls[0] ?? [];
      const form: unknown = options?.body;
      if (!(form instanceof FormData)) throw new TypeError("The upload body was not FormData.");

      const parts = new Map<string, { body: string; type: string; filename: string | null }>();
      let metadata: Record<string, unknown> = {};
      for (const [name, value] of form.entries()) {
        if (!(value instanceof Blob)) throw new TypeError(`Part '${name}' was not a Blob.`);
        const body = await value.text();
        if (name === "metadata") {
          metadata = JSON.parse(body) as Record<string, unknown>;
          continue;
        }
        parts.set(name, { body, type: value.type, filename: "name" in value ? String(value.name) : null });
      }
      return { path, metadata, parts };
    }

    it("PUTs one JSON metadata part and one module part named by main_module", async () => {
      mockPut.mockResolvedValue({ result: { id: "new-1" } });

      const result = await manager.createWorker("w1", KIT_DATE, { tag: "x" });

      expect(result).toEqual({ id: "new-1" });
      const { path, metadata, parts } = await uploadSent();
      expect(path).toBe("/accounts/acct-1/workers/scripts/w1");
      // One `metadata` part carrying JSON — not the SDK's flattened `metadata[main_module]` fields.
      expect(metadata).toEqual({ tag: "x", main_module: "index.js", compatibility_date: KIT_DATE });
      // The module part is named by its filename, which is what `main_module` points at. Never `files[]`.
      expect([...parts.keys()]).toEqual(["index.js"]);
      expect(parts.get("index.js")?.type).toBe("application/javascript+module");
      expect(parts.get("index.js")?.body).toContain("export default");
      expect(mockPut.mock.calls[0]?.[1]).toMatchObject({ timeout: 10000, maxRetries: 3 });
    });

    it("never pins a Content-Type on the request — the FormData body decides it", async () => {
      // The whole of #373: `workers.scripts.update` sent `Content-Type: application/javascript` with a
      // multipart body, so Cloudflare parsed the `------WebKit…` boundary as a classic script and
      // answered `10021 … Invalid left-hand side expression in prefix operation at worker.js:1:4`.
      mockPut.mockResolvedValue({ result: { id: "new-1" } });
      await manager.createWorker("w1", KIT_DATE);
      const headers: unknown = mockPut.mock.calls[0]?.[1]?.headers;
      expect(headers).toBeUndefined();
    });

    it("uploads a caller's module under its own name", async () => {
      mockPut.mockResolvedValue({ result: { id: "new-1" } });

      await manager.createWorker(
        "w1",
        KIT_DATE,
        { bindings: [{ type: "kv_namespace", name: "OBSERVED", namespace_id: "ns-1" }] },
        { name: "worker.mjs", body: "export default { async email() {} };" },
      );

      const { metadata, parts } = await uploadSent();
      expect(metadata.main_module).toBe("worker.mjs");
      expect(metadata.bindings).toEqual([{ type: "kv_namespace", name: "OBSERVED", namespace_id: "ns-1" }]);
      expect(parts.get("worker.mjs")?.body).toBe("export default { async email() {} };");
      expect(parts.get("worker.mjs")?.filename).toBe("worker.mjs");
    });

    it("takes the compatibility date from the argument, and never main_module from metadata", async () => {
      mockPut.mockResolvedValue({ result: { id: "new-1" } });

      await manager.createWorker("w1", "2025-01-01", { main_module: "wrong.js" });

      const { metadata } = await uploadSent();
      // Whatever the caller names, uploaded verbatim. There is no default underneath it any more (#396).
      expect(metadata.compatibility_date).toBe("2025-01-01");
      expect(metadata.main_module).toBe("index.js");
    });

    it("refuses a compatibility date stated twice rather than picking a winner", async () => {
      // The defect #396 removed was a date nobody chose. Admitting a second way to state it would put
      // one back — a precedence rule, which is a thing to remember rather than a contract to read.
      await expect(manager.createWorker("w1", KIT_DATE, { compatibility_date: "2025-01-01" })).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
      );
      expect(mockPut).not.toHaveBeenCalled();
    });

    it("refuses a compatibility date that is not one, before Cloudflare has to", async () => {
      await expect(manager.createWorker("w1", "june")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
      );
      expect(mockPut).not.toHaveBeenCalled();
    });

    it("refuses a classic service-worker script rather than half-supporting one", async () => {
      // The manager uploads ES modules only, and says so. `body_part` is the classic shape.
      await expect(manager.createWorker("w1", KIT_DATE, { body_part: "worker.js" })).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
      );
      expect(mockPut).not.toHaveBeenCalled();
    });

    it("throws invalid_response when Cloudflare returns a success envelope with no script", async () => {
      mockPut.mockResolvedValue({ result: null });
      await expect(manager.createWorker("w1", KIT_DATE)).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });
  });

  describe("setSubdomainSettings", () => {
    it("always sends previews_enabled explicitly", async () => {
      mockSubdomainCreate.mockResolvedValue(undefined);
      await manager.setSubdomainSettings("w1", true);
      expect(mockSubdomainCreate).toHaveBeenCalledWith("w1", {
        account_id: "acct-1",
        enabled: true,
        previews_enabled: false,
      });
    });
  });

  describe("updateSettings", () => {
    it("merges the account id into the settings edit", async () => {
      mockSettingsEdit.mockResolvedValue(undefined);
      await manager.updateSettings("w1", { observability: { enabled: true } });
      expect(mockSettingsEdit).toHaveBeenCalledWith("w1", {
        account_id: "acct-1",
        observability: { enabled: true },
      });
    });
  });

  describe("deleteWorker", () => {
    it("deletes with request options", async () => {
      mockScriptsDelete.mockResolvedValue(undefined);
      await manager.deleteWorker("w1");
      expect(mockScriptsDelete).toHaveBeenCalledWith("w1", { account_id: "acct-1" }, { timeout: 10000, maxRetries: 3 });
    });
  });

  describe("versions", () => {
    it("lists versions from the async iterable", async () => {
      mockVersionsList.mockReturnValue(asyncList([{ id: "v1" }, { id: "v2" }]));
      expect(await manager.listVersions("w1")).toEqual([{ id: "v1" }, { id: "v2" }]);
    });

    it("gets a single version", async () => {
      mockVersionsGet.mockResolvedValue({ id: "v1" });
      expect(await manager.getVersion("w1", "v1")).toEqual({ id: "v1" });
      expect(mockVersionsGet).toHaveBeenCalledWith(
        "v1",
        { account_id: "acct-1", script_name: "w1" },
        expect.any(Object),
      );
    });
  });

  describe("deployments", () => {
    it("lists deployments, defaulting to empty", async () => {
      mockDeploymentsList.mockResolvedValue({ deployments: undefined });
      expect(await manager.listDeployments("w1")).toEqual([]);
      mockDeploymentsList.mockResolvedValue({ deployments: [{ id: "d1" }] });
      expect(await manager.listDeployments("w1")).toEqual([{ id: "d1" }]);
    });

    it("gets a deployment", async () => {
      mockDeploymentsGet.mockResolvedValue({ id: "d1" });
      expect(await manager.getDeployment("w1", "d1")).toEqual({ id: "d1" });
    });

    it("creates a 100% percentage deployment", async () => {
      mockDeploymentsCreate.mockResolvedValue({ id: "d2" });
      await manager.createDeployment("w1", "v9");
      expect(mockDeploymentsCreate).toHaveBeenCalledWith(
        "w1",
        { account_id: "acct-1", strategy: "percentage", versions: [{ percentage: 100, version_id: "v9" }] },
        expect.any(Object),
      );
    });
  });

  describe("secrets", () => {
    it("adds a secret as secret_text", async () => {
      mockSecretsUpdate.mockResolvedValue(undefined);
      await manager.addSecret("w1", "API_KEY", "shh");
      expect(mockSecretsUpdate).toHaveBeenCalledWith(
        "w1",
        { account_id: "acct-1", name: "API_KEY", text: "shh", type: "secret_text" },
        expect.any(Object),
      );
    });

    it("deletes a secret", async () => {
      mockSecretsDelete.mockResolvedValue(undefined);
      await manager.deleteSecret("w1", "API_KEY");
      expect(mockSecretsDelete).toHaveBeenCalledWith(
        "API_KEY",
        { account_id: "acct-1", script_name: "w1" },
        expect.any(Object),
      );
    });

    it("lists secrets from the async iterable", async () => {
      mockSecretsList.mockReturnValue(asyncList([{ name: "A" }, { name: "B" }]));
      expect(await manager.listSecrets("w1")).toEqual([{ name: "A" }, { name: "B" }]);
    });
  });

  describe("routes", () => {
    it("returns an existing route instead of creating a duplicate (idempotent)", async () => {
      mockRoutesList.mockReturnValue(asyncList([{ id: "r1", pattern: "example.com/*" }]));
      const result = await manager.addRoute("zone-1", "example.com/*", "w1");
      expect(result).toEqual({ id: "r1", pattern: "example.com/*" });
      expect(mockRoutesCreate).not.toHaveBeenCalled();
    });

    it("creates a route when none matches", async () => {
      mockRoutesList.mockReturnValue(asyncList([]));
      mockRoutesCreate.mockResolvedValue({ id: "r2", pattern: "new.com/*" });
      const result = await manager.addRoute("zone-1", "new.com/*", "w1");
      expect(result).toEqual({ id: "r2", pattern: "new.com/*" });
      expect(mockRoutesCreate).toHaveBeenCalledWith(
        { zone_id: "zone-1", pattern: "new.com/*", script: "w1" },
        expect.any(Object),
      );
    });

    it("getRoute returns null when no pattern matches", async () => {
      mockRoutesList.mockReturnValue(asyncList([{ id: "r1", pattern: "other.com/*" }]));
      expect(await manager.getRoute("zone-1", "nope.com/*")).toBeNull();
    });

    it("removes a route", async () => {
      mockRoutesDelete.mockResolvedValue(undefined);
      await manager.removeRoute("zone-1", "r1");
      expect(mockRoutesDelete).toHaveBeenCalledWith("r1", { zone_id: "zone-1" }, expect.any(Object));
    });
  });

  describe("findQueueIdByName", () => {
    it("resolves a queue id by name", async () => {
      mockQueuesList.mockReturnValue(
        asyncList([
          { queue_name: "other", queue_id: "q0" },
          { queue_name: "evts", queue_id: "q1" },
        ]),
      );
      expect(await manager.findQueueIdByName("evts")).toBe("q1");
    });

    it("returns null when no queue matches", async () => {
      mockQueuesList.mockReturnValue(asyncList([{ queue_name: "other", queue_id: "q0" }]));
      expect(await manager.findQueueIdByName("evts")).toBeNull();
    });
  });

  describe("subscribeBuildEvents", () => {
    it("creates a build-events subscription", async () => {
      mockSubscriptionsCreate.mockResolvedValue({ id: "sub-1" });
      await manager.subscribeBuildEvents("build-events-w1", "q1", "w1");
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
        account_id: "acct-1",
        name: "build-events-w1",
        destination: { type: "queues.queue", queue_id: "q1" },
        source: { type: "workersBuilds.worker", worker_name: "w1" },
        events: ["build.started", "build.succeeded", "build.failed", "build.canceled"],
      });
    });

    it("treats an 'already exists' conflict as success (idempotent)", async () => {
      mockSubscriptionsCreate.mockRejectedValue(new Error("405 multiple subscriptions on the same resource"));
      await expect(manager.subscribeBuildEvents("n", "q1", "w1")).resolves.toBeUndefined();
    });

    it("wraps a genuine failure as request_failed", async () => {
      mockSubscriptionsCreate.mockRejectedValue(new Error("500 internal"));
      await expect(manager.subscribeBuildEvents("n", "q1", "w1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when the scripts list is reachable", async () => {
      mockScriptsList.mockReturnValue(asyncList([]));
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when the scripts list throws", async () => {
      mockScriptsList.mockImplementation(() => {
        throw new Error("403");
      });
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockScriptsList.mockImplementation(() => {
      throw "a bare string";
    });
    await expect(manager.listWorkers()).rejects.toBeInstanceOf(PithyError);
  });
});
