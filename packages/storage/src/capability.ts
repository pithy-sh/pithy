// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import type { KvNamespaceSpecMap } from "@pithy-sh/core/src/kv/namespaces";
import type { Migration } from "kysely/migration";
import { StorageConfig, type StorageConfigInput } from "./config/config";
import { storageTables } from "./data/tables";
import { registerStorageRoutes } from "./http/routes";
import { storage_0001_objects } from "./migrations/0001_objects";
import { storageSecretsRegistry } from "./secret/registry";
import { storageExampleSeed } from "./seeds/example";
import { storageWorkflows } from "./workflows/specs";

/**
 * Where storage's migrations sort in the app database. Unique per database; the registry composes keys
 * like `0800_storage_0001_objects`. Sits after matchmaking (700).
 */
export const STORAGE_MIGRATION_ORDER = 800;

export type StorageOptions = StorageConfigInput & {
  /** Mount the object routes somewhere other than `/storage`. */
  basePath?: string;
  /** Mount share fetches somewhere other than `/s`. Short by default — the whole URL gets pasted around. */
  sharePath?: string;
};

/**
 * The storage capability, with its resolved config attached. The workflow slice is kept literal so a
 * composed project types `c.var.workflows.trigger("storage/sweep", { dryRun: true })` precisely — an
 * unregistered key or a mistyped payload is a compile error, not a 500.
 */
export interface StorageCapability
  extends Capability<DatabaseSpecMap, KvNamespaceSpecMap, "storage", typeof storageWorkflows> {
  /** The resolved storage config. */
  storageConfig: StorageConfig;
}

/**
 * The storage capability: general file storage on the adopter's own R2 bucket — uploads that never
 * proxy through the Worker, downloads that do, and a D1 record of what exists and who owns it.
 *
 * The bucket is `STORAGE_BUCKET`, deliberately separate from media's `MEDIA_BUCKET`. Buckets are free
 * — cost is bytes and operations — so two cost nothing, and the separation buys independent teardown
 * and independent public-access posture. `visibility: 'public'` is a plausible thing for a file store
 * to offer and never appropriate for media's originals.
 *
 * `dependsOn: ["secrets"]` is real: the R2 credential bundle is read through the aggregated registry
 * at startup, so a project composing storage without `@pithy-sh/secrets` must fail at assembly, not at
 * the first presign. Auth is *not* listed — it is a seam. Ownership scoping reads `c.var.auth.userId`,
 * so without `@pithy-sh/auth` every owner-scoped route denies rather than opens, which is the right
 * failure and needs no dependency edge. It belongs in the manifest's `optionalCapabilities`.
 */
export function storage(options: StorageOptions = {}): StorageCapability {
  const { basePath, sharePath, ...configInput } = options;
  // Parse at assembly — an out-of-range part size or a threshold below it fails on deploy, not on the
  // first large upload.
  const resolved = StorageConfig.parse(configInput);

  const migrations: Record<string, Migration> = { "0001_objects": storage_0001_objects };
  const requiredBindings: BindingSpecInput[] = [
    // The app database — the objects and shares tables live here.
    { type: "d1", name: "DB" },
    // The bucket the bytes live in. Deliberately separate from media's `MEDIA_BUCKET`.
    { type: "r2", name: "STORAGE_BUCKET" },
    // The sweep's Workflow binding, derived from the spec rather than written again — one declaration,
    // so a binding rename cannot leave the two disagreeing. Optional: the binding exists only once
    // `pithy storage provision` has deployed the sweep worker, and an unprovisioned project must still
    // serve every upload and download route.
    ...Object.values(storageWorkflows).map((spec) => ({
      type: "workflow" as const,
      name: spec.binding,
      optional: spec.optional,
    })),
  ];

  const capability = defineCapability({
    name: "storage",
    dependsOn: ["secrets"],
    secretRegistry: storageSecretsRegistry,
    workflows: storageWorkflows,
    requiredBindings,
    config: StorageConfig,
    databases: {
      app: {
        binding: "DB",
        tables: storageTables(),
        migrationOrder: STORAGE_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerStorageRoutes({ config: resolved, basePath, sharePath }),
    seeds: [storageExampleSeed],
  });

  return Object.assign(capability, { storageConfig: resolved });
}

export function isStorageCapability(capability: Capability): capability is StorageCapability {
  return capability.name === "storage" && "storageConfig" in capability;
}
