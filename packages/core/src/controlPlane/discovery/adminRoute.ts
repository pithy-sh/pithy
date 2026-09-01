// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ControlPlaneScope } from "../scope/scope";
import { ManifestConfigKey, ManifestConfigValues } from "./configuration";
import { CapabilityHealthReport, HealthSummary, HealthSummaryKey, healthReport, healthWire } from "./healthSummary";

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

/**
 * One composed capability's declaration — everything about it that is the same for every caller.
 *
 * Split from {@link CapabilityDescriptor} because the health *values* are the one part of a manifest
 * entry that depends on who is asking, and the seam holds this half from assembly (`compose`) while the
 * other half is resolved per request.
 */
export const CapabilityDeclaration = z
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
    // **Defaulted, not required, and that is the compatibility mechanism.** This manifest carries no schema
    // version on purpose — a client dispatches on what the Worker declares right now — so absence is the
    // only way a new field can ship without breaking every Worker deployed before it. A required one fails
    // at the object level, which costs the client the *whole* manifest rather than the part it did not
    // know about, and every pane goes dark for an adopter whose only mistake was not upgrading yet (#352).
    healthKeys: z
      .array(HealthSummaryKey)
      .default([])
      .describe(
        "The closed vocabulary of scalars this capability may report about its own state, or empty when it reports none — including when the Worker predates this field and says nothing at all. Declared alongside the routes so a client can render a key it has never heard of from what the Worker says about it — and so a *withheld* number is visible as a key with no value, rather than as silence.",
      ),
    // Both defaulted, for the reason stated above `healthKeys` and with the same force (#422). The two
    // arrived together and travel together: a declaration with no value is a control with nothing behind
    // it, and a value with no declaration is a fact a client can only guess the meaning of.
    configKeys: z
      .array(ManifestConfigKey)
      .default([])
      .describe(
        "The configured facts this capability states, or empty when it states none — including when the Worker predates this field. Declared alongside the routes, because a fact is what a client needs to *call* one: `POST /billing/entitlements/grant` names a holder and never assumes it, so a client that cannot learn what this project bills can only guess — and a guess writes a row nothing reads.",
      ),
    config: ManifestConfigValues.default({}).describe(
      "What each declared fact resolved to for this deployment. The same answer for every caller, read off the capability's parsed config at assembly: there is no producer here, so no failure state, no per-request cost, and no staleness beyond the manifest itself.",
    ),
  })
  .describe(
    "One capability this Worker composes, the version it is at, the admin surface it exposes, the summary it may report, and the configured facts a client must respect to call any of it.",
  );
export type CapabilityDeclaration = z.infer<typeof CapabilityDeclaration>;

/**
 * One composed capability's manifest entry **as it goes over the wire**.
 *
 * Two flat fields, and neither is what a consumer reads: {@link CapabilityDescriptor} decodes them into
 * one value that says which of the four states it is in. They are flat here because the wire has an
 * older half to keep working. A Worker deployed before #350 sends no `healthUnavailable` and a Worker
 * deployed before #317 sends neither field, and both must still parse; and a client pinned to a build
 * older than the Worker it is reading strips the field it has never heard of and lands on `health:
 * null`, which renders as silence rather than as a zero. Putting the fourth state *inside* `health`
 * would have cost that client the whole manifest for one capability's bad afternoon, which is the
 * failure #352 is about.
 */
const CapabilityDescriptorWire = CapabilityDeclaration.extend({
  // Defaulted for the same reason as `healthKeys` above, and it lands on the meaning it already had: a
  // Worker that says nothing about health has nothing declared, which is the first of the four states.
  health: HealthSummary.nullable()
    .default(null)
    .describe(
      "Every declared value this caller may see, or null when there is none to give — either nothing is declared, or this connection lacks the scope the value is behind, or producing it failed, or the Worker predates this field. **Null is never zero.**",
    ),
  healthUnavailable: z
    .boolean()
    .default(false)
    .describe(
      "Whether producing this capability's summary failed on this read — the fourth state (#350), and the reason `health` being null is not enough on its own. Carries no message, no code and no error: what the producer threw may name a row or a key, so nothing derived from it travels. False when the Worker predates this field.",
    ),
});

/**
 * One composed capability, as `GET /control-plane/manifest` reports it to **this** caller.
 *
 * `health` is the only per-caller part of a manifest entry, and it is a four-state value rather than a
 * nullable record: a capability that declares nothing, one that declares a number this connection was
 * not granted, one that reports a number — zero included — and one whose producer failed. A management
 * client that collapsed any two of those tells an adopter something untrue. The first two collapsed
 * says everything is fine when it has simply not been allowed to look; the last two collapsed says
 * nothing is pending when the store is down.
 *
 * The state travels **on** the value, so the scalars are unreachable without narrowing and a consumer
 * that forgets the sick case gets a type error rather than a zero.
 */
const CapabilityDescriptorRead = CapabilityDeclaration.extend({
  health: CapabilityHealthReport.describe(
    "What this caller is told about the capability's own state: nothing declared, a number withheld, the numbers themselves, or a producer that failed. Four states on one value, so none of them is reachable by forgetting to check another.",
  ),
});

export const CapabilityDescriptor = z
  .codec(CapabilityDescriptorWire, CapabilityDescriptorRead, {
    decode: ({ health, healthUnavailable, ...declaration }) => ({
      ...declaration,
      health: healthReport({ healthKeys: declaration.healthKeys, health, healthUnavailable }),
    }),
    // Both fields, from the one value, in the one place. A handler cannot write the numbers and forget
    // the flag, which is what makes `encode(decode(entry))` the entry again — the property the seam's
    // response contract test rests on.
    encode: ({ health, healthKeys, configKeys, config, ...declaration }) => ({
      ...declaration,
      // Every defaulted field is optional on the way back out, and empty is the meaning absence already
      // had: a capability that declares no summary, and one that states no configured fact.
      //
      // **The `map` is load-bearing for the compiler and inert at run time, and both halves are the
      // point (#471).** `HealthSummaryKey.nominal` is `.default(null)`, so the key's input type has it
      // optional and its output type has it present — and this encode sits exactly on that seam, so
      // spreading the keys through unchanged does not compile.
      //
      // At run time the `?? null` never fires: the read side validates before this transform, and it
      // demands `nominal`, so no value carrying a key without one ever reaches here. It is written as a
      // `??` rather than a cast because the two branches genuinely mean the same thing — absence and
      // null are both *this capability makes no claim* — so the widening is stated rather than asserted,
      // and the day the read side stops validating first this keeps being correct instead of becoming
      // a lie the type system was told to ignore.
      healthKeys: (healthKeys ?? []).map((key) => ({ ...key, nominal: key.nominal ?? null })),
      configKeys: configKeys ?? [],
      config: config ?? {},
      ...healthWire(health),
    }),
  })
  .describe(
    "One capability this Worker composes, as reported to one caller: its version, its admin surface, and the summary that caller is entitled to — or the named reason there is none.",
  );
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
 *
 * **And each entry carries a third thing: the configured facts that capability states** (#422). Knowing
 * where a route is and which scope it needs is not always enough to call it — `POST
 * {base}/entitlements/grant` names a holder, and whether this project's holders are people or
 * organizations is a decision the adopter made in config. A client that cannot read the decision guesses
 * it, and a guess writes a row nothing reads. See `discovery/configuration.ts` for why a fact is not a
 * health number, despite the two fields sitting side by side.
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

/**
 * The manifest as the Worker sends it, before a client decodes it.
 *
 * The handler builds this and is `satisfies`-checked against it, which keeps the response a compile-time
 * contract rather than a validation pass over values this Worker just built. A client parses with
 * {@link ControlPlaneManifest} and gets the four-state health value out the far side.
 */
export type ControlPlaneManifestWire = z.input<typeof ControlPlaneManifest>;
