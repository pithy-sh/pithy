// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import type { KvNamespaceSpecMap } from "@pithy-sh/core/src/kv/namespaces";
import type { Migration } from "kysely/migration";
import { VectorConfig, type VectorConfigInput } from "./config/config";
import { vectorTables } from "./data/tables";
import { provisionGuard } from "./http/provisionGuard";
import { registerVectorRoutes } from "./http/routes";
import { vector_0001_documents } from "./migrations/0001_documents";
import { vectorExampleSeed } from "./seeds/example";
import { vectorWorkflows } from "./workflows/specs";

/**
 * Where vector's migrations sort in the app database. Unique per database; the registry composes keys like
 * `0900_vector_0001_documents`. Sits after storage (800).
 */
export const VECTOR_MIGRATION_ORDER = 900;

/** The options `pithy add vector` writes into `pithy.config.ts`: the config, plus where the routes mount. */
export type VectorOptions = VectorConfigInput & {
  /** The path the routes mount under. Defaults to `/vector`. */
  basePath?: string;
};

/**
 * The vector capability, with its resolved config attached. The workflow slice is kept literal so a composed
 * project types `c.var.workflows.trigger("vector/reprocess", …)` precisely — an unregistered key or a
 * mistyped payload is a compile error, not a 500.
 */
export interface VectorCapability
  extends Capability<DatabaseSpecMap, KvNamespaceSpecMap, "vector", typeof vectorWorkflows> {
  /** The resolved vector config. */
  vectorConfig: VectorConfig;
}

/**
 * The vector capability: semantic search over the adopter's own Vectorize indexes and Workers AI embeddings.
 *
 * Fully optional. Config, migrations, and bindings arrive only on `pithy add vector`, and `pithy remove
 * vector` is the clean inverse. The index is Vectorize and the embeddings are Workers AI, both in the
 * adopter's account, reached through bindings — nothing routes through a Pithy-operated service.
 *
 * What this package adds over a thin wrapper is one thing: an index's filterable metadata is declared in Zod,
 * beside the rest of its schema. That single declaration provisions the metadata indexes, types the filter
 * builder, and is compared against the live index by `pithy vector provision` — because Vectorize does not
 * error when you filter on a field it indexed late. It silently omits every vector written before the index
 * existed, which is a bug with no error message and no obvious cause.
 *
 * That declaration is checked three times, each as early as it can be. `VectorConfig.parse` below refuses an
 * unindexable filterable field, an eleventh one, and two indexes sharing a binding. `pithy vector provision`
 * compares the declaration against the live index over the control plane, waits for each metadata index to
 * become visible, and records what it saw. And {@link provisionGuard} re-checks that record at boot, so a
 * schema edited and deployed without re-provisioning fails with `vector/metadata_index_drift` instead of
 * quietly returning partial results. The boot check reads a var, never the network: an account API token has
 * no business on the request path of a search.
 *
 * `dependsOn` is deliberately empty. Auth is a seam, not a peer: without `@pithy-sh/auth` the routes deny
 * rather than open, which is the right failure and needs no dependency edge.
 *
 * The `VECTORIZE` and `AI` bindings are declared `remote` because neither has a local emulation. Without it
 * `wrangler dev` binds nothing and every search fails locally for a reason that looks like a code fault.
 */
export function vector(options: VectorOptions = { indexes: {} }): VectorCapability {
  const { basePath, ...configInput } = options;
  // Parse the index set at assembly — an unindexable filterable field, an eleventh one, or a model/dimension
  // mismatch fails on deploy, not on the first search.
  const resolved = VectorConfig.parse(configInput);

  const migrations: Record<string, Migration> = { "0001_documents": vector_0001_documents };
  const requiredBindings: BindingSpecInput[] = [
    // One Vectorize binding per configured index — a binding addresses exactly one index, so a project with
    // two indexes needs two. Deduplicated in config order; a single-index project sees just `VECTORIZE`.
    ...[...new Set(Object.values(resolved.indexes).map((index) => index.binding))].map((name) => ({
      type: "vectorize" as const,
      name,
      remote: true,
    })),
    { type: "ai", name: "AI", remote: true },
    { type: "d1", name: "DB" },
    // The reprocess Workflow's binding, derived from the spec rather than restated. Optional: it exists only
    // once `pithy vector provision` has deployed the vector worker, and an unprovisioned project must still
    // boot and serve every search route.
    ...Object.values(vectorWorkflows).map((spec) => ({
      type: "workflow" as const,
      name: spec.binding,
      optional: spec.optional,
    })),
  ];

  const capability = defineCapability({
    name: "vector",
    requiredBindings,
    config: VectorConfig,
    workflows: vectorWorkflows,
    databases: {
      app: {
        binding: "DB",
        tables: vectorTables(),
        migrationOrder: VECTOR_MIGRATION_ORDER,
        migrations,
      },
    },
    seeds: [vectorExampleSeed],
    // The drift check runs as middleware because the record it reads is a var, and in Workers vars arrive
    // per request — there is no env at assembly for a `compose` hook to read.
    middleware: [provisionGuard(resolved)],
    routes: registerVectorRoutes({ config: resolved, ...(basePath !== undefined ? { basePath } : {}) }),
  });

  return Object.assign(capability, { vectorConfig: resolved });
}

export function isVectorCapability(capability: Capability): capability is VectorCapability {
  return capability.name === "vector" && "vectorConfig" in capability;
}
