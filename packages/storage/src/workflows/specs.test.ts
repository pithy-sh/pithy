// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { describe, expect, test } from "vitest";
import { STORAGE_CAPABILITY, StorageSweepParams, storageWorkflowRegistry, storageWorkflows } from "./specs";

describe("storage workflow specs", () => {
  test("declares one job, bound and classed for the prebuilt sweep worker", () => {
    expect(Object.keys(storageWorkflows)).toEqual(["sweep"]);
    expect(storageWorkflows.sweep.binding).toBe("STORAGE_SWEEP");
    expect(storageWorkflows.sweep.className).toBe("StorageSweepWorkflow");
  });

  test("the sweep is optional, so a project that has not provisioned still boots", () => {
    expect(storageWorkflows.sweep.optional).toBe(true);
  });

  test("carries a daily cron — the sweep is scheduled as well as dispatchable", () => {
    expect(storageWorkflows.sweep.schedule).toBe("0 3 * * *");
  });

  test("the registry keys on `storage/sweep`, through core's own key builder", () => {
    expect(Object.keys(storageWorkflowRegistry)).toEqual(["storage/sweep"]);
    expect(storageWorkflowRegistry["storage/sweep"]?.capability).toBe(STORAGE_CAPABILITY);
  });

  test("the deployed name is the shape already on the wire for email and media", () => {
    expect(workflowScriptName(STORAGE_CAPABILITY, "sweep", "staging")).toBe("pithy-storage-sweep-staging");
  });

  test("empty params are valid — a cron supplies none, so a required field could never run", () => {
    expect(StorageSweepParams.parse({})).toEqual({});
  });

  test("a manual run may narrow the TTL, ask for a dry run, and cap the pages", () => {
    expect(StorageSweepParams.parse({ olderThanSeconds: 60, dryRun: true, maxPages: 2 })).toEqual({
      olderThanSeconds: 60,
      dryRun: true,
      maxPages: 2,
    });
  });

  test("a nonsense TTL is refused at dispatch, not inside a running instance", () => {
    expect(StorageSweepParams.safeParse({ olderThanSeconds: 0 }).success).toBe(false);
    expect(StorageSweepParams.safeParse({ olderThanSeconds: -1 }).success).toBe(false);
  });
});
