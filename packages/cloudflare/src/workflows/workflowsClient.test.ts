import { describe, expect, test } from "vitest";
import { CloudflareNotConfiguredError, CloudflareRequestError } from "../client/errors";
import { CloudflareWorkflowsClient, type Fetcher } from "./workflowsClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetcher that returns a scripted queue of responses, in order. */
function queueFetcher(responses: Response[]): Fetcher {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("queueFetcher: no more responses");
    return next;
  };
}

function client(fetcher: Fetcher): CloudflareWorkflowsClient {
  return new CloudflareWorkflowsClient({ accountId: "acc", apiToken: "tok", fetcher, sleeper: async () => {} });
}

describe("CloudflareWorkflowsClient", () => {
  test("requires accountId and apiToken", () => {
    expect(() => new CloudflareWorkflowsClient({ accountId: "", apiToken: "" })).toThrow(CloudflareNotConfiguredError);
  });

  test("createInstance returns the instance id", async () => {
    const id = await client(
      queueFetcher([jsonResponse({ success: true, errors: [], result: { id: "wf-1" } })]),
    ).createInstance("secrets-write", { name: "x" });
    expect(id).toBe("wf-1");
  });

  test("createInstance throws on an unsuccessful envelope", async () => {
    const fetcher = queueFetcher([
      jsonResponse({ success: false, errors: [{ code: 1000, message: "bad token" }], result: null }),
    ]);
    await expect(client(fetcher).createInstance("secrets-write", {})).rejects.toBeInstanceOf(CloudflareRequestError);
  });

  test("getInstanceStatus returns null on a 404 (instance lag)", async () => {
    const status = await client(queueFetcher([new Response("", { status: 404 })])).getInstanceStatus("w", "id");
    expect(status).toBeNull();
  });

  test("dispatchAndPoll resolves with the output once complete", async () => {
    const fetcher = queueFetcher([
      jsonResponse({ success: true, errors: [], result: { id: "wf-1" } }),
      jsonResponse({ success: true, errors: [], result: { status: "running" } }),
      jsonResponse({ success: true, errors: [], result: { status: "complete", output: { ok: true } } }),
    ]);
    expect(await client(fetcher).dispatchAndPoll("secrets-write", { name: "x" })).toEqual({ ok: true });
  });

  test("dispatchAndPoll tolerates a 404 before the instance is queryable", async () => {
    const fetcher = queueFetcher([
      jsonResponse({ success: true, errors: [], result: { id: "wf-1" } }),
      new Response("", { status: 404 }),
      jsonResponse({ success: true, errors: [], result: { status: "complete", output: "done" } }),
    ]);
    expect(await client(fetcher).dispatchAndPoll("secrets-write", {})).toBe("done");
  });

  test("dispatchAndPoll throws when the instance errors — with the reason, not the params", async () => {
    const fetcher = queueFetcher([
      jsonResponse({ success: true, errors: [], result: { id: "wf-1" } }),
      jsonResponse({ success: true, errors: [], result: { status: "errored", error: { message: "decrypt failed" } } }),
    ]);
    const error = await client(fetcher)
      .dispatchAndPoll("secrets-write", { secret: "TOPSECRET" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareRequestError);
    const payload = (error as CloudflareRequestError).payload;
    expect(payload.detail).toContain("decrypt failed");
    expect(payload.detail).not.toContain("TOPSECRET");
  });
});
