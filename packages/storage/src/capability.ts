// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PermissionHook } from "@pithy-sh/core/src/access/access";
import { recordsOutsidePolicy } from "@pithy-sh/core/src/access/policyCheck";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { allSettings } from "@pithy-sh/core/src/capability/settings";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import type { KvNamespaceSpecMap } from "@pithy-sh/core/src/kv/namespaces";
import { workflowBindings } from "@pithy-sh/core/src/workflow/bindings";
import type { Migration } from "kysely/migration";
import { refuseRenamedStorageOptions, StorageConfig, type StorageConfigInput } from "./config/config";
import { storageTables } from "./data/tables";
import { STORAGE_MANAGE_POWER } from "./http/handlers";
import { registerStorageRoutes } from "./http/routes";
import { storageAdminRoutes } from "./http/scopes";
import { storage_0001_objects } from "./migrations/0001_objects";
import { storage_0002_ownership } from "./migrations/0002_ownership";
import { bundleTokenCheck } from "./secret/bundleToken";
import { STORAGE_BUCKET_BINDING, STORAGE_R2_SECRET, storageSecretsRegistry } from "./secret/registry";
import { storageExampleSeed } from "./seeds/example";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";
import { storageWorkflows } from "./workflows/specs";

/**
 * Where storage's migrations sort in the app database. Unique per database; the registry composes keys
 * like `0800_storage_0001_objects`. Sits after matchmaking (700).
 */
export const STORAGE_MIGRATION_ORDER = 800;

export type StorageOptions = StorageConfigInput & {
  /** Mount the object routes somewhere other than `/storage`. */
  basePath?: string;
  /**
   * Asked on every read and write of a stored file: `allow`, `deny`, or `default` for the rules. Sharing a
   * file with one person is an allow; a legal hold is a deny. No hook is the rules, unchanged. Share
   * links are unchanged by it, and usage rollups keep their non-disclosure rule whatever it answers.
   */
  permission?: PermissionHook;
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
 * the first presign. Auth is *not* listed — it is a seam. Ownership reads `c.var.auth.userId`, so without
 * `@pithy-sh/auth` every write denies rather than opens, which is the right failure and needs no
 * dependency edge. Tenancy is a seam too: the organization a file belongs to comes from core's
 * acting-organization resolver, so `@pithy-sh/organization` is optional, never imported, and declared on
 * `powers` only through `storage:manage`. Both belong in the manifest's `optionalCapabilities`.
 */
export function storage(options: StorageOptions = {}): StorageCapability {
  const { basePath, sharePath, permission, ...configInput } = options;
  // A renamed option is refused by name before anything parses, so it cannot quietly mean the default.
  refuseRenamedStorageOptions(configInput as Record<string, unknown>);
  // Parse at assembly — an out-of-range part size or a threshold below it fails on deploy, not on the
  // first large upload.
  const resolved = StorageConfig.parse(configInput);
  const mountPath = basePath ?? "/storage";

  const migrations: Record<string, Migration> = {
    "0001_objects": storage_0001_objects,
    "0002_ownership": storage_0002_ownership,
  };
  const requiredBindings: BindingSpecInput[] = [
    // The app database — the objects and shares tables live here.
    { type: "d1", name: "DB" },
    // The bucket the bytes live in. Deliberately separate from media's `MEDIA_BUCKET`.
    { type: "r2", name: STORAGE_BUCKET_BINDING },
    // The sweep's Workflow binding, derived from the spec rather than written again — one declaration,
    // so a binding rename cannot leave the two disagreeing. Optional: the binding exists only once
    // `pithy storage provision` has deployed the sweep worker, and an unprovisioned project must still
    // serve every upload and download route.
    ...workflowBindings(storageWorkflows),
  ];

  const capability = defineCapability({
    name: "storage",
    // The package this capability ships in and the version it ships at, both stamped by
    // `scripts/stampVersions.ts` — a Worker cannot read its own package.json. Reported per capability by
    // the control-plane manifest, and reported together: a release feed is keyed by package name, so the
    // version alone leaves a client guessing the key (#626).
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    dependsOn: ["secrets"],
    secretRegistry: storageSecretsRegistry,
    workflows: storageWorkflows,
    requiredBindings,
    config: StorageConfig,
    // The power a role holds to edit, delete and re-scope any file in its own organization. Declared so
    // tenancy can refuse a role catalog that places it nowhere — but only in a Worker that composes storage.
    powers: [STORAGE_MANAGE_POWER],
    databases: {
      app: {
        binding: "DB",
        tables: storageTables(),
        migrationOrder: STORAGE_MIGRATION_ORDER,
        migrations,
      },
    },
    // Built from the resolved mount path, never the default, so the manifest names this Worker's paths.
    adminRoutes: storageAdminRoutes(mountPath),
    // `pithy doctor` names every file a narrowed `visibility.allowed` no longer admits. Nothing rewrites
    // them: making a public file private breaks every link already published. And it names an R2 bundle
    // still holding the Cloudflare API token provisioning once stored beside the key pair (#728).
    settings: allSettings(
      recordsOutsidePolicy({
        capability: "storage",
        noun: "file",
        table: "pithy_storage_objects",
        policy: resolved.visibility,
        remedy: `Move each with PATCH ${mountPath}/:id`,
      }),
      bundleTokenCheck({ secret: STORAGE_R2_SECRET, provision: "storage provision" }),
    ),
    routes: registerStorageRoutes({
      config: resolved,
      basePath: mountPath,
      sharePath,
      ...(permission ? { permission } : {}),
    }),
    seeds: [storageExampleSeed],
  });

  return Object.assign(capability, { storageConfig: resolved });
}

export function isStorageCapability(capability: Capability): capability is StorageCapability {
  return capability.name === "storage" && "storageConfig" in capability;
}
