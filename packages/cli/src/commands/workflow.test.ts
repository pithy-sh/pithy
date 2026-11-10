// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowInstance } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { CommandDef } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { Plan } from "../plan/plan";
import type { ResolvedWorker } from "../project/workerScope";
import { expectConforms } from "../test-utils/payloadContract";
import workflow from "./workflow";

const root = vi.hoisted(() => ({ config: {} as { name?: string; seed?: { productionEnvironments?: string[] } } }));
const scope = vi.hoisted(() => ({ workers: [] as unknown[], asked: [] as (string | undefined)[] }));

/** The account's Workflows: the instances each holds, and every start this test made. */
const account = vi.hoisted(() => ({
  instances: {} as Record<string, Record<string, unknown>>,
  starts: [] as { name: string; params: unknown; id: string | undefined }[],
}));

vi.mock("@pithy-sh/cloudflare/src/workflows/workflowsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/workflows/workflowsClient")>()),
  CloudflareWorkflowsClient: class {
    async createInstance(name: string, params: unknown, id?: string): Promise<string> {
      const held = account.instances[name] ?? {};
      account.instances[name] = held;
      if (id !== undefined && id in held) throw new Error("instance.already_exists");
      account.starts.push({ name, params, id });
      const assigned = id ?? "cf-generated";
      held[assigned] = { status: "queued" };
      return assigned;
    }
    async getInstanceStatus(name: string, id: string): Promise<unknown> {
      return account.instances[name]?.[id] ?? null;
    }
  },
}));

vi.mock("../project/composeFor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/composeFor")>()),
  resolveSingleWorkerFor: async (_env: string, options: { worker?: string }) => {
    scope.asked.push(options.worker);
    return scope.workers[0];
  },
  resolveWorkersFor: async () => scope.workers,
}));

vi.mock("@pithy-sh/cloudflare/src/env/devVars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/env/devVars")>()),
  loadCloudflareEnv: () => ({}),
}));

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => root.config,
  projectCloudflareAccount: async () => null,
}));

function subcommand(name: string): CommandDef {
  const entry = (workflow.subCommands as Record<string, CommandDef>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return entry;
}

/** Run a subcommand to its first failure and return the `--json` error payload it reported. */
async function failure(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exited");
  }) as never);
  try {
    await expect(subcommand(name).run?.({ args, rawArgs: [] } as never)).rejects.toThrow("exited");
  } finally {
    stderr.mockRestore();
    exit.mockRestore();
  }
  return JSON.parse(lines.join("")).error;
}

/** Run a subcommand to completion and return everything it wrote to stdout. */
async function output(name: string, args: Record<string, unknown>): Promise<string> {
  const lines: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await subcommand(name).run?.({ args, rawArgs: [] } as never);
  } finally {
    stdout.mockRestore();
  }
  return lines.join("");
}

/**
 * A Worker composing a kit capability's job and an app job of its own: `storage/sweep`, and `stats/collect` taking
 * `{ backfill }`.
 */
function statsWorker(): ResolvedWorker {
  const storage = { name: "storage", workflows: { sweep: { binding: "STORAGE_SWEEP", params: z.object({}) } } };
  const app = {
    name: "stats",
    workflows: {
      collect: {
        binding: "COLLECT",
        className: "CollectWorkflow",
        schedule: "0 * * * *",
        params: z.object({ backfill: z.boolean().default(false) }),
      },
    },
  };
  return {
    name: "acme-api",
    dir: "/nowhere/apps/api",
    config: {},
    capabilities: [storage, app],
    target: { name: "acme-api", dir: "/nowhere/apps/api" },
  } as unknown as ResolvedWorker;
}

const COLLECT = "acme-staging-stats-collect";

beforeEach(() => {
  root.config = { name: "acme" };
  scope.workers = [statsWorker()];
  scope.asked = [];
  account.instances = {};
  account.starts = [];
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const TRIGGER = { env: "staging", json: true, "dry-run": false };

describe("pithy workflow trigger", () => {
  test("starts the app's Workflow with the params, and prints the instance id", async () => {
    const written = await output("trigger", { ...TRIGGER, job: "collect", params: '{"backfill":true}' });

    expect(account.starts).toEqual([{ name: COLLECT, params: { backfill: true }, id: undefined }]);
    expect(JSON.parse(written)).toEqual({
      command: "workflow trigger",
      schemaVersion: 1,
      env: "staging",
      worker: "api",
      job: "stats/collect",
      workflow: COLLECT,
      instanceId: "cf-generated",
      dryRun: false,
    });
    await expectConforms("workflow trigger", written);
  });

  test("a capability's job is reached by its key", async () => {
    await output("trigger", { ...TRIGGER, job: "storage/sweep" });
    expect(account.starts).toEqual([{ name: "acme-staging-storage-sweep", params: {}, id: undefined }]);
  });

  test("the text run names the instance and the command that follows it", async () => {
    const written = await output("trigger", { ...TRIGGER, json: false, job: "collect", id: "backfill-1" });
    expect(written).toContain(`Started stats/collect in staging, as ${COLLECT}.\n`);
    expect(written).toContain(
      "Instance backfill-1. Follow it with pithy workflow status stats/collect backfill-1 --env staging --worker api.\n",
    );
    expect(written.trimEnd().split("\n").at(-1)).toBe("Done.");
  });

  test("bad --params is refused with the schema's message, before any call", async () => {
    const error = await failure("trigger", { ...TRIGGER, job: "collect", params: '{"backfill":"yes"}' });
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toMatch(/^--params does not fit stats\/collect: backfill: .*expected boolean/);
    expect(account.starts).toEqual([]);
  });

  test("--id sets the instance id", async () => {
    const written = await output("trigger", { ...TRIGGER, job: "collect", id: "backfill-1" });
    expect(account.starts[0]?.id).toBe("backfill-1");
    expect(JSON.parse(written).instanceId).toBe("backfill-1");
  });

  test("a duplicate id is reported as a conflict, naming the command that follows the one there", async () => {
    account.instances[COLLECT] = { "backfill-1": { status: "running" } };
    const error = await failure("trigger", { ...TRIGGER, job: "collect", id: "backfill-1" });
    expect(error).toMatchObject({
      code: "core/conflict",
      message: `${COLLECT} already has an instance named "backfill-1".`,
      action:
        "Pass another --id, or follow that one with pithy workflow status stats/collect backfill-1 --env staging --worker api.",
    });
  });

  test("production without the phrase is a person's decision, and starts nothing", async () => {
    const error = await failure("trigger", { ...TRIGGER, env: "prod", job: "collect" });
    expect(error.code).toBe("core/person_required");
    expect(error.action).toBe('Pass --confirm "yes, i really want to trigger prod".');
    expect(account.starts).toEqual([]);
  });

  test("production with the phrase starts the prod Workflow", async () => {
    await output("trigger", { ...TRIGGER, env: "prod", job: "collect", confirm: "yes, i really want to trigger prod" });
    expect(account.starts[0]?.name).toBe("acme-prod-stats-collect");
  });

  test("a dry run starts nothing, plans the one instance, and needs no confirmation", async () => {
    const written = await output("trigger", { ...TRIGGER, env: "prod", job: "collect", "dry-run": true });
    expect(account.starts).toEqual([]);
    const line = JSON.parse(written);
    expect(line.dryRun).toBe(true);
    expect(line.instanceId).toBeNull();
    expect(Plan.parse(line.plan).data).toEqual([
      { worker: "api", store: "workflow", target: "acme-prod-stats-collect", count: 1, action: "write" },
    ]);
    await expectConforms("workflow trigger", written);
  });

  test("a dry run in text ends saying nothing started", async () => {
    const written = await output("trigger", { ...TRIGGER, json: false, job: "collect", "dry-run": true });
    expect(written.trimEnd().split("\n").at(-1)).toBe("Dry run. Nothing started.");
  });

  test("dev is refused: there is no deployed Workflow to start", async () => {
    const error = await failure("trigger", { ...TRIGGER, env: "dev", job: "collect" });
    expect(error.code).toBe("validation/invalid_input");
  });

  test("--worker names the Worker the job is looked up in", async () => {
    await output("trigger", { ...TRIGGER, job: "collect", worker: "api" });
    expect(scope.asked).toEqual(["api"]);
  });
});

describe("pithy workflow list", () => {
  test("lists app and capability jobs with their deployed names", async () => {
    const written = await output("list", { env: "staging", json: true });
    expect(JSON.parse(written).jobs).toEqual([
      {
        worker: "api",
        key: "stats/collect",
        capability: "stats",
        job: "collect",
        binding: "COLLECT",
        schedule: "0 * * * *",
        workflow: COLLECT,
      },
      {
        worker: "api",
        key: "storage/sweep",
        capability: "storage",
        job: "sweep",
        binding: "STORAGE_SWEEP",
        schedule: null,
        workflow: "acme-staging-storage-sweep",
      },
    ]);
    await expectConforms("workflow list", written);
  });

  test("in text, one line per job", async () => {
    const written = await output("list", { env: "staging", json: false });
    expect(written).toBe(
      `api  stats/collect  ${COLLECT}  cron 0 * * * *\napi  storage/sweep  acme-staging-storage-sweep  on trigger\n`,
    );
  });
});

describe("pithy workflow status", () => {
  test("reports an app job's instance", async () => {
    account.instances[COLLECT] = {
      "backfill-1": { status: "complete", output: { rows: 3 } } satisfies WorkflowInstance,
    };
    const written = await output("status", { env: "staging", json: true, job: "collect", instance: "backfill-1" });
    expect(JSON.parse(written)).toEqual({
      command: "workflow status",
      schemaVersion: 1,
      env: "staging",
      worker: "api",
      job: "stats/collect",
      workflow: COLLECT,
      instanceId: "backfill-1",
      status: "complete",
      output: { rows: 3 },
      error: null,
      failedStep: null,
    });
    await expectConforms("workflow status", written);
  });

  test("reports a capability job's failed instance, naming the step", async () => {
    account.instances["acme-staging-storage-sweep"] = {
      s1: {
        status: "errored",
        steps: [
          { name: "list", type: "step", success: false, attempts: [{ success: false, error: { message: "R2 down" } }] },
        ],
      },
    };
    const written = await output("status", { env: "staging", json: false, job: "storage/sweep", instance: "s1" });
    expect(written).toBe("storage/sweep s1 in staging: errored.\nStep list failed: R2 down\n");
  });

  test("an instance the Workflow does not hold is not found", async () => {
    const error = await failure("status", { env: "staging", json: true, job: "collect", instance: "nope" });
    expect(error.code).toBe("core/not_found");
  });
});
