// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ControlPlaneScope } from "../scope/scope";

/**
 * What a capability tells a management client about its own admin surface.
 *
 * **This exists because knowing a capability is installed is not enough to call it.** A management
 * client that learns only names still has to hold a route table for every capability, guess that
 * payments is mounted at `/payments`, and know out-of-band which scope each operation needs. Every one
 * of those is a thing that can be wrong, and `basePath` is configurable — an adopter who mounts
 * payments at `/billing` would silently 404 a client that hardcoded the default.
 *
 * So the capability declares the routes it actually registered, with the paths it actually used, and
 * `GET /control-plane/manifest` reports them. That is what makes discovery-over-configuration real
 * rather than aspirational: a client composes its navigation *and* its calls from what the Worker says
 * about itself, and an adopter who moves a mount point or upgrades a capability changes what the client
 * does without either side coordinating.
 *
 * **The declaration is checked against the router**, not trusted — see `missingAdminRoutes`. A manifest
 * that drifts from the routes is worse than no manifest, because a client would believe it.
 */

/** The HTTP methods an admin route may use. */
export const AdminRouteMethod = z
  .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
  .describe("The HTTP method this admin route answers on.");
export type AdminRouteMethod = z.infer<typeof AdminRouteMethod>;

/** One admin route a capability contributes behind the `control-plane` strategy. */
export const AdminRoute = z
  .object({
    method: AdminRouteMethod.describe("The method to call this route with."),
    path: z
      .string()
      .min(1)
      .describe(
        "The **fully mounted** path, with the capability's configured `basePath` already applied — `/billing/entitlements/grant`, not `/entitlements/grant`. Built by the capability at assembly, so an adopter who moved the mount point is reflected here rather than silently breaking a client that assumed the default.",
      ),
    scope: ControlPlaneScope.nullable().describe(
      "The scope this route requires, or null when it needs only a verified caller (the seam's `ping`). A client compares it against the connection's granted scopes to know which operations it may actually offer, instead of discovering a 403 by trying.",
    ),
    summary: z
      .string()
      .min(1)
      .describe("One line describing what the route does, for a management client to render beside it."),
  })
  .describe(
    "One admin route, described well enough for a management client to call it without holding any capability-specific knowledge.",
  );
export type AdminRoute = z.infer<typeof AdminRoute>;

/** One composed capability, as `GET /control-plane/manifest` reports it. */
export const CapabilityDescriptor = z
  .object({
    name: z
      .string()
      .min(1)
      .describe("The capability's name — the same token used as its migration namespace and error domain."),
    version: z
      .string()
      .nullable()
      .describe(
        "The npm version of the package supplying this capability, or null where there is none — the adopter's own `app` capability has a name and no package. Reported per capability and never aggregated: the package name is the join key against a release feed, and a project composes some capabilities and not others, so only the intersection of what it composes and what changed is worth reporting.",
      ),
    adminRoutes: z
      .array(AdminRoute)
      .describe(
        "Every admin route this capability contributes, or empty when it contributes none. Most capabilities are empty: having no management surface is the normal case, and saying so explicitly is what lets a client render a capability it cannot act on.",
      ),
  })
  .describe("One capability this Worker composes, the version it is at, and the admin surface it exposes.");
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

/**
 * The manifest a management client reads to build itself.
 *
 * **There is deliberately no manifest schema version, and that is a different thing from the two build
 * identities below.** A client dispatches on the routes described here — what this Worker declares right
 * now — so a capability that changed its paths or its scopes reports the change directly, and a schema
 * version would be a second source of truth to keep in sync with the first. That reasoning is unchanged.
 *
 * What the manifest does carry is **identity**, not schema, and it carries two of them because they
 * answer questions neither can answer alone. `version` is Cloudflare's opaque per-deploy id: it says
 * *exactly which build* is running, which is what forensics needs, what reproduces a report, and what
 * pins the code an audited action ran against. It carries no version semantics, so it says nothing about
 * features. `capabilities[].version` is the npm version of each composed package: it says *which
 * features*, which is what answers "should this customer upgrade", "which customers are exposed to what
 * we just fixed", and "does this project predate the capability a pane needs". Reporting only one leaves
 * half the questions unanswerable, and they are the halves people actually ask.
 */
export const ControlPlaneManifest = z
  .object({
    environment: z
      .string()
      .describe("The environment this connection is bound to, echoed so a client can label what it is looking at."),
    connectionId: z.string().describe("The connection this call authenticated as."),
    version: z
      .string()
      .nullable()
      .describe(
        "The Cloudflare version id of the build answering this call, from the `CF_VERSION_METADATA` binding, or null where the binding is absent. Opaque and per-deploy: it identifies which build is running, never which features it has. Null is honest — a Worker scaffolded before the binding was declared genuinely cannot say.",
      ),
    capabilities: z
      .array(CapabilityDescriptor)
      .describe(
        "Every capability composed into this Worker, in composition order with the adopter's own app last. A capability absent here has no data to show, which is a fact the client discovers rather than a setting anybody maintains.",
      ),
    grantedScopes: z
      .array(ControlPlaneScope)
      .describe(
        "Every scope this connection holds. Together with each route's own `scope`, this is what tells a client which operations to offer and which to hide.",
      ),
  })
  .describe("What this Worker is, what it composes, and how to call the admin surface it exposes.");
export type ControlPlaneManifest = z.infer<typeof ControlPlaneManifest>;
