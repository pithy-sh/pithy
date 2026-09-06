// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { PaymentsConfig } from "@pithy-sh/payments/src/config/config";
import { paymentsWorkerName, resolvePaymentsConfig } from "@pithy-sh/payments/src/provision/resolvePaymentsConfig";
import { parse } from "comment-json";
import { describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { kitSource } from "../project/kitSource";
import { CloudflarePaymentsProvisioner, loadPayments } from "./paymentsProvisioner";

/** The project every provisioned name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "acme";

/**
 * The payments provisioner. It does less than the others by design — no bucket, no namespace, and no secret
 * written — so what is worth testing is the guard rail and the template, not a fan-out of resource creation.
 *
 * The committed `wrangler.jsonc` is read off disk here rather than reproduced as a fixture. That is the point
 * of the case: a template edit that dropped the secrets-store entry, or renamed a binding the resolver fills
 * by name, would deploy a worker that boots and then cannot read a single credential.
 */

const CATALOG = PaymentsConfig.parse({
  billingSubject: "user",
  rails: { apple: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
    },
  },
});

/** A fake CloudflareClients exposing only the methods the provisioner touches, with spies. */
function fakeCf() {
  const accountSubdomain = vi.fn();
  const cf = { workers: () => ({ accountSubdomain }) } as unknown as CloudflareClients;
  return { cf, accountSubdomain };
}

/** A Workflows client that records the dispatch instead of making one. */
function fakeWorkflows(calls: { name: string; params: unknown }[]) {
  return {
    dispatchAndPoll: async (name: string, params: unknown) => {
      calls.push({ name, params });
      return { scanned: 3, drifted: 1 };
    },
  } as unknown as CloudflareWorkflowsClient;
}

function provisioner(
  cf: CloudflareClients,
  events: CliAuditEvent[] = [],
  workflows: CloudflareWorkflowsClient = fakeWorkflows([]),
) {
  return new CloudflarePaymentsProvisioner({
    project: PROJECT,
    cf,
    accountId: "acct-1",
    apiToken: "tok",
    storeId: "store-1",
    paymentsConfig: CATALOG,
    resolveEnv: async () => ({ appDatabaseId: "app-db", secretsDatabaseId: "secrets-db" }),
    workflows,
    audit: async (event) => void events.push(event),
  });
}

describe("CloudflarePaymentsProvisioner", () => {
  test("preflight refuses an account with no workers.dev subdomain, which Workflows require", async () => {
    const { cf, accountSubdomain } = fakeCf();
    const payments = provisioner(cf);

    accountSubdomain.mockResolvedValue(null);
    await expect(payments.preflight()).rejects.toThrow(/workers\.dev subdomain/);

    accountSubdomain.mockResolvedValue("acme");
    await expect(payments.preflight()).resolves.toBeUndefined();
  });

  test("runs a pass by the Workflow's deployed name, with the parameters it was given", async () => {
    // The CLI has no bindings, only the REST API, so a pass is dispatched by name. The name has to be the one
    // the spec derives, or the command reports success against a Workflow that does not exist.
    const calls: { name: string; params: unknown }[] = [];
    const { cf } = fakeCf();
    const report = await provisioner(cf, [], fakeWorkflows(calls)).reconcile("prod", { userId: "ada" });

    expect(calls).toEqual([{ name: "acme-prod-payments-reconcile", params: { userId: "ada" } }]);
    expect(report).toEqual({ scanned: 3, drifted: 1 });
  });
});

describe("loadPayments", () => {
  test("resolves the optional package from the workspace, so the CLI never hard-depends on it", async () => {
    // The guard exists so a project that has not run `pithy add payments` gets one instruction rather than an
    // unresolved-module crash from whichever call site ran first. Here the package *is* installed, which is
    // what proves the import list itself is right.
    const payments = await loadPayments();
    expect(typeof payments.resolvePaymentsConfig).toBe("function");
    expect(typeof payments.isPaymentsCapability).toBe("function");
    expect(payments.PAYMENTS_CAPABILITY).toBe("payments");
    expect(Object.keys(payments.paymentsWorkflowRegistry)).toEqual(["payments/reconcile"]);
  });
});

describe("the committed reconcile-worker template", () => {
  /** The template as the provisioner parses it off disk — not a fixture, deliberately. */
  async function template(): Promise<WorkflowHostTemplate> {
    const dir = dirname(kitSource("@pithy-sh/payments/src/workflows/worker"));
    return parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
  }

  test("resolves into a complete config for one environment", async () => {
    const resolved = resolvePaymentsConfig(await template(), {
      project: PROJECT,
      env: "prod",
      appDatabaseId: "app-db",
      secretsDatabaseId: "secrets-db",
      storeId: "store-1",
      paymentsConfig: CATALOG,
    });

    expect(resolved.name).toBe(paymentsWorkerName(PROJECT, "prod"));
    expect(resolved.d1_databases?.map((entry) => `${entry.binding}:${entry.database_id}`)).toEqual([
      "DB:app-db",
      "SECRETS:secrets-db",
    ]);
    // Without this entry the worker deploys, boots, and cannot decrypt a single rail's credentials.
    expect(resolved.secrets_store_secrets?.[0]).toMatchObject({
      binding: "SECRETS_ENCRYPTION_KEYS",
      store_id: "store-1",
    });
    expect(resolved.workflows).toEqual([
      {
        binding: "PAYMENTS_RECONCILE",
        name: "acme-prod-payments-reconcile",
        class_name: "PaymentsReconcileWorkflow",
      },
    ]);
    expect(resolved.triggers).toEqual({ crons: ["0 4 * * *"] });
  });

  test("a Lemon Squeezy catalog travels whole, credentials excepted", async () => {
    // The pass maps a refreshed variant back to a product before it can project it, so the rail's toggle,
    // its return URLs and its variant ids all have to survive the trip into `PAYMENTS_CONFIG`. A rail
    // added to the schema and dropped here would reconcile nothing and report zero drift, which reads
    // exactly like a rail with nothing wrong.
    const catalog = PaymentsConfig.parse({
      billingSubject: "user",
      rails: { lemonSqueezy: true },
      lemonSqueezy: { successUrl: "https://app.example.com/thanks" },
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          lemonSqueezy: { variantId: "123456" },
        },
      },
    });

    const resolved = resolvePaymentsConfig(await template(), {
      project: PROJECT,
      env: "prod",
      appDatabaseId: "app-db",
      secretsDatabaseId: "secrets-db",
      storeId: "store-1",
      paymentsConfig: catalog,
    });

    expect(JSON.parse(resolved.vars?.PAYMENTS_CONFIG ?? "null")).toEqual(catalog);
    // The var is a plain one, and it stays that way because nothing secret is in it. The API key, the
    // webhook secret and the store id live in `payments-provider-credentials`, which this never touches.
    for (const shape of ["apiKey", "webhookSecret", "storeId"]) {
      expect(resolved.vars?.PAYMENTS_CONFIG, shape).not.toContain(shape);
    }
  });

  test("the template's entry point is the module the class is exported from", async () => {
    // A `main` that does not resolve is a deploy that fails after every id has been looked up.
    const parsed = await template();
    const dir = dirname(kitSource("@pithy-sh/payments/src/workflows/worker"));
    await expect(readFile(join(dir, parsed.main.replace("./", "")), "utf8")).resolves.toContain(
      "export class PaymentsReconcileWorkflow",
    );
  });
});
