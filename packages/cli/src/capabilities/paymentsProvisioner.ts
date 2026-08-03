// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { CliAuditEmit } from "../audit/cliAudit";
import { runWrangler } from "../project/wrangler";

/**
 * The live payments provisioner — the Cloudflare + wrangler implementation behind `pithy payments provision`.
 *
 * **Payments provisions less than any other capability, and that is the design.** There is no bucket, no KV
 * namespace, no index, and — this is the part worth stating — **no secret written here**. Three stores' worth
 * of credentials are things a human downloads from three consoles: Apple's `.p8`, Google's service-account
 * JSON, Stripe's key pair. Nothing can mint them, so nothing here pretends to; they arrive through
 * `pithy secrets set` and this command deploys the worker that reads them. What is left is one prebuilt
 * Workflow host per environment, and the `workflows` binding that `pithy add` cannot write because the
 * deployed Workflow name is per environment.
 *
 * `@pithy-sh/payments` is an **optional** capability, so the CLI must not hard-depend on it. Types come in
 * through type-only imports (erased at build), and every runtime value comes through {@link loadPayments} — a
 * guarded dynamic import that turns "the package isn't installed" into an actionable error rather than an
 * unresolved-module crash.
 */

/** The payments runtime surface provisioning needs, loaded from the project's own install. */
type PaymentsResolveModule = typeof import("@pithy-sh/payments/src/provision/resolvePaymentsConfig");
type PaymentsCapabilityModule = typeof import("@pithy-sh/payments/src/capability");
type PaymentsSpecsModule = typeof import("@pithy-sh/payments/src/workflows/specs");

/** The config type, referenced by type only so the CLI gains no dependency on the package. */
type PaymentsConfig = import("@pithy-sh/payments/src/config/config").PaymentsConfig;

/** Everything `pithy payments` loads out of the optional package, in one guarded import. */
export type PaymentsModule = PaymentsResolveModule & PaymentsCapabilityModule & PaymentsSpecsModule;

/**
 * Load `@pithy-sh/payments` from the project's own install. The one place the optional dependency is
 * resolved, so a project that has not added payments gets one clear instruction instead of a module error
 * from whichever call site happened to run first.
 */
export async function loadPayments(): Promise<PaymentsModule> {
  try {
    const [resolve, capability, specs] = await Promise.all([
      import("@pithy-sh/payments/src/provision/resolvePaymentsConfig"),
      import("@pithy-sh/payments/src/capability"),
      import("@pithy-sh/payments/src/workflows/specs"),
    ]);
    return { ...resolve, ...capability, ...specs };
  } catch (error) {
    throw new ValidationError(
      {
        message: "The payments capability is not installed.",
        action: "Run `pithy add payments`, then re-run this command.",
        detail: "@pithy-sh/payments could not be resolved from the project's install.",
      },
      { cause: error },
    );
  }
}

/** The directory of the prebuilt reconcile worker inside the installed package (holds `wrangler.jsonc`). */
async function paymentsWorkerDir(): Promise<string> {
  try {
    return dirname(fileURLToPath(import.meta.resolve("@pithy-sh/payments/src/workflows/worker")));
  } catch (error) {
    throw new ValidationError(
      {
        message: "The payments capability is not installed.",
        action: "Run `pithy add payments`, then re-run this command.",
        detail: "@pithy-sh/payments/src/workflows/worker could not be resolved from the project's install.",
      },
      { cause: error },
    );
  }
}

/** The per-environment resource ids the reconcile worker binds, resolved by the caller. */
export interface PaymentsEnvResources {
  /** The app database id for this environment — where the `pithy_payments_*` tables live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`<project>-<env>-secrets`) — holds the rails' credentials. */
  secretsDatabaseId: string;
}

/** Resolve the per-environment resources for the reconcile worker (from the project wrangler + a lookup). */
export type ResolvePaymentsEnv = (env: ManagedEnvironment) => Promise<PaymentsEnvResources>;

export interface CloudflarePaymentsProvisionerOptions {
  cf: CloudflareClients;
  accountId: string;
  /**
   * The project name, from `requireProjectName(await loadProject(projectDir))` — never
   * `resolveProjectName`. The deployed host and the reconcile Workflow both lead with it, and a guessed
   * value dispatches into a Workflow name nothing deployed.
   */
  project: string;
  /** The bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  apiToken: string;
  /** The CF Secrets Store id holding the per-env master keys (the worker decrypts its credentials with one). */
  storeId: string;
  /** The app's resolved payments config — serialized into the worker's `PAYMENTS_CONFIG` var. */
  paymentsConfig: PaymentsConfig;
  /** Resolve the per-env app DB id and secrets DB id — injected so it is testable and decoupled. */
  resolveEnv: ResolvePaymentsEnv;
  /** The Workflows REST client, for running a pass in a deployed environment on demand. */
  workflows: CloudflareWorkflowsClient;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/** The live payments provisioner. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflarePaymentsProvisioner {
  readonly #cf: CloudflareClients;
  readonly #accountId: string;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #storeId: string;
  readonly #paymentsConfig: PaymentsConfig;
  readonly #resolveEnv: ResolvePaymentsEnv;
  readonly #workflows: CloudflareWorkflowsClient;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflarePaymentsProvisionerOptions) {
    this.#cf = options.cf;
    this.#accountId = options.accountId;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#storeId = options.storeId;
    this.#paymentsConfig = options.paymentsConfig;
    this.#resolveEnv = options.resolveEnv;
    this.#workflows = options.workflows;
    this.#audit = options.audit ?? (async () => {});
  }

  /** Require a registered `workers.dev` subdomain — Cloudflare needs one to deploy a Workflow host. */
  async preflight(): Promise<void> {
    if (!(await this.#cf.workers().accountSubdomain())) {
      throw new ValidationError({
        message: "This Cloudflare account has no workers.dev subdomain, which Workflows require.",
        action: "Open Workers & Pages in the dashboard once to create one, then re-run.",
      });
    }
  }

  /** Resolve the env's wrangler config from the committed template + provisioned ids, then `wrangler deploy`. */
  async deployWorker(env: ManagedEnvironment): Promise<void> {
    const { paymentsWorkerName, resolvePaymentsConfig } = await loadPayments();
    const { appDatabaseId, secretsDatabaseId } = await this.#resolveEnv(env);
    const dir = await paymentsWorkerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolvePaymentsConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      secretsDatabaseId,
      storeId: this.#storeId,
      paymentsConfig: this.#paymentsConfig,
    });

    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: this.#apiToken, CLOUDFLARE_ACCOUNT_ID: this.#accountId },
      });
      await this.#audit({
        action: "payments/worker_deployed",
        outcome: "success",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: paymentsWorkerName(this.#project, env),
        metadata: { env },
      });
    } catch (error) {
      // Truthful: recorded as it happened, never as it was intended.
      await this.#audit({
        action: "payments/worker_deployed",
        outcome: "failure",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: paymentsWorkerName(this.#project, env),
        metadata: { env },
      });
      throw error;
    } finally {
      await unlink(configPath).catch(() => {});
    }
  }

  /**
   * Run a reconciliation pass in a deployed environment and wait for its report.
   *
   * Dispatched by the Workflow's own deployed name rather than through a Worker binding, because this call
   * comes from a terminal rather than from inside the Worker — the CLI has no bindings, only the REST API. The
   * parameters are the same schema the in-Worker dispatcher validates, so a run started here and one started
   * by the cron are the same run.
   */
  async reconcile(env: ManagedEnvironment, params: Record<string, unknown>): Promise<unknown> {
    const { PAYMENTS_CAPABILITY } = await loadPayments();
    const name = resourceNames(this.#project).env(env).workflow(PAYMENTS_CAPABILITY, "reconcile");
    return this.#workflows.dispatchAndPoll(name, params);
  }
}
