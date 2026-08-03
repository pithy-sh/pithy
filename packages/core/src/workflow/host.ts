// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../error/pithyError";
import { ENVIRONMENT_VAR, PROJECT_VAR } from "../worker/identity";
import { type WorkflowHostNameParts, workflowHostName, workflowScriptName } from "./naming";
import type { WorkflowRegistry } from "./spec";

/**
 * The prebuilt-worker host contract.
 *
 * A capability that owns Workflows ships a committed `wrangler.jsonc` **template** beside its
 * worker entry — not an env-stanza file, because staging and production are genuinely separate
 * Workers. `pithy <capability> provision` resolves that template into one complete config per
 * environment and deploys each with `wrangler deploy --config <resolved>`. The adopter authors
 * none of it.
 *
 * Email, secrets, and media each grew their own copy of that resolver. This module is the one they
 * converge on: a template shape wide enough for all three, and a pure resolver that fills it.
 *
 * Pure by construction — no filesystem, no Cloudflare, no `cloudflare:workers`. The caller parses
 * the template and writes the result. That keeps core node-safe (its `.describe()` meta-test
 * imports every module eagerly under node) and keeps the ordering and idempotency logic unit-
 * testable without an account.
 *
 * **Workflows cannot use remote bindings**, so a host always runs locally in `wrangler dev`. Any
 * binding it needs that has no local emulation — Vectorize and Workers AI both lack one — must
 * carry `remote: true`, which is why {@link WorkflowHostParams.remoteBindings} exists rather than
 * the flag being inferred per binding kind.
 */

/** A D1 binding in a host template. `database_name` is rewritten only when the caller supplies one. */
export interface HostD1Binding {
  binding: string;
  database_name: string;
  database_id: string;
}

/** A KV namespace binding in a host template. */
export interface HostKvBinding {
  binding: string;
  id: string;
}

/** An R2 bucket binding in a host template. */
export interface HostR2Binding {
  binding: string;
  bucket_name: string;
  remote?: boolean;
}

/** A Vectorize index binding in a host template. Always `remote: true` — Vectorize has no local emulation. */
export interface HostVectorizeBinding {
  binding: string;
  index_name: string;
  remote?: boolean;
}

/** The Workers AI binding in a host template. Always `remote: true` — Workers AI has no local emulation. */
export interface HostAiBinding {
  binding: string;
  remote?: boolean;
}

/** A Cloudflare Email Service send binding in a host template. */
export interface HostSendEmailBinding {
  name: string;
  remote?: boolean;
}

/** A Secrets Store entry in a host template — the master key a host reads its secrets through. */
export interface HostSecretsStoreBinding {
  binding: string;
  store_id: string;
  secret_name: string;
}

/** One Workflow the host worker hosts: the binding, the deployed name, and the class that runs it. */
export interface HostWorkflowBinding {
  binding: string;
  name: string;
  class_name: string;
}

/**
 * A capability's committed `wrangler.jsonc` template, typed. Every field is optional but `name` and
 * `main` — a host that binds no D1 is legal, and email binds no R2. Unknown keys survive
 * `structuredClone` untouched, so a template may carry fields this contract does not model.
 */
export interface WorkflowHostTemplate {
  name: string;
  main: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  d1_databases?: HostD1Binding[];
  kv_namespaces?: HostKvBinding[];
  r2_buckets?: HostR2Binding[];
  vectorize?: HostVectorizeBinding[];
  ai?: HostAiBinding;
  send_email?: HostSendEmailBinding[];
  secrets_store_secrets?: HostSecretsStoreBinding[];
  workflows?: HostWorkflowBinding[];
  triggers?: { crons: string[] };
  vars?: Record<string, string>;
}

/** What one environment's resolution needs. Everything absent is left exactly as the template had it. */
export interface WorkflowHostParams {
  /**
   * The project name — the `<project>` segment every derived name leads with. The root
   * `pithy.config.ts` `name`, resolved by `requireProjectName` and **never guessed**: Worker script
   * and Workflow names are account-scoped, so a wrong value here overwrites another project's
   * running Worker rather than colliding with it.
   */
  project: string;
  /** The capability that owns the host — the `<capability>` segment of every derived name. */
  capability: string;
  /** The target environment (`dev` | `staging` | `production`). */
  env: string;
  /** D1 binding name → database id. An unlisted binding keeps the template's id. */
  databaseIds?: Record<string, string>;
  /**
   * D1 binding name → database name. Rewritten **only** for the bindings listed here. Email
   * deliberately lets `pithy-app`/`pithy-secrets` pass through while secrets rewrites its own, so
   * the choice cannot be a blanket rule.
   */
  databaseNames?: Record<string, string>;
  /** KV binding name → namespace id. */
  kvNamespaceIds?: Record<string, string>;
  /** R2 binding name → bucket name. */
  r2BucketNames?: Record<string, string>;
  /** Vectorize binding name → index name. */
  vectorizeIndexNames?: Record<string, string>;
  /** The Secrets Store id, set on every `secrets_store_secrets` entry. */
  secretsStoreId?: string;
  /**
   * The environment-scoped name of the master-key secret. Passed in rather than derived: core must
   * not depend on `@pithy-sh/secrets`, which owns that naming.
   */
  masterKeySecretName?: string;
  /** Vars merged over the template's, e.g. the capability's config serialized as one JSON blob. */
  vars?: Record<string, string>;
  /**
   * Binding names that must carry `remote: true`. A Workflow host runs locally in dev, so any
   * binding without local emulation has to reach the real service.
   */
  remoteBindings?: readonly string[];
  /**
   * KV binding names to drop. A template declares every binding a capability *might* need; a mode
   * that does not use one must not ship a binding pointing at a namespace that was never created.
   */
  omitKvBindings?: readonly string[];
  /**
   * The host's `workflows` array, already derived from the capability's registry by
   * {@link hostWorkflowsFor}. **Required whenever the template declares any `workflows`.**
   *
   * The resolver used to build these by appending `-<env>` to the template's own name, which cannot
   * produce a project-scoped name: the template says `pithy-email-send`, and the resolver has no way
   * to recover the job from it. Deriving them from the registry is the only path that knows both the
   * project and the job, so the textual suffix is gone and its absence is an error rather than a
   * silent fallback to an unscoped, account-colliding Workflow name.
   */
  workflows?: readonly HostWorkflowBinding[];
}

/** Apply `remote: true` to an entry whose binding the caller listed. */
function withRemote<T extends { remote?: boolean }>(entry: T, name: string, remote: ReadonlySet<string>): T {
  return remote.has(name) ? { ...entry, remote: true } : entry;
}

/**
 * Resolve a host template into one environment's complete, standalone config.
 *
 * Structural, never textual: the template is `structuredClone`d and fields are overwritten by
 * binding-name lookup. The `<filled-at-provision>` markers in the committed templates are
 * documentation for whoever reads the file — nothing matches or replaces them, so a template that
 * spells a placeholder differently still resolves correctly.
 *
 * The worker name becomes `<project>-<env>-<capability>` through {@link workflowHostName}, and the
 * `workflows` array is replaced wholesale by `params.workflows` (derived from the registry by
 * {@link hostWorkflowsFor}), so the deployed names cannot drift from what the dispatcher and the
 * CLI compute. `binding` and
 * `class_name` are never rewritten — they are code references, not deployment identities.
 */
export function resolveWorkflowHost(template: WorkflowHostTemplate, params: WorkflowHostParams): WorkflowHostTemplate {
  const resolved = structuredClone(template);
  const remote = new Set(params.remoteBindings ?? []);

  resolved.name = workflowHostName({ project: params.project, capability: params.capability, env: params.env });

  if (resolved.d1_databases) {
    resolved.d1_databases = resolved.d1_databases.map((entry) => ({
      ...entry,
      database_name: params.databaseNames?.[entry.binding] ?? entry.database_name,
      database_id: params.databaseIds?.[entry.binding] ?? entry.database_id,
    }));
  }

  if (resolved.kv_namespaces) {
    const omit = new Set(params.omitKvBindings ?? []);
    const kept = resolved.kv_namespaces.filter((entry) => !omit.has(entry.binding));
    // Drop the key entirely when nothing survives — wrangler treats an empty array as a declaration.
    if (kept.length > 0) {
      resolved.kv_namespaces = kept.map((entry) => ({
        ...entry,
        id: params.kvNamespaceIds?.[entry.binding] ?? entry.id,
      }));
    } else {
      resolved.kv_namespaces = undefined;
    }
  }

  if (resolved.r2_buckets) {
    resolved.r2_buckets = resolved.r2_buckets.map((entry) =>
      withRemote(
        { ...entry, bucket_name: params.r2BucketNames?.[entry.binding] ?? entry.bucket_name },
        entry.binding,
        remote,
      ),
    );
  }

  if (resolved.vectorize) {
    resolved.vectorize = resolved.vectorize.map((entry) =>
      withRemote(
        { ...entry, index_name: params.vectorizeIndexNames?.[entry.binding] ?? entry.index_name },
        entry.binding,
        remote,
      ),
    );
  }

  if (resolved.ai) {
    resolved.ai = withRemote(resolved.ai, resolved.ai.binding, remote);
  }

  if (resolved.send_email) {
    resolved.send_email = resolved.send_email.map((entry) => withRemote(entry, entry.name, remote));
  }

  if (resolved.secrets_store_secrets && params.secretsStoreId !== undefined) {
    const storeId = params.secretsStoreId;
    const masterKey = params.masterKeySecretName;
    resolved.secrets_store_secrets = resolved.secrets_store_secrets.map((entry) => ({
      ...entry,
      store_id: storeId,
      // Only the master key is environment-scoped; every other entry keeps its declared name.
      secret_name:
        masterKey !== undefined && entry.binding === "SECRETS_ENCRYPTION_KEYS" ? masterKey : entry.secret_name,
    }));
  }

  if (resolved.workflows) {
    if (!params.workflows) {
      throw new InternalError({
        message: `The ${params.capability} host template declares workflows but none were derived.`,
        action: "Pass `workflows` from hostWorkflowsFor(registry, { project, capability, env }).",
        detail:
          "A Workflow name is account-scoped and must carry the project; the template name alone cannot produce one.",
      });
    }
    resolved.workflows = params.workflows.map((entry) => ({ ...entry }));
  }

  // Identity last: a caller's vars can add anything, but never restate who this worker is.
  resolved.vars = {
    ...resolved.vars,
    ...params.vars,
    [ENVIRONMENT_VAR]: params.env,
    [PROJECT_VAR]: params.project,
  };

  return resolved;
}

/**
 * Derive a host's `workflows` array and `triggers.crons` from the registry, so a capability's specs
 * — not a hand-maintained block in its template — are the source of both. A spec without a
 * `className` cannot be hosted: there would be no class for wrangler to instantiate.
 */
export function hostWorkflowsFor(
  registry: WorkflowRegistry,
  parts: WorkflowHostNameParts,
): { workflows: HostWorkflowBinding[]; crons: string[] } {
  const { project, capability, env } = parts;
  const owned = Object.values(registry).filter((entry) => entry.capability === capability);
  const workflows: HostWorkflowBinding[] = [];
  const crons: string[] = [];

  for (const entry of owned) {
    if (!entry.spec.className) {
      throw new InternalError({
        message: `Workflow "${entry.key}" cannot be hosted without a className.`,
        action: "Add className to the spec, naming the exported WorkflowEntrypoint class.",
      });
    }
    workflows.push({
      binding: entry.spec.binding,
      name: workflowScriptName({ project, capability, job: entry.job, env }),
      class_name: entry.spec.className,
    });
    if (entry.spec.schedule) crons.push(entry.spec.schedule);
  }

  return { workflows, crons };
}
