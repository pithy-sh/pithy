import {
  type HostVectorizeBinding,
  resolveWorkflowHost,
  type WorkflowHostTemplate,
} from "@pithy-sh/core/src/workflow/host";
import type { VectorConfig } from "../config/config";
import { toWorkerConfig } from "../config/workerConfig";
import { VECTOR_CAPABILITY } from "../workflows/specs";

/**
 * Resolve the vector worker's committed `wrangler.jsonc` template into one environment's standalone config.
 * Thin over core's {@link resolveWorkflowHost}: the generic resolver owns the mechanics (clone, fill by
 * binding name, suffix the Workflow name with the environment, stamp `ENVIRONMENT`), and this file owns only
 * what is vector's. Pure — the caller parses the template and writes the result.
 *
 * Two things are vector's own.
 *
 * **The `vectorize` array is rebuilt, not filled.** A template declares the bindings a capability has *by
 * default*; how many Vectorize bindings a project needs is a fact about its config, because one binding
 * addresses exactly one index. So the array is regenerated from the configured indexes and then handed to the
 * generic resolver to fill and mark remote.
 *
 * **`VECTOR_CONFIG` is a projection.** An index's `metadata` is a live Zod schema; `JSON.stringify` would
 * hand the worker an unusable husk. {@link toWorkerConfig} projects the config into the serializable facts
 * the worker needs — including the *result* of introspecting each metadata schema.
 */

/** The resolved ids and per-env values for one environment's vector-worker deploy. */
export interface VectorConfigParams {
  /** The target environment. */
  env: string;
  /** The app database id for this environment — where the document corpus lives. */
  appDatabaseId: string;
  /** Config index name → provisioned Vectorize index name, from `provisionVector`. */
  indexNames: Record<string, string>;
  /** The app's resolved vector config. */
  config: VectorConfig;
}

/** Fill the template for one environment. */
export function resolveVectorConfig(template: WorkflowHostTemplate, params: VectorConfigParams): WorkflowHostTemplate {
  const { env, appDatabaseId, indexNames, config } = params;

  // One Vectorize binding per configured index, in config order. `index_name` is a placeholder here; the
  // generic resolver fills it from `vectorizeIndexNames` below, so the mapping lives in exactly one place.
  const vectorize: HostVectorizeBinding[] = Object.entries(config.indexes).map(([index, indexConfig]) => ({
    binding: indexConfig.binding,
    index_name: indexNames[index] ?? "",
    remote: true,
  }));

  const vectorizeIndexNames: Record<string, string> = {};
  for (const [index, indexConfig] of Object.entries(config.indexes)) {
    const name = indexNames[index];
    if (name) vectorizeIndexNames[indexConfig.binding] = name;
  }

  return resolveWorkflowHost(
    { ...template, vectorize },
    {
      capability: VECTOR_CAPABILITY,
      env,
      databaseIds: { DB: appDatabaseId },
      vectorizeIndexNames,
      // Neither Vectorize nor Workers AI has a local emulation, and a Workflow host always runs locally in
      // `wrangler dev` — without `remote` the bindings resolve to nothing and every re-embed fails locally
      // for a reason that reads like a code fault.
      remoteBindings: [...Object.values(config.indexes).map((index) => index.binding), "AI"],
      vars: { VECTOR_CONFIG: JSON.stringify(toWorkerConfig(config, (index) => indexNames[index] ?? "")) },
    },
  );
}
