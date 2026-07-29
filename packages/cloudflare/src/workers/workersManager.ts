import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { Cloudflare } from "cloudflare";
import type { RouteCreateResponse, RouteListResponse } from "cloudflare/resources/workers/routes";
import type { Deployment } from "cloudflare/resources/workers/scripts/deployments";
import type { Script } from "cloudflare/resources/workers/scripts/scripts";
import type { SecretListResponse } from "cloudflare/resources/workers/scripts/secrets";
import type { SettingEditParams } from "cloudflare/resources/workers/scripts/settings";
import type { VersionGetResponse, VersionListResponse } from "cloudflare/resources/workers/scripts/versions";
import { cloudflareRequest, messageOf } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** Per-call SDK timeout + retry budget for Worker management operations. */
const requestOptions: Cloudflare.RequestOptions = { timeout: 10000, maxRetries: 3 };

/**
 * The placeholder module uploaded when a Worker script is first created. A Worker upload requires
 * at least one module file plus `main_module` pointing at it; the real build output replaces this
 * via a later version upload. This stub returns 503 while the worker is being provisioned.
 */
const PLACEHOLDER_MODULE = "index.js";
const PLACEHOLDER_BODY =
  "export default { async fetch() { return new Response('Provisioning...', { status: 503 }); } };";

/** Worker settings a caller may edit (observability, logpush, tags, …); the account id is supplied. */
export type WorkerSettings = Omit<SettingEditParams, "account_id">;

/**
 * Out-of-Worker Workers access over the REST API: script create/list/delete, subdomain + settings,
 * versions, deployments, secrets, and routes from a CLI/CI/provisioning context. Inside a Worker you
 * manage scripts through wrangler/bindings; this manager is the REST counterpart, addressed by
 * account (and zone, for routes).
 */
export class CloudflareWorkersManager extends CloudflareManager {
  /** List every Worker script on the account. */
  async listWorkers(): Promise<Script[]> {
    return cloudflareRequest("list workers", async () => {
      const scripts: Script[] = [];
      for await (const script of this.getClient().workers.scripts.list({ account_id: this.accountId })) {
        scripts.push(script);
      }
      return scripts;
    });
  }

  /** Find a Worker script by name. Returns null when none matches. */
  async getWorker(scriptName: string): Promise<Script | null> {
    const scripts = await this.listWorkers();
    return scripts.find((script) => script.id === scriptName) ?? null;
  }

  /**
   * Resolve a Worker's immutable `id` (the hex UUID) from the beta `/workers/workers` endpoint. CF
   * Builds' `external_script_id` uses this immutable id, not the worker name. This is an explicit
   * get: it throws `core/not_found` when no worker on the account carries the given name.
   */
  async getWorkerInternalId(workerName: string): Promise<string> {
    return cloudflareRequest(`get worker internal id for '${workerName}'`, async () => {
      for await (const worker of this.getClient().workers.beta.workers.list({ account_id: this.accountId })) {
        if (worker.name === workerName) return worker.id;
      }
      throw new NotFoundError({
        message: `No Worker named '${workerName}' exists on the account.`,
        detail: `Beta workers list returned no entry with name '${workerName}'.`,
      });
    });
  }

  /**
   * Create (upload) a Worker script with a placeholder module. The real build output replaces it via
   * a later version upload. `metadata` is merged into the script's metadata.
   */
  async createWorker(scriptName: string, metadata: Record<string, unknown> = {}): Promise<Script> {
    return cloudflareRequest(`create worker '${scriptName}'`, () => {
      const placeholderFile = new File([PLACEHOLDER_BODY], PLACEHOLDER_MODULE, {
        type: "application/javascript+module",
      });
      return this.getClient().workers.scripts.update(
        scriptName,
        {
          account_id: this.accountId,
          metadata: { ...metadata, main_module: PLACEHOLDER_MODULE, compatibility_date: "2026-04-07" },
          files: [placeholderFile],
        },
        requestOptions,
      );
    });
  }

  /**
   * Configure the workers.dev subdomain and preview URLs for a script. Both are controlled by the
   * same endpoint — `previews_enabled` is always sent explicitly so CF does not default it to true.
   */
  async setSubdomainSettings(scriptName: string, enabled: boolean, previewsEnabled = false): Promise<void> {
    await cloudflareRequest(`set subdomain settings for '${scriptName}'`, () =>
      this.getClient().workers.scripts.subdomain.create(scriptName, {
        account_id: this.accountId,
        enabled,
        previews_enabled: previewsEnabled,
      }),
    );
  }

  /** Edit a Worker's settings (observability, logpush, tags, …). */
  async updateSettings(scriptName: string, settings: WorkerSettings): Promise<void> {
    await cloudflareRequest(`update settings for '${scriptName}'`, () =>
      this.getClient().workers.scripts.settings.edit(scriptName, { account_id: this.accountId, ...settings }),
    );
  }

  /** Delete a Worker script. */
  async deleteWorker(scriptName: string): Promise<void> {
    await cloudflareRequest(`delete worker '${scriptName}'`, () =>
      this.getClient().workers.scripts.delete(scriptName, { account_id: this.accountId }, requestOptions),
    );
  }

  /** List every version of a Worker script. */
  async listVersions(scriptName: string): Promise<VersionListResponse[]> {
    return cloudflareRequest(`list versions for '${scriptName}'`, async () => {
      const versions: VersionListResponse[] = [];
      for await (const version of this.getClient().workers.scripts.versions.list(scriptName, {
        account_id: this.accountId,
      })) {
        versions.push(version);
      }
      return versions;
    });
  }

  /** Get one version of a Worker script. */
  async getVersion(scriptName: string, versionId: string): Promise<VersionGetResponse> {
    return cloudflareRequest(`get version '${versionId}' for '${scriptName}'`, () =>
      this.getClient().workers.scripts.versions.get(
        versionId,
        { account_id: this.accountId, script_name: scriptName },
        requestOptions,
      ),
    );
  }

  /** List a Worker script's deployments. Empty when none exist. */
  async listDeployments(scriptName: string): Promise<Deployment[]> {
    return cloudflareRequest(`list deployments for '${scriptName}'`, async () => {
      const result = await this.getClient().workers.scripts.deployments.list(
        scriptName,
        { account_id: this.accountId },
        requestOptions,
      );
      return result.deployments ?? [];
    });
  }

  /** Get one deployment of a Worker script. */
  async getDeployment(scriptName: string, deploymentId: string): Promise<Deployment> {
    return cloudflareRequest(`get deployment '${deploymentId}' for '${scriptName}'`, () =>
      this.getClient().workers.scripts.deployments.get(
        deploymentId,
        { account_id: this.accountId, script_name: scriptName },
        requestOptions,
      ),
    );
  }

  /** Deploy a version to 100% of traffic for a Worker script. */
  async createDeployment(scriptName: string, versionId: string): Promise<Deployment> {
    return cloudflareRequest(`create deployment for '${scriptName}'`, () =>
      this.getClient().workers.scripts.deployments.create(
        scriptName,
        {
          account_id: this.accountId,
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: versionId }],
        },
        requestOptions,
      ),
    );
  }

  /** Set a secret on a Worker script. */
  async addSecret(scriptName: string, name: string, value: string): Promise<void> {
    await cloudflareRequest(`add secret '${name}' to '${scriptName}'`, () =>
      this.getClient().workers.scripts.secrets.update(
        scriptName,
        { account_id: this.accountId, name, text: value, type: "secret_text" },
        requestOptions,
      ),
    );
  }

  /** Delete a secret from a Worker script. */
  async deleteSecret(scriptName: string, secretName: string): Promise<void> {
    await cloudflareRequest(`delete secret '${secretName}' from '${scriptName}'`, () =>
      this.getClient().workers.scripts.secrets.delete(
        secretName,
        { account_id: this.accountId, script_name: scriptName },
        requestOptions,
      ),
    );
  }

  /** List a Worker script's secrets. */
  async listSecrets(scriptName: string): Promise<SecretListResponse[]> {
    return cloudflareRequest(`list secrets for '${scriptName}'`, async () => {
      const secrets: SecretListResponse[] = [];
      for await (const secret of this.getClient().workers.scripts.secrets.list(scriptName, {
        account_id: this.accountId,
      })) {
        secrets.push(secret);
      }
      return secrets;
    });
  }

  /**
   * Create a Workers Route on a zone, mapping a hostname pattern to a script. Idempotent: returns the
   * existing route when one with the same pattern is already present on the zone.
   */
  async addRoute(
    zoneId: string,
    pattern: string,
    scriptName: string,
  ): Promise<RouteCreateResponse | RouteListResponse> {
    const existing = await this.getRoute(zoneId, pattern);
    if (existing) return existing;
    return cloudflareRequest(`add worker route '${pattern}'`, () =>
      this.getClient().workers.routes.create({ zone_id: zoneId, pattern, script: scriptName }, requestOptions),
    );
  }

  /** Find a Workers Route on a zone by its pattern. Returns null when none matches. */
  async getRoute(zoneId: string, pattern: string): Promise<RouteListResponse | null> {
    return cloudflareRequest(`get worker route '${pattern}'`, async () => {
      for await (const route of this.getClient().workers.routes.list({ zone_id: zoneId })) {
        if (route.pattern === pattern) return route;
      }
      return null;
    });
  }

  /** Delete a Workers Route from a zone. */
  async removeRoute(zoneId: string, routeId: string): Promise<void> {
    await cloudflareRequest(`remove worker route '${routeId}'`, () =>
      this.getClient().workers.routes.delete(routeId, { zone_id: zoneId }, requestOptions),
    );
  }

  /** Resolve a queue's id (UUID) from its name. Returns null when no queue on the account matches. */
  async findQueueIdByName(queueName: string): Promise<string | null> {
    return cloudflareRequest(`find queue '${queueName}'`, async () => {
      for await (const queue of this.getClient().queues.list({ account_id: this.accountId })) {
        if (queue.queue_name === queueName) return queue.queue_id ?? null;
      }
      return null;
    });
  }

  /**
   * Subscribe a queue to a Worker's Builds lifecycle events (started/succeeded/failed/canceled).
   * Idempotent: a CF "already exists" conflict (405 "multiple subscriptions", or 409 "already
   * exists") is treated as success rather than re-thrown.
   */
  async subscribeBuildEvents(subscriptionName: string, queueId: string, workerName: string): Promise<void> {
    await cloudflareRequest(`subscribe build events for '${workerName}'`, async () => {
      try {
        await this.getClient().queues.subscriptions.create({
          account_id: this.accountId,
          name: subscriptionName,
          destination: { type: "queues.queue", queue_id: queueId },
          source: { type: "workersBuilds.worker", worker_name: workerName },
          events: ["build.started", "build.succeeded", "build.failed", "build.canceled"],
        });
      } catch (error) {
        const message = messageOf(error);
        // CF returns 405 "multiple subscriptions on the same resource" (or 409 "already exists" on
        // older envs) when a subscription is already present. Treat that as success — idempotent.
        if (/\b409\b/.test(message) || /already exists/i.test(message) || /multiple subscriptions/i.test(message)) {
          return;
        }
        throw error;
      }
    });
  }

  /**
   * The account's `workers.dev` subdomain, or `null` if none is registered. Deploying a Worker that
   * hosts Workflows requires the account to have one (a one-time account bootstrap), so provisioning
   * checks this up front. The CF API returns a 404-style error when absent; that maps to `null`.
   */
  async accountSubdomain(): Promise<string | null> {
    try {
      const result = await this.getClient().workers.subdomains.get({ account_id: this.accountId });
      return result.subdomain ?? null;
    } catch {
      return null;
    }
  }

  getServiceType(): string {
    return "Cloudflare Workers";
  }

  /** Prove access by listing the account's Workers. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().workers.scripts.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }
}
