// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { type AvailableManifests, availableManifests, type ManifestFault } from "../capabilities/manifests";
import type { MissingPrerequisite } from "../capabilities/prerequisites";
import {
  type BuildReconcilePlanOptions,
  buildReconcilePlan,
  type EntitlementGap,
  type ReadLedger,
  type ReconcilePlan,
} from "../capabilities/reconcile";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import type { ProjectLedger, readProjectLedger } from "../migrations/run";

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

/** The `bindings` check: required bindings absent from `wrangler.jsonc`, each with the envs that lack it. */
export interface BindingHealth {
  ok: boolean;
  missing: { name: string; type: string; envs: string[] }[];
}

/**
 * The `migrations` check: the target environment's ledger against what this Worker declares — **both
 * directions**.
 *
 * `pending` alone passed a database `pithy migrate` refused to touch. An extra applied migration is
 * invisible to declared-minus-applied: nothing is missing, so nothing is pending, so the check was
 * green while the migrator read the same ledger as a corrupted chain and applied nothing (#282). Each
 * half fails the check on its own, because either one means the schema is not where the project says.
 */
export interface MigrationHealth {
  ok: boolean;
  /**
   * The environment's ledger, exactly as {@link readProjectLedger} answered it — the counts behind their
   * discriminant rather than flattened onto this object (#371).
   *
   * Flattening was the fault. A database that could not be read contributed nothing to `pending`, so a
   * project whose D1 was unreachable read as `0 pending` — the same two fields a healthy project has, and
   * a green line about a schema nobody had compared.
   */
  ledger: ProjectLedger;
  env: string;
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
}

/** The manifest-scan seam: defaults to {@link availableManifests}, the scan every capability command reads. */
export type ReadManifests = (projectDir: string) => Promise<AvailableManifests>;

/** The plan-builder seam: defaults to {@link buildReconcilePlan}, the engine `upgrade` shares. */
export type BuildPlan = (options: BuildReconcilePlanOptions) => Promise<ReconcilePlan>;

/** The shared engine, exported so a test can assert doctor and upgrade use one implementation. */
export const defaultBuildPlan: BuildPlan = buildReconcilePlan;

/** The minimum a health check needs to know about a Worker — what `resolveWorkers` already returns. */
export interface HealthWorker {
  /** The Worker's name. */
  name: string;
  /** The Worker's directory (`apps/<name>/`) — the config and wrangler stanzas the plan reads. */
  dir: string;
  /** That Worker's composed capabilities, forwarded to the plan for its migration count. */
  capabilities?: Capability[];
}

/** Options for {@link buildProjectHealth}. */
export interface ProjectHealthOptions {
  /** The project root — where the capability manifests resolve from. */
  projectDir: string;
  /** The environment the migration check is computed for. */
  env: string;
  /**
   * The Cloudflare account this project belongs to, or `null` when it names none. `doctor` already
   * resolves it for the `Cloudflare:` block; the pending-migration count inside each plan is the read
   * that needs it, and it was reading whichever credentials file the machine defaulted to (#234).
   */
  account: CloudflareAccountSelection | null;
  /** The Workers to check, in report order. Doctor resolves them once and passes them in. */
  workers: HealthWorker[];
  /** Test seam: read the migration ledger without a real Miniflare/D1 run. */
  readLedger?: ReadLedger;
  /** Test seam: substitute the plan builder. Defaults to the shared reconcile engine. */
  buildPlan?: BuildPlan;
  /** Test seam: substitute the manifest scan. Defaults to the real `node_modules/@pithy-sh` read. */
  readManifests?: ReadManifests;
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

/** Project one Worker's reconcile plan into its three health checks. */
function healthFromPlan(worker: string, plan: ReconcilePlan): WorkerHealth {
  const drift = plan.perCapability
    .filter((cap) => cap.missingConfigKeys.length > 0)
    .map((cap) => ({ capability: cap.name, keys: cap.missingConfigKeys.map((key) => key.key) }));
  const config: ConfigHealth = { ok: drift.length === 0, drift };

  const missing = groupMissingBindings(plan);
  const bindings: BindingHealth = { ok: missing.length === 0, missing };

  // `ok` only on a whole read with nothing on either side of it. A `partial` ledger is a database this
  // check did not compare, and a check that did not run is not a check that passed — the same standard
  // `pithy doctor` already applies to a manifest it could not parse (#184). It is also what today's
  // behaviour was: an unreadable ledger threw, and the exit was non-zero.
  const ledger = plan.ledger;
  const migrations: MigrationHealth = {
    ok: ledger.state === "read" && ledger.pending === 0 && ledger.undeclared.length === 0,
    ledger,
    env: plan.env,
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
 * Build the project's health from one read-only reconcile plan per Worker. For each Worker, `config` fails
 * when a capability's `pithy.config.ts` registration is missing manifest options; `bindings` fails when a
 * required binding is absent from an environment; `migrations` fails when the target env has unapplied migrations **or** has applied one
 * this Worker no longer declares; `entitlements` fails when a route gates on an entitlement no composed capability resolves;
 * `prerequisites` fails when a composed capability declares a peer the Worker does not compose, which is
 * the one that means the Worker will not start at all. The project is healthy only when every Worker is.
 * Writes nothing — safe to run on every `pithy doctor` invocation.
 */
export async function buildProjectHealth(options: ProjectHealthOptions): Promise<ProjectHealth> {
  const build = options.buildPlan ?? defaultBuildPlan;
  const scan = options.readManifests ?? availableManifests;

  // Read once, at the project, because that is where manifests live: one install under the root's
  // `node_modules/@pithy-sh`, shared by every Worker. Every plan below is built from the same scan, so a
  // capability whose manifest will not read is missing from every Worker's checks at once — which is the
  // hole this reports, and the reason it is not a per-Worker line.
  const { faults } = await scan(options.projectDir);

  // **One Worker at a time (#371).** The wiring is per Worker, so a failure to read it is per Worker too —
  // and this is a diagnostic, so one Worker nobody could check must never cost the report on the others.
  // The manifest scan above is not a contributor to this loop: it is read once, at the project, and every
  // plan is built from it, which is why it is a project-wide line and why it still throws.
  //
  // The guard takes no binding. A plan reaches a customer's D1 and imports their config, so what it throws
  // is throw-site context; the Worker's name is the actionable fact and `doctor` already prints it.
  const workers: WorkerHealth[] = [];
  for (const worker of options.workers) {
    let plan: ReconcilePlan;
    try {
      plan = await build({
        projectDir: options.projectDir,
        workerDir: worker.dir,
        worker: worker.name,
        env: options.env,
        account: options.account,
        capabilities: worker.capabilities,
        readLedger: options.readLedger,
      });
    } catch {
      workers.push({ state: "unavailable", worker: worker.name });
      continue;
    }
    workers.push(healthFromPlan(worker.name, plan));
  }

  const manifests: ManifestHealth = { ok: faults.length === 0, faults };
  // An unchecked Worker fails the project, on the same standard #184 set for an unreadable manifest: a
  // check that did not run established nothing, and a report calling a project healthy around a hole is
  // the under-report this whole family exists to prevent. It is also what the behaviour already was —
  // the throw reached `pithy doctor`'s catch and drove a non-zero exit — so the gate does not weaken.
  const checked = workers.every((worker) => worker.state === "checked" && worker.ok);
  return { ok: manifests.ok && checked, workers, manifests };
}
