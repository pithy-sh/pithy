// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { Migration } from "kysely/migration";
import type { BindingSpecInput } from "../capability/bindings";
import { type Capability, defineCapability, type PithyHonoEnv } from "../capability/capability";
import type { DatabaseSpecMap } from "../data/databases";
import type { KvNamespaceSpecMap, KvRegistry } from "../kv/namespaces";
import { PACKAGE_VERSION } from "../version.generated";
import { ENVIRONMENT_VAR } from "../worker/identity";
import { ControlPlaneConfig, type ControlPlaneConfigInput } from "./config/config";
import { ControlPlaneConnection } from "./data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, type ControlPlaneDatabase, controlPlaneTables } from "./data/tables";
import type { CapabilityDeclaration } from "./discovery/adminRoute";
import { type CapabilityHealthSource, capabilityHealthSources } from "./discovery/health";
import { createControlPlaneVerifier } from "./http/guard";
import { controlPlaneRouteDescriptors, registerControlPlaneRoutes } from "./http/routes";
import { controlplane_0001_init } from "./migrations/0001_init";
import { d1ReplayGuard } from "./replay/d1Guard";
import type { ReplayGuard } from "./replay/guard";
import {
  CONTROL_PLANE_KV_BINDING,
  type ControlPlaneKvNamespaces,
  controlPlaneKvNamespaces,
  kvReplayGuard,
} from "./replay/kvGuard";

/**
 * Where the control-plane registration sorts in the app database. Composed key:
 * `1100_controlplane_0001_init`.
 *
 * Taken from `NEXT_FREE_ORDER` in `packages/cli/src/migrations/orders.test.ts`, which is the one place
 * an order may be allocated, and registered in that file's `DECLARED` table. Core used to be skipped by
 * that scanner on the reasoning that it owns the ceiling rather than an order; that stopped being true
 * here, and the skip was removed with this change. Stable forever — renumbering would rename the
 * composed key and make Kysely re-run an applied migration.
 */
export const CONTROLPLANE_MIGRATION_ORDER = 1100;

export type ControlPlaneOptions = ControlPlaneConfigInput;

/** The control-plane capability, with its resolved config attached. */
export interface ControlPlaneCapability extends Capability<DatabaseSpecMap, KvNamespaceSpecMap, "controlplane"> {
  /** The resolved seam config. */
  controlPlaneConfig: ControlPlaneConfig;
}

/** Narrow a composed capability to this one — the CLI and tests use it to find the seam's config. */
export function isControlPlaneCapability(capability: Capability): capability is ControlPlaneCapability {
  return capability.name === "controlplane";
}

/**
 * The `control-plane` seam: inbound, adopter-authenticated M2M admin access to this Worker.
 *
 * **Not Cloudflare's control plane.** That is the outbound REST API `@pithy-sh/cloudflare` calls to
 * provision D1, KV, and Workers, and it carries `cloudflare/*` codes. This is the inverse — a
 * management client calling *in*, authenticated by a key the adopter registered. See
 * `docs/CONTROL-PLANE.md`, whose first section exists entirely to keep the two apart.
 *
 * **Composing it grants nobody anything.** The capability ships present-and-denying: with no connection
 * registered, every route it guards answers `controlplane/not_connected`, and there is no flag that
 * changes that. `pithy dashboard connect` is the deliberate second step, and revoking is a row the
 * adopter deletes without asking anyone.
 *
 * It lives in `@pithy-sh/core` rather than its own package because every capability contributing admin
 * routes imports `requireControlPlane`, and a capability may depend on a core seam but never on a
 * sibling package (principle 4). MIT with the rest of core, and never gated by tier: this is the code
 * that runs in the adopter's own Worker, so restricting it would make "build your own client against
 * your own Worker" untrue.
 */
export function controlplane(options: ControlPlaneOptions = {}): ControlPlaneCapability {
  // Parsed at assembly, so a config whose replay memory is shorter than a token's life fails on deploy
  // rather than by silently admitting a replay months later.
  const config = ControlPlaneConfig.parse(options);

  const migrations: Record<string, Migration> = {
    "0001_init": controlplane_0001_init,
  };
  const requiredBindings: BindingSpecInput[] = [
    // The app database — the connections table lives here, beside auth's and audit's. Not the secrets
    // database: a public key is not confidential, and what it needs is a queryable, auditable lifecycle
    // with room for two valid keys during a rotation overlap.
    { type: "d1", name: "DB" },
  ];

  // The replay set's namespace — required only when the adopter selected the KV backend.
  //
  // Under the `d1` default nothing reads this namespace, and demanding it anyway would make every
  // project provision a KV it never touches, which is exactly what "a Worker composes only what it
  // declares" rules out. `createBackend` derives the binding from `kvNamespaces` too, so declaring it
  // here is redundant for assembly — `dedupeBindings` ANDs `optional`, and a duplicate can only make a
  // requirement stricter. It is declared anyway, because `requiredBindings` is also the list
  // `pithy remove` strips from `wrangler.jsonc`: `@pithy-sh/matchmaking` and `@pithy-sh/media` both
  // repeat their KV bindings for the same reason, and omitting it left `CONTROL_PLANE` behind after a
  // removal, demanding a namespace nothing used.
  const usesKvReplay = config.replayBackend === "kv";
  if (usesKvReplay) requiredBindings.push({ type: "kv", name: CONTROL_PLANE_KV_BINDING });

  /**
   * The app database for this request, off the derived registry. `c.var.db` is `unknown` on the base
   * seam by design — its precise type depends on which capabilities a project composed — so each
   * capability narrows it to its own slice, the same cast every other capability makes.
   */
  const database = (c: Context<PithyHonoEnv>): ControlPlaneDatabase => (c.var.db as { app: ControlPlaneDatabase }).app;

  const now = () => new Date();

  /**
   * The replay guard for this request, chosen once by config.
   *
   * `d1` is the default and claims on a primary key, so one token is spendable exactly once wherever the
   * requests land. `kv` remains selectable and is best-effort — see `./replay/guard.ts`. The interface is
   * what made moving the default a one-line change here rather than an edit at every call site.
   */
  const replay = (c: Context<PithyHonoEnv>): ReplayGuard =>
    config.replayBackend === "kv"
      ? kvReplayGuard((c.var.kv as KvRegistry<ControlPlaneKvNamespaces>).controlplane.jtis)
      : d1ReplayGuard(database(c), { now, ttlSeconds: config.jtiTtlSeconds });

  // What this Worker composed and what each part exposes, filled by the `compose` hook below.
  // Assembly-time knowledge a capability has no other way to reach — `GET /control-plane/manifest`
  // reports it, which is what lets a management client discover this Worker's surface, and how to call
  // it, instead of being configured with both.
  let composed: readonly CapabilityDeclaration[] = [];

  // The bounded summaries those capabilities contribute, by name (#317). Captured by the same hook and
  // checked there: a value behind a scope no admin route of its own capability requires is refused at
  // assembly, because an adopter is never offered such a scope and the number could never be granted.
  let health: ReadonlyMap<string, CapabilityHealthSource> = new Map();

  const capability = defineCapability({
    name: "controlplane",
    // `@pithy-sh/core`'s version, stamped by `scripts/stampVersions.ts` — a Worker cannot read its own
    // package.json. The seam reports itself in the manifest beside every other composed capability, so a
    // client can see which core an adopter is on without a separate question.
    version: PACKAGE_VERSION,
    // No `dependsOn`. The seam must work in a Worker composing neither auth nor audit nor secrets: it
    // holds no secret, mints no session, and emits through a seam that is a no-op when absent.
    requiredBindings,
    config: ControlPlaneConfig,
    databases: {
      app: {
        binding: "DB",
        tables: controlPlaneTables(),
        migrationOrder: CONTROLPLANE_MIGRATION_ORDER,
        migrations,
      },
    },
    // Registered only for the KV backend, and built from the resolved config so `jtiTtlSeconds` actually
    // governs how long a spent token id is remembered. A constant here would make that setting
    // decorative; registering it unconditionally would make every `d1` project carry a namespace nothing
    // in the tree ever reads.
    kvNamespaces: usesKvReplay ? controlPlaneKvNamespaces(config.jtiTtlSeconds) : {},
    // The seam describes itself too. Built from the same resolved `basePath` the routes mount on, so a
    // moved mount point is reported rather than becoming a lie a client believes.
    adminRoutes: controlPlaneRouteDescriptors(config.basePath),
    compose: ({ capabilities }) => {
      // Every capability, including those exposing nothing. A client rendering a capability it cannot
      // act on is useful; a client that cannot tell "no admin surface" from "not installed" is not.
      composed = capabilities.map((cap) => ({
        name: cap.name,
        // `?? null`, never undefined: the adopter's own `app` capability has a name and no package
        // version, and that must render as an explicit null rather than vanish from the JSON.
        version: cap.version ?? null,
        adminRoutes: [...(cap.adminRoutes ?? [])],
        // The vocabulary, always — a capability declaring a number this connection cannot see must be
        // visible as a withheld number rather than as silence.
        healthKeys: [...(cap.health?.keys ?? [])],
      }));
      health = capabilityHealthSources(capabilities);
    },
    middleware: [
      (app) => {
        // Publish the verifier every `requireControlPlane()` in the tree consumes — including the ones
        // in capabilities that know nothing about this config. Publishing it is all this does: no
        // verification happens here, because a request merely carrying the header must not be rejected
        // on a route that has nothing to do with the seam.
        app.use("*", async (c, next) => {
          const db = database(c);
          c.set(
            "controlPlaneVerifier",
            createControlPlaneVerifier({
              loadConnection: async (connectionId) => {
                const row = await db
                  .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
                  .selectAll()
                  .where("id", "=", connectionId)
                  .executeTakeFirst();
                return row ? ControlPlaneConnection.parse(row) : null;
              },
              countConnections: async () => {
                const rows = await db.selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE).select("id").limit(1).execute();
                return rows.length;
              },
              replay: replay(c),
              // The environment a credential is bound to. Absent off-platform, where the empty string
              // matches no stored connection and every call therefore denies — the right failure.
              environment: String((c.env as Record<string, unknown>)[ENVIRONMENT_VAR] ?? ""),
              config,
              now,
            }),
          );
          await next();
        });
      },
    ],
    routes: (app) => {
      registerControlPlaneRoutes(app, config.basePath, {
        config,
        database,
        composedCapabilities: () => composed,
        composedHealth: () => health,
        now,
      });
    },
  });

  return { ...capability, controlPlaneConfig: config } as ControlPlaneCapability;
}

/** Re-exported so a Worker's wrangler config and this capability cannot disagree about the binding name. */
export { CONTROL_PLANE_KV_BINDING };
