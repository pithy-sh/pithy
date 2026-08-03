// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { describe, expect, test, vi } from "vitest";
import type { ManagedEnvironment } from "../scope";
import { secretsRotateWorkflowName, secretsWriteWorkflowName, WorkflowSecretDispatcher } from "./dispatcher";

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

describe("the manager Workflow names", () => {
  test("lead with the project and the environment", () => {
    expect(secretsWriteWorkflowName("acme", "staging")).toBe("acme-staging-secrets-write");
    expect(secretsRotateWorkflowName("acme", "prod")).toBe("acme-prod-secrets-rotate");
  });

  test("differ between two projects in one account", () => {
    // Workflow names are account-scoped. Equal names here would mean one project's `pithy secrets`
    // dispatching writes into the other project's manager, encrypted under a key it cannot read.
    expect(secretsWriteWorkflowName("acme", "prod")).not.toBe(secretsWriteWorkflowName("globex", "prod"));
    expect(secretsRotateWorkflowName("acme", "prod")).not.toBe(secretsRotateWorkflowName("globex", "prod"));
  });

  test("refuse an environment this project scheme does not accept", () => {
    // A Workflow name is the dispatch contract between the CLI and the deployed manager. A stale
    // `production` would compose a name nothing is deployed under, and the dispatch would 404 late
    // instead of failing here with the spelling to use.
    expect(() => secretsWriteWorkflowName("acme", "production" as ManagedEnvironment)).toThrow(/prod/);
    expect(() => secretsRotateWorkflowName("acme", "production" as ManagedEnvironment)).toThrow(/prod/);
  });
});

describe("WorkflowSecretDispatcher", () => {
  test("dispatches to this project's manager Workflow for the env, and resolves on completion", async () => {
    const { client, dispatchAndPoll } = stubClient();
    const dispatcher = new WorkflowSecretDispatcher(client, "acme");

    await dispatcher.dispatch({
      env: "staging",
      mode: "create",
      name: "x",
      value: "v",
      valueType: "text",
      rotatable: false,
    });

    expect(dispatchAndPoll).toHaveBeenCalledWith("acme-staging-secrets-write", {
      mode: "create",
      name: "x",
      value: "v",
      valueType: "text",
      rotatable: false,
    });
  });

  test("two projects' dispatchers never reach the same Workflow", async () => {
    const acme = stubClient();
    const globex = stubClient();
    const request = { env: "prod", mode: "update", name: "x", value: "v" } as const;

    await new WorkflowSecretDispatcher(acme.client, "acme").dispatch({ ...request });
    await new WorkflowSecretDispatcher(globex.client, "globex").dispatch({ ...request });

    expect(acme.dispatchAndPoll.mock.calls[0]?.[0]).toBe("acme-prod-secrets-write");
    expect(globex.dispatchAndPoll.mock.calls[0]?.[0]).toBe("globex-prod-secrets-write");
  });
});
