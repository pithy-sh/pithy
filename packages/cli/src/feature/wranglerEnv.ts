import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "comment-json";
import { writeFileAtomic } from "../project/atomic";
import type { FeatureResource } from "./manifest";

/**
 * After `pithy feature provision` stands up a feature's D1/KV/R2 resources, their ids must land in the
 * worktree's `wrangler.jsonc` under `env.<env>` — that is exactly where the shared `migrate`/`seed` remote
 * drivers read each binding's id from. This writes them there, upserting by binding name and preserving
 * every comment in the JSONC (a `pithy.config` output, per CLAUDE.md). The worktree's `wrangler.jsonc` is
 * a local checkout, so the write stays worktree-scoped and uncommitted.
 */

/** One binding-id entry keyed by binding, plus the id field that resource kind uses in wrangler.jsonc. */
interface BindingEntry {
  binding: string;
  [idField: string]: string;
}

/** One `services` entry: the binding name and the Worker script it resolves to in this environment. */
interface ServiceEntry {
  binding: string;
  service: string;
}

/** The env stanza slice provision writes: the Worker's own name, its binding arrays, and its services. */
interface EnvBindings {
  name?: string;
  d1_databases?: BindingEntry[];
  kv_namespaces?: BindingEntry[];
  r2_buckets?: BindingEntry[];
  services?: ServiceEntry[];
}

/**
 * Upsert a binding's id into a binding array **in place**, so comment-json's array-internal comments
 * (stored as symbol-keyed properties on the array object) survive — a `filter()` would return a plain
 * array and silently drop them. A matching binding's id field is updated on the existing entry;
 * otherwise the entry is pushed.
 */
function upsertByBinding(entries: BindingEntry[], binding: string, idField: string, id: string): void {
  const existing = entries.find((entry) => entry.binding === binding);
  if (existing) existing[idField] = id;
  else entries.push({ binding, [idField]: id });
}

/** The `EnvBindings` keys holding a binding array — the only ones an id is upserted into. */
type BindingArrayKey = "d1_databases" | "kv_namespaces" | "r2_buckets";

/** The wrangler.jsonc key and id-field name for each provisionable resource kind. */
const KIND_TO_WRANGLER: Record<FeatureResource["kind"], { array: BindingArrayKey; idField: string }> = {
  d1: { array: "d1_databases", idField: "database_id" },
  kv: { array: "kv_namespaces", idField: "id" },
  r2: { array: "r2_buckets", idField: "bucket_name" },
};

/**
 * Read a `wrangler.jsonc`, hand its `env.<env>` stanza to `mutate`, and write it back. The parsed document
 * is comment-annotated and mutated in place, so every comment survives the round trip. The stanza is created
 * when absent and reused when present, so repeated calls layer onto one another.
 */
async function editEnvStanza(wranglerPath: string, env: string, mutate: (stanza: EnvBindings) => void): Promise<void> {
  const raw = await readFile(wranglerPath, "utf8");
  const config = parse(raw) as unknown as { env?: Record<string, EnvBindings | undefined> };

  config.env ??= {};
  const stanza: EnvBindings = config.env[env] ?? {};
  config.env[env] = stanza;

  mutate(stanza);

  await writeFileAtomic(wranglerPath, `${stringify(config, null, 2)}\n`);
}

/**
 * Write each provisioned resource's id into `env.<env>` of the worktree's `wrangler.jsonc`, keyed by
 * binding, so `migrate`/`seed` resolve the feature's resources for that environment. Idempotent: re-running
 * replaces the same binding entries in place. Comments in the JSONC are preserved.
 */
export async function applyProvisionedIds(
  projectDir: string,
  env: string,
  resources: FeatureResource[],
): Promise<void> {
  await editEnvStanza(join(projectDir, "wrangler.jsonc"), env, (stanza) => {
    for (const resource of resources) {
      const { array, idField } = KIND_TO_WRANGLER[resource.kind];
      // Reuse the existing comment-json array (preserving its comments) or start a fresh one, then mutate
      // in place — never replace it with a filtered plain array, which would strip comment-json's symbols.
      stanza[array] ??= [];
      upsertByBinding(stanza[array], resource.binding, idField, resource.id);
    }
  });
}

/**
 * Give one Worker its environment-scoped identity: write `env.<env>.name` — the script name this Worker
 * deploys under for the feature — and rewrite each of its `service` bindings to target the *feature's* copy
 * of the callee rather than production's. This is what makes worker-to-worker RPC work in a feature
 * environment with no hand-editing: every name is recomputed from the branch, so CI produces the same wiring
 * on every push without any of it being stored. Idempotent, and comment-preserving.
 */
export async function applyWorkerEnv(options: {
  /** The Worker's directory — the one holding the `wrangler.jsonc` to edit. */
  workerDir: string;
  /** The target environment. */
  env: string;
  /** The script name this Worker deploys under for the feature. */
  name: string;
  /** Each service binding and the script name it resolves to in this environment. */
  services: ServiceEntry[];
}): Promise<void> {
  await editEnvStanza(join(options.workerDir, "wrangler.jsonc"), options.env, (stanza) => {
    stanza.name = options.name;
    if (options.services.length === 0) return;
    stanza.services ??= [];
    for (const entry of options.services) {
      const existing = stanza.services.find((candidate) => candidate.binding === entry.binding);
      if (existing) existing.service = entry.service;
      else stanza.services.push(entry);
    }
  });
}
