// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability, SecretRegistrySeam } from "@pithy-sh/core/src/capability/capability";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { ENVIRONMENT_VAR } from "@pithy-sh/core/src/worker/identity";
import { FreshCopyRefused, loadWorkerConfig, projectEnvironments, type WorkerConfig } from "../project/config";
import { type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { composedManifests } from "./manifests";
import { type BindingDeclines, honoredNames, workerDeclines } from "./reconcile";

/**
 * **Which declared secrets this project's configuration cannot reach, and why (#541).**
 *
 * Every surface that lists secrets listed what a composed capability *declares*, never what the
 * composition can use. So one `pithy doctor` run said this:
 *
 * ```
 * bindings     SUPPORT_BUCKET (r2) declined in pithy.config.ts — Attachments are off,
 *              so nothing would ever be written to it.
 * ...
 * Dev secrets:
 *   No dev value for auth-apple-credentials, auth-facebook-credentials, support-r2-credentials.
 * ```
 *
 * — acknowledging the bucket is declined, in the adopter's own words, and then asking for the R2
 * credential whose only purpose is reaching it. Both halves were right; the report contradicted itself
 * because the two halves never met. This is where they meet.
 *
 * ## Two sources, and neither is a guess
 *
 * - **A declined binding.** A registry entry states the binding its value exists to reach
 *   (`SecretRegistryEntryBase.binding`); a Worker states which optional bindings it declines. Join them
 *   through {@link workerDeclines}, which is the same resolution `pithy provision` and `pithy upgrade`
 *   act on — never the raw declaration, because a decline of a *required* binding is refused and the
 *   binding written anyway, so the credential is still read.
 * - **A capability's own declaration.** `Capability.inapplicableSecrets` — what only the capability
 *   knows, because it holds its config: `auth()` composed without the apple provider will never read
 *   `auth-apple-credentials`. Read, never inferred: the config key and the secret name are spelled
 *   alike by coincidence, and `secretBranches` had the same rule for the same reason (#513).
 *
 * A capability's sentence wins over the derived one where both fire: it is the more specific fact, and
 * it is the one an author wrote about this exact secret.
 *
 * ## One Worker in reach is in reach — for a question that is about the project
 *
 * A secret is per project — one name, one value — which is why `projectSecretRegistry` merges every
 * Worker's registry. So for a project-wide surface a name is unreachable only when **every** Worker that
 * declares it says so. Marking on the union of what each Worker cannot reach would tell an operator to skip
 * a credential a live Worker reads, which is worse than the noise this removes.
 *
 * **And the two secret surfaces do not ask the same question.** `checkDevSecrets` asks one about the
 * project — one `.dev.secrets.json`, one value per name — so the union above is its answer. `pithy doctor`'s
 * bindings tier asks a different one: its loop is per Worker *and* per environment, and a
 * `secrets_store_secrets` stanza belongs to one Worker. Handed the project answer, it printed a missing
 * binding for Worker A's stanza because Worker B still reaches the credential — a finding A can never close,
 * a few lines under `SUPPORT_BUCKET (r2) declined in pithy.config.ts` for A, which is the same
 * self-contradiction #541 exists to delete wearing different clothes. So both answers are kept:
 * {@link SecretApplicability.project} for the project-wide surfaces and
 * {@link SecretApplicability.byWorker} for the per-stanza one. Neither is derived from the other, because
 * neither is a rounding of the other.
 *
 * ## What is never claimed
 *
 * A `declinedBindings` block that will not parse leaves everything in reach — "nothing reads this" is a
 * negative claim, and an unreadable declaration is exactly what might have settled it. Doctor's
 * bindings tier is what reports the broken block; this one only has to stop asserting what it could not
 * establish. Same rule as `checkDevSecrets`'s `undeclared`.
 *
 * **That is a composition with one fact missing, and it is not the case {@link UnresolvedEnvironment}
 * covers.** This Worker composed: it has capabilities, a registry and a configuration, and every one of
 * them still speaks. Only the decline block is unreadable, so only what that block would have ruled out
 * goes unclaimed. An environment whose config threw produced no composition at all, so it says nothing
 * rather than saying *everything applies* — a distinction that cost this feature a release when the two
 * were treated alike.
 */

/** One Worker's half of the question: what it declares, what it composes, and what it declines. */
export interface ApplicabilityWorker {
  /** The Worker's name — carried so a caller can report which composition answered. */
  name: string;
  /** That Worker's composed capabilities, read for their `inapplicableSecrets` declarations. */
  capabilities: readonly Capability[];
  /**
   * That Worker's declared secrets, merged — the set anything here may have an opinion about.
   *
   * The loose {@link SecretRegistrySeam}, which `@pithy-sh/secrets`' concrete `SecretRegistry` is a
   * subtype of. Two axes are read and neither is interpreted, so the seam is the whole requirement —
   * and taking it keeps this module free of a static import of the kit's own `@pithy-sh/secrets`, which
   * is a copy of the package the adopter's project may not be running (#533).
   */
  registry: SecretRegistrySeam;
  /** That Worker's `declinedBindings`, resolved by {@link workerDeclines}. */
  declines: BindingDeclines;
}

/**
 * **An environment that is not a composition, and why it is not (#548).**
 *
 * ## Only a composition votes
 *
 * Whether a secret applies is a property of **the composition** — which capabilities are composed and how
 * they are configured. Environments enter into this at all for one reason: an adopter may write
 * `auth({ google: { enabled: compositionEnvironment() === "prod" } })`, so one project can hold three
 * compositions. The sweep below takes each of them and folds *in reach anywhere wins*.
 *
 * An environment whose `pithy.config.ts` **throws is not a composition.** There are no capabilities, no
 * registry and no configuration — so there is nothing that could have a requirement, and nothing for it
 * to say about any name. It contributes nothing to the fold: not every-name-in-reach, and not any name.
 *
 * **That correction is the whole of this issue.** It used to contribute `inReach(worker)` — every declared
 * name reachable — on the reasoning that the environment nobody could take is the one that might have
 * needed the credential. The reasoning is what was wrong: an environment that will not load has a broken
 * config, not a requirement. And because the fold is *in reach anywhere wins*, counting a thing that does
 * not exist as a vote let it beat every composition that does. One half-configured environment turned the
 * whole of #541 off. The first project to run it had exactly that — `prod` threw `Billing is not
 * configured for this environment`, and `pithy secrets ls` listed `auth-apple-credentials` for a project
 * that enables neither Apple nor Facebook, on every run, saying nothing.
 *
 * **The old worry is answered rather than traded away.** A credential only `prod` needs is not marked by
 * mistake, because a `prod` that does not compose is not a `prod` that needs anything — it is a config to
 * fix, and `pithy doctor` raises it on those terms. Restore the fallback and #541 is off again.
 *
 * ## Which is why this is reported, and reported loudly
 *
 * The answer is now drawn from **fewer environments than the project declares**, so saying so is not a
 * courtesy. `pithy secrets ls` prints it under its list and `pithy doctor` gives it a block of its own —
 * *this Worker's config does not load for prod*, which is a far bigger fault than a secret listing and is
 * met as one.
 *
 * When **no** environment composed, both answers are empty and everything is in reach — not by a fallback
 * policy but because there is nothing to fold. No composition said anything about any name.
 */
export interface UnresolvedEnvironment {
  /** The environment whose composition threw. */
  environment: string;
  /** The operator's sentence for why — a config's own `action`, never prose about it. */
  reason: string;
}

/**
 * **The two answers, because the two surfaces ask two questions** — plus what could not be asked at all.
 * Both answers are secret name → why it cannot be reached; absent means it applies, which is the ordinary
 * state of almost every declared secret.
 *
 * The reason is an operator's sentence, drawn from configuration and not from prose: it names the
 * binding and the file, or the call an adopter would edit. A surface renders it; nothing parses it.
 */
export interface SecretApplicability {
  /**
   * What **no** Worker in this project can reach — the project-wide answer, for the project-wide surfaces:
   * `pithy secrets ls`, which lists one inventory, and `checkDevSecrets`, which reads one file holding one
   * value per name. One Worker in reach is in reach.
   */
  project: ReadonlyMap<string, string>;
  /**
   * Worker name → what **that** Worker cannot reach, whatever another Worker can. For the per-stanza
   * surface: a `secrets_store_secrets` entry is one Worker's `wrangler.jsonc`, so the question "is this
   * stanza short of a binding" is that Worker's alone.
   *
   * Keyed on {@link ApplicabilityWorker.name}, which is the name every report prints. A Worker that
   * contributed no row at all is absent rather than empty — the caller decides what an unknown Worker
   * means, and the safe reading is {@link project}, which marks the fewest names.
   */
  byWorker: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * The declared environments that are **not compositions** — see {@link UnresolvedEnvironment}.
   *
   * Empty is the ordinary case and means both answers above were folded over every environment the
   * project declares. Non-empty means they were folded over **fewer**: each listed environment has a
   * config that will not load, so it said nothing, and what it would have said is unknown rather than
   * permissive. A surface renders this; nothing branches on it beyond saying so.
   *
   * Reporting it is not optional. An answer drawn from two of a project's three environments is a
   * narrower answer than the one an operator asked for, and the environment that is missing from it is a
   * fault they have to fix anyway.
   */
  unresolved: readonly UnresolvedEnvironment[];
}

/**
 * Resolve both answers in one walk. A Worker appears once per environment it was composed in, and the
 * "in reach anywhere wins" rule applies inside each answer's own scope: across the project for
 * {@link SecretApplicability.project}, and across one Worker's environments for
 * {@link SecretApplicability.byWorker}.
 */
export function secretApplicability(workers: readonly ApplicabilityWorker[]): SecretApplicability {
  /** Every reason a Worker gave, in Worker order — the first is the one reported. */
  const reasons = new Map<string, string>();
  /** Names at least one Worker can still reach. These win, whatever any other Worker said. */
  const reachable = new Set<string>();
  /** The same pair per Worker name, which is the same rule applied in a smaller scope. */
  const perWorker = new Map<string, { reasons: Map<string, string>; reachable: Set<string> }>();

  for (const worker of workers) {
    const honored = honoredNames(worker.declines);
    const declared = new Map<string, string>();
    for (const capability of worker.capabilities) {
      for (const [name, reason] of Object.entries(capability.inapplicableSecrets ?? {})) {
        // Only about a secret this Worker actually declares. A name nothing composed declares is not a
        // secret with a reason — no surface lists it, so a reason for it is a line about nothing.
        if (Object.hasOwn(worker.registry, name) && !declared.has(name)) declared.set(name, reason);
      }
    }
    const own = perWorker.get(worker.name) ?? { reasons: new Map<string, string>(), reachable: new Set<string>() };
    perWorker.set(worker.name, own);
    for (const [name, entry] of Object.entries(worker.registry)) {
      // The capability's own sentence first: it is the more specific fact, written about this secret.
      const reason =
        declared.get(name) ??
        (entry.binding !== undefined && honored.has(entry.binding)
          ? `${entry.binding} declined in pithy.config.ts`
          : undefined);
      if (reason === undefined) {
        reachable.add(name);
        own.reachable.add(name);
        continue;
      }
      if (!reasons.has(name)) reasons.set(name, reason);
      if (!own.reasons.has(name)) own.reasons.set(name, reason);
    }
  }

  for (const name of reachable) reasons.delete(name);
  const byWorker = new Map<string, ReadonlyMap<string, string>>();
  for (const [name, own] of perWorker) {
    for (const reached of own.reachable) own.reasons.delete(reached);
    byWorker.set(name, own.reasons);
  }
  // The pure fold answers about the compositions it was handed and knows nothing about environments that
  // never became one. `projectSecretApplicability` is what takes them, so it is what reports them.
  return { project: reasons, byWorker, unresolved: [] };
}

/**
 * **A Worker has one composition per environment, not one composition.**
 *
 * `pithy init` scaffolds `originFor(compositionEnvironment(), DOMAINS)` into every `pithy.config.ts`, so
 * reading the environment *while the config is being evaluated* is a pattern the kit teaches. An adopter
 * who writes `auth({ google: { enabled: compositionEnvironment() === "prod" } })` has a project where
 * `auth-google-credentials` is needed in one environment and unreachable in the other two.
 *
 * Composed once, under whatever the command happened to run in, that project answers with the
 * composition of *no* environment at all: `compositionEnvironment()` is `undefined` in CLI-land, the
 * provider resolves as disabled, and a credential production reads is reported as **not applicable** and
 * taken out of doctor's outstanding work. Before #541 it was merely listed as missing. That is the one
 * way this feature can be worse than the bug it fixes, and it has no invocation that gets it right —
 * neither `doctor` nor `secrets ls` takes an `--env`, because a secret is per project, not per run.
 *
 * So the environment is an **input**, every declared one is taken, and a name in reach in any of them is
 * in reach. Exactly `composedPaths` in `ui/routeAllowlist.ts`, which stamps {@link ENVIRONMENT_VAR}
 * around each composition for the same reason and resolves the union the same way.
 *
 * **The union is over the compositions that exist, and not over the environments a project declares.** An
 * environment whose config throws produced no composition, so it is not in the union and contributes
 * nothing — see {@link UnresolvedEnvironment} for why counting it as *everything in reach* turned this
 * feature off wherever one environment was half-configured. The in-reach-anywhere rule is unchanged among
 * the compositions themselves, and that is what keeps the correction from becoming *mark everything*.
 *
 * ## Why the config is re-imported rather than re-composed
 *
 * `routeAllowlist` stamps and calls `createBackend` again, because the gate it is chasing is inside
 * `routes()` — registration time, after the config object exists. This gate is one level earlier: it is
 * an argument to `auth()`, evaluated while the module is being imported, and a module is imported once.
 * `loadWorkerConfig({ fresh: true })` is the loader that re-reads a config the process has already seen,
 * and it is what makes the second environment's answer a different answer rather than a copy of the first.
 *
 * That is the expensive half of this function, and why {@link composedManifests} is hoisted out of the
 * loop: a manifest scan reads `node_modules` and cannot vary with the environment.
 */
async function applicabilityIn(
  projectDir: string,
  environment: string,
  manifests: ReadonlyMap<string, CapabilityManifest[]>,
  loadConfig: FreshConfigLoader,
): Promise<{ workers: ApplicabilityWorker[]; unwritable: boolean; failed?: UnresolvedEnvironment }> {
  const previous = process.env[ENVIRONMENT_VAR];
  process.env[ENVIRONMENT_VAR] = environment;
  try {
    const workers = await resolveWorkers({ projectDir, loadConfig });
    return {
      workers: workers.map((worker) => applicabilityOf(worker, manifests.get(worker.dir) ?? [])),
      unwritable: false,
    };
  } catch (cause) {
    // **An environment that would not compose is not a composition, so it contributes nothing** — see
    // {@link UnresolvedEnvironment}. No capabilities, no registry, no configuration: nothing that could
    // have a requirement about any name. It is reported instead, which is where it belongs.
    //
    // It used to contribute every declared name *in reach*, and because the fold is "in reach anywhere
    // wins" that non-vote beat every environment that really did compose. One half-configured environment
    // turned the whole of #541 off, silently. Restoring it restores that.
    //
    // One failure is not about this environment at all: a checkout the process cannot write a fresh copy
    // into will fail identically for every remaining Worker and every remaining environment, and each
    // attempt is another doomed write into somebody's source tree. That one is reported upward so the
    // sweep stops after it.
    return {
      workers: [],
      unwritable: cause instanceof FreshCopyRefused,
      failed: { environment, reason: loadReason(cause) },
    };
  } finally {
    // Restored, not defaulted: a variable this process never had must not exist afterwards, or the next
    // thing to read `ENVIRONMENT` in this CLI run is told something the project never said.
    if (previous === undefined) delete process.env[ENVIRONMENT_VAR];
    else process.env[ENVIRONMENT_VAR] = previous;
  }
}

/**
 * The operator's sentence for why an environment would not compose.
 *
 * `action` first, then `message`, because that ordering is the error taxonomy's and not a preference:
 * `action` is the operator's field — it names the config, the setting, the command — and `message` is
 * the caller's. This line goes to a terminal, so the operator's is the one worth having. `detail` is
 * never read: it is the throw site's, for logs and audit alone (`CLAUDE.md` §Errors).
 *
 * A non-`PithyError` falls back to its own text, and something that is not an `Error` at all gets a
 * sentence rather than `[object Object]` — this is a diagnostic, and it runs in the broken project it
 * exists to diagnose.
 */
function loadReason(cause: unknown): string {
  if (cause instanceof PithyError) return cause.payload.action ?? cause.payload.message;
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  return "the composition threw something that is not an error";
}

/**
 * One Worker's half of the question, in the environment it was just composed under.
 *
 * This is the only thing that builds an {@link ApplicabilityWorker}, and it takes a composition that
 * exists. There is deliberately no counterpart for an environment that would not compose: such an
 * environment is not a composition, so it has nothing to contribute and nothing to build from.
 */
function applicabilityOf(worker: ResolvedWorker, manifests: readonly CapabilityManifest[]): ApplicabilityWorker {
  // Guarded, and the failure falls to *nothing declined* rather than to skipping the Worker — a Worker
  // with no say leaves its names in reach, which is the direction that cannot hide outstanding work.
  let declines: BindingDeclines;
  try {
    declines = workerDeclines({ manifests, capabilities: worker.capabilities, workerConfig: worker.config });
  } catch {
    declines = { state: "read", declines: [] };
  }
  return {
    name: worker.name,
    capabilities: worker.capabilities,
    registry: declaredSecrets(worker.capabilities),
    declines,
  };
}

/**
 * Every environment a composition is taken in: the ones the project declares, plus the local one.
 *
 * `dev` is added rather than asked for, because {@link DeclaredEnvironments} refuses it — it is the
 * top-level wrangler stanza, it never deploys, and it always exists. Declared first, so the reason a
 * marked secret reports is a deployed environment's rather than the laptop's.
 *
 * A root config that will not load falls to {@link DEFAULT_ENVIRONMENTS}, which is what an absent
 * `environments` declaration means anyway — never to the single environment this process happens to be.
 */
async function applicabilityEnvironments(projectDir: string): Promise<string[]> {
  const declared = await projectEnvironments(projectDir).catch(() => [...DEFAULT_ENVIRONMENTS]);
  return [...new Set([...declared, LOCAL_ENVIRONMENT])];
}

/** How one Worker's config is re-read, once per environment. See {@link ProjectApplicabilityOptions}. */
type FreshConfigLoader = (workerDir: string) => Promise<WorkerConfig>;

/** What {@link projectSecretApplicability} will take instead of reaching for the real thing. */
export interface ProjectApplicabilityOptions {
  /**
   * How a Worker's `pithy.config.ts` is re-read per environment. Defaults to
   * `loadWorkerConfig(dir, { fresh: true })`, which is the only loader that gives a *second* environment a
   * second answer rather than the first one's module.
   *
   * A seam because the failure that matters most here cannot be staged portably: a checkout this process
   * cannot write into is a `chmod` for everyone except the runner that happens to be root, and what the
   * sweep does about it — stop, rather than try once per Worker per environment — is only visible as a
   * count of attempts.
   */
  loadConfig?: FreshConfigLoader;
}

/**
 * The same question asked of a real project, in **every environment the project declares**. **Never
 * throws** — every caller is a reporting surface, and a diagnostic has to work in the broken environment
 * it exists to diagnose.
 *
 * An empty answer is what a directory that is not a project gives, and it is the safe one: nothing is
 * marked, so every surface renders exactly what it rendered before this existed.
 *
 * Each environment costs one fresh import of each Worker's config (see {@link applicabilityIn}), so a
 * caller asking twice in one run should ask once and pass the answer — `pithy doctor` does, through the
 * `inapplicable` seam its two secret checks take.
 *
 * **And a fresh import is a write into the adopter's Worker directory**, which is the one thing this
 * function does that its two callers never did before it existed: `pithy doctor` and `pithy secrets ls` are
 * read-only commands. The copies are removed on the ordinary path, on Ctrl-C, and by the next run's sweep
 * (`importFreshCopy`). Where they cannot be written at all — a read-only checkout, a container mount — the
 * first refusal ends the sweep: every remaining Worker and environment would fail the same way, and
 * answering nothing three times over is still answering nothing. **No environment composed, so both answers
 * are empty** and every name is in reach — not by a fallback policy, but because there is no composition to
 * have ruled anything out. Every environment is in {@link SecretApplicability.unresolved}, which is what
 * makes that empty answer readable as *nobody could ask* rather than as *nothing to say*.
 */
export async function projectSecretApplicability(
  projectDir: string,
  options: ProjectApplicabilityOptions = {},
): Promise<SecretApplicability> {
  const loadConfig = options.loadConfig ?? ((workerDir: string) => loadWorkerConfig(workerDir, { fresh: true }));
  // One unstamped resolution first, and only to answer which Workers there are — a project with none has
  // no composition to take in any environment, so there is no sweep to run.
  const base = await resolveWorkers({ projectDir }).catch(() => []);
  if (base.length === 0) return { project: new Map(), byWorker: new Map(), unresolved: [] };

  // Hoisted out of the environment loop: a manifest scan reads `node_modules`, which no `ENVIRONMENT`
  // changes, and it is the one part of this that would otherwise be repeated per environment for nothing.
  const manifests = new Map<string, CapabilityManifest[]>();
  for (const worker of base) {
    manifests.set(
      worker.dir,
      (await composedManifests(projectDir, worker.dir).catch(() => ({ manifests: [] }))).manifests,
    );
  }

  // Resolved once and walked once. The list is also what the early return below owes a reason for, and
  // asking twice would let a project whose root config changed mid-sweep answer two different questions.
  const environments = await applicabilityEnvironments(projectDir);
  const applicability: ApplicabilityWorker[] = [];
  const unresolved: UnresolvedEnvironment[] = [];
  for (const [index, environment] of environments.entries()) {
    const taken = await applicabilityIn(projectDir, environment, manifests, loadConfig);
    applicability.push(...taken.workers);
    if (taken.failed !== undefined) unresolved.push(taken.failed);
    // The tree, not the environment. Nothing after this could answer differently, and every attempt is one
    // more write into a directory that has already refused one.
    //
    // **The environments never reached are unresolved too, and saying so is the point.** None of them
    // became a composition, so none of them voted — and a reader owed the reason is owed it for every
    // environment the sweep gave up on, not only the one that happened to refuse first. Each carries that
    // refusal's own sentence, because it is why they were skipped and the one thing that would fix them.
    if (taken.unwritable) {
      const reason = taken.failed?.reason ?? "the checkout could not be written";
      const skipped = environments.slice(index + 1).map((name) => ({ environment: name, reason }));
      return { ...secretApplicability(applicability), unresolved: [...unresolved, ...skipped] };
    }
  }
  return { ...secretApplicability(applicability), unresolved };
}

/**
 * **The shared half of what a surface says about an environment that is not a composition (#548).**
 *
 * The head states what happened and the lines under it name each environment and the config's own action.
 * The *consequence* is the caller's own closing sentence, because the two surfaces run opposite risks:
 * `pithy secrets ls` marks, so its reader may be shown a mark an unloaded environment would have removed;
 * `pithy doctor` filters, so its reader may be shown work that environment would have settled. One fact,
 * worded once; two consequences, each worded where it is true.
 *
 * Empty for an empty list, which is the ordinary case — so a surface splices it in unconditionally and
 * prints nothing at all when every environment composed.
 */
export function unresolvedLines(unresolved: readonly UnresolvedEnvironment[]): string[] {
  if (unresolved.length === 0) return [];
  const count = unresolved.length === 1 ? "One environment" : `${unresolved.length} environments`;
  return [
    `${count} did not compose, so this answer is drawn from the rest.`,
    ...unresolved.map(({ environment, reason }) => `  ${environment}: ${reason}`),
  ];
}

/**
 * The names one Worker's capabilities declare, merged — the union, and deliberately not
 * `aggregateSecretRegistries`.
 *
 * That function is the Worker's own startup merge and it **refuses** two capabilities that describe one
 * name differently. Refusing is right there, where the composition is being built and the disagreement
 * decides which value gets read; here it would cost a reporting surface its whole answer over a fault
 * the Worker already raises at boot, and the axes it compares are not the ones this reads. So this
 * takes the union, first declaration winning, and asks only what a name is called and which binding it
 * addresses.
 *
 * The result is prototype-free, so a capability that names a secret `constructor` is a declared name
 * here and not a function inherited from `Object.prototype`.
 */
export function declaredSecrets(capabilities: readonly Capability[]): SecretRegistrySeam {
  const merged: SecretRegistrySeam = Object.create(null) as SecretRegistrySeam;
  for (const capability of capabilities) {
    for (const [name, entry] of Object.entries(capability.secretRegistry ?? {})) {
      if (!Object.hasOwn(merged, name)) merged[name] = entry;
    }
  }
  return merged;
}
