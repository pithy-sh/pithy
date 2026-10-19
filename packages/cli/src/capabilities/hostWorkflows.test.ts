// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { workflowsHolding } from "../test-utils/workflows";
import { deleteHostWorkflows } from "./hostWorkflows";

/** The shared double, with its delete spied on so a test can count what was asked. */
function fakeWorkflows(present: readonly string[]) {
  const { workflows, held } = workflowsHolding(present);
  const deleteWorkflow = vi.spyOn(workflows, "deleteWorkflow");
  return { workflows, held, deleteWorkflow };
}

const NAMES = ["acme-staging-email-send", "acme-staging-email-schedule"];

describe("deleteHostWorkflows", () => {
  test("deletes every named Workflow and audits each one it deleted (#789)", async () => {
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

  test("refuses an unconfirmed account before any delete (#378)", async () => {
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
