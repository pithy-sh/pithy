// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { personDecision, type Remedy, remedy, type WorkerDir } from "@pithy-sh/core/src/cli/command";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
import { kitImport } from "../project/kitResolve";
import { kitSource } from "../project/kitSource";
import type { FeatureIndexes } from "../provision/resources";
import { deployHostWorker, kitPackageVersion } from "./hostDeploy";
import { capabilityLoadError } from "./loadFailure";
import { capabilityProvisionRemedy } from "./provisionCommand";

/**
 * The live vector provisioner — the Cloudflare + wrangler implementation behind `@pithy-sh/vector`'s
 * `VectorProvisioner` seam. Control-plane calls go through `@pithy-sh/cloudflare` (CLAUDE.md: the CF API
 * only via that client); the worker deploy shells out to wrangler with the bootstrap token.
 *
 * `@pithy-sh/vector` is an **optional** capability, so the CLI must not hard-depend on it. Types arrive
 * through type-only imports (erased at build) and every runtime value through {@link loadVector} — a guarded
 * dynamic import that turns "the package isn't installed" into an actionable error rather than an
 * unresolved-module crash.
 *
 * **Vectorize is eventually consistent, and this file never assumes otherwise.** Creating an index or a
 * metadata index is *accepted*, not applied. Where the ordering matters — a metadata index must exist before
 * any vector is written, or that vector is permanently unfilterable — the provisioner polls the list endpoint
 * until several reads in a row agree, inside a budget sized from measured latency, rather than reading back
 * what it just wrote.
 */

type VectorProvisionModule = typeof import("@pithy-sh/vector/src/provision/provisionVector");
type VectorResolveModule = typeof import("@pithy-sh/vector/src/provision/resolveVectorConfig");
type VectorCapabilityModule = typeof import("@pithy-sh/vector/src/capability");
type VectorDriftModule = typeof import("@pithy-sh/vector/src/index/drift");
type VectorProvisionedModule = typeof import("@pithy-sh/vector/src/index/provisioned");
type VectorSpecsModule = typeof import("@pithy-sh/vector/src/workflows/specs");

/** The seams, referenced by type only so the CLI gains no dependency on the package. */
type VectorProvisioner = import("@pithy-sh/vector/src/provision/provisionVector").VectorProvisioner;
type VectorIndexShape = import("@pithy-sh/vector/src/provision/provisionVector").VectorIndexShape;
type MetadataIndexDescriptor = import("@pithy-sh/vector/src/index/metadata").MetadataIndexDescriptor;
type MetadataIndexReport = import("@pithy-sh/vector/src/index/drift").MetadataIndexReport;
type VectorConfig = import("@pithy-sh/vector/src/config/config").VectorConfig;

/** Everything `pithy vector` loads out of the optional package, in one guarded import. */
export type VectorModule = VectorProvisionModule &
  VectorResolveModule &
  VectorCapabilityModule &
  VectorDriftModule &
  VectorProvisionedModule &
  VectorSpecsModule;

/**
 * Load `@pithy-sh/vector` from the project's own install. The one place the optional dependency is resolved,
 * so a project that has not added vector gets one clear instruction instead of a module error from whichever
 * call site happened to run first.
 */
export async function loadVector(projectDir: string): Promise<VectorModule> {
  try {
    const [provision, resolve, capability, drift, provisioned, specs] = await Promise.all([
      kitImport<VectorProvisionModule>(projectDir, "@pithy-sh/vector/src/provision/provisionVector"),
      kitImport<VectorResolveModule>(projectDir, "@pithy-sh/vector/src/provision/resolveVectorConfig"),
      kitImport<VectorCapabilityModule>(projectDir, "@pithy-sh/vector/src/capability"),
      kitImport<VectorDriftModule>(projectDir, "@pithy-sh/vector/src/index/drift"),
      kitImport<VectorProvisionedModule>(projectDir, "@pithy-sh/vector/src/index/provisioned"),
      kitImport<VectorSpecsModule>(projectDir, "@pithy-sh/vector/src/workflows/specs"),
    ]);
    return { ...provision, ...resolve, ...capability, ...drift, ...provisioned, ...specs };
  } catch (error) {
    throw await capabilityLoadError("vector", "@pithy-sh/vector", error, projectDir);
  }
}

/** The directory of the prebuilt vector worker inside the installed package (holds `wrangler.jsonc`). */
async function vectorWorkerDir(projectDir: string): Promise<string> {
  try {
    return dirname(kitSource(projectDir, "@pithy-sh/vector/src/workflows/worker"));
  } catch (error) {
    throw await capabilityLoadError("vector", "@pithy-sh/vector/src/workflows/worker", error, projectDir);
  }
}

/** Resolve the app database id for an environment — where the document corpus lives. */
export type ResolveVectorEnv = (env: string) => Promise<{ appDatabaseId: string }>;

/**
 * How long to wait for an accepted metadata index to become live. Sized from measurement, not chosen: on #709 a
 * metadata index settled in about 97s on one run and was still unsettled at 120s on the next. The ten
 * one-second polls this replaced gave up on both. The kit's own live suites wait on the same number.
 */
export const METADATA_SETTLE_BUDGET_MS = 300_000;

/**
 * Consecutive agreeing reads that count as live. The metadata-index list is eventually consistent and not
 * monotonic: a live probe watched it report an index, then drop it 18s later with nothing else running, then
 * report it again. So one read that shows an index proves nothing.
 */
export const METADATA_STABLE_READS = 3;

/** How often to look. Vectorize applies a metadata index in tens of seconds, so a tighter loop only burns quota. */
export const METADATA_POLL_INTERVAL_MS = 2_000;

export interface CloudflareVectorProvisionerOptions {
  /**
   * The project root — the directory `pithy.config.ts` was read from, and the base every
   * `@pithy-sh/vector` module is resolved against. Not derivable from `project`, which is a *name*;
   * see `project/kitResolve.ts` for why a resolution may not fall back to the CLI's own copy.
   */
  readonly projectDir: string;
  cf: CloudflareClients;
  accountId: string;
  /**
   * The project name, from `requireProjectName(await loadProject(projectDir))` — never
   * `resolveProjectName`. The deployed worker and the reprocess Workflow both lead with it, and a
   * guessed value dispatches into a Workflow name nothing deployed.
   */
  project: string;
  /** The bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  apiToken: string;
  /** The app's resolved vector config — the indexes to create and the config the worker is deployed with. */
  config: VectorConfig;
  /** Resolve the per-env app database id. Injected so it is testable and decoupled from wrangler parsing. */
  resolveEnv: ResolveVectorEnv;
  /** The Workflows REST client, for triggering a reprocess run in a deployed environment. */
  workflows: CloudflareWorkflowsClient;
  /** Sleep between metadata-index polls. Injected so tests run with no real delay. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the metadata-index budget is measured on, in ms. Injected so a test can run the budget out. */
  now?: () => number;
  /**
   * The Worker (by its apps/ directory) and environment this run acts on, which every command a refusal names
   * carries so it runs as written in a project with several Workers (#711). Absent for a feature's indexes,
   * whose refusals name the feature's own provisioning and no rebuild.
   */
  target?: { worker: WorkerDir; env: string; productionEnvironments: readonly string[] };
}

/**
 * The metadata indexes a wait was still on when it ran out. The last read's missing and mis-typed ones, or every
 * declared one when that read happened to list them all, short of the agreeing reads that make it live.
 */
function pending(last: MetadataIndexReport, declared: readonly MetadataIndexDescriptor[]): string {
  const unsettled = [...last.missing, ...last.mismatched];
  return (unsettled.length > 0 ? unsettled : declared).map((entry) => entry.propertyName).join(", ");
}

/** The live {@link VectorProvisioner}. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareVectorProvisioner implements VectorProvisioner {
  readonly #projectDir: string;
  readonly #cf: CloudflareClients;
  readonly #accountId: string;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #config: VectorConfig;
  readonly #resolveEnv: ResolveVectorEnv;
  readonly #workflows: CloudflareWorkflowsClient;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #target: { worker: WorkerDir; env: string; productionEnvironments: readonly string[] } | undefined;

  constructor(options: CloudflareVectorProvisionerOptions) {
    this.#projectDir = options.projectDir;
    this.#cf = options.cf;
    this.#accountId = options.accountId;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#config = options.config;
    this.#resolveEnv = options.resolveEnv;
    this.#workflows = options.workflows;
    this.#target = options.target;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  /**
   * The rebuild a shape refusal offers beside changing the config back (#711). A reset deletes every vector in the
   * index, so it is a person's decision, said as one — never a remedy an agent runs for one mis-shaped index. A
   * feature's index has no rebuild of its own: tearing the feature down takes every resource it owns and its
   * worktree with them, which is far more than the fault, so a feature is offered no command at all.
   */
  #orReset(): string {
    if (this.#target === undefined) return "";
    const { worker, env } = this.#target;
    return ` Rebuilding it from the document corpus is the other way: ${personDecision("vector reset", { flags: { "--worker": worker, "--env": env } })}`;
  }

  /** The provisioning run to repeat: this run's, for its Worker and environment, or a feature's own. */
  #provision(): Remedy {
    if (this.#target === undefined) return remedy("provision", { flags: { "--feature": true } });
    const { worker, env, productionEnvironments } = this.#target;
    return capabilityProvisionRemedy("vector", worker, env, productionEnvironments);
  }

  /** Require Vectorize access and a workers.dev subdomain — Cloudflare needs one to deploy a Workflow host. */
  async preflight(): Promise<void> {
    if (!(await this.#cf.vectorizeProvisioner().validateServiceAccess())) {
      throw new ValidationError({
        message: "This Cloudflare account cannot reach Vectorize.",
        action: "Vectorize needs a paid Workers plan, and the API token needs Vectorize Read and Write.",
      });
    }
    if (!(await this.#cf.workers().accountSubdomain())) {
      throw new ValidationError({
        message: "This Cloudflare account has no workers.dev subdomain, which Workflows require.",
        action: "Open Workers & Pages in the dashboard once to create one, then re-run.",
      });
    }
  }

  /** Reuse the index if it exists, otherwise create it. An index's shape is fixed, so a mismatch is fatal. */
  async ensureIndex(indexName: string, shape: VectorIndexShape): Promise<{ name: string }> {
    const existing = await this.#cf.vectorizeProvisioner().findIndexByName(indexName);
    if (existing) {
      if (existing.config.dimensions !== shape.dimensions || existing.config.metric !== shape.metric) {
        throw new ValidationError({
          message: `The \`${indexName}\` index already exists with a different shape.`,
          action: `Dimensions and metric are fixed when an index is created. Change the config back.${this.#orReset()}`,
          detail: `live ${existing.config.dimensions}/${existing.config.metric}, config ${shape.dimensions}/${shape.metric}`,
        });
      }
      return { name: existing.name };
    }
    const created = await this.#cf.vectorizeProvisioner().createIndex(indexName, shape);
    return { name: created.name };
  }

  /**
   * Create every declared metadata index that is missing, then wait until each one is live.
   *
   * The wait is the point. Cloudflare applies a metadata index asynchronously, and a vector written before it
   * lands is never covered by it — silently, with no error and no way back but a full re-embed. Returning
   * before the index is live would put the caller's very next step (deploying the worker that writes vectors)
   * inside that window.
   *
   * Live means {@link METADATA_STABLE_READS} reads in a row that list every declared index under its own name
   * and type, inside {@link METADATA_SETTLE_BUDGET_MS}. A re-run confirms the same way, because a re-run is
   * what the not-live-yet error asks for, and its answer is what the operator writes vectors on.
   */
  async ensureMetadataIndexes(
    indexName: string,
    declared: readonly MetadataIndexDescriptor[],
  ): Promise<MetadataIndexReport> {
    const { compareMetadataIndexes } = await loadVector(this.#projectDir);
    const provisioner = this.#cf.vectorizeProvisioner();
    const read = async () => compareMetadataIndexes(declared, await provisioner.listMetadataIndexes(indexName));
    const live = (report: MetadataIndexReport) => report.missing.length === 0 && report.mismatched.length === 0;

    const before = await read();
    if (before.mismatched.length > 0) {
      throw new ValidationError({
        message: `A metadata index on \`${indexName}\` was created with a different type.`,
        action: `A metadata index's type is fixed. Change the field's type back in the index's metadata schema.${this.#orReset()}`,
        detail: before.mismatched
          .map((entry) => `${entry.propertyName}: declared ${entry.declared}, indexed as ${entry.live}`)
          .join("; "),
      });
    }

    for (const descriptor of before.missing) {
      try {
        await provisioner.createMetadataIndex(indexName, descriptor.propertyName, descriptor.indexType);
      } catch (error) {
        // The list can miss an index that exists, so a re-run can ask for one the last run's create already
        // made. Cloudflare's answer to that is not something this code matches on: an index listed under its
        // own name and type right after the refusal is that earlier create, and the wait below confirms it.
        // Anything else is Cloudflare's refusal, and it stands.
        const now = await provisioner.listMetadataIndexes(indexName);
        const landed = now.some(
          (entry) => entry.propertyName === descriptor.propertyName && entry.indexType === descriptor.indexType,
        );
        if (!landed) throw error;
      }
    }

    const started = this.#now();
    let last = before;
    let agreed = live(before) ? 1 : 0;
    while (agreed < METADATA_STABLE_READS) {
      if (this.#now() - started >= METADATA_SETTLE_BUDGET_MS) {
        throw new InternalError({
          message: `The metadata indexes on \`${indexName}\` were accepted but are not live yet.`,
          action: `${this.#provision().say((command) => `Re-run \`${command}\` in a minute.`)} Do not write vectors until it reports them ready.`,
          detail: `waited ${Math.round((this.#now() - started) / 1000)}s for ${pending(last, declared)}`,
        });
      }
      await this.#sleep(METADATA_POLL_INTERVAL_MS);
      last = await read();
      agreed = live(last) ? agreed + 1 : 0;
    }
    return { ...last, missing: [...before.missing] };
  }

  /** Resolve the env's wrangler config from the committed template + provisioned ids, then `wrangler deploy`. */
  async deployWorker(env: string, indexNames: Record<string, string>): Promise<void> {
    const { resolveVectorConfig } = await loadVector(this.#projectDir);
    const { appDatabaseId } = await this.#resolveEnv(env);
    const dir = await vectorWorkerDir(this.#projectDir);
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolveVectorConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      indexNames,
      config: this.#config,
    });

    // **The gate, inherited rather than opted into (#537).** `deployHostWorker` stamps the resolved
    // config with this package's version and a hash of the config itself, compares that against what
    // the deployed Worker carries, and ships only when they differ. A first provision has no stamp, so
    // it deploys. Anything it cannot establish — no Worker, no stamp, an unreachable account — deploys
    // too: a false redeploy costs seconds, a false skip is silent.
    await deployHostWorker({
      capability: "vector",
      pkg: "@pithy-sh/vector",
      version: await kitPackageVersion(this.#projectDir, "@pithy-sh/vector"),
      config,
      dir,
      env,
      readVars: (script) => this.#cf.workers().getWorkerVars(script),
      account: { accountId: this.#accountId, apiToken: this.#apiToken },
    });
  }

  /** Delete an index. Destructive, and idempotent — a missing index is a no-op. */
  async deleteIndex(indexName: string): Promise<void> {
    await this.#cf.vectorizeProvisioner().deleteIndex(indexName);
  }

  /** Trigger the deployed reprocess Workflow for this environment and wait for it to finish. */
  async reprocess(
    env: string,
    index: string,
    options: { all?: boolean; filter?: Record<string, unknown> },
  ): Promise<unknown> {
    const { VECTOR_CAPABILITY } = await loadVector(this.#projectDir);
    const name = resourceNames(this.#project).env(env).workflow(VECTOR_CAPABILITY, "reprocess");
    return this.#workflows.dispatchAndPoll(name, {
      index,
      ...(options.all !== undefined ? { all: options.all } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
    });
  }
}

/**
 * **A feature's own Vectorize indexes, created the way `pithy vector provision` creates an environment's (#643)** —
 * through {@link CloudflareVectorProvisioner}'s own `ensureIndex` and `ensureMetadataIndexes`, so a feature's
 * index has the declared shape and every declared metadata index before anything writes a vector to it. Only
 * those two steps and the delete are used: the vector host itself deploys with the feature's other kit Workers.
 */
export function cloudflareFeatureIndexes(options: {
  projectDir: string;
  cf: CloudflareClients;
  accountId: string;
  apiToken: string;
  project: string;
  workflows: CloudflareWorkflowsClient;
}): FeatureIndexes {
  const provisioner = new CloudflareVectorProvisioner({
    ...options,
    // Read only by the deploy and reprocess steps, which a feature never runs through this provisioner.
    config: { indexes: {} } as unknown as VectorConfig,
    resolveEnv: async () => {
      throw new InternalError({
        message: "A feature's vector host is deployed with its other kit Workers.",
        detail: "cloudflareFeatureIndexes: resolveEnv is not part of a feature run",
      });
    },
  });
  return {
    ensure: async (index) => {
      await provisioner.ensureIndex(index.name, { dimensions: index.dimensions, metric: index.metric });
      await provisioner.ensureMetadataIndexes(index.name, index.metadata as MetadataIndexDescriptor[]);
    },
    remove: async (name) => {
      if (!(await options.cf.vectorizeProvisioner().findIndexByName(name))) return false;
      await provisioner.deleteIndex(name);
      return true;
    },
  };
}
