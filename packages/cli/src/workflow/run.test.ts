// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowInstance } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import type { WorkflowSpec } from "@pithy-sh/core/src/workflow/spec";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type InstanceReader, type InstanceStarter, jobStatus, triggerJob } from "./run";

/** The job every test triggers: `stats/collect`, deployed as `acme-staging-stats-collect`. */
function entryOf(spec: Partial<WorkflowSpec> = {}) {
  const app = {
    name: "stats",
    workflows: { collect: { binding: "COLLECT", params: z.object({ backfill: z.boolean() }), ...spec } },
  } as unknown as Capability;
  const entry = composeWorkflows([app])["stats/collect"];
  if (!entry) throw new Error("fixture");
  return entry;
}

const WORKFLOW = "acme-staging-stats-collect";

/** A Workflows client double over the instances it holds, recording each start. */
function account(held: Record<string, WorkflowInstance> = {}) {
  const started: { name: string; params: unknown; id: string | undefined }[] = [];
  const client: InstanceStarter & InstanceReader = {
    async createInstance(name, params, id) {
      if (id !== undefined && id in held) throw new Error("instance.already_exists");
      started.push({ name, params, id });
      const assigned = id ?? "generated-id";
      held[assigned] = { status: "queued" };
      return assigned;
    },
    async getInstanceStatus(_name, id) {
      return held[id] ?? null;
    },
  };
  return { client, started };
}

async function refusal(run: Promise<unknown>): Promise<PithyError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("triggerJob", () => {
  test("starts the job's Workflow with its params, and hands back the id Cloudflare gave", async () => {
    const { client, started } = account();
    const outcome = await triggerJob({
      entry: entryOf(),
      workflow: WORKFLOW,
      params: { backfill: true },
      dryRun: false,
      workflows: client,
    });
    expect(started).toEqual([{ name: WORKFLOW, params: { backfill: true }, id: undefined }]);
    expect(outcome).toEqual({ instanceId: "generated-id", started: true });
  });

  test("--id names the instance", async () => {
    const { client, started } = account();
    const outcome = await triggerJob({
      entry: entryOf(),
      workflow: WORKFLOW,
      params: { backfill: true },
      id: "backfill-1",
      dryRun: false,
      workflows: client,
    });
    expect(started[0]?.id).toBe("backfill-1");
    expect(outcome.instanceId).toBe("backfill-1");
  });

  test("with no --id, the spec's instanceId names the instance from the params", async () => {
    const { client, started } = account();
    await triggerJob({
      entry: entryOf({ instanceId: ({ params }) => `collect-${(params as { backfill: boolean }).backfill}` }),
      workflow: WORKFLOW,
      params: { backfill: true },
      dryRun: false,
      workflows: client,
    });
    expect(started[0]?.id).toBe("collect-true");
  });

  test("--id over the spec's instanceId", async () => {
    const { client, started } = account();
    await triggerJob({
      entry: entryOf({ instanceId: () => "from-spec" }),
      workflow: WORKFLOW,
      params: { backfill: true },
      id: "from-flag",
      dryRun: false,
      workflows: client,
    });
    expect(started[0]?.id).toBe("from-flag");
  });

  test("an id already taken is a conflict that names the instance and how to follow it", async () => {
    const { client } = account({ "backfill-1": { status: "running" } });
    const error = await refusal(
      triggerJob({
        entry: entryOf(),
        workflow: WORKFLOW,
        params: { backfill: true },
        id: "backfill-1",
        dryRun: false,
        workflows: client,
        follow: (instance) => `pithy workflow status stats/collect ${instance} --env staging`,
      }),
    );
    expect(error.payload.code).toBe("core/conflict");
    expect(error.message).toBe(`${WORKFLOW} already has an instance named "backfill-1".`);
    expect(error.payload.action).toBe(
      "Pass another --id, or follow that one with pithy workflow status stats/collect backfill-1 --env staging.",
    );
  });

  test("a start that fails for another reason fails as it did", async () => {
    const client: InstanceStarter & InstanceReader = {
      async createInstance() {
        throw new Error("network down");
      },
      async getInstanceStatus() {
        return null;
      },
    };
    await expect(
      triggerJob({ entry: entryOf(), workflow: WORKFLOW, params: {}, id: "x", dryRun: false, workflows: client }),
    ).rejects.toThrow("network down");
  });

  test("a dry run starts nothing, and reports the id it would ask for", async () => {
    const { client, started } = account();
    const outcome = await triggerJob({
      entry: entryOf({ instanceId: () => "daily" }),
      workflow: WORKFLOW,
      params: { backfill: true },
      dryRun: true,
      workflows: client,
    });
    expect(started).toEqual([]);
    expect(outcome).toEqual({ instanceId: "daily", started: false });
  });

  test("a dry run makes the duplicate refusal the real run would", async () => {
    const { client } = account({ daily: { status: "complete" } });
    const error = await refusal(
      triggerJob({
        entry: entryOf({ instanceId: () => "daily" }),
        workflow: WORKFLOW,
        params: { backfill: true },
        dryRun: true,
        workflows: client,
        follow: (instance) => `pithy workflow status stats/collect ${instance} --env staging`,
      }),
    );
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.action).toBe(
      "Pass another --id, or follow that one with pithy workflow status stats/collect daily --env staging.",
    );
  });

  test("an id the spec's instanceId names, already taken, names how to follow that instance", async () => {
    const { client } = account({ daily: { status: "running" } });
    const error = await refusal(
      triggerJob({
        entry: entryOf({ instanceId: () => "daily" }),
        workflow: WORKFLOW,
        params: { backfill: true },
        dryRun: false,
        workflows: client,
        follow: (instance) => `pithy workflow status stats/collect ${instance} --env staging`,
      }),
    );
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.action).toBe(
      "Pass another --id, or follow that one with pithy workflow status stats/collect daily --env staging.",
    );
  });

  test("a dry run with no id to ask for leaves the id to Cloudflare", async () => {
    const { client } = account();
    const outcome = await triggerJob({
      entry: entryOf(),
      workflow: WORKFLOW,
      params: { backfill: true },
      dryRun: true,
      workflows: client,
    });
    expect(outcome).toEqual({ instanceId: null, started: false });
  });
});

describe("jobStatus", () => {
  test("a running instance reports its state", async () => {
    const { client } = account({ "backfill-1": { status: "running" } });
    expect(await jobStatus({ workflow: WORKFLOW, instanceId: "backfill-1", workflows: client })).toEqual({
      status: "running",
      error: null,
      failedStep: null,
    });
  });

  test("a complete instance carries its output", async () => {
    const { client } = account({ "backfill-1": { status: "complete", output: { rows: 3 } } });
    expect(await jobStatus({ workflow: WORKFLOW, instanceId: "backfill-1", workflows: client })).toEqual({
      status: "complete",
      output: { rows: 3 },
      error: null,
      failedStep: null,
    });
  });

  test("an errored instance names the step that failed and what it said", async () => {
    const { client } = account({
      "backfill-1": {
        status: "errored",
        error: { message: "a step threw" },
        steps: [
          { name: "fetch", type: "step", success: true },
          {
            name: "write",
            type: "step",
            success: false,
            attempts: [{ success: false, error: { name: "Error", message: "D1 is full" } }],
          },
        ],
      },
    });
    const report = await jobStatus({ workflow: WORKFLOW, instanceId: "backfill-1", workflows: client });
    expect(report.status).toBe("errored");
    expect(report.failedStep).toBe("write");
    expect(report.error).toContain("D1 is full");
  });

  test("an errored instance with no step to blame reports the instance's own error", async () => {
    const { client } = account({ "backfill-1": { status: "terminated", error: "terminated by user" } });
    const report = await jobStatus({ workflow: WORKFLOW, instanceId: "backfill-1", workflows: client });
    expect(report).toEqual({ status: "terminated", error: "terminated by user", failedStep: null });
  });

  test("an instance Cloudflare does not know is not found", async () => {
    const { client } = account();
    const error = await refusal(jobStatus({ workflow: WORKFLOW, instanceId: "nope", workflows: client }));
    expect(error.payload.code).toBe("core/not_found");
    expect(error.message).toBe(`${WORKFLOW} has no instance named "nope".`);
  });
});
