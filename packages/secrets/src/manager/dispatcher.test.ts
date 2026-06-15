import { CloudflareWorkflowsClient, type Fetcher } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { describe, expect, test } from "vitest";
import { WorkflowSecretDispatcher } from "./dispatcher";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function queueFetcher(responses: Response[]): Fetcher {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("queueFetcher: no more responses");
    return next;
  };
}

describe("WorkflowSecretDispatcher", () => {
  test("dispatches to the env's manager Workflow by name and resolves on completion", async () => {
    const names: string[] = [];
    const fetcher = queueFetcher([
      jsonResponse({ success: true, errors: [], result: { id: "wf-1" } }),
      jsonResponse({ success: true, errors: [], result: { status: "complete" } }),
    ]);
    const client = new CloudflareWorkflowsClient({
      accountId: "acc",
      apiToken: "tok",
      fetcher,
      sleeper: async () => {},
    });
    const dispatcher = new WorkflowSecretDispatcher(client, (env) => {
      const name = `pithy-secrets-write-${env}`;
      names.push(name);
      return name;
    });

    await dispatcher.dispatch({
      env: "staging",
      mode: "create",
      name: "x",
      value: "v",
      valueType: "text",
      rotatable: false,
    });

    expect(names).toEqual(["pithy-secrets-write-staging"]);
  });
});
