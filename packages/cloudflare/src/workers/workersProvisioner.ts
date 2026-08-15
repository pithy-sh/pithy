// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareNotConfiguredError } from "../client/errors";
import type { CloudflareManagerConfig } from "../client/manager";
import { CloudflareBuildsManager } from "./buildsManager";
import type { CfRepoConnection, CfTriggerEnvVar } from "./buildsTypes";
import { CloudflareWorkersManager, type WorkerSettings } from "./workersManager";

/** Describes the git repo a build trigger should clone, in provider-neutral terms. */
export interface BuildRepo {
  /** The git provider hosting the repo. */
  providerType: "gitlab" | "github";
  /** The repository's id in the git provider. */
  repoId: string;
  /** The repo path relative to the provider account. */
  repoName: string;
  /** The provider account identifier (e.g. 'group:15366484'). */
  providerAccountId: string;
  /** The provider account display name. */
  providerAccountName: string;
}

/** Everything `setupBuildTrigger` needs, all caller-supplied — no environment-specific defaults. */
export interface BuildTriggerSetup {
  /** The Worker the trigger builds, by name (resolved to its immutable id internally). */
  workerName: string;
  /** The repo to clone. */
  repo: BuildRepo;
  /** The build token UUID the trigger authenticates with. */
  buildTokenUuid: string;
  /** The trigger's human-readable name. */
  triggerName: string;
  /** Branch patterns that auto-fire the trigger (must be non-empty). */
  branchIncludes: string[];
  /** The shell command that builds the Worker. */
  buildCommand: string;
  /** The shell command CF Builds runs to deploy after a build. */
  deployCommand: string;
  /** Environment variables to set on the trigger. */
  envVars?: CfTriggerEnvVar[];
}

/**
 * Provisions Cloudflare Workers infrastructure over the REST API: create a Worker, set its secrets,
 * wire a CF Builds trigger to a repo, register a Workers Route, and subscribe a queue to build
 * events. A thin orchestrator over `CloudflareWorkersManager` + `CloudflareBuildsManager`.
 *
 * Each method is a discrete, idempotent step so a caller (e.g. a Workflow) can resume from the point
 * of failure rather than from scratch. It carries no environment- or product-specific defaults —
 * every name, command, and env var is supplied by the caller.
 */
export class WorkersProvisioner {
  private readonly workers: CloudflareWorkersManager;

  private readonly builds: CloudflareBuildsManager;

  constructor(config: CloudflareManagerConfig) {
    this.workers = new CloudflareWorkersManager(config);
    this.builds = new CloudflareBuildsManager(config);
  }

  /**
   * Create the Worker script, enable its workers.dev subdomain, and turn on observability. Returns
   * the created script's id. workers.dev must be enabled via a separate call after script creation.
   */
  async createWorker(workerName: string, metadata: Record<string, unknown> = {}): Promise<string> {
    const script = await this.workers.createWorker(workerName, metadata);
    if (!script.id) {
      throw new CloudflareNotConfiguredError({
        message: `Worker '${workerName}' was created but returned no script id.`,
        detail: "The Worker upload returned a script with no id.",
      });
    }
    await this.workers.setSubdomainSettings(workerName, true, false);
    await this.workers.updateSettings(workerName, { observability: { enabled: true } } as WorkerSettings);
    return script.id;
  }

  /** Resolve the immutable hex id ("external_script_id") for a worker, stable across renames. */
  async getWorkerInternalId(workerName: string): Promise<string> {
    return this.workers.getWorkerInternalId(workerName);
  }

  /** Set a secret on a worker. */
  async addWorkerSecret(workerName: string, key: string, value: string): Promise<void> {
    await this.workers.addSecret(workerName, key, value);
  }

  /**
   * Create the CF Builds repo connection + trigger and set its env vars, returning the trigger UUID.
   * Idempotent — `createRepoConnection` is CF's upsert and `upsertTrigger` reconciles an existing
   * trigger. The trigger is keyed on the worker's immutable internal id (resolved here), not its name.
   */
  async setupBuildTrigger(setup: BuildTriggerSetup): Promise<string> {
    const repoConnection = await this.builds.createRepoConnection({
      providerType: setup.repo.providerType,
      repoId: setup.repo.repoId,
      repoName: setup.repo.repoName,
      providerAccountId: setup.repo.providerAccountId,
      providerAccountName: setup.repo.providerAccountName,
    });

    const externalScriptId = await this.workers.getWorkerInternalId(setup.workerName);

    const trigger = await this.builds.upsertTrigger({
      scriptName: externalScriptId,
      repoConnectionId: repoConnection.repo_connection_uuid,
      buildTokenUuid: setup.buildTokenUuid,
      triggerName: setup.triggerName,
      branchIncludes: setup.branchIncludes,
      pathIncludes: ["*"],
      buildCommand: setup.buildCommand,
      deployCommand: setup.deployCommand,
    });

    if (setup.envVars && setup.envVars.length > 0) {
      await this.builds.upsertTriggerEnvVars(trigger.trigger_uuid, setup.envVars);
    }

    return trigger.trigger_uuid;
  }

  /** Create (or upsert) only the repo connection. Useful when a caller manages the trigger itself. */
  async setupRepoConnection(repo: BuildRepo): Promise<CfRepoConnection> {
    return this.builds.createRepoConnection({
      providerType: repo.providerType,
      repoId: repo.repoId,
      repoName: repo.repoName,
      providerAccountId: repo.providerAccountId,
      providerAccountName: repo.providerAccountName,
    });
  }

  /**
   * Register a Workers Route on a zone mapping `${hostname}/*` to the worker. Idempotent. Returns the
   * route id (empty string when CF returns a route without one).
   */
  async setupWorkerRoute(zoneId: string, workerName: string, hostname: string): Promise<string> {
    const record = await this.workers.addRoute(zoneId, `${hostname}/*`, workerName);
    return record.id ?? "";
  }

  /**
   * Subscribe a named queue to the worker's Builds lifecycle events. Resolves the queue's id from its
   * name first; throws `cloudflare/not_configured` when the queue does not exist. Idempotent.
   */
  async setupBuildEventSubscription(workerName: string, queueName: string): Promise<void> {
    const queueId = await this.workers.findQueueIdByName(queueName);
    if (!queueId) {
      throw new CloudflareNotConfiguredError({
        message: `Queue '${queueName}' was not found on the account.`,
        action: "Create the queue before provisioning build event subscriptions.",
        detail: `No queue named '${queueName}' on the account.`,
      });
    }
    await this.workers.subscribeBuildEvents(`build-events-${workerName}`, queueId, workerName);
  }
}
