// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { MediaConfig } from "../config/config";
import { MEDIA_CAPABILITY, mediaWorkflowRegistry } from "../workflows/specs";
import type { MediaResources } from "./provisionMedia";

/**
 * Resolve the media worker's committed `wrangler.jsonc` template into one environment's standalone
 * config. Every per-environment decision lives here; everything static — the compatibility date, the AI
 * binding, the four Workflow class names — stays as the template committed it.
 *
 * Thin over core's {@link resolveWorkflowHost}: the generic resolver owns the mechanics (clone, fill by
 * binding name, stamp the worker's identity as `ENVIRONMENT` + `PROJECT`), and this file owns only what
 * is media's — which bindings map to which provisioned resource, the Workflow names derived from
 * media's own specs, and the serialized config the worker parses. Pure: the caller parses the template
 * and writes the result.
 *
 * `PROJECT` matters more here than anywhere else the resolver is used: media is the one capability that
 * creates Cloudflare Images and Stream assets, and those two stores are account-flat with
 * Cloudflare-minted ids, so the var is what the ownership metadata on each asset is written from.
 */

/** The resolved resource ids + per-env values for one environment's media-worker deploy. */
export interface MediaConfigParams {
  /**
   * The project name — the `<project>` segment the deployed worker and its four Workflow names lead
   * with. The root `pithy.config.ts` `name`, resolved by `requireProjectName` and never guessed:
   * Worker script and Workflow names are account-scoped, so a wrong value overwrites another
   * project's running host rather than colliding with it.
   */
  project: string;
  /** The target environment. */
  env: ManagedEnvironment;
  /** The app database id for this environment — where media records and hashes live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`<project>-<env>-secrets`) — holds the storage credentials. */
  secretsDatabaseId: string;
  /** The CF Secrets Store id holding the per-env master key. */
  storeId: string;
  /** The provisioned bucket and KV namespace the worker binds. */
  resources: MediaResources;
  /** The app's resolved media config — serialized into the worker's `MEDIA_CONFIG` var. */
  mediaConfig: MediaConfig;
}

/**
 * Fill the template for one environment.
 *
 * The one media-specific subtlety is the `MEDIA` KV binding: the template declares it unconditionally,
 * because a template describes every binding the capability *might* need. In `recordStore: 'd1'` mode no
 * namespace is ever created, so the binding is dropped rather than left pointing at nothing — a deploy
 * that binds a namespace which does not exist fails opaquely at the worker's first request.
 */
export function resolveMediaConfig(template: WorkflowHostTemplate, params: MediaConfigParams): WorkflowHostTemplate {
  const { project, env, appDatabaseId, secretsDatabaseId, storeId, resources, mediaConfig } = params;
  const kvNamespaceId = resources.kvNamespaceId;

  return resolveWorkflowHost(template, {
    project,
    capability: MEDIA_CAPABILITY,
    env,
    databaseIds: { DB: appDatabaseId, SECRETS: secretsDatabaseId },
    ...(kvNamespaceId ? { kvNamespaceIds: { MEDIA: kvNamespaceId } } : { omitKvBindings: ["MEDIA"] }),
    r2BucketNames: { MEDIA_BUCKET: resources.bucketName },
    secretsStoreId: storeId,
    // The master key entry is project- and env-scoped, matching what the secrets manager wrote.
    masterKeySecretName: masterKeySecretName(project, env),
    vars: { MEDIA_CONFIG: JSON.stringify(mediaConfig) },
    // The four enrichment Workflows, derived from the specs rather than from the template's own block.
    // A Workflow name is account-scoped, so the template's `pithy-media-image-to-text` cannot be made
    // project-scoped by suffixing — only the registry knows both the project and the job.
    workflows: hostWorkflowsFor(mediaWorkflowRegistry, { project, capability: MEDIA_CAPABILITY, env }).workflows,
  });
}
