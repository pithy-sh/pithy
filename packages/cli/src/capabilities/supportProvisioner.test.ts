// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { SupportConfig, type SupportConfigInput } from "@pithy-sh/support/src/config/config";
import { supportRoutingRuleName, supportWorkerName } from "@pithy-sh/support/src/provision/provisionSupport";
import { resolveSupportConfig } from "@pithy-sh/support/src/provision/resolveSupportConfig";
import { parse } from "comment-json";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { CloudflareSupportDeprovisioner, CloudflareSupportProvisioner, supportBucketName } from "./supportProvisioner";

/**
 * Support's provisioned names and the resolution of its committed host template.
 *
 * Every name here is account-scoped in Cloudflare — an R2 bucket, a Worker script, an Email Routing
 * rule — and each is *found by name and reused* before it is created. The project segment is what
 * makes that reuse mean "mine again" rather than "whatever another Pithy project left here", so it is
 * the property these tests pin.
 */

/** The project every provisioned name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "acme";

/** The committed template as `deployWorker` parses it off disk — not a fixture, deliberately. */
async function committedTemplate(): Promise<WorkflowHostTemplate> {
  const dir = dirname(fileURLToPath(import.meta.resolve("@pithy-sh/support/src/workflows/worker")));
  return parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
}

/** A fake CloudflareClients exposing only what the bucket and rule steps touch. */
function fakeCf() {
  const findBucketByName = vi.fn();
  const createBucket = vi.fn();
  const ensureWorkerRoute = vi.fn();
  const removeWorkerRoute = vi.fn();
  const cf = {
    r2Provisioner: () => ({ findBucketByName, createBucket }),
    emailRouting: () => ({ ensureWorkerRoute, removeWorkerRoute }),
  } as unknown as CloudflareClients;
  return { cf, findBucketByName, createBucket, ensureWorkerRoute, removeWorkerRoute };
}

function provisioner(cf: CloudflareClients, events: CliAuditEvent[], overrides?: ProvisionerSlice) {
  const { supportConfig, ...rest } = overrides ?? {};
  return new CloudflareSupportProvisioner({
    cf,
    project: PROJECT,
    account: { accountId: "acct-1", confirmation: "pinned" },
    apiToken: "tok",
    supportConfig: SupportConfig.parse(supportConfig ?? {}),
    resolveEnv: async () => ({ appDatabaseId: "app-db" }),
    ...rest,
    audit: async (event) => void events.push(event),
  });
}

/** Only the routing slice and the support config vary between the cases below. */
type ProvisionerSlice = {
  routing?: { zoneId: string; address: string; appWorkerName: string };
  supportConfig?: SupportConfigInput;
};

describe("names", () => {
  test("the bucket is one per project, shared across that project's environments", () => {
    // `global` in the environment slot says the scope out loud: the app Worker's binding is what
    // separates environments, so there is one bucket for the project to point at.
    expect(supportBucketName(PROJECT)).toBe("acme-global-support");
  });

  test("a second project never resolves to this project's bucket, rule, or worker", () => {
    expect(supportBucketName("globex")).not.toBe(supportBucketName("acme"));
    expect(supportRoutingRuleName("globex")).not.toBe(supportRoutingRuleName("acme"));
    expect(supportWorkerName("globex", "prod")).not.toBe(supportWorkerName("acme", "prod"));
  });
});

describe("ensureBucket", () => {
  test("reuses a bucket found under this project's name rather than creating a second", async () => {
    const { cf, findBucketByName, createBucket } = fakeCf();
    const events: CliAuditEvent[] = [];
    findBucketByName.mockResolvedValue({ name: supportBucketName(PROJECT) });

    expect(await provisioner(cf, events).ensureBucket()).toEqual({
      bucket: supportBucketName(PROJECT),
      created: false,
      skipped: false,
    });
    // The lookup is by the project-scoped name, which is the whole reason reuse is safe: R2's
    // namespace is account-wide and offers no tags, so the name is the entire ownership record.
    expect(findBucketByName).toHaveBeenCalledWith(supportBucketName(PROJECT));
    expect(createBucket).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test("creates nothing when no setting would ever write to it", async () => {
    // The bucket holds three kinds of byte and each has its own flag. With all three off nothing is
    // ever written, so creating one is an account-wide name claimed for nothing.
    const { cf, findBucketByName, createBucket } = fakeCf();
    const events: CliAuditEvent[] = [];

    expect(
      await provisioner(cf, events, {
        supportConfig: {
          inboundAddresses: ["support@help.example.com"],
          attachments: { enabled: false, retainRaw: false },
          submission: { attachments: { enabled: false } },
        },
      }).ensureBucket(),
    ).toEqual({ bucket: supportBucketName(PROJECT), created: false, skipped: true });
    expect(findBucketByName).not.toHaveBeenCalled();
    expect(createBucket).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test("creates it for in-app submissions alone, with both mail settings off", async () => {
    // The case the old two-flag gate missed. `submission/submit.ts` writes an in-app submission's
    // files to this same bucket, so a project that wants uploads but no mail attachments got a
    // binding pointing at a bucket nothing had created — and every submitted file was dropped with a
    // warning nobody was reading (#440). One predicate now answers for all three writers.
    const { cf, findBucketByName, createBucket } = fakeCf();
    const events: CliAuditEvent[] = [];
    findBucketByName.mockResolvedValue(null);
    createBucket.mockResolvedValue({ name: supportBucketName(PROJECT) });

    expect(
      await provisioner(cf, events, {
        supportConfig: {
          inboundAddresses: ["support@help.example.com"],
          attachments: { enabled: false, retainRaw: false },
          submission: { attachments: { enabled: true } },
        },
      }).ensureBucket(),
    ).toEqual({ bucket: supportBucketName(PROJECT), created: true, skipped: false });
    expect(createBucket).toHaveBeenCalledWith(supportBucketName(PROJECT));
  });

  test("creates it when absent, and audits the project alongside the name", async () => {
    const { cf, findBucketByName, createBucket } = fakeCf();
    const events: CliAuditEvent[] = [];
    findBucketByName.mockResolvedValue(null);
    createBucket.mockResolvedValue({ name: supportBucketName(PROJECT) });

    expect(await provisioner(cf, events).ensureBucket()).toEqual({
      bucket: supportBucketName(PROJECT),
      created: true,
      skipped: false,
    });
    expect(createBucket).toHaveBeenCalledWith(supportBucketName(PROJECT));
    expect(events).toEqual([
      expect.objectContaining({
        action: "support/bucket_created",
        resourceId: supportBucketName(PROJECT),
        metadata: { name: supportBucketName(PROJECT) },
      }),
    ]);
  });
});

describe("the inbound routing rule", () => {
  const routing = { zoneId: "zone-1", address: "help@example.test", appWorkerName: "acme-prod-app" };

  test("is created under this project's rule name, never a shared one", async () => {
    const { cf, ensureWorkerRoute } = fakeCf();
    const events: CliAuditEvent[] = [];
    ensureWorkerRoute.mockResolvedValue({ created: true });

    expect(await provisioner(cf, events, { routing }).ensureRoutingRule()).toEqual({ created: true, skipped: false });
    // Idempotency in `ensureWorkerRoute` keys on the rule name: two projects on one zone sharing an
    // unscoped name would each read the other's rule as their own, and one project's customer mail
    // would be delivered to the other project's Worker.
    expect(ensureWorkerRoute).toHaveBeenCalledWith({
      zoneId: routing.zoneId,
      address: routing.address,
      workerName: routing.appWorkerName,
      ruleName: supportRoutingRuleName(PROJECT),
    });
  });

  test("teardown removes only this project's rule", async () => {
    const { cf, removeWorkerRoute } = fakeCf();
    removeWorkerRoute.mockResolvedValue({ removed: true });
    const deprovisioner = new CloudflareSupportDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      routingZoneId: "zone-1",
    });

    expect(await deprovisioner.removeRoutingRule()).toEqual({ removed: true });
    expect(removeWorkerRoute).toHaveBeenCalledWith({ zoneId: "zone-1", ruleName: supportRoutingRuleName(PROJECT) });
  });
});

describe("the committed classification worker template", () => {
  test("resolves into a complete config, project- and environment-scoped", async () => {
    const resolved = resolveSupportConfig(await committedTemplate(), {
      project: PROJECT,
      env: "prod",
      appDatabaseId: "app-db",
      supportConfig: SupportConfig.parse({}),
    });

    expect(resolved.name).toBe(supportWorkerName(PROJECT, "prod"));
    expect(resolved.d1_databases?.find((entry) => entry.binding === "DB")?.database_id).toBe("app-db");
    // A Workflow name is account-scoped too, and it comes from support's own specs rather than from the
    // template's block — the template's name cannot be suffixed into a project-scoped one.
    expect(resolved.workflows).toEqual([
      { binding: "SUPPORT_CLASSIFY", name: "acme-prod-support-classify", class_name: "SupportClassifyWorkflow" },
    ]);
    // Workers AI has no local emulation and a Workflow host always runs locally in `wrangler dev`.
    expect(resolved.ai).toEqual({ binding: "AI", remote: true });
    // No credential at all — the smallest blast radius a deployed worker can have.
    expect(resolved.secrets_store_secrets).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain("<filled-at-provision>");
  });

  test("a second project resolves to entirely different worker and Workflow names", async () => {
    const template = await committedTemplate();
    const resolved = resolveSupportConfig(template, {
      project: "globex",
      env: "prod",
      appDatabaseId: "app-db",
      supportConfig: SupportConfig.parse({}),
    });

    expect(resolved.name).toBe("globex-prod-support");
    expect(resolved.workflows?.[0]?.name).toBe("globex-prod-support-classify");
    // Resolution is pure: the committed template it was handed is untouched.
    expect(template.name).toBe("pithy-support");
  });
});

/**
 * The account a teardown deletes from must be one something claims (#378).
 *
 * `getWorker` answers "this account has no such script" and "you asked an account that is not yours"
 * with the same `null`, so a teardown pointed at a stranger's account used to delete nothing, audit
 * nothing, and exit 0 — a success message printed over a production Worker that is still running.
 *
 * The account id below is a literal, written here and nowhere else, and the plant that proves this gate
 * can fail is one word: turn `confirmation` back into something the guard ignores.
 */
describe("teardown refuses an unconfirmed account", () => {
  test("refuses instead of reading a miss as `already gone`", async () => {
    const getWorker = vi.fn().mockResolvedValue(null);
    const deleteWorker = vi.fn();
    const cf = { workers: () => ({ getWorker, deleteWorker }) } as unknown as CloudflareClients;
    const stranger = new CloudflareSupportDeprovisioner({
      cf,
      project: PROJECT,
      account: { accountId: "acct-stranger", confirmation: "ambient" },
    });

    await expect(stranger.deleteWorker("prod")).rejects.toThrow(
      "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.",
    );
    expect(deleteWorker).not.toHaveBeenCalled();
    expect(getWorker).not.toHaveBeenCalled();
  });

  test("a confirmed account still tears down", async () => {
    const getWorker = vi.fn().mockResolvedValue({ id: "acme-prod-support" });
    const deleteWorker = vi.fn();
    const cf = { workers: () => ({ getWorker, deleteWorker }) } as unknown as CloudflareClients;
    const ours = new CloudflareSupportDeprovisioner({
      cf,
      project: PROJECT,
      account: { accountId: "acct-ours", confirmation: "pinned" },
    });

    await ours.deleteWorker("prod");
    expect(deleteWorker).toHaveBeenCalledTimes(1);
  });
});
