// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProvisionScope } from "@pithy-sh/core/src/naming/provisionScope";
import { parse, stringify } from "comment-json";
import type { FeatureResource } from "../feature/manifest";
import { writeFileAtomic } from "../project/atomic";

/**
 * After provisioning stands up an environment's D1/KV/R2 resources, their ids must land in each
 * Worker's `wrangler.jsonc` under `env.<name>` — that is exactly where the shared `migrate`/`seed`
 * remote drivers, and `wrangler deploy --env <name>`, read each binding's id from. This writes them
 * there, upserting by binding name and preserving every comment in the JSONC (a `pithy.config` output,
 * per CLAUDE.md).
 *
 * **One writer, taking the scope.** The stanza key is `scope.stanza` and every name is the same
 * scope's, so the file this writes into and the names it writes cannot come from two different
 * decisions — which is precisely how `pithy feature provision --env staging` used to put
 * feature-named resources in the staging stanza.
 */

/** One binding-id entry keyed by binding, plus the id field that resource kind uses in wrangler.jsonc. */
interface BindingEntry {
  binding: string;
  [field: string]: string;
}

/** One `services` entry: the binding name and the Worker script it resolves to in this environment. */
export interface ServiceEntry {
  /** The binding name in the Worker env (e.g. `BOARD`). */
  binding: string;
  /** The script name that binding reaches in this scope. */
  service: string;
}

/** The env stanza slice provisioning writes: the Worker's own name, its binding arrays, and its services. */
interface EnvBindings {
  name?: string;
  d1_databases?: BindingEntry[];
  kv_namespaces?: BindingEntry[];
  r2_buckets?: BindingEntry[];
  services?: ServiceEntry[];
}

/**
 * Upsert a binding's fields into a binding array **in place**, so comment-json's array-internal
 * comments (stored as symbol-keyed properties on the array object) survive — a `filter()` would return
 * a plain array and silently drop them. A matching binding's fields are updated on the existing entry;
 * otherwise the entry is pushed.
 */
function upsertByBinding(entries: BindingEntry[], binding: string, fields: Record<string, string>): void {
  const existing = entries.find((entry) => entry.binding === binding);
  if (existing) Object.assign(existing, fields);
  else entries.push({ binding, ...fields });
}

/** The `EnvBindings` keys holding a binding array — the only ones an id is upserted into. */
type BindingArrayKey = "d1_databases" | "kv_namespaces" | "r2_buckets";

/**
 * The wrangler key and the fields provisioning owns for each resource kind.
 *
 * **D1 carries its name as well as its id**, and that is not decoration: `pithy add` proposes a
 * `database_name` offline, before any account has been reached, and provisioning is the step that makes
 * the proposal true. Writing only the id would leave a stanza asserting one name while addressing a
 * database that may carry another — the two must be written by the same step or they drift.
 */
const KIND_TO_WRANGLER: Record<
  FeatureResource["kind"],
  { array: BindingArrayKey; fields: (r: FeatureResource) => Record<string, string> }
> = {
  d1: { array: "d1_databases", fields: (r) => ({ database_name: r.name, database_id: r.id }) },
  kv: { array: "kv_namespaces", fields: (r) => ({ id: r.id }) },
  r2: { array: "r2_buckets", fields: (r) => ({ bucket_name: r.id }) },
};

/**
 * Write one Worker's whole `env.<scope.stanza>` stanza: the resource ids it declares, the script name it
 * deploys under in this scope, and each of its `service` bindings retargeted at this scope's copy of the
 * callee.
 *
 * The stanza is created when absent and reused when present, so this is also what makes provisioning the
 * creator of a stanza for an environment declared after the project was scaffolded. Idempotent, and every
 * comment in the file survives the round trip.
 */
export async function applyProvisionedEnv(options: {
  /** The Worker's directory — the one holding the `wrangler.jsonc` to edit. */
  workerDir: string;
  /** The Worker's deploy name, from its own `wrangler.jsonc`. `scope.worker` turns it into this scope's. */
  worker: string;
  /** The scope: both the stanza written into and the names written in. */
  scope: ProvisionScope;
  /** Only the resources this Worker's own config declares. */
  resources: readonly FeatureResource[];
  /** Only the service bindings this Worker's own config declares, already resolved to this scope. */
  services: readonly ServiceEntry[];
}): Promise<void> {
  const wranglerPath = join(options.workerDir, "wrangler.jsonc");
  const raw = await readFile(wranglerPath, "utf8");
  const config = parse(raw) as unknown as { env?: Record<string, EnvBindings | undefined> };

  config.env ??= {};
  const stanza: EnvBindings = config.env[options.scope.stanza] ?? {};
  config.env[options.scope.stanza] = stanza;

  stanza.name = options.scope.worker(options.worker);
  for (const resource of options.resources) {
    const { array, fields } = KIND_TO_WRANGLER[resource.kind];
    // Reuse the existing comment-json array (preserving its comments) or start a fresh one, then mutate
    // in place — never replace it with a filtered plain array, which would strip comment-json's symbols.
    stanza[array] ??= [];
    upsertByBinding(stanza[array], resource.binding, fields(resource));
  }
  if (options.services.length > 0) {
    stanza.services ??= [];
    for (const entry of options.services) {
      const existing = stanza.services.find((candidate) => candidate.binding === entry.binding);
      if (existing) existing.service = entry.service;
      else stanza.services.push({ ...entry });
    }
  }

  await writeFileAtomic(wranglerPath, `${stringify(config, null, 2)}\n`);
}
