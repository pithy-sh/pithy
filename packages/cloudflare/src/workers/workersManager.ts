// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Cloudflare } from "cloudflare";
import type { RouteCreateResponse, RouteListResponse } from "cloudflare/resources/workers/routes";
import type { Deployment } from "cloudflare/resources/workers/scripts/deployments";
import type { Script } from "cloudflare/resources/workers/scripts/scripts";
import type { SecretListResponse } from "cloudflare/resources/workers/scripts/secrets";
import type { SettingEditParams } from "cloudflare/resources/workers/scripts/settings";
import type { VersionGetResponse, VersionListResponse } from "cloudflare/resources/workers/scripts/versions";
import { CloudflareInvalidResponseError, cloudflareRequest, messageOf } from "../client/errors";
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

/**
 * An ISO date, the only spelling a compatibility date has. Refused here so a typo is a `ValidationError`
 * naming the argument rather than a 400 from Cloudflare naming the request.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The content type every module part carries. ES modules only — see {@link WorkerModule}. */
const MODULE_CONTENT_TYPE = "application/javascript+module";

/** Worker settings a caller may edit (observability, logpush, tags, …); the account id is supplied. */
export type WorkerSettings = Omit<SettingEditParams, "account_id">;

/**
 * One ES-module file of a Worker upload.
 *
 * **ES modules only.** `name` becomes both the multipart part name and the upload's `main_module`,
 * and the part is sent as `application/javascript+module`. Classic service-worker scripts — the
 * `body_part` shape, with a global `addEventListener("fetch", …)` — are not supported by this
 * manager and never were: every upload it has ever sent set `main_module`. {@link
 * CloudflareWorkersManager.createWorker} refuses a `body_part` in metadata rather than sending a
 * request with both shapes half-declared.
 */
export interface WorkerModule {
  /** The module's filename, e.g. `index.js`. Becomes the part name and the upload's `main_module`. */
  name: string;
  /** The module's ES-module source, uploaded verbatim as `application/javascript+module`. */
  body: string;
}

/** The placeholder module `createWorker` uploads when the caller supplies none. */
const PLACEHOLDER: WorkerModule = { name: PLACEHOLDER_MODULE, body: PLACEHOLDER_BODY };

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
   * Create (upload) a Worker script. With no `module` the placeholder above is uploaded and the real
   * build output replaces it via a later version upload; pass one to upload real source. `metadata`
   * is merged into the upload's metadata — bindings, compatibility flags, tags — and this method
   * fixes `main_module`.
   *
   * **`compatibilityDate` is required, and there is no default (#396).** This method used to supply
   * `2026-04-07` when the caller named none, which is one date below the floor `compatibility.ts`
   * holds every other Worker in this repository to, and the one date #388's gate could not reach —
   * because it is TypeScript rather than a `wrangler.jsonc`, and the gate reads manifests.
   *
   * Moving it to the floor was the obvious answer and it is the wrong one. **A compatibility date is a
   * behavior contract, not a version number** — it is the date workerd pretends it is — and this one
   * lands on Workers in accounts that are not ours. Re-picking the number changes what an existing
   * caller's Workers run, silently, for somebody who never asked; and the new number is stale on
   * exactly the schedule the old one was, with the same gate unable to see it. `compatibility.ts` makes
   * that argument about `2026-03-03` in as many words: *the minimum that fixes the last bug is exactly
   * the number `2025-01-01` once was.*
   *
   * Requiring the date removes the class instead of re-picking the number, which is the move #377, #366
   * and #394 each took. It is also the cheaper break: a caller who wanted `2026-04-07` writes
   * `2026-04-07` and gets precisely what they had, and everyone else finds out at compile time rather
   * than from a behavior change in production. `WorkersProvisioner` already promised this — *"it
   * carries no environment- or product-specific defaults — every name, command, and env var is supplied
   * by the caller"* — and the manager under it was the one place that was untrue.
   *
   * `metadata` may **not** also carry `compatibility_date`. Two ways to state one contract is a
   * precedence rule to remember, and this method exists to have one statement rather than two.
   *
   * **The multipart request is built here rather than through `workers.scripts.update`, and that is
   * a fix rather than a preference (#373).** The typed SDK's `update` pins
   * `Content-Type: application/javascript` on the request and *then* lets its uploader turn the body
   * into `FormData`. Cloudflare believes the header, parses the multipart envelope as a classic
   * service-worker script, and rejects every upload with `10021 Uncaught SyntaxError: Invalid
   * left-hand side expression in prefix operation at worker.js:1:4` — the leading `------WebKit…`
   * boundary read as prefix `--` operators. Its form is wrong twice over besides: metadata is
   * flattened to `metadata[main_module]` fields instead of one JSON part, and the module is appended
   * as `files[]` rather than under the filename `main_module` names. So the form is assembled here
   * and handed to the SDK's own `put`, which keeps auth, retries, timeout and error mapping intact.
   */
  async createWorker(
    scriptName: string,
    compatibilityDate: string,
    metadata: Record<string, unknown> = {},
    module: WorkerModule = PLACEHOLDER,
  ): Promise<Script> {
    if ("body_part" in metadata) {
      throw new ValidationError({
        message: "This client uploads ES-module Workers only.",
        action: "Remove `body_part` from the metadata and pass the script as a module.",
        detail: `createWorker('${scriptName}') was given a 'body_part', the classic service-worker shape. Every upload sets 'main_module'.`,
      });
    }

    if ("compatibility_date" in metadata) {
      throw new ValidationError({
        message: "A Worker's compatibility date is named once, as an argument.",
        action: "Remove `compatibility_date` from the metadata and pass it as the second argument.",
        detail: `createWorker('${scriptName}') was given a 'compatibility_date' in metadata as well as an argument. Two statements of one behavior contract is a precedence rule nobody should have to know.`,
      });
    }

    if (!ISO_DATE.test(compatibilityDate)) {
      throw new ValidationError({
        message: "A compatibility date is an ISO date, like 2026-06-01.",
        action: "Pass the date as YYYY-MM-DD.",
        detail: `createWorker('${scriptName}') was given the compatibility date '${compatibilityDate}'.`,
      });
    }

    const form = new FormData();
    form.append(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            ...metadata,
            compatibility_date: compatibilityDate,
            main_module: module.name,
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.append(module.name, new Blob([module.body], { type: MODULE_CONTENT_TYPE }), module.name);

    return cloudflareRequest(`create worker '${scriptName}'`, async () => {
      const envelope = await this.getClient().put<{ result: Script | null }>(
        `/accounts/${this.accountId}/workers/scripts/${scriptName}`,
        { body: form, ...requestOptions },
      );
      if (!envelope.result) {
        throw new CloudflareInvalidResponseError({
          message: "Cloudflare accepted the Worker upload but returned no script.",
          detail: `Upload of '${scriptName}' returned a success envelope with a null result.`,
        });
      }
      return envelope.result;
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
