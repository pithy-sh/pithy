// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
import { kitSource } from "../project/kitSource";
import { runWrangler } from "../project/wrangler";
import { capabilityLoadError } from "./loadFailure";

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
 * with a bounded retry rather than reading back what it just wrote.
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
export async function loadVector(): Promise<VectorModule> {
  try {
    const [provision, resolve, capability, drift, provisioned, specs] = await Promise.all([
      import("@pithy-sh/vector/src/provision/provisionVector"),
      import("@pithy-sh/vector/src/provision/resolveVectorConfig"),
      import("@pithy-sh/vector/src/capability"),
      import("@pithy-sh/vector/src/index/drift"),
      import("@pithy-sh/vector/src/index/provisioned"),
      import("@pithy-sh/vector/src/workflows/specs"),
    ]);
    return { ...provision, ...resolve, ...capability, ...drift, ...provisioned, ...specs };
  } catch (error) {
    throw capabilityLoadError("vector", "@pithy-sh/vector", error);
  }
}

/** The directory of the prebuilt vector worker inside the installed package (holds `wrangler.jsonc`). */
async function vectorWorkerDir(): Promise<string> {
  try {
    return dirname(kitSource("@pithy-sh/vector/src/workflows/worker"));
  } catch (error) {
    throw capabilityLoadError("vector", "@pithy-sh/vector/src/workflows/worker", error);
  }
}

/** Resolve the app database id for an environment — where the document corpus lives. */
export type ResolveVectorEnv = (env: string) => Promise<{ appDatabaseId: string }>;

/** How long to wait for an accepted metadata index to become visible, and how often to look. */
const METADATA_POLL_ATTEMPTS = 10;
const METADATA_POLL_INTERVAL_MS = 1_000;

export interface CloudflareVectorProvisionerOptions {
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
}

/** The live {@link VectorProvisioner}. Every step is idempotent, so provisioning is safe to re-run. */
export class CloudflareVectorProvisioner implements VectorProvisioner {
  readonly #cf: CloudflareClients;
  readonly #accountId: string;
  readonly #project: string;
  readonly #apiToken: string;
  readonly #config: VectorConfig;
  readonly #resolveEnv: ResolveVectorEnv;
  readonly #workflows: CloudflareWorkflowsClient;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: CloudflareVectorProvisionerOptions) {
    this.#cf = options.cf;
    this.#accountId = options.accountId;
    this.#project = options.project;
    this.#apiToken = options.apiToken;
    this.#config = options.config;
    this.#resolveEnv = options.resolveEnv;
    this.#workflows = options.workflows;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
          action:
            "Dimensions and metric are fixed when an index is created. Change the config back, or run `pithy vector reset` to rebuild the index from the document corpus.",
          detail: `live ${existing.config.dimensions}/${existing.config.metric}, config ${shape.dimensions}/${shape.metric}`,
        });
      }
      return { name: existing.name };
    }
    const created = await this.#cf.vectorizeProvisioner().createIndex(indexName, shape);
    return { name: created.name };
  }

  /**
   * Create every declared metadata index that is missing, then wait until each one is visible.
   *
   * The wait is the point. Cloudflare applies a metadata index asynchronously, and a vector written before it
   * lands is never covered by it — silently, with no error and no way back but a full re-embed. Returning
   * before the index is live would put the caller's very next step (deploying the worker that writes vectors)
   * inside that window.
   */
  async ensureMetadataIndexes(
    indexName: string,
    declared: readonly MetadataIndexDescriptor[],
  ): Promise<MetadataIndexReport> {
    const { compareMetadataIndexes } = await loadVector();
    const provisioner = this.#cf.vectorizeProvisioner();

    const before = compareMetadataIndexes(declared, await provisioner.listMetadataIndexes(indexName));
    if (before.mismatched.length > 0) {
      throw new ValidationError({
        message: `A metadata index on \`${indexName}\` was created with a different type.`,
        action:
          "A metadata index's type is fixed. Change the field's type back in the index's metadata schema, or run `pithy vector reset` to rebuild the index.",
        detail: before.mismatched
          .map((entry) => `${entry.propertyName}: declared ${entry.declared}, indexed as ${entry.live}`)
          .join("; "),
      });
    }
    if (before.missing.length === 0) return before;

    for (const descriptor of before.missing) {
      await provisioner.createMetadataIndex(indexName, descriptor.propertyName, descriptor.indexType);
    }

    for (let attempt = 0; attempt < METADATA_POLL_ATTEMPTS; attempt += 1) {
      await this.#sleep(METADATA_POLL_INTERVAL_MS);
      const now = compareMetadataIndexes(declared, await provisioner.listMetadataIndexes(indexName));
      if (now.missing.length === 0) return { ...now, missing: [...before.missing] };
    }

    throw new InternalError({
      message: `The metadata indexes on \`${indexName}\` were accepted but are not live yet.`,
      action: "Re-run `pithy vector provision` in a minute. Do not write vectors until it reports them ready.",
      detail: `waited ${(METADATA_POLL_ATTEMPTS * METADATA_POLL_INTERVAL_MS) / 1000}s for ${before.missing
        .map((entry) => entry.propertyName)
        .join(", ")}`,
    });
  }

  /** Resolve the env's wrangler config from the committed template + provisioned ids, then `wrangler deploy`. */
  async deployWorker(env: string, indexNames: Record<string, string>): Promise<void> {
    const { resolveVectorConfig } = await loadVector();
    const { appDatabaseId } = await this.#resolveEnv(env);
    const dir = await vectorWorkerDir();
    const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
    const config = resolveVectorConfig(template, {
      project: this.#project,
      env,
      appDatabaseId,
      indexNames,
      config: this.#config,
    });

    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: this.#apiToken, CLOUDFLARE_ACCOUNT_ID: this.#accountId },
      });
    } finally {
      await unlink(configPath).catch(() => {});
    }
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
    const { VECTOR_CAPABILITY } = await loadVector();
    const name = resourceNames(this.#project).env(env).workflow(VECTOR_CAPABILITY, "reprocess");
    return this.#workflows.dispatchAndPoll(name, {
      index,
      ...(options.all !== undefined ? { all: options.all } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
    });
  }
}
