// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { suppressionDatabaseName } from "@pithy-sh/email/src/provision/provisionEmail";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import { describe, expect, test } from "vitest";
import { TestersConfig } from "../config/config";
import {
  deprovisionTesters,
  provisionTesters,
  type TestersDeprovisioner,
  type TestersProvisioner,
  testersWorkerName,
} from "./provisionTesters";
import { resolveTestersConfig } from "./resolveTestersConfig";

/**
 * The orchestration is tested against a fake that records its call order, with no Cloudflare account —
 * the same shape `@pithy-sh/storage` uses. What matters here is sequence and idempotency, and both are
 * properties of this file rather than of the CF client.
 */
function fake(overrides: { failPreflight?: boolean; failOn?: ManagedEnvironment } = {}) {
  const calls: string[] = [];
  const provisioner: TestersProvisioner & TestersDeprovisioner = {
    preflight: async () => {
      calls.push("preflight");
      if (overrides.failPreflight) throw new Error("no workers.dev subdomain");
    },
    deployWorker: async (env) => {
      calls.push(`deploy:${env}`);
      if (overrides.failOn === env) throw new Error(`deploy failed for ${env}`);
    },
    deleteWorker: async (env) => {
      calls.push(`delete:${env}`);
    },
  };
  return { calls, provisioner };
}

const ENVIRONMENTS: ManagedEnvironment[] = ["staging", "prod"];

/** The project every name in this suite leads with — the root `pithy.config.ts` `name`. */
const PROJECT = "acme";

describe("provisioning the daily-pass host", () => {
  test("checks the account once, before any deploy", async () => {
    // Failing at the account level after one environment is already deployed leaves exactly the
    // half-provisioned state that is hardest to reason about and hardest to recover from.
    const { calls, provisioner } = fake();
    await provisionTesters(provisioner, PROJECT, ENVIRONMENTS);
    expect(calls).toEqual(["preflight", "deploy:staging", "deploy:prod"]);
  });

  test("a failing preflight deploys nothing at all", async () => {
    const { calls, provisioner } = fake({ failPreflight: true });
    await expect(provisionTesters(provisioner, PROJECT, ENVIRONMENTS)).rejects.toThrow(/workers\.dev/);
    expect(calls).toEqual(["preflight"]);
  });

  test("a failing deploy stops rather than carrying on to the next environment", async () => {
    // Continuing would report a partial success as a success, and the environment that failed is the
    // one the operator most needs told about.
    const { calls, provisioner } = fake({ failOn: "staging" });
    await expect(provisionTesters(provisioner, PROJECT, ENVIRONMENTS)).rejects.toThrow(/staging/);
    expect(calls).toEqual(["preflight", "deploy:staging"]);
  });

  test("reports the deployed worker name per environment", async () => {
    const { provisioner } = fake();
    const results = await provisionTesters(provisioner, PROJECT, ENVIRONMENTS);
    expect(results).toEqual([
      { env: "staging", worker: "acme-staging-testers" },
      { env: "prod", worker: "acme-prod-testers" },
    ]);
  });

  test("provisioning one environment leaves the others alone", async () => {
    const { calls, provisioner } = fake();
    await provisionTesters(provisioner, PROJECT, ["prod"]);
    expect(calls).toEqual(["preflight", "deploy:prod"]);
  });

  test("re-running is a no-op, because every step overwrites", async () => {
    const { calls, provisioner } = fake();
    await provisionTesters(provisioner, PROJECT, ENVIRONMENTS);
    await provisionTesters(provisioner, PROJECT, ENVIRONMENTS);
    expect(calls.filter((call) => call.startsWith("deploy:"))).toEqual([
      "deploy:staging",
      "deploy:prod",
      "deploy:staging",
      "deploy:prod",
    ]);
  });
});

describe("deprovisioning", () => {
  test("deletes each environment's worker and reports it", async () => {
    const { calls, provisioner } = fake();
    const results = await deprovisionTesters(provisioner, PROJECT, ENVIRONMENTS);
    expect(calls).toEqual(["delete:staging", "delete:prod"]);
    expect(results.map((r) => r.worker)).toEqual(["acme-staging-testers", "acme-prod-testers"]);
  });

  test("runs no preflight — tearing down does not need the account to be able to host anything", async () => {
    const { calls, provisioner } = fake({ failPreflight: true });
    await expect(deprovisionTesters(provisioner, PROJECT, ENVIRONMENTS)).resolves.toBeDefined();
    expect(calls).not.toContain("preflight");
  });
});

describe("the worker name", () => {
  test("is derived, so the deployed name cannot drift from what the dispatcher computes", () => {
    expect(testersWorkerName(PROJECT, "staging")).toBe("acme-staging-testers");
    expect(testersWorkerName(PROJECT, "prod")).toBe("acme-prod-testers");
  });

  test("carries the project, so a second project's deploy cannot overwrite this host", () => {
    expect(testersWorkerName("acme", "prod")).not.toBe(testersWorkerName("globex", "prod"));
  });

  test("comes off core's facade, so it is measured against a Worker script's own limit", () => {
    expect(testersWorkerName(PROJECT, "prod")).toBe(resourceNames(PROJECT).env("prod").worker("testers"));
  });

  test("refuses `production` — the spelling that would deploy a second host beside the real one", () => {
    expect(() => testersWorkerName(PROJECT, "production" as never)).toThrowError(/not an environment name/);
  });
});

describe("resolving the host template", () => {
  /**
   * The **committed** template, not a fixture.
   *
   * A hand-written stand-in is a template that does not exist, and a resolver test against one proves a
   * property of the test. That is not hypothetical here: this file previously declared a `vars` block
   * carrying only `TESTERS_CONFIG` and `ENVIRONMENT`, so the assertion that the `EMAIL_*` vars are
   * omitted when no email capability is composed passed without the resolver doing anything — the real
   * template declares all three as `<filled-at-provision>`, and they were shipping through. Reading the
   * file means a template edit that breaks the deploy breaks this test, which is the point of the
   * template being a file.
   */
  const TEMPLATE = parse(
    readFileSync(join(import.meta.dirname, "../workflows/wrangler.jsonc"), "utf8"),
  ) as unknown as WorkflowHostTemplate;

  const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });

  function resolve(
    env: ManagedEnvironment = "prod",
    email?: { fromAddress: string; fromName: string; theme: unknown },
  ) {
    return resolveTestersConfig(TEMPLATE, {
      project: PROJECT,
      env,
      appDatabaseId: "app-db-id",
      suppressionDatabaseId: "suppression-db-id",
      testersConfig: CONFIG,
      email,
    });
  }

  test("names the worker per environment and fills both database ids", () => {
    const resolved = resolve();
    expect(resolved.name).toBe("acme-prod-testers");
    expect(resolved.d1_databases?.find((d) => d.binding === "DB")?.database_id).toBe("app-db-id");
    expect(resolved.d1_databases?.find((d) => d.binding === "EMAIL_SUPPRESSIONS")?.database_id).toBe(
      "suppression-db-id",
    );
  });

  test("rewrites workflows and the cron from the specs, never from the template's own block", () => {
    // The template carries both so it reads as a complete config, but the spec is the single source —
    // so moving the pass off 05:00 is a one-line edit rather than two that nothing checks agree.
    const resolved = resolve();
    expect(resolved.workflows).toEqual([
      { binding: "TESTERS_DAILY", name: "acme-prod-testers-daily", class_name: "TestersDailyWorkflow" },
    ]);
    expect(resolved.triggers).toEqual({ crons: ["0 5 * * *"] });
  });

  test("rewrites the suppression database name, which is email's and now carries the project", () => {
    // Left alone, the deployed config would print `pithy-email-suppressions` — a name no account holds
    // once the database is project-scoped. The id is what binds, but a config that names a resource
    // that does not exist is one nobody can debug from.
    const resolved = resolve();
    expect(resolved.d1_databases?.find((d) => d.binding === "EMAIL_SUPPRESSIONS")?.database_name).toBe(
      suppressionDatabaseName(PROJECT),
    );
    // The app database is owned elsewhere and passes through untouched.
    expect(resolved.d1_databases?.find((d) => d.binding === "DB")?.database_name).toBe("pithy-app");
  });

  test("serializes the resolved config, so the host reads the adopter's own constants", () => {
    const resolved = resolve();
    expect(JSON.parse(resolved.vars?.TESTERS_CONFIG ?? "{}")).toMatchObject({
      baseUrl: "https://api.example.test",
      nudges: { cooldownHours: 72 },
    });
    expect(resolved.vars?.ENVIRONMENT).toBe("prod");
  });

  test("carries the sending identity when email is composed", () => {
    const resolved = resolve("staging", {
      fromAddress: "hi@example.test",
      fromName: "Acme",
      theme: { appName: "Acme" },
    });
    expect(resolved.vars?.EMAIL_FROM_ADDRESS).toBe("hi@example.test");
    expect(resolved.vars?.EMAIL_FROM_NAME).toBe("Acme");
    expect(JSON.parse(resolved.vars?.EMAIL_THEME ?? "{}")).toMatchObject({ appName: "Acme" });
  });

  test("omits it entirely when email is not composed, rather than writing empty strings", () => {
    // An empty string would satisfy the worker's `if (!env.EMAIL_FROM_ADDRESS)` guard and then fail at
    // the send — a worse place to discover it than the pass reporting that it sent nothing.
    const resolved = resolve();
    expect(resolved.vars?.EMAIL_FROM_ADDRESS).toBeUndefined();
    expect(resolved.vars?.EMAIL_FROM_NAME).toBeUndefined();
  });

  test("leaves the template untouched, so resolving twice cannot compound", () => {
    resolve("staging");
    expect(TEMPLATE.name).toBe("pithy-testers");
    expect(TEMPLATE.workflows?.[0]?.name).toBe("pithy-testers-daily");
  });

  test("binds no secrets store, because this capability reads no secret", () => {
    // The whole reason `pithy testers invite` works against any environment. A stray binding here would
    // be the first step back toward needing one.
    expect(resolve().secrets_store_secrets).toBeUndefined();
  });
});

describe("the configured snapshot hour", () => {
  const template = parse(
    readFileSync(join(import.meta.dirname, "../workflows/wrangler.jsonc"), "utf8"),
  ) as unknown as WorkflowHostTemplate;

  function cronFor(hour: number): string | undefined {
    return resolveTestersConfig(template, {
      project: "acme",
      env: "prod",
      appDatabaseId: "app-db-id",
      suppressionDatabaseId: "suppression-db-id",
      testersConfig: TestersConfig.parse({ baseUrl: "https://api.example.test", snapshotHourUtc: hour }),
      email: undefined,
    }).triggers?.crons?.[0];
  }

  test("reaches the deployed cron", () => {
    // It was a fully described, bounded, defaulted knob that nothing read: an adopter moving the pass
    // off 05:00 because it collided with their own nightly job changed nothing, with no error and no
    // warning, and a config field that read as though it had taken effect.
    expect(cronFor(9)).toBe("0 9 * * *");
    expect(cronFor(0)).toBe("0 0 * * *");
  });

  test("and the default still lands where the spec puts it", () => {
    expect(cronFor(5)).toBe("0 5 * * *");
  });
});
