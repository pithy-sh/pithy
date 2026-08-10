// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import { discoverWorkers } from "../project/workers";
import { readOptionalWranglerConfig } from "../project/wrangler";

/**
 * **Which of an environment's declared bindings still have no resource behind them.**
 *
 * The state this reads is the one #240 was reported from: a project scaffolded, wired and migrated by
 * pithy, whose `wrangler.jsonc` declares `"database_name": "<project>-staging-db"` and no
 * `database_id`, in every environment. `pithy deploy --env staging` used to hand that straight to
 * wrangler, which failed on a binding the adopter never knew they were meant to create — after `init`,
 * `add`, `migrate` and `dev` had all succeeded.
 *
 * So the answer is read from files, offline, and used twice: `pithy deploy` refuses with the command to
 * run, and `pithy doctor` reports it without being asked. One reader, so the two can never disagree
 * about what "provisioned" means.
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

/** The slice of a `wrangler.jsonc` this reads: the environment stanzas and their binding arrays. */
interface RawWrangler {
  env?: Record<
    string,
    | {
        d1_databases?: RawBinding[];
        kv_namespaces?: RawBinding[];
        r2_buckets?: RawBinding[];
      }
    | undefined
  >;
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
 * Every binding one environment declares across the project's Workers that has no id yet, in worker
 * then binding order. A Worker with no stanza for that environment declares nothing there and is
 * skipped; a `wrangler.jsonc` that will not open is skipped too, because this reader gates a deploy and
 * a config that cannot be read has its own, better error waiting one step later.
 */
export async function unprovisionedBindings(projectDir: string, env: string): Promise<UnprovisionedBinding[]> {
  const missing: UnprovisionedBinding[] = [];
  for (const target of await discoverWorkers(projectDir)) {
    if (target.hasWrangler === false) continue;
    const raw = (await readOptionalWranglerConfig(target.dir).catch(() => null)) as RawWrangler | null;
    const stanza = raw?.env?.[env];
    if (!stanza) continue;
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
 * Refuse to deploy into an environment whose bindings have no resources, naming the command that
 * creates them.
 *
 * **Deploy refuses; it does not provision.** A deploy that silently creates account resources is hard
 * to review, and the resources it would create are the long-lived ones. The refusal is the whole
 * improvement: the failure moves from inside wrangler, on a field nobody wrote, to one sentence naming
 * the missing binding and the command that fills it.
 */
export async function assertEnvironmentProvisioned(projectDir: string, env: string): Promise<void> {
  const missing = await unprovisionedBindings(projectDir, env);
  if (missing.length === 0) return;
  throw new ValidationError({
    message: `${env} declares bindings with no Cloudflare resource behind them: ${describeUnprovisioned(missing)}.`,
    action: `Run pithy provision --env ${env} --yes, then deploy.`,
    detail: "wrangler validates a binding's id before it deploys, so this would have failed inside wrangler.",
  });
}
