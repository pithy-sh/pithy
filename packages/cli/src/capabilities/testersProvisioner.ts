// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { CliAuditEmit } from "../audit/cliAudit";
import { runWrangler } from "../project/wrangler";
import { capabilityLoadError } from "./loadFailure";

/**
 * The live testers provisioner — the Cloudflare + wrangler implementation behind `@pithy-sh/testers`'s
 * `TestersProvisioner` seam. The account check goes through `@pithy-sh/cloudflare` (CLAUDE.md: the CF
 * API only via that client); the worker deploy shells out to wrangler with the bootstrap token.
 *
 * `@pithy-sh/testers` is an **optional** capability, so the CLI must not hard-depend on it. Types come
 * in through type-only imports (erased at build), and every runtime value comes through
 * {@link loadTestersProvisioning} — a guarded dynamic import that turns "the package isn't installed"
 * into an actionable error rather than an unresolved-module crash.
 */

/** The testers runtime surface provisioning needs, loaded from the project's own install. */
type TestersProvisionModule = typeof import("@pithy-sh/testers/src/provision/provisionTesters");
type TestersResolveModule = typeof import("@pithy-sh/testers/src/provision/resolveTestersConfig");
type TestersSpecsModule = typeof import("@pithy-sh/testers/src/workflows/specs");

/** The provisioner seams, referenced by type only so the CLI gains no dependency on the package. */
type TestersProvisioner = import("@pithy-sh/testers/src/provision/provisionTesters").TestersProvisioner;
type TestersDeprovisioner = import("@pithy-sh/testers/src/provision/provisionTesters").TestersDeprovisioner;
type TestersConfig = import("@pithy-sh/testers/src/config/config").TestersConfig;
type TestersEmailIdentity = import("@pithy-sh/testers/src/provision/resolveTestersConfig").TestersEmailIdentity;

/** Everything `pithy testers provision` loads out of the optional package, in one guarded import. */
export type TestersProvisionSurface = TestersProvisionModule & TestersResolveModule & TestersSpecsModule;

/**
 * Load the provisioning surface from the project's own install.
 *
 * Separate from `testersLoader.ts`'s `loadTesters`, which pulls the data-layer modules the roster
 * commands need. Splitting them keeps `pithy testers status` from importing a wrangler template
 * resolver it will never call.
 */
export async function loadTestersProvisioning(): Promise<TestersProvisionSurface> {
  try {
    const [provision, resolve, specs] = await Promise.all([
      import("@pithy-sh/testers/src/provision/provisionTesters"),
      import("@pithy-sh/testers/src/provision/resolveTestersConfig"),
      import("@pithy-sh/testers/src/workflows/specs"),
    ]);
    return { ...provision, ...resolve, ...specs };
  } catch (error) {
    throw capabilityLoadError("testers", "@pithy-sh/testers", error);
  }
}

/**
 * The directory of the prebuilt daily-pass worker inside the installed package.
 *
 * Resolved from the module rather than assembled from a path, so it keeps working however the adopter's
 * package manager laid `node_modules` out.
 */
async function testersWorkerDir(): Promise<string> {
  try {
    return dirname(fileURLToPath(import.meta.resolve("@pithy-sh/testers/src/workflows/worker")));
  } catch (error) {
    throw capabilityLoadError("testers", "@pithy-sh/testers/src/workflows/worker", error);
  }
}

/** The per-environment resource ids the daily-pass worker binds, resolved by the caller. */
export interface TestersEnvResources {
  /** The app database id — the `pithy_testers_*`, `pithy_auth_*` and `pithy_email_jobs` tables. */
  readonly appDatabaseId: string;
  /** The global email-suppression database id, shared across environments. */
  readonly suppressionDatabaseId: string;
}

/** Resolve the per-environment resources for the host (from the project wrangler + name lookups). */
export type ResolveTestersEnv = (env: ManagedEnvironment) => Promise<TestersEnvResources>;

export interface CloudflareTestersProvisionerOptions {
  readonly cf: CloudflareClients;
  readonly accountId: string;
  /**
   * The project name, from `requireProjectName(await loadProject(projectDir))` — never
   * `resolveProjectName`. The deployed host, its daily Workflow, and the suppression database name all
   * lead with it, and a guessed value deploys a host teardown will never find.
   */
  readonly project: string;
  /** The broad bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  readonly apiToken: string;
  /** The app's resolved testers config — serialized into the host's `TESTERS_CONFIG` var. */
  readonly testersConfig: TestersConfig;
  /** The sending identity, or undefined when the project composes no email capability. */
  readonly email: TestersEmailIdentity | undefined;
  /** Resolve the per-env database ids — injected so it is testable and decoupled from wrangler parsing. */
  readonly resolveEnv: ResolveTestersEnv;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  readonly audit?: CliAuditEmit;
}

/** The live provisioner. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareTestersProvisioner implements TestersProvisioner, TestersDeprovisioner {
  readonly #cf: CloudflareClients;
  readonly #accountId: string;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #testersConfig: TestersConfig;
  readonly #email: TestersEmailIdentity | undefined;
  readonly #resolveEnv: ResolveTestersEnv;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareTestersProvisionerOptions) {
    this.#cf = options.cf;
    this.#accountId = options.accountId;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#testersConfig = options.testersConfig;
    this.#email = options.email;
    this.#resolveEnv = options.resolveEnv;
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

  /** Resolve the env's wrangler config from the committed template + ids, then `wrangler deploy`. */
  async deployWorker(env: ManagedEnvironment): Promise<void> {
    const { resolveTestersConfig, testersWorkerName } = await loadTestersProvisioning();
    const { appDatabaseId, suppressionDatabaseId } = await this.#resolveEnv(env);
    const dir = await testersWorkerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;

    const config = resolveTestersConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      suppressionDatabaseId,
      testersConfig: this.#testersConfig,
      email: this.#email,
    });

    // Written beside the template and removed afterwards. Leaving a resolved config in the package
    // directory would leave one environment's database ids sitting in `node_modules` after the command
    // that needed them finished.
    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: this.#apiToken, CLOUDFLARE_ACCOUNT_ID: this.#accountId },
      });
      await this.#audit({
        environment: env,
        action: "testers/worker_deployed",
        outcome: "success",
        severity: "info",
        resourceType: "cf_worker",
        resourceId: testersWorkerName(this.#project, env),
        metadata: { sends: this.#email !== undefined },
      });
    } catch (error) {
      await this.#audit({
        environment: env,
        action: "testers/worker_deployed",
        outcome: "failure",
        severity: "warning",
        resourceType: "cf_worker",
        resourceId: testersWorkerName(this.#project, env),
      });
      throw error;
    } finally {
      await unlink(configPath).catch(() => {});
    }
  }

  /**
   * Delete this environment's host, if it is deployed.
   *
   * The existence check is what makes teardown idempotent, and it is not belt-and-braces: Cloudflare
   * answers a delete for an absent script with a 404, `cloudflareRequest` rethrows that as a
   * `CloudflareRequestError`, and `deprovisionTesters` has no per-environment catch — so an
   * un-provisioned staging would abort the fan-out before production was attempted. Every sibling
   * deprovisioner in this directory guards the same call for the same reason.
   *
   * The audit sits inside the guard too. A `worker_deleted` event for a worker that never existed is a
   * false entry in the one log that is supposed to be the record of what actually happened.
   */
  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    const { testersWorkerName } = await loadTestersProvisioning();
    const name = testersWorkerName(this.#project, env);
    if (await this.#cf.workers().getWorker(name)) {
      await this.#cf.workers().deleteWorker(name);
      await this.#audit({
        environment: env,
        action: "testers/worker_deleted",
        outcome: "success",
        severity: "warning",
        resourceType: "cf_worker",
        resourceId: name,
      });
    }
  }
}
