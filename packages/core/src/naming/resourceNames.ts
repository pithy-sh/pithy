// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "../error/pithyError";
import { workflowHostName, workflowScriptName } from "../workflow/naming";
import { assertValidEnvironment, GLOBAL_SCOPE } from "./environment";
import { type FeatureIdentity, type FeatureResourceKind, featureResourceName, featureWorkerName } from "./feature";
import { NAMESPACE_LIMITS, type NamespaceLimit } from "./limits";
import { assertValidProjectName, kebab, resourceName } from "./resource";

/**
 * Every Cloudflare name a project composes, behind one object — **the facade**.
 *
 * The free functions underneath are correct and stay exported, but they share one flaw: each takes a
 * budget, so every call site decides for itself which limit applies. That is how one number, 63, ended
 * up standing in for eight different namespaces. Here the budget is not an argument at all. You pick a
 * *kind of thing* — a bucket, a KV namespace, a Workflow — and the kind carries its own cap and its own
 * refuse-or-truncate policy from `./limits`. There is no wrong budget to pass, because there is no
 * budget to pass.
 *
 * **Shape: project, then scope, then kind.**
 *
 * ```ts
 * const names = resourceNames(config.name);   // the project, validated once
 * const prod = names.env("prod");             // the environment, validated once
 * prod.d1("DB");                              // acme-prod-db
 * prod.workflow("email", "send");             // acme-prod-email-send
 * names.global.secretEntry("secrets-manager-cf-api-token");
 * names.feature({ issue, slug }).resource("DB", "d1");
 * ```
 *
 * Three reasons for that order rather than a flat `worker(capability, env)`:
 *
 * 1. **Each thing is validated once, at the point it is named.** A bad project fails at
 *    `resourceNames`, before a single name exists; a bad environment fails at `env`, not on the fourth
 *    getter that happened to use it.
 * 2. **The environment is threaded once, not through every call.** Commands are environment-scoped —
 *    `pithy deploy --env prod` names a dozen resources in one environment — so binding it once removes a
 *    dozen chances to pass the wrong one.
 * 3. **`global` becomes a property, not a magic string.** It is the same interface as an environment
 *    (`names.global.secretEntry(…)`), so no call site special-cases the literal, and no call site can
 *    typo it into a real environment named `globl`.
 *
 * The feature shape hangs off the same object for the same reason it exists at all: it is the *other*
 * scope a project's resources live in, and it shares the project segment with everything above.
 */

/** The names available within one scope — an environment, or the global scope beside them. */
export interface ScopedNames {
  /** A capability's Worker script — `<project>-<env>-<capability>`. Refused, not truncated, past 63. */
  worker(capability: string): string;
  /** One durable job's Workflow — `<project>-<env>-<capability>-<job>`. Refused, not truncated, past 64. */
  workflow(capability: string, job: string): string;
  /** A D1 database. No Cloudflare cap; Pithy's ceiling, truncated with a stable hash. */
  d1(binding: string): string;
  /** A KV namespace title. Cloudflare's 512, not the 63 this used to be held to. */
  kv(binding: string): string;
  /** An R2 bucket. Cloudflare's 63 — the one namespace where that number was always right. */
  r2(binding: string): string;
  /** A Vectorize index. 64 bytes, refused rather than truncated: a renamed index has no vectors. */
  vectorizeIndex(index: string): string;
  /** A Secrets Store entry. No Cloudflare cap; Pithy's ceiling. */
  secretEntry(secret: string): string;
  /** A Cloudflare API token label. No Cloudflare cap; Pithy's ceiling. */
  apiToken(profile: string): string;
}

/** The names a feature environment provisions under, with the project already bound. */
export interface FeatureNames {
  /** A feature's D1, KV, or R2 resource — `<project>-f<issue>-<slug>-<binding>-<kind>`. */
  resource(binding: string, kind: FeatureResourceKind): string;
  /** A feature's Worker script — `<project>-f<issue>-<slug>-<worker>`. */
  worker(worker: string): string;
}

/** Everything a project can be asked to name. Created once, from the project, by {@link resourceNames}. */
export interface ProjectNames {
  /** The kebabbed project name every name below leads with. */
  readonly project: string;
  /** The names in one environment. Throws if the environment is not one this scheme accepts. */
  env(environment: string): ScopedNames;
  /** The names shared by every environment — the `global` scope, without typing the word. */
  readonly global: ScopedNames;
  /** The names a feature environment provisions under. */
  feature(identity: Omit<FeatureIdentity, "project">): FeatureNames;
}

/**
 * Compose `<project>-<scope>-<thing>` under one namespace's rule.
 *
 * A `truncate` namespace hands off to {@link resourceName} with that namespace's cap, so there is still
 * exactly one truncation rule. A `refuse` namespace composes verbatim and throws with the limit named —
 * as an `InternalError`, because by this point the project and scope have both been validated, so an
 * over-long name means author-controlled code asked for one.
 *
 * **The refuse branch here is deliberately not `../workflow/naming`'s**, though both compose
 * `<project>-<scope>-<thing>` and both refuse rather than truncate. They answer different questions: a
 * Workflow or Worker name is assembled from author-controlled capability and job identifiers, so that
 * module *asserts* each segment against `NAME_SEGMENT` and measures the result in **bytes**, the
 * unit Cloudflare states those two limits in. The kinds routed through here are named after a binding
 * or a secret, which is an adopter's string, so it is kebabbed into shape instead. Merging the two would
 * either start mangling a capability name or stop normalizing a binding.
 */
function scopedName(project: string, scope: string, thing: string, limit: NamespaceLimit): string {
  if (limit.policy === "truncate") {
    const name = resourceName({ project, env: scope, thing }, limit.maxLength);
    if (name.length < limit.minLength) {
      throw new InternalError({
        message: `"${name}" is too short for ${limit.label}.`,
        action: `Use a longer project, environment, or resource name — ${limit.label} needs ${limit.minLength} characters.`,
      });
    }
    return name;
  }

  const segment = kebab(thing);
  if (!segment) {
    throw new ValidationError({
      message: `A name needs something to name.`,
      detail: `${limit.label} was asked for with an empty segment (raw: ${JSON.stringify(thing)}).`,
    });
  }
  const name = `${kebab(project)}-${scope}-${segment}`;
  if (name.length > limit.maxLength) {
    throw new InternalError({
      message: `"${name}" is ${name.length} characters. ${limit.label[0]?.toUpperCase()}${limit.label.slice(1)} stops at ${limit.maxLength}.`,
      action: "Shorten the project, environment, or resource name.",
      detail: `${limit.label} is refused rather than truncated — renaming it after a deploy orphans what it addresses.`,
    });
  }
  return name;
}

/** The getters for one scope. `global` and every environment share this, so nothing special-cases either. */
function scopedNames(project: string, scope: string): ScopedNames {
  return {
    worker: (capability) => workflowHostName({ project, capability, env: scope }),
    workflow: (capability, job) => workflowScriptName({ project, capability, job, env: scope }),
    d1: (binding) => scopedName(project, scope, binding, NAMESPACE_LIMITS.d1),
    kv: (binding) => scopedName(project, scope, binding, NAMESPACE_LIMITS.kv),
    r2: (binding) => scopedName(project, scope, binding, NAMESPACE_LIMITS.r2),
    vectorizeIndex: (index) => scopedName(project, scope, index, NAMESPACE_LIMITS.vectorizeIndex),
    secretEntry: (secret) => scopedName(project, scope, secret, NAMESPACE_LIMITS.secretEntry),
    apiToken: (profile) => scopedName(project, scope, profile, NAMESPACE_LIMITS.apiToken),
  };
}

/**
 * Bind a project to every name it can compose.
 *
 * The project is validated here — charset *and* length, the one project rule — so a project that cannot
 * carry every namespace fails before it has provisioned any of them. That is the whole reason the
 * project is supplied once instead of per call.
 */
export function resourceNames(project: string): ProjectNames {
  assertValidProjectName(project);
  const normalized = kebab(project);

  return {
    project: normalized,
    env(environment: string): ScopedNames {
      assertValidEnvironment(environment);
      return scopedNames(normalized, environment);
    },
    global: scopedNames(normalized, GLOBAL_SCOPE),
    feature(identity): FeatureNames {
      const full: FeatureIdentity = { ...identity, project: normalized };
      return {
        resource: (binding, kind) => featureResourceName(full, binding, kind),
        worker: (worker) => featureWorkerName(full, worker),
      };
    },
  };
}
