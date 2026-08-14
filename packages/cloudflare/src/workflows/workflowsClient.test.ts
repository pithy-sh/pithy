// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, test, vi } from "vitest";
import { CloudflareNotConfiguredError, CloudflareRequestError } from "../client/errors";
import { CloudflareWorkflowsClient } from "./workflowsClient";

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockWorkflowsList = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    workflows = {
      list: mockWorkflowsList,
      instances: { create: mockCreate, get: mockGet },
    };
  },
}));

/** An SDK 404 throw — the shape `isNotFoundError` keys on. */
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

/**
 * A real instance-detail body for a step that raised `NonRetryableError` — captured verbatim from the
 * Workflows engine in `wrangler dev` (4.123.0), 2026-08-14. The instance error is the platform's
 * sentence and the step's is the kit's; that difference is the whole of pithy-sh/pithy#349.
 */
const TERMINAL_INSTANCE = {
  status: "errored",
  output: null,
  error: {
    name: "WorkflowFatalError",
    message:
      "The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled",
  },
  steps: [
    {
      name: "write-secret-1",
      type: "step",
      success: false,
      attempts: [
        {
          success: false,
          error: {
            name: "WorkflowFatalError",
            message:
              "Step threw a NonRetryableError with message \"NonRetryableError: secrets/already_exists: Secret 'api-token' already exists.\"",
          },
        },
      ],
    },
  ],
};

function client(): CloudflareWorkflowsClient {
  return new CloudflareWorkflowsClient({ accountId: "acc", apiToken: "tok", sleeper: async () => {} });
}

describe("CloudflareWorkflowsClient", () => {
  beforeEach(() => vi.clearAllMocks());

  test("requires accountId and apiToken", () => {
    expect(() => new CloudflareWorkflowsClient({ accountId: "", apiToken: "" })).toThrow(CloudflareNotConfiguredError);
  });

  test("createInstance returns the instance id and addresses the workflow by name", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    expect(await client().createInstance("secrets-write", { name: "x" })).toBe("wf-1");
    expect(mockCreate).toHaveBeenCalledWith("secrets-write", { account_id: "acc", params: { name: "x" } });
  });

  test("createInstance passes an explicit instance id through as instance_id", async () => {
    mockCreate.mockResolvedValue({ id: "chosen", status: "queued" });
    await client().createInstance("secrets-write", {}, "chosen");
    expect(mockCreate).toHaveBeenCalledWith("secrets-write", {
      account_id: "acc",
      params: {},
      instance_id: "chosen",
    });
  });

  test("createInstance wraps an SDK failure as cloudflare/request_failed", async () => {
    mockCreate.mockRejectedValue(new Error("bad token"));
    await expect(client().createInstance("secrets-write", {})).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  test("getInstanceStatus returns null on a 404 (instance lag)", async () => {
    mockGet.mockRejectedValue(notFound());
    expect(await client().getInstanceStatus("w", "id")).toBeNull();
  });

  test("getInstanceStatus rethrows a non-404 failure rather than reporting absence", async () => {
    mockGet.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(client().getInstanceStatus("w", "id")).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  test("dispatchAndPoll resolves with the output once complete", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    mockGet
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "complete", output: { ok: true } });
    expect(await client().dispatchAndPoll("secrets-write", { name: "x" })).toEqual({ ok: true });
  });

  test("dispatchAndPoll tolerates a 404 before the instance is queryable", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    mockGet.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ status: "complete", output: "done" });
    expect(await client().dispatchAndPoll("secrets-write", {})).toBe("done");
  });

  test("dispatchAndPoll keeps polling through rollingBack — it is not a terminal state", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    mockGet
      .mockResolvedValueOnce({ status: "rollingBack" })
      .mockResolvedValueOnce({ status: "complete", output: "recovered" });
    expect(await client().dispatchAndPoll("secrets-write", {})).toBe("recovered");
  });

  test("dispatchAndPoll throws when the instance errors — with the reason, not the params", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    mockGet.mockResolvedValue({ status: "errored", error: { message: "decrypt failed" } });
    const error = await client()
      .dispatchAndPoll("secrets-write", { secret: "TOPSECRET" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareRequestError);
    const payload = (error as CloudflareRequestError).payload;
    expect(payload.detail).toContain("decrypt failed");
    expect(payload.detail).not.toContain("TOPSECRET");
  });

  test("dispatchAndPoll reports the sentence the step raised, not the platform's (pithy-sh/pithy#349)", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    mockGet.mockResolvedValue(TERMINAL_INSTANCE);
    const error = await client()
      .dispatchAndPoll("secrets-write", { secret: "TOPSECRET" })
      .catch((e: unknown) => e);
    const payload = (error as CloudflareRequestError).payload;
    expect(payload.message).toBe("Secret 'api-token' already exists.");
    expect(payload.message).not.toContain("NonRetryableError");
    expect(payload.detail).toContain("secrets/already_exists");
    expect(payload.detail).not.toContain("TOPSECRET");
  });

  test("dispatchAndPoll gives up once the poll budget is exhausted", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    mockGet.mockResolvedValue({ status: "running" });
    await expect(client().dispatchAndPoll("secrets-write", {}, { maxPolls: 3 })).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
    );
    expect(mockGet).toHaveBeenCalledTimes(3);
  });
});
