import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { describe, expect, test, vi } from "vitest";
import { WorkflowSecretDispatcher } from "./dispatcher";

/**
 * The dispatcher's job is name resolution and payload shape — the transport belongs to
 * `CloudflareWorkflowsClient` and is covered by its own suite. Stubbing the client (rather than
 * mocking the `cloudflare` SDK) keeps this test on that seam; a `vi.mock("cloudflare")` here would
 * also resolve to a different SDK instance than the one `@pithy-sh/cloudflare` imports, and silently
 * hit the network.
 */
function stubClient() {
  const dispatchAndPoll = vi.fn().mockResolvedValue(undefined);
  return { client: { dispatchAndPoll } as unknown as CloudflareWorkflowsClient, dispatchAndPoll };
}

describe("WorkflowSecretDispatcher", () => {
  test("dispatches to the env's manager Workflow by name and resolves on completion", async () => {
    const { client, dispatchAndPoll } = stubClient();
    const names: string[] = [];
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
    expect(dispatchAndPoll).toHaveBeenCalledWith("pithy-secrets-write-staging", {
      mode: "create",
      name: "x",
      value: "v",
      valueType: "text",
      rotatable: false,
    });
  });
});
