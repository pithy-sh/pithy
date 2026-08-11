// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpecMap } from "@pithy-sh/core/src/data/databases";
import type { KvNamespaceSpecMap } from "@pithy-sh/core/src/kv/namespaces";
import type { Migration } from "kysely/migration";
import type { z } from "zod";
import { MediaConfig, type MediaConfigInput } from "./config/config";
import { extendMediaAsset, extensionColumns } from "./data/extend";
import { mediaTables } from "./data/tables";
import { registerMediaRoutes } from "./http/routes";
import { media_0001_init } from "./migrations/0001_init";
import { mediaExtendMigration } from "./migrations/extend";
import { assertValidKvMetadata } from "./record/kvStore";
import { mediaSecretsRegistry } from "./secret/registry";
import { PACKAGE_VERSION } from "./version.generated";
import { mediaWorkflows } from "./workflows/specs";

/**
 * Sort order of the media migrations within the app database, relative to other capabilities (core low,
 * app high). Unique per database; the registry composes keys like `0350_media_0001_init`.
 *
 * Sits after auth (300), which holds it: a media record's `ownerId` names a user, so the table that
 * users live in should exist first. Media was itself at 300 until this was corrected — `pithy migrate`
 * threw `duplicate migration order 300 in database "app"` for any project composing both, which is
 * every project that stores media against an identity.
 */
export const MEDIA_MIGRATION_ORDER = 350;

/** The options `media()` accepts: the config, an optional adopter schema extension, and a mount path. */
export type MediaOptions = MediaConfigInput & {
  /**
   * Extend a media record with the adopter's own fields (an owning `userId`, a tenant id, tags), as a
   * `z.ZodObject`. From this one schema the capability derives real D1 columns (a generated `0002_extend`
   * migration) or a validated KV value — with no backend-specific work. Base fields are never redefined.
   */
  extend?: z.ZodObject;
  /** The path the routes mount under. Defaults to `/media`. */
  basePath?: string;
};

/**
 * The media capability, with its resolved config and effective record schema attached. The workflow
 * slice is kept literal so a composed project types `c.var.workflows.trigger("media/image-to-text", …)`
 * precisely — an unregistered key or a mistyped payload is a compile error, not a 500.
 */
export interface MediaCapability
  extends Capability<DatabaseSpecMap, KvNamespaceSpecMap, "media", typeof mediaWorkflows> {
  /** The resolved media config. */
  mediaConfig: MediaConfig;
  /** The effective record schema (base {@link MediaAsset} plus any adopter extension). */
  schema: z.ZodObject;
}

/**
 * The media capability. It contributes the dedup `pithy_media_hashes` table to the app `DB` for **both**
 * record stores (duplicate detection is a query workload only D1 can serve), plus the `pithy_media_assets`
 * table when `recordStore: 'd1'` (KV mode keeps records in KV). It mounts the media routes (upload-init,
 * finalize, get, list, delete, duplicate search — each gated by auth) and declares the enrichment Workflow
 * bindings the finalize route dispatches to. The Workflows live in the prebuilt media worker
 * (`workflows/worker.ts`), deployed per environment by `pithy media provision`.
 *
 * The `DB` binding is required in every mode (the hash table lives there). Storage credentials are read
 * through `@pithy-sh/secrets`, so the `secrets` capability must be composed; the routes need an identity,
 * so `@pithy-sh/auth` should be composed too — without it, `c.var.auth` is null and every route is denied.
 */
export function media(options: MediaOptions = {}): MediaCapability {
  const { extend, basePath, ...configInput } = options;
  const resolved = MediaConfig.parse(configInput);
  const schema = extendMediaAsset(extend);
  // Fail fast on a typo'd or unknown `kvMetadata` field rather than silently ignoring it.
  assertValidKvMetadata(resolved.kvMetadata, schema);
  const isKv = resolved.recordStore === "kv";

  // One authored migration, told what to create: the hash table always (dedup is D1-only), plus the
  // record table for the D1 record store. The extension columns are generated per adopter from their
  // own schema, so they arrive as a second, synthesised migration rather than as part of the schema
  // this package authors — the same shape as `@pithy-sh/auth`'s plugin tables.
  const migrations: Record<string, Migration> = { "0001_init": media_0001_init({ withAssets: !isKv }) };
  if (!isKv) {
    const extendMigration = mediaExtendMigration(extensionColumns(extend));
    if (extendMigration) migrations["0002_extend"] = extendMigration;
  }

  const requiredBindings: BindingSpecInput[] = [
    // The app database — the dedup hash table (both modes) and the record table (D1 mode) live here.
    { type: "d1", name: "DB" },
    // The KV namespace records live in, when `recordStore: 'kv'`.
    ...(isKv ? [{ type: "kv" as const, name: "MEDIA" }] : []),
    // The R2 bucket the routes read and delete objects through (bindings-first).
    { type: "r2", name: "MEDIA_BUCKET" },
    // The enrichment Workflow bindings the finalize route dispatches to, derived from the specs rather
    // than listed again — one declaration, so a binding rename cannot leave the two disagreeing. Each is
    // optional: the bindings exist only once `pithy media provision` has deployed the media worker, and
    // an unprovisioned project must still boot and serve every non-enrichment route.
    ...Object.values(mediaWorkflows).map((spec) => ({
      type: "workflow" as const,
      name: spec.binding,
      optional: spec.optional,
    })),
  ];

  const capability = defineCapability({
    name: "media",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    // Storage credentials are read through @pithy-sh/secrets, so secrets must be composed.
    dependsOn: ["secrets"],
    secretRegistry: mediaSecretsRegistry,
    workflows: mediaWorkflows,
    requiredBindings,
    databases: {
      app: {
        binding: "DB",
        tables: mediaTables(schema, { withAssets: !isKv }),
        migrationOrder: MEDIA_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerMediaRoutes({ config: resolved, schema, basePath }),
  });

  return Object.assign(capability, { mediaConfig: resolved, schema });
}

/** Whether a capability is the media capability — carries its resolved config and effective schema. */
export function isMediaCapability(capability: Capability): capability is MediaCapability {
  return capability.name === "media" && "mediaConfig" in capability;
}
