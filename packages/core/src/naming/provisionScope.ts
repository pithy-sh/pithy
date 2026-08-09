// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { assertValidEnvironment } from "./environment";
import { type FeatureIdentity, type FeatureResourceKind, featureResourceName, featureWorkerName } from "./feature";
import { resourceNames } from "./resourceNames";

/**
 * **What a provisioning run names its resources, and which `env.<name>` stanza it writes them into —
 * as one object, never two arguments.**
 *
 * Provisioning was specified for ephemeral feature environments and parameterised by `--env` before it
 * was generalised to named ones. That left the namer and the target stanza as independent inputs, and
 * `pithy feature provision --env staging` was the reachable consequence: it composed
 * `<project>-f<issue>-<slug>-db` and wrote it in as `staging`'s `DB`. Nothing refused it, the ids went
 * into a checked-in `wrangler.jsonc`, and a remote migrate ran against them.
 *
 * A guard against that combination would be a list of forbidden pairs. This is the invariant instead:
 * **a scope is chosen once, and it carries both halves.** There is no call path that takes an
 * environment name and a naming scheme separately, so there is no pair left to get wrong.
 *
 * Two scopes exist, and they are the two kinds of environment a project has:
 *
 * - {@link environmentScope} — a **declared** environment (`staging`, `prod`, whatever the root
 *   `pithy.config.ts` lists). Names are `<project>-<env>-<thing>`, the rule every other namer in the
 *   kit follows, so the environment segment of a name is always the stanza the name lives in.
 * - {@link featureScope} — one branch's **ephemeral** environment. Names are
 *   `<project>-f<issue>-<slug>-<thing>`, with no environment segment because a feature *is* an
 *   environment, and the `f<issue>` marker is what teardown recomputes and what keeps a feature's
 *   database from ever being mistaken for a deployed one's.
 */

/**
 * The wrangler stanza a feature environment lives in.
 *
 * One name, not a flag: a feature has exactly one environment, so a second value here would be the
 * decoupling this module exists to remove. Seven characters, which is `MAX_ENVIRONMENT_NAME` — it has
 * to be a legal environment because it is a real `env.<name>` key.
 */
export const FEATURE_ENVIRONMENT = "feature";

/** Where a provisioning run's resources are named, and where their ids are written. */
export interface ProvisionScope {
  /** The `env.<stanza>` key in each Worker's `wrangler.jsonc` that this scope's ids are written into. */
  readonly stanza: string;
  /** This scope's Cloudflare name for a provisionable binding. */
  resource(binding: string, kind: FeatureResourceKind): string;
  /** The script name a Worker deploys under in this scope. */
  worker(worker: string): string;
}

/** The wrangler binding array a resource kind's name is composed for. */
const KIND_NAMER: Record<FeatureResourceKind, "d1" | "kv" | "r2"> = { d1: "d1", kv: "kv", r2: "r2" };

/**
 * A declared environment's scope — `staging`, `prod`, or whatever the root `pithy.config.ts` lists.
 *
 * The environment is validated here, once, before a single name exists: it is the middle segment of
 * every name below, so an illegal one must fail before anything is created rather than at the fourth
 * getter that happened to use it.
 *
 * **A Worker's script name is wrangler's own, `<script>-<env>`, deliberately.** It is the one name here
 * that is not `<project>-<env>-<thing>`, because `wrangler deploy --env staging` has always appended the
 * environment to the top-level `name` — so every project that ever deployed is already at that address.
 * A Worker script is a `refuse`-policy namespace precisely because renaming one orphans the deployment
 * and every `service` binding pointing at it; composing a "more correct" name here would do exactly
 * that, silently, on the next deploy. The name is written out rather than left implicit so a service
 * binding and a deploy agree on one string that is in the file.
 */
export function environmentScope(project: string, environment: string): ProvisionScope {
  assertValidEnvironment(environment);
  const names = resourceNames(project).env(environment);
  return {
    stanza: environment,
    resource: (binding, kind) => names[KIND_NAMER[kind]](binding),
    worker: (worker) => `${worker}-${environment}`,
  };
}

/**
 * One feature's scope — the ephemeral environment a branch gets, named from the branch rather than from
 * an environment.
 *
 * Its stanza is {@link FEATURE_ENVIRONMENT} and nothing else, which is what makes
 * `pithy feature provision --env staging` unexpressible rather than merely discouraged.
 */
export function featureScope(identity: FeatureIdentity): ProvisionScope {
  return {
    stanza: FEATURE_ENVIRONMENT,
    resource: (binding, kind) => featureResourceName(identity, binding, kind),
    worker: (worker) => featureWorkerName(identity, worker),
  };
}
