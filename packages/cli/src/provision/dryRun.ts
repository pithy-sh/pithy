// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { FeatureIdentity, FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import type { CliAuditEmit } from "../audit/cliAudit";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { featureHostCapabilities, featureHostScripts } from "../feature/hosts";
import { planMigrateProject } from "../migrations/run";
import { emptyPlan, type Plan, type PlanMigration, type PlanResource, type PlanSecret } from "../plan/plan";
import { inShadow } from "../plan/shadow";
import type { BackendRunner, ProvisionReport, ProvisionWorker } from "./environment";
import type { ResourceProvisioner, ResourceProvisioners } from "./resources";
import type { SecretsStore } from "./store";

/**
 * **`pithy provision --dry-run`: the real provisioning, in a copy of the project, against an account that is
 * only read (#697).**
 *
 * Provisioning is not described here, for the reason `pithy add --dry-run` is not: the find-or-create loop,
 * the declines, the scoped script names, the service targets and the stanza writer each have rules of their
 * own, and a plan written beside them would be a second copy of every one. So the run runs — in a private
 * copy of the project, with the seams that would reach past it swapped:
 *
 * - **the account is asked, never changed.** `find` goes to Cloudflare exactly as the run's does, so a
 *   resource of the right name is reported as adopted. `create` makes nothing: it hands back a placeholder
 *   id, and the copy's `wrangler.jsonc` carries it, so the diff shows where the new id would land;
 * - **the Secrets Store is asked, never written.** `exists` is the run's own read. A mint generates a value
 *   in memory, as the run's does, and drops it — it is reported as a mint by name, never by value;
 * - **migrate and seed run nothing.** The migrations are planned by `planMigrateProject` against the copy,
 *   once its stanzas carry the ids: an adopted database is read for what it has applied, and one the run
 *   would create has applied nothing, so every migration it carries is listed;
 * - **the audit records nothing.**
 *
 * **Without credentials there is no plan.** The run refuses before it creates anything, and a dry run makes
 * every refusal the run makes before it plans (`docs/CLI.md` §1.2), so the command refuses first, in the
 * run's words, and this is only ever handed an account it can ask.
 */

/** What the run is handed in place of the seams that would reach past the project. */
export interface ProvisionPlanSeams {
  /** The copy's root, where `apps/` is. */
  projectDir: string;
  /** The same Workers, each pointed at its directory in the copy. */
  workers: (workers: readonly ProvisionWorker[]) => ProvisionWorker[];
  /** An account that answers `find` and creates nothing. */
  provisioners: ResourceProvisioners;
  /** A Secrets Store that answers `exists` and writes nothing, or `null` when the run would have none. */
  store: SecretsStore | null;
  /** A migrate that runs nothing. */
  migrate: BackendRunner;
  /** A seed that runs nothing. */
  seed: BackendRunner;
  /** An audit that records nothing. */
  audit: CliAuditEmit;
}

/** What {@link planProvision} needs: where, for whom, against what, and the run to plan. */
export interface PlanProvisionOptions {
  /** The project root. Nothing under it is written. */
  projectDir: string;
  /** The project every database is claimed for, as the run's migrate claims it. */
  project: string;
  /** The environment: the scope's stanza. */
  env: string;
  /** The account the project belongs to, for the migrations' reads. */
  account: CloudflareAccountSelection | null;
  /** The account's provisioners. Never absent: without credentials the command refused before planning. */
  provisioners: ResourceProvisioners;
  /** The account's Secrets Store, or `null` when the run would reach none. */
  store: SecretsStore | null;
  /** Whether the run would seed once the schema is up. */
  seed: boolean;
  /** The project's `seed.productionEnvironments`, carried to the migrations' refusals. */
  productionEnvironments?: readonly string[];
  /** The run itself — `provisionEnvironment` or `provisionFeature` — over the seams it is handed. */
  run: (seams: ProvisionPlanSeams) => Promise<ProvisionReport>;
}

/** What a dry run returns: the run's report as it would be, and the plan. */
export interface ProvisionPlanRun {
  /** The report, as the run would write it. A created resource's id is the placeholder the plan wrote. */
  report: ProvisionReport;
  /** Everything the run would change. */
  plan: Plan;
}

/** The id a planned creation hands back: the bucket's name for R2, which has no other, else a placeholder. */
export function plannedId(kind: FeatureResourceKind, name: string): string {
  return kind === "r2" ? name : `<new ${kind} ${name}>`;
}

/** A seam a dry run must never reach. It throws, so a plan that reached it fails rather than writes. */
function refused(what: string): never {
  throw new InternalError({
    message: "A dry run reached a step that writes.",
    detail: `provision --dry-run called ${what}`,
  });
}

/** One kind's provisioner for a plan: the real `find`, and a `create` that makes nothing. */
function plannedKind(kind: FeatureResourceKind, real: ResourceProvisioner): ResourceProvisioner {
  return {
    find: async (name) => real.find(name),
    create: async (name) => ({ id: plannedId(kind, name) }),
    delete: async () => refused(`${kind}.delete`),
  };
}

/** The account, for a plan: asked, never changed. */
export function plannedProvisioners(real: ResourceProvisioners): ResourceProvisioners {
  return {
    d1: plannedKind("d1", real.d1),
    kv: plannedKind("kv", real.kv),
    r2: plannedKind("r2", real.r2),
  };
}

/**
 * The Secrets Store, for a plan: `exists` is the store's own, and a `create` reports the value as made and
 * writes nothing — so the run's minter generates its value, hands it here, and it goes nowhere.
 */
export function plannedStore(real: SecretsStore): SecretsStore {
  return {
    storeId: real.storeId,
    exists: (name) => real.exists(name),
    create: async () => "created",
    put: async () => refused("store.put"),
    remove: async () => refused("store.remove"),
  };
}

/** Plan a provisioning run, writing nothing in the project and nothing in the account. */
export async function planProvision(options: PlanProvisionOptions): Promise<ProvisionPlanRun> {
  const { projectDir, env } = options;
  let migrations: PlanMigration[] = [];

  const {
    result: report,
    files,
    notes: copied,
  } = await inShadow(projectDir, async (shadow) => {
    // The Workers the run resolved, in the copy: the set its migrate would fan out over.
    let resolved: ProvisionWorker[] | undefined;
    const run = await options.run({
      projectDir: shadow.root,
      workers: (workers) => {
        resolved = workers.map((worker) => ({ ...worker, dir: shadow.at(worker.dir) }));
        return resolved;
      },
      provisioners: plannedProvisioners(options.provisioners),
      store: options.store === null ? null : plannedStore(options.store),
      migrate: async () => {},
      seed: async () => {},
      audit: async () => {},
    });
    // A database this run would create has applied nothing, and there is nothing to ask it.
    const fresh = new Set(
      run.resources.filter((resource) => resource.kind === "d1" && resource.created).map((r) => r.id),
    );
    migrations = await planMigrateProject({
      projectDir: shadow.root,
      project: options.project,
      account: options.account,
      env,
      fresh,
      ...(resolved ? { workers: resolved } : {}),
      ...(options.productionEnvironments ? { productionEnvironments: options.productionEnvironments } : {}),
    });
    return run;
  });

  const resources: PlanResource[] = report.resources.map((resource) => {
    const base = { kind: resource.kind, name: resource.name, binding: resource.binding, env };
    return resource.created ? { ...base, action: "create" } : { ...base, action: "adopt", id: resource.id };
  });
  const secrets: PlanSecret[] = report.secretBindings
    .filter((secret) => secret.bound)
    .map((secret) => ({ name: secret.secret, env, action: secret.minted ? "mint" : "bind", where: secret.entry }));
  const notes: string[] = [...copied];
  if (options.seed) notes.push(`Then loads the seed fixtures into ${env}.`);

  return { report, plan: { ...emptyPlan(), files, resources, migrations, secrets, notes } };
}

/**
 * **What a feature's run does after its resources, which a plan does not run (#697).** A feature deploys a
 * kit Worker per host its capabilities compose, then binds each app Worker to them, creates their indexes
 * and their `d1` secrets. Uploading is a write, so the plan names each upload and stops there; and a
 * feature composing `secrets` gets its own master key first, which is a write to the account's store.
 *
 * This is a description of `provisionFeature`'s host phase, not a run of it, so `dryRun.test.ts` holds the two
 * together: it runs that phase with every seam a recorder, hands it exactly these uploads, and pins every option
 * the run reads. A step added there fails that test until it is named here.
 */
export function plannedFeatureHosts(
  identity: FeatureIdentity,
  capabilities: readonly Capability[],
  options: { store: boolean },
): { resources: PlanResource[]; notes: string[] } {
  const composed = new Set(featureHostCapabilities(capabilities as Capability[]));
  const hosts = featureHostScripts(identity).filter((host) => composed.has(host.capability));
  const notes: string[] = [];
  if (options.store && composed.has("secrets")) {
    notes.push("Creates this feature's master key in the Secrets Store first, if it is absent.");
  }
  if (hosts.length > 0) {
    notes.push(
      "Then binds each app Worker to the kit Workers that deploy, and creates the indexes and d1 secrets they need.",
    );
  }
  return {
    resources: hosts.map((host) => ({
      kind: "worker",
      name: host.script,
      env: FEATURE_ENVIRONMENT,
      action: "upload",
      reason: `The ${host.capability} kit Worker this feature composes.`,
    })),
    notes,
  };
}
