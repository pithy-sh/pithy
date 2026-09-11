// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { CliAuditEmit } from "../audit/cliAudit";
import { kitImport } from "../project/kitResolve";
import { kitSource } from "../project/kitSource";
import { deployHostWorker, kitPackageVersion } from "./hostDeploy";
import { capabilityLoadError } from "./loadFailure";

/**
 * The live payments provisioner — the Cloudflare + wrangler implementation behind `pithy payments provision`.
 *
 * **Payments provisions less than any other capability, and that is the design.** There is no bucket, no KV
 * namespace, no index, and — this is the part worth stating — **no secret written here**. Four stores' worth
 * of credentials are things a human downloads from four consoles: Apple's `.p8`, Google's service-account
 * JSON, Stripe's key pair, Lemon Squeezy's API key and webhook secret. Nothing can mint them, so nothing here
 * pretends to; they arrive through `pithy secrets set` and this command deploys the worker that reads them.
 * What is left is one prebuilt Workflow host per environment, and the `workflows` binding that `pithy add`
 * cannot write because the deployed Workflow name is per environment.
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
type PaymentsSubjectModule = typeof import("@pithy-sh/payments/src/data/subject");

/** The config type, referenced by type only so the CLI gains no dependency on the package. */
type PaymentsConfig = import("@pithy-sh/payments/src/config/config").PaymentsConfig;

/** Everything `pithy payments` loads out of the optional package, in one guarded import. */
export type PaymentsModule = PaymentsResolveModule &
  PaymentsCapabilityModule &
  PaymentsSpecsModule &
  PaymentsSubjectModule;

/**
 * Load `@pithy-sh/payments` from the project's own install. The one place the optional dependency is
 * resolved, so a project that has not added payments gets one clear instruction instead of a module error
 * from whichever call site happened to run first.
 */
export async function loadPayments(projectDir: string): Promise<PaymentsModule> {
  try {
    const [resolve, capability, specs, subject] = await Promise.all([
      kitImport<PaymentsResolveModule>(projectDir, "@pithy-sh/payments/src/provision/resolvePaymentsConfig"),
      kitImport<PaymentsCapabilityModule>(projectDir, "@pithy-sh/payments/src/capability"),
      kitImport<PaymentsSpecsModule>(projectDir, "@pithy-sh/payments/src/workflows/specs"),
      // `decodeSubjectReference`, so `pithy payments reconcile --subject` reads a holder through the same
      // strict decoder the rails do rather than a split of its own (#412).
      kitImport<PaymentsSubjectModule>(projectDir, "@pithy-sh/payments/src/data/subject"),
    ]);
    return { ...resolve, ...capability, ...specs, ...subject };
  } catch (error) {
    throw capabilityLoadError("payments", "@pithy-sh/payments", error, projectDir);
  }
}

/** The directory of the prebuilt reconcile worker inside the installed package (holds `wrangler.jsonc`). */
async function paymentsWorkerDir(projectDir: string): Promise<string> {
  try {
    return dirname(kitSource(projectDir, "@pithy-sh/payments/src/workflows/worker"));
  } catch (error) {
    throw capabilityLoadError("payments", "@pithy-sh/payments/src/workflows/worker", error, projectDir);
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
  /**
   * The project root — the directory `pithy.config.ts` was read from, and the base every
   * `@pithy-sh/payments` module is resolved against. Not derivable from {@link project}, which is a
   * *name*; see `project/kitResolve.ts` for why a resolution may not fall back to the CLI's own copy.
   */
  projectDir: string;
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
  readonly #projectDir: string;
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
    this.#projectDir = options.projectDir;
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
    const { paymentsWorkerName, resolvePaymentsConfig } = await loadPayments(this.#projectDir);
    const { appDatabaseId, secretsDatabaseId } = await this.#resolveEnv(env);
    const dir = await paymentsWorkerDir(this.#projectDir);
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolvePaymentsConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      secretsDatabaseId,
      storeId: this.#storeId,
      paymentsConfig: this.#paymentsConfig,
    });

    // **The gate, inherited rather than opted into (#537).** `deployHostWorker` stamps the resolved
    // config with this package's version and a hash of the config itself, compares that against what
    // the deployed Worker carries, and ships only when they differ. A first provision has no stamp, so
    // it deploys. Anything it cannot establish — no Worker, no stamp, an unreachable account — deploys
    // too: a false redeploy costs seconds, a false skip is silent.
    try {
      const { outcome } = await deployHostWorker({
        capability: "payments",
        pkg: "@pithy-sh/payments",
        version: await kitPackageVersion(this.#projectDir, "@pithy-sh/payments"),
        config,
        dir,
        env,
        readVars: (script) => this.#cf.workers().getWorkerVars(script),
        account: { accountId: this.#accountId, apiToken: this.#apiToken },
      });
      // A skipped deploy shipped nothing, so it records nothing. An audit row saying a Worker was
      // deployed on a run where wrangler never ran is worse than a gap in the trail.
      if (outcome === "deployed") {
        await this.#audit({
          environment: env,
          action: "payments/worker_deployed",
          outcome: "success",
          severity: "info",
          resourceType: "cf_worker",
          resourceId: paymentsWorkerName(this.#project, env),
        });
      }
    } catch (error) {
      // Truthful: recorded as it happened, never as it was intended.
      await this.#audit({
        environment: env,
        action: "payments/worker_deployed",
        outcome: "failure",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: paymentsWorkerName(this.#project, env),
      });
      throw error;
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
    const { PAYMENTS_CAPABILITY } = await loadPayments(this.#projectDir);
    const name = resourceNames(this.#project).env(env).workflow(PAYMENTS_CAPABILITY, "reconcile");
    return this.#workflows.dispatchAndPoll(name, params);
  }
}
