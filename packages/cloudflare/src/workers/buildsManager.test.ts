import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareBuildsManager } from "./buildsManager";

/** Build a CF REST `Response` wrapping `result` in the standard envelope. */
function envelopeResponse(result: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify({ result, success: status < 400, errors: [], messages: [] }), { status });
}

/** Build a CF error `Response` with the given status and CF error code in the envelope. */
function errorResponse(status: number, code: number, message = "error"): Response {
  return new Response(JSON.stringify({ result: null, success: false, errors: [{ code, message }], messages: [] }), {
    status,
  });
}

const REPO_CONNECTION = {
  repo_connection_uuid: "rc-1",
  repo_id: "42",
  repo_name: "group/repo",
  provider_type: "gitlab",
  provider_account_id: "group:7",
  provider_account_name: "acme",
  created_on: "2026-01-02T03:04:05.000Z",
  modified_on: "2026-01-02T03:04:05.000Z",
};

const TRIGGER = {
  trigger_uuid: "t-1",
  external_script_id: "hex-1",
  build_token_uuid: "bt-1",
  trigger_name: "My Trigger",
  build_command: "bun run build",
  deploy_command: "echo deploy",
  root_directory: "/",
  branch_includes: ["main"],
  created_on: "2026-02-01T00:00:00.000Z",
  modified_on: "2026-02-01T00:00:00.000Z",
};

const BUILD = {
  build_uuid: "b-1",
  status: "queued",
  created_on: "2026-03-01T00:00:00.000Z",
  modified_on: "2026-03-01T00:00:00.000Z",
};

describe("CloudflareBuildsManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareBuildsManager;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    manager = new CloudflareBuildsManager(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Cloudflare Builds");
  });

  describe("createRepoConnection", () => {
    it("PUTs the connection with a bearer token and validates the response", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(REPO_CONNECTION));
      const result = await manager.createRepoConnection({
        providerType: "gitlab",
        repoId: "42",
        repoName: "group/repo",
        providerAccountId: "group:7",
        providerAccountName: "acme",
      });
      expect(result.repo_connection_uuid).toBe("rc-1");
      expect(result.created_on).toBeInstanceOf(Date);

      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/builds/repos/connections");
      expect(options.method).toBe("PUT");
      expect(options.headers.authorization).toBe("Bearer tok-1");
      expect(JSON.parse(options.body)).toMatchObject({ provider_type: "gitlab", repo_id: "42" });
    });

    it("throws invalid_response when the body does not match the schema", async () => {
      fetchMock.mockResolvedValue(envelopeResponse({ wrong: "shape" }));
      await expect(
        manager.createRepoConnection({
          providerType: "gitlab",
          repoId: "1",
          repoName: "r",
          providerAccountId: "a",
          providerAccountName: "n",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("wraps a non-2xx status as request_failed", async () => {
      fetchMock.mockResolvedValue(errorResponse(500, 10000, "boom"));
      await expect(
        manager.createRepoConnection({
          providerType: "gitlab",
          repoId: "1",
          repoName: "r",
          providerAccountId: "a",
          providerAccountName: "n",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });

    it("throws invalid_response on a non-JSON body", async () => {
      fetchMock.mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));
      await expect(
        manager.createRepoConnection({
          providerType: "gitlab",
          repoId: "1",
          repoName: "r",
          providerAccountId: "a",
          providerAccountName: "n",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("treats an HTTP 200 with success:false as a request failure (not a null result)", async () => {
      fetchMock.mockResolvedValue(errorResponse(200, 10000, "soft failure"));
      await expect(
        manager.createRepoConnection({
          providerType: "gitlab",
          repoId: "1",
          repoName: "r",
          providerAccountId: "a",
          providerAccountName: "n",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("upsertTrigger", () => {
    const args = {
      scriptName: "hex-1",
      repoConnectionId: "rc-1",
      buildTokenUuid: "bt-1",
      triggerName: "My Trigger",
      branchIncludes: ["main"],
      buildCommand: "bun run build",
      deployCommand: "echo deploy",
    };

    it("POSTs and returns the created trigger", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(TRIGGER));
      const result = await manager.upsertTrigger(args);
      expect(result.trigger_uuid).toBe("t-1");
      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/builds/triggers");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toMatchObject({
        external_script_id: "hex-1",
        branch_includes: ["main"],
        path_includes: ["*"],
        root_directory: "/",
        build_caching_enabled: true,
      });
    });

    it("on a 409 code-12042 conflict, falls back to the matching existing trigger", async () => {
      // First the POST conflicts; then listTriggersByScript GETs the existing triggers.
      fetchMock
        .mockResolvedValueOnce(errorResponse(409, 12042, "A trigger already exists for this configuration"))
        .mockResolvedValueOnce(envelopeResponse([TRIGGER]));
      const result = await manager.upsertTrigger(args);
      expect(result.trigger_uuid).toBe("t-1");
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/builds/workers/hex-1/triggers",
      );
    });

    it("re-throws a conflict when no existing trigger matches", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(409, 12042)).mockResolvedValueOnce(envelopeResponse([])); // no triggers to match
      await expect(manager.upsertTrigger(args)).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });

    it("detects the conflict code even when the error body exceeds the detail truncation", async () => {
      // A verbose 409 whose raw "code":12042 substring would fall past the 2000-char detail cut; the
      // structured [cf-codes:…] marker call() pins to the front keeps idempotency working.
      const noise = Array.from({ length: 100 }, (_, i) => ({ code: 11000 + i, message: "x".repeat(40) }));
      const body = JSON.stringify({
        result: null,
        success: false,
        errors: [...noise, { code: 12042, message: "exists" }],
      });
      fetchMock
        .mockResolvedValueOnce(new Response(body, { status: 409, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(envelopeResponse([TRIGGER]));
      const result = await manager.upsertTrigger(args);
      expect(result.trigger_uuid).toBe("t-1");
    });
  });

  describe("listBuildTokens", () => {
    it("returns the tokens array", async () => {
      fetchMock.mockResolvedValue(envelopeResponse([{ build_token_uuid: "u1", build_token_name: "n1" }]));
      expect(await manager.listBuildTokens()).toEqual([{ build_token_uuid: "u1", build_token_name: "n1" }]);
    });

    it("defaults a non-array result to empty", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(null));
      expect(await manager.listBuildTokens()).toEqual([]);
    });
  });

  describe("updateTrigger", () => {
    it("PUTs only the provided fields", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(TRIGGER));
      await manager.updateTrigger("t-1", { buildCommand: "make" });
      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/builds/triggers/t-1");
      expect(JSON.parse(options.body)).toEqual({ build_command: "make" });
    });
  });

  describe("deleteTrigger", () => {
    it("DELETEs the trigger", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(null));
      await manager.deleteTrigger("t-1");
      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/builds/triggers/t-1");
      expect(options.method).toBe("DELETE");
    });
  });

  describe("triggerManualBuild", () => {
    it("POSTs branch + commit and validates the build", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(BUILD));
      const result = await manager.triggerManualBuild("t-1", "main", "abc123");
      expect(result.build_uuid).toBe("b-1");
      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/builds/triggers/t-1/builds");
      expect(JSON.parse(options.body)).toEqual({ branch: "main", commit_hash: "abc123" });
    });
  });

  describe("getBuild / cancelBuild / getBuildLogs", () => {
    it("gets a build", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(BUILD));
      expect((await manager.getBuild("b-1")).status).toBe("queued");
    });

    it("cancels a build", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(null));
      await manager.cancelBuild("b-1");
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/builds/b-1/cancel",
      );
    });

    it("gets build logs, decoding their timestamps", async () => {
      fetchMock.mockResolvedValue(
        envelopeResponse([{ line: 1, timestamp: "2026-04-01T00:00:00.000Z", message: "hi" }]),
      );
      const logs = await manager.getBuildLogs("b-1");
      expect(logs[0]?.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("listBuildsByScript", () => {
    it("encodes the script name in the query and returns builds", async () => {
      fetchMock.mockResolvedValue(envelopeResponse([BUILD]));
      const builds = await manager.listBuildsByScript("my worker");
      expect(builds).toHaveLength(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/builds?script_name=my%20worker",
      );
    });
  });

  describe("listTriggersByScript", () => {
    it("returns the triggers array", async () => {
      fetchMock.mockResolvedValue(envelopeResponse([TRIGGER]));
      expect(await manager.listTriggersByScript("hex-1")).toHaveLength(1);
    });

    it("returns [] on a 404 code-12000 not-found", async () => {
      fetchMock.mockResolvedValue(errorResponse(404, 12000, "Not found"));
      expect(await manager.listTriggersByScript("hex-1")).toEqual([]);
    });

    it("re-throws other request failures", async () => {
      fetchMock.mockResolvedValue(errorResponse(500, 10000, "boom"));
      await expect(manager.listTriggersByScript("hex-1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("upsertTriggerEnvVars", () => {
    it("PATCHes a name-keyed map, marking secret_text as is_secret", async () => {
      fetchMock.mockResolvedValue(envelopeResponse(null));
      await manager.upsertTriggerEnvVars("t-1", [
        { name: "PLAIN", value: "1", type: "plain_text" },
        { name: "SECRET", value: "2", type: "secret_text" },
      ]);
      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/builds/triggers/t-1/environment_variables",
      );
      expect(options.method).toBe("PATCH");
      expect(JSON.parse(options.body)).toEqual({
        PLAIN: { is_secret: false, value: "1" },
        SECRET: { is_secret: true, value: "2" },
      });
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when triggers are reachable", async () => {
      fetchMock.mockResolvedValue(envelopeResponse([]));
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false on failure", async () => {
      fetchMock.mockResolvedValue(errorResponse(403, 10000));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(manager.getBuild("b-1")).rejects.toBeInstanceOf(PithyError);
  });
});
