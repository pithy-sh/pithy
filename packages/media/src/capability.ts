import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import type { z } from "zod";
import { MediaConfig, type MediaConfigInput } from "./config/config";
import { extendMediaAsset, extensionColumns } from "./data/extend";
import { mediaTables } from "./data/tables";
import { registerMediaRoutes } from "./http/routes";
import { media_0001_init } from "./migrations/0001_init";
import { mediaExtendMigration } from "./migrations/extend";
import { mediaSecretsRegistry } from "./secret/registry";

/**
 * Sort order of the media migrations within the app database, relative to other capabilities (core low,
 * app high). Unique per database; the registry composes the key `0300_media_0001_init`.
 */
export const MEDIA_MIGRATION_ORDER = 300;

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

/** The media capability, with its resolved config and effective record schema attached. */
export interface MediaCapability extends Capability {
  /** The resolved media config. */
  mediaConfig: MediaConfig;
  /** The effective record schema (base {@link MediaAsset} plus any adopter extension). */
  schema: z.ZodObject;
}

/**
 * The media capability. It contributes the `pithy_media_assets` table (plus a generated column-extension
 * migration) to the app `DB`, or routes records to KV when `recordStore: 'kv'`; mounts the media routes
 * (upload-init, finalize, get, list, delete, duplicate search — each gated by auth); and declares the
 * enrichment Workflow bindings the finalize route dispatches to. The Workflows themselves live in the
 * prebuilt media worker (`workflows/worker.ts`), deployed per environment by `pithy media provision`.
 *
 * Its storage credentials are read through `@pithy-sh/secrets` (CLAUDE.md §secrets), so the `secrets`
 * capability must be composed. The routes need an identity, so `@pithy-sh/auth` should be composed too —
 * without it, `c.var.auth` is null and every media route is denied.
 */
export function media(options: MediaOptions = {}): MediaCapability {
  const { extend, basePath, ...configInput } = options;
  const resolved = MediaConfig.parse(configInput);
  const schema = extendMediaAsset(extend);

  const migrations: Record<string, Migration> = { "0001_init": media_0001_init };
  const extendMigration = mediaExtendMigration(extensionColumns(extend));
  if (extendMigration) migrations["0002_extend"] = extendMigration;

  const isKv = resolved.recordStore === "kv";
  const requiredBindings: BindingSpecInput[] = [
    ...(isKv ? [{ type: "kv" as const, name: "MEDIA" }] : [{ type: "d1" as const, name: "DB" }]),
    // The R2 bucket the routes read and delete objects through (bindings-first).
    { type: "r2", name: "MEDIA_BUCKET" },
    // The enrichment Workflow bindings the finalize route dispatches to — optional, present only once
    // `pithy media provision` has deployed the media worker.
    { type: "workflow", name: "MEDIA_IMAGE_TO_TEXT", optional: true },
    { type: "workflow", name: "MEDIA_AUDIO_TRANSCRIBE", optional: true },
    { type: "workflow", name: "MEDIA_VIDEO_TRANSCRIBE", optional: true },
    { type: "workflow", name: "MEDIA_DOC_EXTRACT", optional: true },
  ];

  const common = {
    name: "media",
    // Storage credentials are read through @pithy-sh/secrets, so secrets must be composed.
    dependsOn: ["secrets"],
    secretRegistry: mediaSecretsRegistry,
    requiredBindings,
    routes: registerMediaRoutes({ config: resolved, schema, basePath }),
  };

  const capability = isKv
    ? defineCapability(common)
    : defineCapability({
        ...common,
        databases: {
          app: {
            binding: "DB",
            tables: mediaTables(schema),
            migrationOrder: MEDIA_MIGRATION_ORDER,
            migrations,
          },
        },
      });

  return Object.assign(capability, { mediaConfig: resolved, schema });
}

/** Whether a capability is the media capability — carries its resolved config and effective schema. */
export function isMediaCapability(capability: Capability): capability is MediaCapability {
  return capability.name === "media" && "mediaConfig" in capability;
}
