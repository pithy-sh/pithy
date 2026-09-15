// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import { parse } from "comment-json";
import { NO_PROVISION_ARG, stanzaOf, wranglerEnvironment } from "../project/effectiveConfig";
import { readOptionalFile } from "../project/readOptionalFile";
import { discoverWorkers } from "../project/workers";
import { wranglerConfigPath } from "./featureConfig";

/**
 * **Which of the bindings a deploy would ship still have no resource behind them.**
 *
 * The state this reads is the one #240 was reported from: a project scaffolded, wired and migrated by
 * pithy, whose `wrangler.jsonc` declares `"database_name": "<project>-staging-db"` and no
 * `database_id`, in every environment. `pithy deploy --env staging` used to hand that straight to
 * wrangler — and under wrangler's default, #589 found, wrangler did not fail on it: it **created the
 * database**.
 *
 * ## Two halves, and this is the readable one
 *
 * What makes a deploy create nothing is the argv — `NO_PROVISION_ARG`, held at both spawn sites — because
 * for R2, queues and the namespace kinds the name is the id and no read of a file can tell a real one from
 * one wrangler is about to make. This half turns the failure that switch produces, inside wrangler, into
 * one sentence before anything is built: the Worker, the binding, and the command that provisions it.
 * So it reads the kinds whose id is a separate field — D1 and KV — and an R2 binding naming no bucket at
 * all. A named bucket that does not exist is not visible here, and the switch is what stops it being
 * created.
 *
 * ## The stanza is the one the deploy ships, for every environment
 *
 * It read `env.<name>` of the tracked file, which missed three deploys: a bare one and `--env dev`, which
 * ship the **top level** (there is no `env.dev`, and no project may declare one), and a feature
 * environment, whose ids live in the generated config under `.wrangler/`. The file is
 * `wranglerConfigPath` and the stanza is `stanzaOf(wranglerEnvironment(env))` — the resolvers `pithy
 * deploy`'s argv and `assertDeploysRequestedEnvironment` already use — so this and the deploy cannot
 * disagree about what is being shipped.
 */

/** One binding an environment declares and has no resource for. */
export interface UnprovisionedBinding {
  /** The Worker's `apps/<name>` directory. */
  worker: string;
  /** The Cloudflare resource kind the binding needs. */
  kind: FeatureResourceKind;
  /** The binding name in the Worker env, e.g. `DB`. */
  binding: string;
}

/** One binding entry as it appears in a wrangler binding array; only its kind's id field is populated. */
interface RawBinding {
  binding?: string;
  database_id?: string;
  id?: string;
  bucket_name?: string;
}

/** The slice of a wrangler config this reads: a stanza's binding arrays, and the stanzas under `env`. */
interface RawWrangler {
  d1_databases?: RawBinding[];
  kv_namespaces?: RawBinding[];
  r2_buckets?: RawBinding[];
  env?: Record<string, unknown>;
}

/**
 * A value is an id only if it is a non-empty, non-placeholder string.
 *
 * The same rule `pithy env` reports `provisioned` by. A scaffold leaves `<database_id>` behind and an
 * adopter leaves `""`; both look filled in to a truthiness check and neither is something wrangler will
 * deploy against.
 */
function isId(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== "" && !/^<.+>$/.test(trimmed) && !/placeholder/i.test(trimmed);
}

/**
 * The configuration one Worker's deploy for `env` reads, or `null` when there is none to read.
 *
 * `null` for a file that is absent or will not parse, because this reader gates a deploy and a config that
 * cannot be read has its own, better error waiting one step later. A feature environment nobody provisioned
 * has no generated config at all, and wrangler refuses a `--config` naming a missing file before it uploads.
 */
async function deployedConfig(workerDir: string, env: string | undefined): Promise<RawWrangler | null> {
  const raw = await readOptionalFile(wranglerConfigPath(workerDir, env ?? LOCAL_ENVIRONMENT)).catch(() => null);
  if (raw === null) return null;
  try {
    return parse(raw) as unknown as RawWrangler;
  } catch {
    return null;
  }
}

/**
 * Every binding a deploy for `env` would ship across the project's Workers that has no id yet, in worker
 * then binding order. `undefined` is a bare deploy. A Worker with no `env.<name>` stanza is held to the top
 * level, because that is what wrangler ships for it.
 */
export async function unprovisionedBindings(
  projectDir: string,
  env: string | undefined,
): Promise<UnprovisionedBinding[]> {
  const missing: UnprovisionedBinding[] = [];
  for (const target of await discoverWorkers(projectDir)) {
    if (target.hasWrangler === false) continue;
    const config = await deployedConfig(target.dir, env);
    if (config === null) continue;
    const stanza = stanzaOf(config, wranglerEnvironment(env));
    const worker = basename(target.dir);
    for (const entry of stanza.d1_databases ?? [])
      if (!isId(entry.database_id)) missing.push({ worker, kind: "d1", binding: entry.binding ?? "" });
    for (const entry of stanza.kv_namespaces ?? [])
      if (!isId(entry.id)) missing.push({ worker, kind: "kv", binding: entry.binding ?? "" });
    for (const entry of stanza.r2_buckets ?? [])
      if (!isId(entry.bucket_name)) missing.push({ worker, kind: "r2", binding: entry.binding ?? "" });
  }
  return missing;
}

/** How a report names one unprovisioned binding: the Worker, the binding, and the kind behind it. */
export function describeUnprovisioned(missing: readonly UnprovisionedBinding[]): string {
  return missing.map((entry) => `${entry.worker}.${entry.binding} (${entry.kind})`).join(", ");
}

/**
 * The move that gives these bindings a resource — which, for the stanza `pithy dev` runs, is not a move
 * on that stanza at all.
 *
 * The top level is dev's, and dev is Miniflare: its `database_name`s are resolved locally and nothing
 * provisions them on an account, by design. So a bare deploy and `--env dev` are sent to the environments
 * that do have resources, rather than to a provisioning command that would refuse `dev` — or worse, one
 * that would not.
 */
function remedy(env: string | undefined): string {
  if (env === undefined || env === LOCAL_ENVIRONMENT) {
    return "The top-level stanza is dev's, which runs under pithy dev and has no Cloudflare resources. Deploy --env staging or --env prod.";
  }
  if (env === FEATURE_ENVIRONMENT) return "Run pithy provision --feature, then deploy.";
  return `Run pithy provision --env ${env} --yes, then deploy.`;
}

/**
 * Refuse to deploy a stanza whose bindings have no resources, naming each binding and the command that
 * creates them.
 *
 * **Deploy refuses; it does not provision.** A deploy that creates account resources is hard to review,
 * and the resources it would create are the long-lived ones. wrangler would have: its default is to create
 * what it cannot find, and a deploy now turns that off, so what reaches wrangler fails there instead — on
 * a field nobody wrote. This moves that failure to one sentence, before anything is built.
 */
export async function assertEnvironmentProvisioned(projectDir: string, env: string | undefined): Promise<void> {
  const missing = await unprovisionedBindings(projectDir, env);
  if (missing.length === 0) return;
  const stanza = env === undefined ? "The top-level stanza" : env;
  throw new ValidationError({
    message: `${stanza} declares bindings with no Cloudflare resource behind them: ${describeUnprovisioned(missing)}.`,
    action: remedy(env),
    detail: `A deploy runs wrangler with ${NO_PROVISION_ARG}, so a binding with no id fails inside wrangler rather than creating a resource.`,
  });
}
