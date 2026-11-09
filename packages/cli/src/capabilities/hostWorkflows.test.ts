// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { workflowsHolding } from "../test-utils/workflows";
import {
  deleteHostWorkflows,
  hostScriptsOf,
  hostWorkflowsOf,
  ownedHostNames,
  projectHostOwners,
} from "./hostWorkflows";

/** The shared double, with its delete spied on so a test can count what was asked. */
function fakeWorkflows(present: readonly string[]) {
  const { workflows, held } = workflowsHolding(present);
  const deleteWorkflow = vi.spyOn(workflows, "deleteWorkflow");
  return { workflows, held, deleteWorkflow };
}

const NAMES = ["acme-staging-email-send", "acme-staging-email-schedule"];

describe("deleteHostWorkflows", () => {
  test("deletes every named Workflow and audits each one it deleted", async () => {
    const { workflows, held } = fakeWorkflows([...NAMES, "acme-prod-email-send"]);
    const events: CliAuditEvent[] = [];
    const deleted = await deleteHostWorkflows({
      workflows,
      account: { accountId: "acct-1", confirmation: "pinned" },
      capability: "email",
      env: "staging",
      names: NAMES,
      audit: async (event) => void events.push(event),
    });

    expect(deleted).toEqual(NAMES);
    // Production's is not among the names, so it is not touched.
    expect([...held]).toEqual(["acme-prod-email-send"]);
    expect(events).toEqual(
      NAMES.map((name) => ({
        environment: "staging",
        action: "email/workflow_deleted",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_workflow",
        resourceId: name,
      })),
    );
  });

  test("a second run, or one after a hand deletion, deletes nothing, audits nothing, and does not throw", async () => {
    const { workflows, deleteWorkflow } = fakeWorkflows(["acme-staging-email-schedule"]);
    const events: CliAuditEvent[] = [];
    const run = () =>
      deleteHostWorkflows({
        workflows,
        account: { accountId: "acct-1", confirmation: "named" },
        capability: "email",
        env: "staging",
        names: NAMES,
        audit: async (event) => void events.push(event),
      });

    expect(await run()).toEqual(["acme-staging-email-schedule"]);
    expect(await run()).toEqual([]);
    expect(events.map((event) => event.resourceId)).toEqual(["acme-staging-email-schedule"]);
    expect(deleteWorkflow).toHaveBeenCalledTimes(4);
  });

  test("refuses an unconfirmed account before any delete", async () => {
    const { workflows, deleteWorkflow } = fakeWorkflows(NAMES);
    await expect(
      deleteHostWorkflows({
        workflows,
        account: { accountId: "acct-stranger", confirmation: "ambient" },
        capability: "email",
        env: "staging",
        names: NAMES,
        audit: async () => {},
      }),
    ).rejects.toThrow("Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.");
    expect(deleteWorkflow).not.toHaveBeenCalled();
  });
});

/**
 * **A Worker's own host is torn down by the names provision gave it**, recomputed from the shared host's: the same
 * jobs, with the owner in the thing.
 */
describe("ownedHostNames", () => {
  test("names each owner's host and its Workflows from the shared host's Workflows", () => {
    expect(
      ownedHostNames({
        capability: "email",
        project: "acme",
        env: "staging",
        owners: ["two", "three"],
        workflows: ["acme-staging-email-send", "acme-staging-email-schedule"],
      }),
    ).toEqual({
      workers: ["acme-staging-two---email", "acme-staging-three---email"],
      workflows: [
        "acme-staging-two---email-send",
        "acme-staging-two---email-schedule",
        "acme-staging-three---email-send",
        "acme-staging-three---email-schedule",
      ],
    });
  });

  test("skips a name too long to compose, which no deploy could have created, and names the rest", () => {
    // `acme-platform-services-prod-marketing-frontend---support-classify` is past a Workflow's 64 bytes.
    const names = ownedHostNames({
      capability: "support",
      project: "acme-platform-services",
      env: "prod",
      owners: ["marketing-frontend", "two"],
      workflows: ["acme-platform-services-prod-support-classify"],
    });
    expect(names).toEqual({
      workers: [
        "acme-platform-services-prod-marketing-frontend---support",
        "acme-platform-services-prod-two---support",
      ],
      workflows: ["acme-platform-services-prod-two---support-classify"],
    });
  });

  test("names nothing for a project with no owning Worker", () => {
    expect(
      ownedHostNames({
        capability: "email",
        project: "acme",
        env: "prod",
        owners: [],
        workflows: ["acme-prod-email-send"],
      }),
    ).toEqual({ workers: [], workflows: [] });
  });
});

describe("hostScriptsOf and hostWorkflowsOf", () => {
  const naming = { capability: "audit", project: "acme", env: "prod" as const, owners: ["two"] };

  test("list the shared host first, then each owner's", () => {
    expect(hostScriptsOf(naming, "acme-prod-audit")).toEqual(["acme-prod-audit", "acme-prod-two---audit"]);
    expect(hostWorkflowsOf({ ...naming, workflows: ["acme-prod-audit-checkpoint"] })).toEqual([
      "acme-prod-audit-checkpoint",
      "acme-prod-two---audit-checkpoint",
    ]);
  });
});

describe("projectHostOwners", () => {
  test("names every apps/ Worker that lists ownBindings, by its directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-host-owners-"));
    for (const worker of ["one", "two"]) {
      await mkdir(join(dir, "apps", worker), { recursive: true });
      await writeFile(join(dir, "apps", worker, "wrangler.jsonc"), `{ "name": "acme-${worker}" }`);
    }
    await writeFile(join(dir, "apps", "two", "pithy.worker.jsonc"), '{ "ownBindings": ["DB"] }');
    try {
      expect(await projectHostOwners(dir)).toEqual(["two"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
