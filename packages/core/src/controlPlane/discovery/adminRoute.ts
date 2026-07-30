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
    adminRoutes: z
      .array(AdminRoute)
      .describe(
        "Every admin route this capability contributes, or empty when it contributes none. Most capabilities are empty: having no management surface is the normal case, and saying so explicitly is what lets a client render a capability it cannot act on.",
      ),
  })
  .describe("One capability this Worker composes, and the admin surface it exposes.");
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

/**
 * The manifest a management client reads to build itself.
 *
 * Deliberately not a version number. With the routes described here, a client dispatches on what this
 * Worker declares right now — so a capability that changed its paths or its scopes reports the change,
 * and a version would be a second source of truth to keep in sync with the first.
 */
export const ControlPlaneManifest = z
  .object({
    environment: z
      .string()
      .describe("The environment this connection is bound to, echoed so a client can label what it is looking at."),
    connectionId: z.string().describe("The connection this call authenticated as."),
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
