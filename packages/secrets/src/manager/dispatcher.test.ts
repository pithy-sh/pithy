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

  test("probes this project's manager, carrying a name and nothing else", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockResolvedValue({ outcome: "present" });

    expect(await new WorkflowSecretDispatcher(client, "acme").probe({ env: "prod", name: "x" })).toBe(true);

    // No value, no valueType, no rotatable — a read has nothing to carry.
    expect(dispatchAndPoll).toHaveBeenCalledWith("acme-prod-secrets-write", { mode: "probe", name: "x" });
  });

  test("an absent secret probes false", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockResolvedValue({ outcome: "absent" });

    expect(await new WorkflowSecretDispatcher(client, "acme").probe({ env: "prod", name: "x" })).toBe(false);
  });

  /**
   * **The gate that must not read as "absent".** The instance output crosses back from a deployed
   * Worker, so it is untrusted; an unreadable one — an old manager that predates the probe mode, a
   * truncated body — would leave `outcome` undefined, which compares unequal to `"present"` and is
   * therefore indistinguishable from *this secret does not exist*. That is the exact answer that makes
   * provisioning mint a second value over a live signing key. It stops the run instead.
   */
  test.each([undefined, {}, { outcome: "maybe" }, "present", { audited: true }])(
    "refuses an answer it cannot read rather than treating it as absent: %s",
    async (output) => {
      const { client, dispatchAndPoll } = stubClient();
      dispatchAndPoll.mockResolvedValue(output);

      await expect(new WorkflowSecretDispatcher(client, "acme").probe({ env: "prod", name: "x" })).rejects.toThrow(
        /no usable answer/,
      );
    },
  );

  /**
   * **The rotation ledger over the same wire (`#379`).** A row addressed by an id, so the id is the thing
   * that must not be guessed at: a `rotation-open` whose answer cannot be read leaves the close pointing at
   * nothing, and a row that never closes reads as a rotation still running long after it ended.
   */
  test("opens a rotation row and returns the id its manager assigned", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockResolvedValue({ outcome: "opened", rotationId: 7 });

    const id = await new WorkflowSecretDispatcher(client, "acme").openRotation({
      env: "prod",
      name: "CF_TOKEN",
      trigger: "manual",
      rotatedBy: "pithy secrets rotate",
    });

    expect(id).toBe(7);
    // No value and no valueType — opening a row touches nothing a secret could be in.
    expect(dispatchAndPoll).toHaveBeenCalledWith("acme-prod-secrets-write", {
      mode: "rotation-open",
      name: "CF_TOKEN",
      trigger: "manual",
      rotatedBy: "pithy secrets rotate",
    });
  });

  test.each([undefined, {}, { outcome: "opened" }, { outcome: "written", rotationId: 7 }, { rotationId: 7 }])(
    "refuses an open it cannot read rather than closing an id it invented: %s",
    async (output) => {
      const { client, dispatchAndPoll } = stubClient();
      dispatchAndPoll.mockResolvedValue(output);

      await expect(
        new WorkflowSecretDispatcher(client, "acme").openRotation({
          env: "prod",
          name: "CF_TOKEN",
          trigger: "manual",
          rotatedBy: "pithy secrets rotate",
        }),
      ).rejects.toThrow(/did not record a rotation/);
    },
  );

  test("closes a row with a reason code, never with a sentence", async () => {
    const { client, dispatchAndPoll } = stubClient();

    await new WorkflowSecretDispatcher(client, "acme").closeRotation({
      env: "prod",
      rotationId: 7,
      closure: { status: "failed", reason: "not-recorded" },
    });

    // The failure sentence is composed inside the Worker. Free text is what a value gets pasted into, and
    // nothing crossing this wire has a field one could go in.
    expect(dispatchAndPoll).toHaveBeenCalledWith("acme-prod-secrets-write", {
      mode: "rotation-close",
      rotationId: 7,
      closure: { status: "failed", reason: "not-recorded" },
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
