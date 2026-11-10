// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import type { WorkflowSpec } from "@pithy-sh/core/src/workflow/spec";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { boundWorkflows, findJob, jobRows, jobWorkflowName, parseInstanceId, parseJobParams } from "./jobs";

/** A capability declaring `jobs`, as `composeWorkflows` reads one. */
function capability(name: string, jobs: Record<string, Partial<WorkflowSpec>>): Capability {
  const workflows = Object.fromEntries(
    Object.entries(jobs).map(([job, spec]) => [
      job,
      { binding: job.toUpperCase(), params: z.object({}), ...spec } as WorkflowSpec,
    ]),
  );
  return { name, workflows } as unknown as Capability;
}

/** The thrown `PithyError`, so a test reads its code and lines. */
function thrown(run: () => unknown): PithyError {
  try {
    run();
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a PithyError");
}

const collect = capability("stats", {
  collect: { params: z.object({ backfill: z.boolean().default(false) }), className: "CollectWorkflow" },
});
const sweeps = [capability("storage", { sweep: {} }), capability("media", { sweep: {} })];

describe("findJob", () => {
  test("the full <capability>/<job> key names the job", () => {
    const registry = composeWorkflows([collect, ...sweeps]);
    expect(findJob(registry, "storage/sweep", "api").key).toBe("storage/sweep");
  });

  test("a bare job name names the one job that carries it", () => {
    const registry = composeWorkflows([collect, ...sweeps]);
    expect(findJob(registry, "collect", "api").key).toBe("stats/collect");
  });

  test("a bare name two capabilities share is refused, naming both keys", () => {
    const error = thrown(() => findJob(composeWorkflows(sweeps), "sweep", "api"));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.message).toBe('"sweep" is a job in more than one capability.');
    expect(error.payload.action).toBe("Name it by its key: media/sweep, storage/sweep.");
  });

  test("an unknown job is refused, listing the jobs the Worker declares", () => {
    const error = thrown(() => findJob(composeWorkflows([collect, ...sweeps]), "colect", "api"));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.message).toBe('api declares no Workflow job "colect".');
    expect(error.payload.action).toBe("Pick one of: media/sweep, stats/collect, storage/sweep.");
  });

  test("a Worker with no jobs says so rather than listing nothing", () => {
    const error = thrown(() => findJob({}, "collect", "api"));
    expect(error.message).toBe('api declares no Workflow job "collect".');
    expect(error.payload.action).toBe("api composes no capability that declares a Workflow.");
  });
});

describe("parseJobParams", () => {
  const entry = composeWorkflows([collect])["stats/collect"];
  if (!entry) throw new Error("fixture");

  test("the params parse through the job's schema, defaults applied", () => {
    expect(parseJobParams(entry, '{"backfill":true}')).toEqual({ backfill: true });
    expect(parseJobParams(entry, undefined)).toEqual({ backfill: false });
  });

  test("params the schema refuses are refused with the schema's own message", () => {
    const error = thrown(() => parseJobParams(entry, '{"backfill":"yes"}'));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.message).toMatch(/^--params does not fit stats\/collect: backfill: /);
    expect(error.message).toContain("expected boolean");
    expect(error.payload.action).toBe("Correct --params to match the job's params schema.");
  });

  test("text that is not JSON is refused before the schema is asked", () => {
    const error = thrown(() => parseJobParams(entry, "{backfill:true}"));
    expect(error.payload.code).toBe("validation/invalid_input");
    expect(error.message).toBe("--params is not JSON.");
    expect(error.payload.action).toBe(`Pass one JSON value, such as --params '{"backfill":true}'.`);
  });
});

describe("parseInstanceId", () => {
  test("no --id is no id", () => {
    expect(parseInstanceId(undefined)).toBeUndefined();
  });

  test("an id of letters, digits, dashes and underscores is taken as it is", () => {
    expect(parseInstanceId("backfill_2026-11-09")).toBe("backfill_2026-11-09");
  });

  test("an id Cloudflare would refuse is refused here, before any call", () => {
    for (const bad of ["", "has space", "a/b", "x".repeat(101)]) {
      const error = thrown(() => parseInstanceId(bad));
      expect(error.payload.code).toBe("validation/invalid_input");
      expect(error.message).toBe("--id must be 1 to 100 letters, digits, dashes or underscores.");
    }
    expect(parseInstanceId("x".repeat(100))).toBe("x".repeat(100));
  });
});

describe("jobWorkflowName", () => {
  test("an app job is named for the app capability in the environment", () => {
    const app = capability("board", { digest: { className: "DigestWorkflow" } });
    const entry = composeWorkflows([app])["board/digest"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "replay",
        env: "staging",
        entry,
        worker: { capabilities: [app], target: { dir: "/p/apps/api" } },
      }),
    ).toBe("replay-staging-board-digest");
  });

  test("a capability job is named for its capability", () => {
    const entry = composeWorkflows(sweeps)["storage/sweep"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "replay",
        env: "prod",
        entry,
        worker: { capabilities: sweeps, target: { dir: "/p/apps/api" } },
      }),
    ).toBe("replay-prod-storage-sweep");
  });

  /** The storage host's sweep, as the kit declares it: a class the host Worker runs. */
  const hosted = capability("storage", { sweep: { className: "SweepWorkflow" } });

  test("a Worker that owns what its capability's host binds names the owner's Workflow", () => {
    const entry = composeWorkflows([hosted])["storage/sweep"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "acme",
        env: "staging",
        entry,
        worker: { capabilities: [hosted], target: { dir: "/p/apps/api", ownBindings: ["DB", "STORAGE_BUCKET"] } },
      }),
    ).toBe("acme-staging-api---storage-sweep");
  });

  test("a Worker that owns nothing the host binds names the shared host's Workflow", () => {
    const entry = composeWorkflows([hosted])["storage/sweep"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "acme",
        env: "staging",
        entry,
        worker: { capabilities: [hosted], target: { dir: "/p/apps/api", ownBindings: ["CACHE"] } },
      }),
    ).toBe("acme-staging-storage-sweep");
  });

  /** Payments' usage pass: no class, so the adopter's own Worker hosts it under the binding they wrote. */
  const payments = capability("payments", { usage: { binding: "PAYMENTS_USAGE" } });

  test("an adopter-hosted library job is named by the Worker's own entry for its binding", () => {
    const entry = composeWorkflows([payments])["payments/usage"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "acme",
        env: "prod",
        entry,
        worker: {
          capabilities: [payments],
          target: { dir: "/p/apps/api", ownBindings: ["DB"] },
          bound: [
            { binding: "OTHER", name: "acme-prod-other" },
            { binding: "PAYMENTS_USAGE", name: "acme-prod-payments-usage-v2" },
          ],
        },
      }),
    ).toBe("acme-prod-payments-usage-v2");
  });

  test("an adopter-hosted library job with no entry is named without an owner, though the Worker owns DB", () => {
    const entry = composeWorkflows([payments])["payments/usage"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "acme",
        env: "prod",
        entry,
        worker: { capabilities: [payments], target: { dir: "/p/apps/api", ownBindings: ["DB"] }, bound: [] },
      }),
    ).toBe("acme-prod-payments-usage");
  });

  test("a hand-maintained app job is named by the Worker's own entry for its binding", () => {
    const app = capability("board", { export: { binding: "BOARD_EXPORT", optional: true } });
    const entry = composeWorkflows([app])["board/export"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "acme",
        env: "staging",
        entry,
        worker: {
          capabilities: [app],
          target: { dir: "/p/apps/api" },
          bound: [{ binding: "BOARD_EXPORT", name: "exporter-staging" }],
        },
      }),
    ).toBe("exporter-staging");
  });

  test("a job with a class keeps its derived name whatever the stanza binds", () => {
    const entry = composeWorkflows([hosted])["storage/sweep"];
    if (!entry) throw new Error("fixture");
    expect(
      jobWorkflowName({
        project: "acme",
        env: "staging",
        entry,
        worker: {
          capabilities: [hosted],
          target: { dir: "/p/apps/api" },
          bound: [{ binding: "SWEEP", name: "stale-name" }],
        },
      }),
    ).toBe("acme-staging-storage-sweep");
  });
});

describe("boundWorkflows", () => {
  test("reads the environment stanza's workflows entries, comments and all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-bound-"));
    try {
      await writeFile(
        join(dir, "wrangler.jsonc"),
        `{
  // the adopter's own entry
  "workflows": [{ "binding": "PAYMENTS_USAGE", "name": "top-level", "class_name": "UsageWorkflow" }],
  "env": {
    "prod": {
      "workflows": [{ "binding": "PAYMENTS_USAGE", "name": "acme-prod-payments-usage", "class_name": "UsageWorkflow" }],
    },
  },
}`,
      );
      expect(await boundWorkflows(dir, "prod")).toEqual([
        { binding: "PAYMENTS_USAGE", name: "acme-prod-payments-usage" },
      ]);
      expect(await boundWorkflows(dir, "staging")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a Worker with no wrangler.jsonc binds nothing", async () => {
    expect(await boundWorkflows(join(tmpdir(), "pithy-no-such-worker"), "prod")).toEqual([]);
  });
});

describe("jobRows", () => {
  test("each Worker's rows name its own Workflows: an owner's host, and the entries its stanza binds", () => {
    const hosted = capability("storage", { sweep: { className: "SweepWorkflow" } });
    const payments = capability("payments", { usage: { binding: "PAYMENTS_USAGE" } });
    const workers = [
      {
        capabilities: [hosted, payments],
        target: { dir: "/p/apps/api", ownBindings: ["DB", "STORAGE_BUCKET"] },
        bound: [{ binding: "PAYMENTS_USAGE", name: "acme-prod-payments-usage" }],
      },
      { capabilities: [hosted], target: { dir: "/p/apps/admin" } },
    ];
    expect(jobRows(workers, { project: "acme", env: "prod" }).map((row) => [row.worker, row.workflow])).toEqual([
      ["api", "acme-prod-payments-usage"],
      ["api", "acme-prod-api---storage-sweep"],
      ["admin", "acme-prod-storage-sweep"],
    ]);
  });

  test("every job of every Worker, app and capability alike, with its Workflow in the environment", () => {
    const app = capability("board", { digest: { className: "DigestWorkflow", schedule: "0 4 * * *" } });
    const workers = [
      { capabilities: [...sweeps, app], target: { dir: "/p/apps/api" } },
      { capabilities: [], target: { dir: "/p/apps/admin" } },
    ];
    expect(jobRows(workers, { project: "replay", env: "staging" })).toEqual([
      {
        worker: "api",
        key: "board/digest",
        capability: "board",
        job: "digest",
        binding: "DIGEST",
        schedule: "0 4 * * *",
        workflow: "replay-staging-board-digest",
      },
      {
        worker: "api",
        key: "media/sweep",
        capability: "media",
        job: "sweep",
        binding: "SWEEP",
        schedule: null,
        workflow: "replay-staging-media-sweep",
      },
      {
        worker: "api",
        key: "storage/sweep",
        capability: "storage",
        job: "sweep",
        binding: "SWEEP",
        schedule: null,
        workflow: "replay-staging-storage-sweep",
      },
    ]);
  });
});
