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
import { bundleTokenCheck } from "@pithy-sh/storage/src/secret/bundleToken";
import type { Migration } from "kysely/migration";
import type { z } from "zod";
import { MediaConfig, type MediaConfigInput, refuseRemovedMediaOptions } from "./config/config";
import { extendMediaAsset, extensionColumns } from "./data/extend";
import { mediaTables } from "./data/tables";
import { MEDIA_MANAGE_POWER } from "./http/handlers";
import { registerMediaRoutes } from "./http/routes";
import { mediaAdminRoutes } from "./http/scopes";
import { media_0001_init } from "./migrations/0001_init";
import { media_0003_ownership } from "./migrations/0003_ownership";
import { mediaExtendMigration } from "./migrations/extend";
import { mediaOrganizationPurge } from "./purge/contribution";
import {
  MEDIA_BUCKET_BINDING,
  MEDIA_R2_SECRET,
  mediaRuntimePermissions,
  mediaSecretsRegistryFor,
} from "./secret/registry";
import { suppliedTokenCheck } from "./secret/supersededToken";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";
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

/** The options `media()` accepts: the config, an optional adopter schema extension, a hook, and a mount path. */
export type MediaOptions = MediaConfigInput & {
  /**
   * Extend a media record with the adopter's own fields (tags, an album), as a `z.ZodObject`. From this
   * one schema the capability derives real D1 columns (a generated `0002_extend` migration). Base fields —
   * the owner and organization among them — are never redefined.
   */
  extend?: z.ZodObject;
  /**
   * Asked on every read and write of a media record: `allow`, `deny`, or `default` for the rules. Sharing a
   * record with one person is an allow; a legal hold is a deny. No hook is the rules, unchanged. The hook
   * governs the record routes only — duplicate detection and usage rollups keep their non-disclosure rules
   * whatever it answers.
   */
  permission?: PermissionHook;
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
 * The media capability. It contributes the `pithy_media_assets` record table and the dedup
 * `pithy_media_hashes` table to the app `DB`, mounts the media routes (upload-init, finalize, get, list,
 * update, delete, delivery URL, duplicate search, and a control-plane usage read), and declares the
 * enrichment Workflow bindings the finalize route dispatches to. The Workflows live in the prebuilt media
 * worker (`workflows/worker.ts`), deployed per environment by `pithy media provision`.
 *
 * Every record carries its owner, the organization in force when it was written, and a visibility; every
 * record route asks core's access rules and the adopter's `permission` hook. The organization comes from
 * core's acting-organization seam, so `@pithy-sh/organization` is optional and is never imported — without
 * it every record writes a null organization. `media:manage` is declared on `powers`, so a project that
 * composes tenancy must give it to some role.
 *
 * Its account, signing keys and the application's runtime token are read through `@pithy-sh/secrets`, so
 * the `secrets` capability must be composed; writes need an identity, so `@pithy-sh/auth` should be composed too — without it,
 * `c.var.auth` is null, every write is denied, and only public records can be read.
 */
export function media(options: MediaOptions = {}): MediaCapability {
  const { extend, basePath, permission, ...configInput } = options;
  // Refused by name before anything parses — a config naming the removed KV store must never boot against
  // an empty record table.
  refuseRemovedMediaOptions(configInput as Record<string, unknown>);
  const resolved = MediaConfig.parse(configInput);
  const schema = extendMediaAsset(extend);
  const mountPath = basePath ?? "/media";

  // The authored chain, plus the extension columns generated per adopter from their own schema — the same
  // shape as `@pithy-sh/auth`'s plugin tables. `0003_ownership` is authored; `0002` is the generated slot.
  const migrations: Record<string, Migration> = {
    "0001_init": media_0001_init,
    "0003_ownership": media_0003_ownership,
  };
  const extendMigration = mediaExtendMigration(extensionColumns(extend));
  if (extendMigration) migrations["0002_extend"] = extendMigration;

  const requiredBindings: BindingSpecInput[] = [
    // The app database — the record table and the dedup hash table live here.
    { type: "d1", name: "DB" },
    // The R2 bucket the routes read and delete objects through (bindings-first).
    { type: "r2", name: MEDIA_BUCKET_BINDING },
    // The enrichment Workflow bindings the finalize route dispatches to, derived from the specs rather
    // than listed again — one declaration, so a binding rename cannot leave the two disagreeing. Each is
    // optional: the bindings exist only once `pithy media provision` has deployed the media worker, and
    // an unprovisioned project must still boot and serve every non-enrichment route.
    ...workflowBindings(mediaWorkflows),
  ];

  const capability = defineCapability({
    name: "media",
    // The package this capability ships in and the version it ships at, both stamped by
    // `scripts/stampVersions.ts` — a Worker cannot read its own package.json. Reported per capability by
    // the control-plane manifest, and reported together: a release feed is keyed by package name, so the
    // version alone leaves a client guessing the key (#626).
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    // Storage credentials are read through @pithy-sh/secrets, so secrets must be composed.
    dependsOn: ["secrets"],
    // Built from the resolved config (#728): a project storing both types in R2 calls Cloudflare for
    // nothing, so it declares no runtime token and adds nothing to it. Declared and marked inapplicable was
    // not enough — provision binds every declared store secret.
    secretRegistry: mediaSecretsRegistryFor(resolved),
    // What media's Workers call Cloudflare with — Images and Stream uploads, and the delivery read — unioned
    // into the one `runtime` token the application holds. Nothing is added to `ci-system`: it all runs in
    // the Worker.
    runtimePermissions: mediaRuntimePermissions(resolved),
    workflows: mediaWorkflows,
    // What erasing one organization means here (#623): its records, their bytes and their hashes. The
    // organization purge runs it as its own step, in the adopter's Worker, which binds what it reads.
    purge: [mediaOrganizationPurge(resolved)],
    requiredBindings,
    // The power a role holds to edit, delete and re-scope any record in its own organization. Declared so
    // tenancy can refuse a role catalog that places it nowhere — but only in a Worker that composes media.
    powers: [MEDIA_MANAGE_POWER],
    databases: {
      app: {
        binding: "DB",
        tables: mediaTables(schema),
        migrationOrder: MEDIA_MIGRATION_ORDER,
        migrations,
      },
    },
    // Built from the resolved mount path, never the default, so the manifest names this Worker's paths.
    adminRoutes: mediaAdminRoutes(mountPath),
    // `pithy doctor` names every record a narrowed `visibility.allowed` no longer admits. Nothing rewrites
    // them: making a public record private breaks every link already published. And it names a bundle
    // still holding the Images and Stream token the runtime token superseded (#728), which nothing revokes,
    // and an R2 bundle still holding the Cloudflare API token provisioning once stored beside the key pair.
    settings: allSettings(
      recordsOutsidePolicy({
        capability: "media",
        noun: "media record",
        table: "pithy_media_assets",
        policy: resolved.visibility,
        remedy: `Move each with PATCH ${mountPath}/:id`,
      }),
      suppliedTokenCheck(),
      bundleTokenCheck({ secret: MEDIA_R2_SECRET, provision: "media provision" }),
    ),
    routes: registerMediaRoutes({
      config: resolved,
      schema,
      basePath: mountPath,
      ...(permission ? { permission } : {}),
    }),
  });

  return Object.assign(capability, { mediaConfig: resolved, schema });
}

/** Whether a capability is the media capability — carries its resolved config and effective schema. */
export function isMediaCapability(capability: Capability): capability is MediaCapability {
  return capability.name === "media" && "mediaConfig" in capability;
}
