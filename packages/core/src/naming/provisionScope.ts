// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../error/pithyError";
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
 * Provisioning was specified for ephemeral feature environments and parameterized by `--env` before it
 * was generalized to named ones. That left the namer and the target stanza as independent inputs, and
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
 *   kit follows, so the environment segment of a name is always the stanza the name lives in — unless
 *   the thing being named is one the whole project shares, which a binding says with
 *   {@link BindingNaming} and a secret with its registry, and which puts the literal `global` in that
 *   slot instead. `global` is a scope beside the environments rather than one of them, so this is the
 *   same statement and not an exception to it: the segment still says which scope owns the resource.
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

/**
 * What a binding's manifest says about the *name* of the resource behind it — the two fields of
 * `BindingSpec` that a composed name reads, and nothing else.
 *
 * Structural rather than an import of `BindingSpec`, for the reason {@link SecretNameScope} is a literal
 * union rather than an import of `SecretScope`: this module composes names and must not depend on the
 * capability contract to do it. A caller with a whole spec passes the spec; a caller with neither field
 * passes `{}`.
 *
 * **Both fields absent is the ordinary binding**, and it composes exactly what it always did:
 * `<project>-<env>-<kebabbed binding>`.
 */
export interface BindingNaming {
  /**
   * `global` where one resource serves the whole project, absent or `environment` where each environment
   * gets its own. See `BindingSpec.scope` — this is that field, and the reason it exists is that
   * `EMAIL_SUPPRESSIONS` and `SECRETS` sit one line apart in the same env and no convention tells them
   * apart.
   */
  readonly scope?: SecretNameScope;
  /**
   * The `<thing>` segment, where it is not the binding name. See `BindingSpec.resource` —
   * `SUPPORT_BUCKET` backs `<project>-global-support`.
   */
  readonly resource?: string;
}

/**
 * A {@link BindingNaming} that says `global` in its **type**, not only in its value.
 *
 * The distinction earns its keep at exactly one call: {@link bindingResourceName} needs a per-environment
 * fallback from a writer filling in one stanza, and cannot need one from a capability's own namer, which
 * has no environment to fall back to because its resource has none. Typing the declaration is what lets
 * the compiler tell those two callers apart, so the namer omits an argument it could only have invented.
 */
export interface ProjectGlobalNaming extends BindingNaming {
  readonly scope: "global";
}

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
  /**
   * This scope's Cloudflare name for a provisionable binding, given what the binding's manifest says
   * about naming it.
   *
   * **The naming is required, not defaulted.** A caller with nothing to say passes `{}` and gets the
   * name it always got; what it may not do is *omit* the question. `pithy add` and `pithy provision`
   * both compose this name, from two different call paths, and the whole of #513 is that one of them
   * had no way to hear "this resource is one per project" — so the app Worker bound three suppression
   * databases where the email Worker bound one, and an unsubscribe on either was invisible to the other.
   * A parameter with a default is a parameter a new call site inherits an answer to without ever
   * reading the question.
   */
  resource(binding: string, kind: FeatureResourceKind, naming: BindingNaming): string;
  /**
   * Whether a binding that declares itself project-global is actually named that way here — and so
   * belongs to the project rather than to this run.
   *
   * The asymmetry between the two scopes, stated by the object that implements it rather than inferred
   * by a caller comparing two composed names. A declared environment honors `global` and shares the one
   * resource; {@link featureScope} does not, so a feature's copy is the feature's own. A caller reading
   * the manifest alone gets that backwards, and the way it goes wrong is silent: the feature's database
   * is created, judged to be the project's, kept out of the teardown record, and orphaned.
   */
  readonly honorsGlobal: boolean;
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
 * The same branch, one line down, for a provisioned resource: a `global` binding resolves to the
 * project's single `<project>-global-<thing>`, and everything else to the scope's own name for it.
 *
 * Written beside {@link secretEntryName} and shaped like it deliberately — the argument is the same
 * argument. A value defined as one value must have one name, or the scoping mints a second copy of it;
 * the only difference is that a secret's second copy is read and a database's is *written to*, which is
 * why this one is the bug where an unsubscribe recorded in `staging` was invisible in `prod` (#513).
 *
 * `thing` is `naming.resource` when the manifest states one and the binding name otherwise. Either way
 * it goes to the same composer, which kebabs it — so a binding passed verbatim keeps the name it has
 * always had (`kebab("EMAIL_SUPPRESSIONS") === "email-suppressions"`), and this function cannot change
 * what any existing spec composes.
 *
 * **Exported, because `pithy add` composes this name too and has no {@link ProvisionScope} to do it
 * with.** It writes a `database_name` into a `wrangler.jsonc` stanza long before an account is reached,
 * from a Worker's declared environment rather than a provisioning run's — and it is the writer that got
 * #513 wrong. Handing it the scoped name as a callback is what lets the *global* branch live here once:
 * a second copy of it in the writer is the arrangement this issue exists to end.
 *
 * **And exported for the third writer, which is the capability's own namer.** `suppressionDatabaseName`
 * and `supportBucketName` name the same two resources their manifests declare, and they composed them
 * with a second expression until #513 — which is how `<project>-global-email-suppressions` and
 * `<project>-staging-email-suppressions` came to be the same database under two names. They pass a
 * {@link ProjectGlobalNaming} and no callback: a namer for a project-global resource has no environment,
 * so there is no scoped name for it to supply and the overload will not let it pretend otherwise.
 */
export function bindingResourceName(
  project: string,
  binding: string,
  kind: FeatureResourceKind,
  naming: ProjectGlobalNaming,
): string;
export function bindingResourceName(
  project: string,
  binding: string,
  kind: FeatureResourceKind,
  naming: BindingNaming,
  scoped: (thing: string) => string,
): string;
export function bindingResourceName(
  project: string,
  binding: string,
  kind: FeatureResourceKind,
  naming: BindingNaming,
  scoped?: (thing: string) => string,
): string {
  const thing = naming.resource ?? binding;
  if (naming.scope === GLOBAL_SCOPE) return resourceNames(project).global[KIND_NAMER[kind]](thing);
  // The second wall behind the overloads, not the first. A caller with no environment reaching a naming
  // that is not `global` has nothing this function could compose, and the honest answer is to say so
  // rather than return a name with a segment nobody chose.
  if (scoped === undefined) {
    throw new InternalError({
      message: "A resource name could not be composed.",
      detail: `bindingResourceName was asked for a scoped name for "${binding}" with no scope to compose it in. Pass the environment's composer, or declare the binding \`scope: "global"\`.`,
    });
  }
  return scoped(thing);
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
    // A declared environment is one of the scopes a project-global resource is shared *between*.
    honorsGlobal: true,
    resource: (binding, kind, naming) =>
      bindingResourceName(project, binding, kind, naming, (thing) => names[KIND_NAMER[kind]](thing)),
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
 *
 * **A feature takes a binding's {@link BindingNaming} and ignores it — and that is the asymmetry against
 * `secretEntry` one line below, which honors `global` here as everywhere.** A global *secret* is a value
 * defined once for the project, so a feature binds the project's copy rather than minting a second: it is
 * **read**. A global *database* is a resource a feature would **migrate** — `provisionFeature` runs
 * `pithy migrate` against everything it names — so honoring `global` here would point one branch's
 * schema changes at the project's live suppression list, and point teardown at it afterwards. A feature
 * owns every resource it names, exactly so that destroying the feature destroys them all; there is no
 * shared name to match and nothing for teardown to spare.
 *
 * `resource` is ignored for the same reason it is moot: a feature's `<thing>` segment is the binding plus
 * the kind, and the whole name is recomputed on teardown rather than looked up, so nothing outside the
 * feature reads the string.
 */
export function featureScope(identity: FeatureIdentity): ProvisionScope {
  return {
    stanza: FEATURE_ENVIRONMENT,
    // One job's ids, for resources `destroy` deletes. Never a tracked file.
    source: false,
    // A feature owns every resource it names — see the docstring above for why a database and a secret
    // part company here.
    honorsGlobal: false,
    resource: (binding, kind) => featureResourceName(identity, binding, kind),
    worker: (worker) => featureWorkerName(identity, worker),
    secretEntry: (secret, secretScope) =>
      secretEntryName(identity.project, secret, secretScope, () => featureSecretEntryName(identity, secret)),
  };
}
