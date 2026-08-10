// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { assertValidEnvironment, FEATURE_ENVIRONMENT, GLOBAL_SCOPE } from "./environment";
import {
  type FeatureIdentity,
  type FeatureResourceKind,
  featureResourceName,
  featureSecretEntryName,
  featureWorkerName,
} from "./feature";
import { resourceNames } from "./resourceNames";

/**
 * **What a provisioning run names its resources, and which `env.<name>` stanza it writes them into —
 * as one object, never two arguments.**
 *
 * Provisioning was specified for ephemeral feature environments and parameterised by `--env` before it
 * was generalised to named ones. That left the namer and the target stanza as independent inputs, and
 * A feature's namer with a declared environment beside it was the reachable consequence: it composed
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
 * Whether a secret's value differs per environment or is one value every environment binds.
 *
 * The same two words `@pithy-sh/secrets`' `SecretScope` uses, restated here as a literal union rather
 * than imported: core carries the secret-registry *seam* and not the package, for the same reason
 * `SecretRegistryEntrySeam` types `backend` as a `string`.
 */
export type SecretNameScope = "environment" | "global";

/** Where a provisioning run's resources are named, and where their ids are written. */
export interface ProvisionScope {
  /** The `env.<stanza>` key in each Worker's config that this scope's ids are written into. */
  readonly stanza: string;
  /**
   * **Are this scope's ids source, or a build artifact?**
   *
   * The same provisioning step produces both, and the difference is not cosmetic. A declared
   * environment's ids are long-lived facts about the repository: they belong in the tracked
   * `wrangler.jsonc`, under review, in a pull request a human reads. A feature's are facts about one
   * job — the branch is deleted, the resources are destroyed, and the ids name nothing afterwards.
   *
   * Writing a feature's into the tracked file was correct as designed *in CI*, where the checkout is
   * throwaway, and an expectation everywhere else: a developer's worktree carried a modified tracked
   * file they never edited, with no note saying it must not be committed, and `git add -A` put ids for
   * deleted resources onto `main`. So a build artifact goes somewhere untracked instead, and the
   * question "which is this?" is answered here, once, by the same object that answers "what is it
   * called?" and "which stanza does it go in?" — because those three answers have to agree.
   */
  readonly source: boolean;
  /** This scope's Cloudflare name for a provisionable binding. */
  resource(binding: string, kind: FeatureResourceKind): string;
  /** The script name a Worker deploys under in this scope. */
  worker(worker: string): string;
  /**
   * This scope's CF Secrets Store entry name for a declared secret.
   *
   * A `global` secret is the one name that does **not** take the scope's segment: it is a single
   * account-level value every environment binds, so every scope resolves it to the project's
   * `<project>-global-<secret>`. Scoping it would mint a second copy of a value defined as one.
   */
  secretEntry(secret: string, secretScope: SecretNameScope): string;
}

/** The wrangler binding array a resource kind's name is composed for. */
const KIND_NAMER: Record<FeatureResourceKind, "d1" | "kv" | "r2"> = { d1: "d1", kv: "kv", r2: "r2" };

/**
 * The one branch every scope shares: a `global` secret resolves to the project's single
 * `<project>-global-<secret>` entry, and everything else to the scope's own name for it.
 *
 * Written once here rather than in each scope, because "global is not scoped" is a property of the
 * secret and not of the environment asking — and two copies of it is how one of them would drift.
 */
function secretEntryName(project: string, secret: string, secretScope: SecretNameScope, scoped: () => string): string {
  if (secretScope === GLOBAL_SCOPE) return resourceNames(project).global.secretEntry(secret);
  return scoped();
}

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
    // Long-lived ids for an environment the project ships to: reviewed, committed, kept.
    source: true,
    resource: (binding, kind) => names[KIND_NAMER[kind]](binding),
    worker: (worker) => `${worker}-${environment}`,
    secretEntry: (secret, secretScope) =>
      secretEntryName(project, secret, secretScope, () => names.secretEntry(secret)),
  };
}

/**
 * One feature's scope — the ephemeral environment a branch gets, named from the branch rather than from
 * an environment.
 *
 * Its stanza is {@link FEATURE_ENVIRONMENT} and nothing else, which is what makes a feature's resources
 * in a declared environment's stanza unexpressible rather than merely discouraged.
 */
export function featureScope(identity: FeatureIdentity): ProvisionScope {
  return {
    stanza: FEATURE_ENVIRONMENT,
    // One job's ids, for resources `destroy` deletes. Never a tracked file.
    source: false,
    resource: (binding, kind) => featureResourceName(identity, binding, kind),
    worker: (worker) => featureWorkerName(identity, worker),
    secretEntry: (secret, secretScope) =>
      secretEntryName(identity.project, secret, secretScope, () => featureSecretEntryName(identity, secret)),
  };
}
