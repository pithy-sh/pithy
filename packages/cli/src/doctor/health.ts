// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { type AvailableManifests, availableManifests, type ManifestFault } from "../capabilities/manifests";
import type { MissingPrerequisite } from "../capabilities/prerequisites";
import {
  type BindingDeclines,
  type BuildReconcilePlanOptions,
  buildReconcilePlan,
  type CapabilityReconcile,
  type EntitlementGap,
  type GeneratedValues,
  type ReadLedger,
  type ReconcilePlan,
} from "../capabilities/reconcile";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { type BindingScopeHealth, bindingScopeHealth } from "./bindingScope";
import { type CapabilityReachHealth, type ComposedWorker, capabilityReachHealth } from "./capabilityReach";
import {
  type ComposeWorker,
  composeWorkerFor,
  type EnvironmentMigrations,
  environmentMigrations,
  type RemoteSkip,
  type WorkerComposition,
} from "./environmentMigrations";

/**
 * The read-only project-health engine behind `pithy doctor`'s `Project health` block — the *same*
 * {@link buildReconcilePlan} `pithy upgrade` runs, rendered without writing (one engine, two commands).
 * `upgrade` fixes the drift this reports; `doctor` only surfaces it and drives a non-zero exit so CI can
 * gate on a project whose wiring has fallen out of sync with its installed capabilities.
 *
 * Health is **per Worker**, because the wiring is: each Worker under `apps/` has its own `pithy.config.ts`
 * and `wrangler.jsonc`, so each drifts independently. One unhealthy Worker makes the project unhealthy.
 */

/** The `config` check: capabilities whose `pithy.config.ts` registration is missing manifest options. */
export interface ConfigHealth {
  ok: boolean;
  /** Per drifting capability: the option keys not yet written into its registration. */
  drift: { capability: string; keys: string[] }[];
}

/**
 * The `bindings` check: required bindings absent from `wrangler.jsonc`, each with the envs that lack it —
 * **and the Durable Object classes the Worker's entry does not export.**
 *
 * One check, because a Durable Object is one binding written in two files. The `durable_objects.bindings`
 * entry names a `class_name` and wrangler resolves that name against the module `main` names; a Worker
 * carrying the first and not the second is refused at deploy. Reporting only the half that lives in
 * `wrangler.jsonc` is what let `doctor` call a project healthy that `wrangler deploy` would not take
 * (#428).
 */
export interface BindingHealth {
  ok: boolean;
  missing: { name: string; type: string; envs: string[] }[];
  /** Durable Object classes bound in `wrangler.jsonc` that this Worker's entry does not export. */
  missingExports: string[];
  /**
   * Optional bindings this Worker's `pithy.config.ts` declines, resolved against what it composes.
   *
   * Taken from the plan **by reference**, never re-projected: `groupMissingBindings` below constructs a
   * fresh object per binding, and a field that had to survive that construction is a field the two
   * commands would eventually disagree about — which is #440 itself, one level up.
   *
   * An honored decline does not fail `ok`. A decline that cannot be honored does, because it means
   * the adopter believes a binding is being left out that is not.
   */
  declinedBindings: BindingDeclines;
  /**
   * Generated binding values this Worker holds that the current kit would derive differently, with each
   * `pinnedBindings` entry resolved (#499).
   *
   * Taken from the plan by reference, on the rule the field above states.
   *
   * **It never fails `ok`, and that is the finding, not a softening of it.** The adopter's value may be
   * the one they meant — a limiter is theirs to tune — and a generated value already deployed is a live
   * identity rather than a default. A red here would be a red no command clears, on a project that is
   * working. So it reports, it says what the kit would write now, and the decision stays the adopter's.
   */
  generatedValues: GeneratedValues;
}

/**
 * The `migrations` check: **every environment's** ledger against what this Worker declares for that
 * environment — both directions, one answer per environment (#586).
 *
 * `pending` alone passed a database `pithy migrate` refused to touch. An extra applied migration is
 * invisible to declared-minus-applied: nothing is missing, so nothing is pending, so the check was
 * green while the migrator read the same ledger as a corrupted chain and applied nothing (#282). Each
 * half fails the check on its own, because either one means the schema is not where the project says.
 *
 * It was one environment, and it was `dev`'s, whatever the reader believed they had asked about (#586).
 * Each environment is now its own {@link EnvironmentMigrations}, composed for itself and read for itself.
 */
export interface MigrationHealth {
  /**
   * `dev`'s answer alone: checked, every database read, nothing pending and nothing undeclared.
   *
   * **A deployed environment is reported and never fails the exit.** Its read reaches an account, so it
   * is skipped offline and without credentials, and an answer that exists on one machine and not another
   * cannot gate CI. Its schema trailing the project is also the ordinary state between a merge and the
   * `pithy migrate --env` a deploy runs — a red over it would be a red on every project mid-release.
   * `dev` is the local store, established on this machine from this checkout, which is the standard every
   * exit-gating finding in `pithy doctor` meets.
   */
  ok: boolean;
  /**
   * One answer per environment, `dev` first, then the declared ones in declaration order. Each carries its
   * ledger behind its own discriminant, never flattened (#371): a database that could not be read is not
   * `0 pending`.
   */
  environments: EnvironmentMigrations[];
}

/**
 * The `entitlements` check: routes gated on an entitlement with no capability composed to resolve one.
 * The seam fails closed, so this Worker would deny every gated route in production and look, to the
 * runtime, exactly like a project full of unentitled users. Unlike the other three checks, `pithy upgrade`
 * cannot fix it — which capability to compose is the adopter's decision, so this only ever reports.
 */
export interface EntitlementHealth {
  ok: boolean;
  /**
   * The scan's answer, exactly as the plan carried it (#371) — the file list behind its discriminant.
   *
   * A flat `gates: []` said "no gap" and "no scan" in the same two characters, and only one of those is
   * good news.
   */
  gap: EntitlementGap;
}

/**
 * The `prerequisites` check: a composed capability whose manifest declares a peer this Worker does not
 * compose.
 *
 * **The only check here that is a boot failure rather than drift.** `createBackend` refuses to assemble
 * on exactly this pair, so the Worker does not start at all — which is what `pithy add auth` used to
 * leave behind, on a project this command called healthy (#273). It reports and does not fix, like the
 * entitlement gap: `pithy upgrade` writes bindings and config keys, and composing a capability is a
 * different kind of decision. The line names the command that makes it.
 */
export interface PrerequisiteHealth {
  ok: boolean;
  /** Each composed capability paired with the peer it declares and this Worker lacks. */
  missing: MissingPrerequisite[];
}

/** One Worker's five checks, when the plan behind them was built. `ok` is their AND. */
export interface WorkerChecks {
  config: ConfigHealth;
  bindings: BindingHealth;
  migrations: MigrationHealth;
  entitlements: EntitlementHealth;
  prerequisites: PrerequisiteHealth;
}

/**
 * One Worker's health — **or that this Worker could not be checked at all (#371)**.
 *
 * The plan behind a Worker's five checks reads that Worker's own `pithy.config.ts` and `wrangler.jsonc`
 * and, through the ledger, its databases. Any of that can fail for reasons that belong to one Worker: a
 * config that will not import, a stanza that will not parse. It used to throw out of the loop, and one
 * Worker in that state erased every *other* Worker's config, bindings, migrations, entitlement and
 * prerequisite lines — from the command whose whole job is to say which part of a project is broken.
 *
 * **The state rides on the value**, so an unchecked Worker cannot be rendered as a checked one. The five
 * checks live behind `checked`, and `unavailable` carries nothing but the Worker's name: a Worker with no
 * `ok`, no empty drift lists and no `0 pending` to mistake for a clean bill.
 *
 * This is the same treatment the *manifest* half of {@link buildProjectHealth} got under #184. It was
 * applied to one loop in this file and not the other.
 */
export type WorkerHealth =
  | ({
      /** The plan was built and every check ran. */
      state: "checked";
      /** The Worker's name, as `pithy worker list` shows it. */
      worker: string;
      /** The AND of the five checks below. */
      ok: boolean;
    } & WorkerChecks)
  | {
      /** The plan could not be built, so nothing is known about this Worker. */
      state: "unavailable";
      /** The Worker's name, as `pithy worker list` shows it. */
      worker: string;
    };

/**
 * The `manifests` check: installed packages whose `pithy.manifest.json` is present and unusable.
 *
 * Project-wide rather than per Worker, because manifests resolve once from the project root. It fails the
 * doctor exit for the same reason the others do: a capability nobody can read is a capability every check
 * below silently leaves out, and `doctor` reporting a healthy project around that hole is what #184 was
 * reported about. `pithy upgrade` cannot fix it — the manifest belongs to someone else's package.
 */
export interface ManifestHealth {
  ok: boolean;
  faults: ManifestFault[];
}

/** The whole project's health: one entry per Worker, plus the project-wide manifest read. `ok` is the AND. */
export interface ProjectHealth {
  ok: boolean;
  workers: WorkerHealth[];
  manifests: ManifestHealth;
  /**
   * The `bindingScope` check: a resource the whole project shares, bound to more than one of it (#513).
   *
   * Project-wide rather than per Worker, because the property is: the app Worker's stanzas and every
   * other Worker's have to name the *same* database, so a per-Worker answer cannot see the disagreement
   * it exists to find. `pithy provision --env <env>` fixes what it reports; `pithy upgrade` cannot,
   * because repointing a binding is not adding one.
   */
  bindingScope: BindingScopeHealth;
  /**
   * The `capabilities` check: a capability this project composes that the CLI cannot resolve (#533).
   *
   * Project-wide rather than per Worker because the resolution is: a Worker's `pithy.config.ts` resolves
   * its own imports from `apps/<name>/`, and every `pithy <capability> …` command resolves the same
   * package from the **project root**. The finding is that the two disagree, so it belongs to neither
   * Worker on its own. Neither `pithy upgrade` nor `pithy provision` can act on it — it is an install.
   */
  capabilityReach: CapabilityReachHealth;
}

/** The manifest-scan seam: defaults to {@link availableManifests}, the scan every capability command reads. */
export type ReadManifests = (projectDir: string) => Promise<AvailableManifests>;

/** The plan-builder seam: defaults to {@link buildReconcilePlan}, the engine `upgrade` shares. */
export type BuildPlan = (options: BuildReconcilePlanOptions) => Promise<ReconcilePlan>;

/** The project-global binding seam: defaults to {@link bindingScopeHealth}. */
export type ReadBindingScope = (projectDir: string) => Promise<BindingScopeHealth>;

/**
 * The capability-resolution seam: defaults to {@link capabilityReachHealth}.
 *
 * It takes the Workers as well as the root, unlike its neighbor, because the question is about the
 * composition and not only about the directory: what is composed comes from the Workers, and where the
 * CLI looks for it comes from the root.
 */
export type ReadCapabilityReach = (
  projectDir: string,
  workers: readonly ComposedWorker[],
) => Promise<CapabilityReachHealth>;

/** The shared engine, exported so a test can assert doctor and upgrade use one implementation. */
export const defaultBuildPlan: BuildPlan = buildReconcilePlan;

/**
 * The minimum a health check needs to know about a Worker: which one, and where. **Never what it composes** —
 * every check reads the Worker as composed for its own environment, through
 * {@link ProjectHealthOptions.composeWorker} (#586).
 */
export interface HealthWorker {
  /** The Worker's name. */
  name: string;
  /** The Worker's directory (`apps/<name>/`) — the config and wrangler stanzas the plan reads. */
  dir: string;
}

/** Options for {@link buildProjectHealth}. */
export interface ProjectHealthOptions {
  /** The project root — where the capability manifests resolve from. */
  projectDir: string;
  /**
   * The deployed environments the root `pithy.config.ts` declares, in declaration order. The migration
   * check answers each of them and `dev` besides, each composed and read for itself (#586).
   */
  environments: readonly string[];
  /**
   * Why a deployed environment's ledger will not be read this run — `offline`, `no-credentials` — or `null`
   * when it will. `doctor` decides it from the same resolution its `Cloudflare:` block reports on.
   */
  remoteSkip: RemoteSkip | null;
  /**
   * The Cloudflare account this project belongs to, or `null` when it names none. `doctor` already
   * resolves it for the `Cloudflare:` block; the migration reads are what need it, and they were reading
   * whichever credentials file the machine defaulted to (#234).
   */
  account: CloudflareAccountSelection | null;
  /** The Workers to check, in report order. Doctor resolves them once and passes them in. */
  workers: HealthWorker[];
  /** Test seam: read the migration ledger without a real Miniflare/D1 run. */
  readLedger?: ReadLedger;
  /**
   * Composition seam: one Worker as evaluated for one environment. Defaults to that Worker's own config
   * loaded through `composeFor` — see `doctor/environmentMigrations.ts`. Called once per Worker per
   * environment, and that one composition answers both the environment's migrations and its plan.
   */
  composeWorker?: ComposeWorker;
  /** Test seam: substitute the plan builder. Defaults to the shared reconcile engine. */
  buildPlan?: BuildPlan;
  /** Test seam: substitute the manifest scan. Defaults to the real `node_modules/@pithy-sh` read. */
  readManifests?: ReadManifests;
  /** Test seam: substitute the project-global binding comparison. Defaults to the real wrangler read. */
  readBindingScope?: ReadBindingScope;
  /** Test seam: substitute the capability-resolution check. Defaults to the real `node_modules` read. */
  readCapabilityReach?: ReadCapabilityReach;
}

/** Group a plan's per-capability missing bindings into one entry per binding, listing the envs that lack it. */
function groupMissingBindings(plan: ReconcilePlan): BindingHealth["missing"] {
  const byKey = new Map<string, { name: string; type: string; envs: string[] }>();
  for (const cap of plan.perCapability) {
    for (const binding of cap.missingBindings) {
      const key = `${binding.name} ${binding.type}`;
      const entry = byKey.get(key) ?? { name: binding.name, type: binding.type, envs: [] };
      if (!entry.envs.includes(binding.env)) entry.envs.push(binding.env);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/**
 * **One Worker's plan, with every per-environment part of it taken from that environment's own plan.**
 *
 * A plan reports, for every stanza in `wrangler.jsonc`, the bindings its composition needs there and the
 * stanza lacks. Which bindings a stanza needs is its composition's to say, so a declared environment's
 * stanza is taken from the plan built for that environment and from no other: `dev`'s plan saying what
 * `prod` lacks is `dev`'s composition answering for `prod` (#586). A stanza no environment declares has no
 * composition of its own, so `dev`'s answer stands for it, and `Environments:` reports the stanza. A
 * declared environment with no plan — its config did not compose — contributes nothing, and `dev`'s answer
 * does not stand in for it; `Environment configs:` fails the exit on that config.
 *
 * Three findings are properties of a composition rather than of a stanza, and each environment's is
 * added to `dev`'s: a Durable Object class any environment binds is an export the one entry needs, an option
 * key missing from a capability only `prod` composes is still missing from the one registration, and a
 * prerequisite `prod`'s composition lacks is a Worker that does not start in `prod`.
 *
 * The rest — declines, generated values, entitlements, ejected capabilities — is `dev`'s plan, from `dev`'s
 * composition, and is what {@link buildProjectHealth} says it is.
 */
function mergeEnvironmentPlans(
  local: ReconcilePlan,
  deployed: ReadonlyMap<string, ReconcilePlan | null>,
): ReconcilePlan {
  const byName = new Map<string, CapabilityReconcile>();
  for (const cap of local.perCapability) {
    byName.set(cap.name, {
      ...cap,
      missingBindings: cap.missingBindings.filter((binding) => !deployed.has(binding.env)),
    });
  }
  const prerequisites = [...local.missingPrerequisites];
  for (const [env, plan] of deployed) {
    if (plan === null) continue;
    for (const cap of plan.perCapability) {
      const entry = byName.get(cap.name) ?? {
        name: cap.name,
        missingBindings: [],
        missingConfigKeys: [],
        missingEntryExports: [],
      };
      entry.missingBindings = [
        ...entry.missingBindings,
        ...cap.missingBindings.filter((binding) => binding.env === env),
      ];
      entry.missingEntryExports = [...new Set([...entry.missingEntryExports, ...cap.missingEntryExports])];
      const keys = new Set(entry.missingConfigKeys.map((option) => option.key));
      entry.missingConfigKeys = [
        ...entry.missingConfigKeys,
        ...cap.missingConfigKeys.filter((option) => !keys.has(option.key)),
      ];
      byName.set(cap.name, entry);
    }
    for (const missing of plan.missingPrerequisites) {
      const known = prerequisites.some(
        (entry) => entry.capability === missing.capability && entry.requires === missing.requires,
      );
      if (!known) prerequisites.push(missing);
    }
  }
  const perCapability = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { ...local, perCapability, missingPrerequisites: prerequisites };
}

/**
 * The `migrations` check from its per-environment answers. `ok` is `dev`'s alone — see
 * {@link MigrationHealth.ok} for why a deployed environment reports and does not gate.
 */
function migrationHealth(environments: EnvironmentMigrations[]): MigrationHealth {
  const local = environments.find((entry) => entry.env === LOCAL_ENVIRONMENT);
  // `ok` only on a whole read with nothing on either side of it. A `partial` ledger is a database this
  // check did not compare, and a check that did not run is not a check that passed — the same standard
  // `pithy doctor` already applies to a manifest it could not parse (#184).
  const ok =
    local?.state === "checked" &&
    local.ledger.state === "read" &&
    local.ledger.pending === 0 &&
    local.ledger.undeclared.length === 0;
  return { ok, environments };
}

/** Project one Worker's reconcile plan, and its per-environment migration answers, into its five checks. */
function healthFromPlan(worker: string, plan: ReconcilePlan, migrations: MigrationHealth): WorkerHealth {
  const drift = plan.perCapability
    .filter((cap) => cap.missingConfigKeys.length > 0)
    .map((cap) => ({ capability: cap.name, keys: cap.missingConfigKeys.map((key) => key.key) }));
  const config: ConfigHealth = { ok: drift.length === 0, drift };

  const missing = groupMissingBindings(plan);
  // Deduplicated across capabilities: two capabilities binding one class is one missing export.
  const missingExports = [...new Set(plan.perCapability.flatMap((cap) => cap.missingEntryExports))];
  // A decline that cannot be honored is a defect in the declaration and fails the check. `unrecognized`
  // does not: `pithy remove <capability>` produces it, and a red no command can clear is worse than the
  // line that reports it.
  const declinedBindings = plan.declinedBindings;
  const generatedValues = plan.generatedValues;
  const badDeclines =
    declinedBindings.state === "invalid" ||
    declinedBindings.declines.some((decline) => decline.state === "required" || decline.state === "undeclinable");
  const bindings: BindingHealth = {
    ok: missing.length === 0 && missingExports.length === 0 && !badDeclines,
    missing,
    missingExports,
    declinedBindings,
    generatedValues,
  };

  // `ok` only on a scan that ran and found nothing, on the same standard the migrations check applies: a
  // check that did not run is not a check that passed.
  const gap = plan.entitlements;
  const entitlements: EntitlementHealth = { ok: gap.state === "read" && gap.gates.length === 0, gap };

  const prerequisites: PrerequisiteHealth = {
    ok: plan.missingPrerequisites.length === 0,
    missing: plan.missingPrerequisites,
  };

  return {
    state: "checked",
    worker,
    ok: config.ok && bindings.ok && migrations.ok && entitlements.ok && prerequisites.ok,
    config,
    bindings,
    migrations,
    entitlements,
    prerequisites,
  };
}

/**
 * Build the project's health from one read-only reconcile plan per Worker per environment. For each Worker,
 * `config` fails when a capability's `pithy.config.ts` registration is missing manifest options; `bindings`
 * fails when a required binding is absent from an environment; `migrations` reports every environment and
 * fails when `dev` has unapplied migrations **or** has applied one this Worker no longer declares;
 * `entitlements` fails when a route gates on an entitlement no composed capability resolves; `prerequisites`
 * fails when a composed capability declares a peer the Worker does not compose, which is the one that means
 * the Worker will not start at all. The project is healthy only when every Worker is. Writes nothing — safe
 * to run on every `pithy doctor` invocation.
 *
 * ## The invariant, and where it stops
 *
 * **No per-environment answer here is taken from a composition built for another environment, or for
 * none (#586).** Every Worker is composed once for each environment, through `composeWorker` — the primitive
 * in `project/composeFor.ts` by default — and nothing in this function holds a composition it did not get
 * from there. An environment's migrations, the bindings its stanza lacks, and what its composition asks of
 * the entry, the registration and the other capabilities are that environment's.
 *
 * What is `dev`'s, and said to be: declines, generated values, entitlements and ejected capabilities come
 * from the plan built for `dev`. A config that declines a binding in `prod` alone, or composes an
 * entitlement provider for `prod` alone, is answered by `dev`'s composition on those four lines.
 */
export async function buildProjectHealth(options: ProjectHealthOptions): Promise<ProjectHealth> {
  const build = options.buildPlan ?? defaultBuildPlan;
  const scan = options.readManifests ?? availableManifests;
  const readScope = options.readBindingScope ?? bindingScopeHealth;
  const readReach = options.readCapabilityReach ?? capabilityReachHealth;

  // Read once, at the project, because that is where manifests live: one install under the root's
  // `node_modules/@pithy-sh`, shared by every Worker. Every plan below is built from the same scan, so a
  // capability whose manifest will not read is missing from every Worker's checks at once — which is the
  // hole this reports, and the reason it is not a per-Worker line.
  const { faults } = await scan(options.projectDir);

  // Read once, at the project, for the reason the manifest scan is: a project-global resource is shared
  // *between* Workers, so the disagreement lives across them and no per-Worker answer can see it.
  const bindingScope = await readScope(options.projectDir);

  // **One Worker at a time (#371).** The wiring is per Worker, so a failure to read it is per Worker too —
  // and this is a diagnostic, so one Worker nobody could check must never cost the report on the others.
  // The manifest scan above is not a contributor to this loop: it is read once, at the project, and every
  // plan is built from it, which is why it is a project-wide line and why it still throws.
  //
  // The guard takes no binding. A plan reaches a customer's D1 and imports their config, so what it throws
  // is throw-site context; the Worker's name is the actionable fact and `doctor` already prints it.
  //
  // **Every environment, each answered for itself (#586).** `dev` first, then the declared ones in the
  // order the project declares them. Each Worker is composed once per environment, and that one composition
  // answers both that environment's migrations and that environment's plan. `environmentMigrations` never
  // throws, so an environment that cannot be answered costs its own line and not its neighbors'.
  //
  // **No part of this answers from a composition for another environment, or for none.** The per-environment
  // parts — migrations, and the bindings each declared stanza lacks — are each environment's own. The rest
  // of a Worker's checks — config drift, declines, generated values, entitlements, prerequisites — are the
  // plan for `dev`, built from the composition for `dev`: the Worker as `pithy dev` runs it, and named so.
  const compose = options.composeWorker ?? composeWorkerFor;
  const environments = [LOCAL_ENVIRONMENT, ...options.environments.filter((env) => env !== LOCAL_ENVIRONMENT)];
  const workers: WorkerHealth[] = [];
  // Each Worker's compositions that succeeded, in environment order, for the capability-resolution read.
  const composedByWorker: WorkerComposition[][] = [];
  for (const worker of options.workers) {
    const target = { name: worker.name, dir: worker.dir };
    const compositions = new Map<string, Promise<WorkerComposition>>();
    const composed: ComposeWorker = (_worker, env) => {
      const known = compositions.get(env);
      if (known !== undefined) return known;
      const composition = compose(target, env);
      // Held for the plan below, which awaits it again; the migration answer reads the rejection first.
      composition.catch(() => undefined);
      compositions.set(env, composition);
      return composition;
    };
    const answers: EnvironmentMigrations[] = [];
    for (const env of environments) {
      answers.push(
        await environmentMigrations({
          projectDir: options.projectDir,
          worker: target,
          env,
          account: options.account,
          remoteSkip: options.remoteSkip,
          compose: composed,
          ...(options.readLedger ? { readLedger: options.readLedger } : {}),
        }),
      );
    }

    // One plan per environment that composed. The plan is `upgrade`'s engine and reads one environment's
    // ledger; doctor has just read every environment's, so each plan is handed that answer rather than
    // reading the store a second time.
    const planFor = async (env: string): Promise<ReconcilePlan | null> => {
      let composition: WorkerComposition;
      try {
        composition = await composed(target, env);
      } catch {
        return null;
      }
      const answer = answers.find((entry) => entry.env === env);
      return build({
        projectDir: options.projectDir,
        workerDir: worker.dir,
        worker: worker.name,
        env,
        account: options.account,
        capabilities: composition.capabilities,
        ...(composition.config ? { workerConfig: composition.config } : {}),
        readLedger: async () => (answer?.state === "checked" ? answer.ledger : { state: "unavailable" }),
      });
    };

    let plan: ReconcilePlan | null;
    try {
      const local = await planFor(LOCAL_ENVIRONMENT);
      const deployed = new Map<string, ReconcilePlan | null>();
      // `dev` did not compose: nothing on this Worker's checks has a composition to be answered from.
      if (local !== null) for (const env of environments.slice(1)) deployed.set(env, await planFor(env));
      plan = local === null ? null : mergeEnvironmentPlans(local, deployed);
    } catch {
      plan = null;
    }
    workers.push(
      plan === null
        ? { state: "unavailable", worker: worker.name }
        : healthFromPlan(worker.name, plan, migrationHealth(answers)),
    );
    const succeeded: WorkerComposition[] = [];
    for (const env of environments) {
      try {
        succeeded.push(await composed(target, env));
      } catch {
        // Not composed for `env`: its migrations line says so, and `Environment configs:` fails the exit.
      }
    }
    composedByWorker.push(succeeded);
  }

  // Read once, at the project, for the reason both of the above are: the CLI resolves every capability
  // from the project root, so "can this be reached" has one answer for the whole project however many
  // Workers compose it. The Workers are handed over for what they compose, never for where to look — and
  // what they compose is every environment's composition, so a capability one environment composes alone
  // is still asked about (#586). An environment that did not compose contributes nothing.
  const reachable: ComposedWorker[] = [];
  for (const [index, worker] of options.workers.entries()) {
    const seen = new Map<string, Capability>();
    for (const composition of composedByWorker[index] ?? []) {
      for (const capability of composition.capabilities)
        if (!seen.has(capability.name)) seen.set(capability.name, capability);
    }
    reachable.push({ name: worker.name, dir: worker.dir, capabilities: [...seen.values()] });
  }
  const capabilityReach = await readReach(options.projectDir, reachable);

  const manifests: ManifestHealth = { ok: faults.length === 0, faults };
  // An unchecked Worker fails the project, on the same standard #184 set for an unreadable manifest: a
  // check that did not run established nothing, and a report calling a project healthy around a hole is
  // the under-report this whole family exists to prevent. It is also what the behavior already was —
  // the throw reached `pithy doctor`'s catch and drove a non-zero exit — so the gate does not weaken.
  const checked = workers.every((worker) => worker.state === "checked" && worker.ok);
  return {
    ok: manifests.ok && bindingScope.ok && capabilityReach.ok && checked,
    workers,
    manifests,
    bindingScope,
    capabilityReach,
  };
}
