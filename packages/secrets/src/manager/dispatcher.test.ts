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
      backend: "d1",
      scope: "environment",
      bootstrap: false,
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
    const request = {
      env: "prod",
      mode: "update",
      name: "x",
      backend: "d1",
      scope: "environment",
      bootstrap: false,
      value: "v",
    } as const;

    await new WorkflowSecretDispatcher(acme.client, "acme").dispatch({ ...request });
    await new WorkflowSecretDispatcher(globex.client, "globex").dispatch({ ...request });

    expect(acme.dispatchAndPoll.mock.calls[0]?.[0]).toBe("acme-prod-secrets-write");
    expect(globex.dispatchAndPoll.mock.calls[0]?.[0]).toBe("globex-prod-secrets-write");
  });
});

/**
 * **This writer reaches one environment's D1 and nothing else, so it refuses anything else** (#517).
 *
 * `backendRoutedDispatcher` sends a store write elsewhere, which should make this unreachable — which is
 * exactly why it is here. A write path added later that forgets to route fails at the first dispatch
 * instead of quietly filling a database with values no reader opens.
 */
describe("a request for another backend never becomes a D1 row", () => {
  const foreign = {
    env: "staging",
    mode: "create",
    name: "SUPPLIED",
    backend: "cf-secrets-store",
    scope: "environment",
    bootstrap: false,
    value: "v",
    valueType: "text",
    rotatable: false,
  } as const;

  test("a cf-secrets-store write is refused, and nothing is dispatched", async () => {
    const { client, dispatchAndPoll } = stubClient();
    await expect(new WorkflowSecretDispatcher(client, "acme").dispatch({ ...foreign })).rejects.toThrow(
      /only reaches D1/,
    );
    expect(dispatchAndPoll.mock.calls).toEqual([]);
  });

  /** The guard is on both entry points: a pre-flight that resolved here would answer about a store this
   * writer cannot reach, which is worse than not asking — it would read as *nothing to refuse*. */
  test("a cf-secrets-store pre-flight is refused too, and probes nothing", async () => {
    const { client, dispatchAndPoll } = stubClient();
    await expect(new WorkflowSecretDispatcher(client, "acme").preflight({ ...foreign })).rejects.toThrow(
      /only reaches D1/,
    );
    expect(dispatchAndPoll.mock.calls).toEqual([]);
  });
});

/**
 * # The refusals a `d1` write owns, asked with nothing written (#517)
 *
 * `storeSecretWriter` got this seam and this dispatcher did not, and the router asked for it with `?.` —
 * so on the more common backend `pithy secrets rotate` called the issuer first and met `Secret does not
 * exist` afterwards, with the old credential dead and the new one nowhere. The questions are the write's
 * own, asked through the one mode that writes nothing.
 */
describe("preflight", () => {
  const update = {
    env: "prod",
    mode: "update",
    name: "CF_TOKEN",
    backend: "d1",
    scope: "environment",
    bootstrap: false,
    valueType: "text",
    rotatable: true,
  } as const;

  test("asks the environment's own manager, in the mode that writes nothing", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockResolvedValue({ outcome: "present" });

    await expect(new WorkflowSecretDispatcher(client, "acme").preflight({ ...update })).resolves.toBeUndefined();

    // One call, and it carries a name and nothing else — no value can be written by a question.
    expect(dispatchAndPoll.mock.calls).toEqual([["acme-prod-secrets-write", { mode: "probe", name: "CF_TOKEN" }]]);
  });

  /** The measured defect, at its own seam: this is the answer that used to arrive after the roll. */
  test("refuses an update of a secret the manager does not hold", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockResolvedValue({ outcome: "absent" });

    await expect(new WorkflowSecretDispatcher(client, "acme").preflight({ ...update })).rejects.toThrow(
      /does not exist/,
    );
  });

  /** The mirror, so a typo cannot create a second secret over a live one. */
  test("refuses a create over a secret the manager already holds", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockResolvedValue({ outcome: "present" });

    await expect(
      new WorkflowSecretDispatcher(client, "acme").preflight({ ...update, mode: "create", value: "v" }),
    ).rejects.toThrow(/already exists/);
  });

  /** An unreachable manager is the other refusal, and it arrives as the probe's own failure. */
  test("refuses when the manager cannot be reached at all", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockRejectedValue(new Error("no such Workflow"));

    await expect(new WorkflowSecretDispatcher(client, "acme").preflight({ ...update })).rejects.toThrow(
      /no such Workflow/,
    );
  });

  /** `delete` refuses nothing and is idempotent — it asks only that the manager is there. */
  test("a delete is asked nothing beyond reachability", async () => {
    const { client, dispatchAndPoll } = stubClient();
    dispatchAndPoll.mockResolvedValue({ outcome: "absent" });

    await expect(
      new WorkflowSecretDispatcher(client, "acme").preflight({ ...update, mode: "delete" }),
    ).resolves.toBeUndefined();
  });
});
