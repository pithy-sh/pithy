// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { email } from "@pithy-sh/email/src/capability";
import { emailWorkflowNames } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import { describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { ConfirmedAccount } from "../cloudflare/accountAnswer";
import { deleteOwnHosts, ownHostNames } from "./ownHostRemoval";

const composed = email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
const two = { dir: "/proj/apps/two", ownBindings: ["DB"] };
const one = { dir: "/proj/apps/one" };
const account: ConfirmedAccount = { accountId: "acc", confirmation: "pinned" };

/** A fake account holding the Workers and Workflows named, recording what was deleted. */
function fakeAccount(workers: string[], workflows: string[]) {
  const deleted = { workers: [] as string[], workflows: [] as string[] };
  return {
    deleted,
    workers: {
      getWorker: async (name: string) => (workers.includes(name) ? ({ id: name } as never) : null),
      deleteWorker: async (name: string) => {
        deleted.workers.push(name);
      },
    },
    workflows: {
      deleteWorkflow: async (name: string) => {
        if (!workflows.includes(name)) return false;
        deleted.workflows.push(name);
        return true;
      },
    },
  };
}

describe("ownHostNames", () => {
  test("a Worker owning DB has its own email host, with every Workflow the shared host has", () => {
    const names = ownHostNames("acme", "staging", composed, two);
    const shared = emailWorkflowNames("acme", "staging");
    expect(names?.script).toBe("acme-staging-two---email");
    expect(names?.workflows).toHaveLength(shared.length);
    expect(names?.workflows).toEqual(
      shared.map((name) => name.replace("acme-staging-email-", "acme-staging-two---email-")),
    );
  });

  test("a Worker owning nothing the host binds shares the host, and has none to delete", () => {
    expect(ownHostNames("acme", "staging", composed, one)).toBeUndefined();
    expect(
      ownHostNames("acme", "staging", composed, { dir: "/proj/apps/two", ownBindings: ["CACHE"] }),
    ).toBeUndefined();
  });
});

describe("deleteOwnHosts", () => {
  test("deletes the Worker's own host and its Workflows in each environment, and never the shared one", async () => {
    const staging = ownHostNames("acme", "staging", composed, two);
    const prod = ownHostNames("acme", "prod", composed, two);
    if (!staging || !prod) throw new Error("two owns DB");
    const cf = fakeAccount(
      ["acme-staging-email", staging.script, prod.script],
      [...emailWorkflowNames("acme", "staging"), ...staging.workflows, ...prod.workflows],
    );
    const events: CliAuditEvent[] = [];

    const deleted = await deleteOwnHosts({
      project: "acme",
      capability: composed,
      worker: two,
      environments: ["staging", "prod"],
      account,
      workers: cf.workers,
      workflows: cf.workflows,
      audit: async () => async (event) => void events.push(event),
    });

    expect(deleted).toEqual([
      { env: "staging", script: "acme-staging-two---email" },
      { env: "prod", script: "acme-prod-two---email" },
    ]);
    expect(cf.deleted.workers).toEqual(["acme-staging-two---email", "acme-prod-two---email"]);
    expect(cf.deleted.workflows).toEqual([...staging.workflows, ...prod.workflows]);
    expect(events.filter((event) => event.action === "email/worker_removed").map((event) => event.resourceId)).toEqual([
      "acme-staging-two---email",
      "acme-prod-two---email",
    ]);
  });

  test("a host already gone is skipped, so a re-run deletes nothing and reports nothing", async () => {
    const cf = fakeAccount([], []);
    const deleted = await deleteOwnHosts({
      project: "acme",
      capability: composed,
      worker: two,
      environments: ["staging"],
      account,
      workers: cf.workers,
      workflows: cf.workflows,
      audit: async () => async () => {},
    });
    expect(deleted).toEqual([]);
    expect(cf.deleted).toEqual({ workers: [], workflows: [] });
  });
});
