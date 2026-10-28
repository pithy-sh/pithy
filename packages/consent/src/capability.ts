// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { type ConsentPurpose, parseConsentPurposes } from "@pithy-sh/core/src/consent/purpose";
import { type ConsentReader, composedConsentPurposes } from "@pithy-sh/core/src/consent/reader";
import type { FieldKeys } from "@pithy-sh/core/src/crypto/fieldKeys";
import { fromZodError } from "@pithy-sh/core/src/error/pithyError";
import { ConsentConfig, type ConsentConfigInput } from "./config/config";
import { consentDatabase, consentRetainedTables, consentTables } from "./data/tables";
import { CONSENT_EVIDENCE_BINDING } from "./evidence/evidence";
import { mergeOnSignIn } from "./http/merge";
import { type ConsentRoutesOptions, registerConsentRoutes } from "./http/routes";
import { consentAdminRoutes } from "./http/scopes";
import { consent_0001_init } from "./migrations/0001_init";
import { consentUserPurge } from "./purge/contribution";
import { consentStore } from "./record/store";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

/**
 * Where consent's migrations sort in the app database. Unique per database; allocated in
 * `packages/cli/src/migrations/orders.test.ts`.
 */
export const CONSENT_MIGRATION_ORDER = 1600;

const DAY_MS = 86_400_000;

/** The consent capability, with the catalog it composed and the reader it provides. */
export interface ConsentCapability extends Capability {
  consentConfig: ConsentConfig;
  /** Every purpose this Worker asks consent for — the composed capabilities' and the adopter's — by id. */
  consentCatalog: () => ReadonlyMap<string, ConsentPurpose>;
}

/**
 * The consent capability: purposes declared and versioned, an append-only record of every grant and
 * withdrawal with its evidence, visitors by an anonymous device id merged into their account at sign-in, and the one
 * question every consent-based processing asks — `hasConsent`, through core's seam.
 *
 * It composes every capability's `consentPurposes` with the adopter's own into one catalog at `compose`, so a
 * capability added later declares its purposes and nothing here changes. Writes wear `requireSameOrigin()`, which
 * `@pithy-sh/auth` publishes, so auth is a peer.
 */
export function consent(config: ConsentConfigInput = {}): ConsentCapability {
  const parsed = ConsentConfig.safeParse(config);
  if (!parsed.success) {
    throw fromZodError(parsed.error, { message: "The consent capability's configuration is not valid." });
  }
  const resolved = parsed.data;
  const visitorWindowMs = resolved.visitorWindowDays * DAY_MS;
  let composition: readonly Capability[] = [];
  // Until `compose` runs, the adopter's own purposes, refused at construction if malformed.
  const own = parseConsentPurposes("consent({ purposes })", resolved.purposes, null);
  let catalog: ReadonlyMap<string, ConsentPurpose> = new Map(own.map((purpose) => [purpose.id, purpose]));

  const options: ConsentRoutesOptions = {
    basePath: resolved.basePath,
    catalog: () => catalog,
    composition: () => composition,
    visitorWindowMs,
    rateLimiterBinding: resolved.rateLimiterBinding,
  };

  const reader = (env: Record<string, unknown>): ConsentReader => {
    const d1 = env.DB as D1Database | undefined;
    return {
      hasConsent: async (subject, purpose) => {
        if (!d1) return false;
        return consentStore({
          db: consentDatabase(d1),
          keys: env.PITHY_FIELD_KEYS as FieldKeys | undefined,
          bucket: undefined,
          purposes: catalog,
          visitorWindowMs,
          now: () => new Date(),
          newId: () => crypto.randomUUID(),
        }).hasConsent(subject, purpose);
      },
    };
  };

  const capability = defineCapability({
    name: "consent",
    // Stamped by `scripts/stampVersions.ts` — a Worker cannot read its own package.json.
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    // The writes wear the same-origin gate auth publishes; without auth they would refuse every visitor.
    dependsOn: ["auth"],
    config: ConsentConfig,
    requiredBindings: [
      { type: "d1", name: "DB" },
      // The two writes take no account, so they are held to a per-IP limit — auth's limiter by default, which auth
      // already declares, so composing consent provisions nothing new.
      { type: "ratelimit", name: resolved.rateLimiterBinding },
      // Drawn signatures and providers' certificates, by hash. Optional: a project that only takes clicks and typed
      // names never needs it, and a drawn grant without it is refused naming the binding.
      { type: "r2", name: CONSENT_EVIDENCE_BINDING, optional: true },
    ],
    databases: {
      app: {
        binding: "DB",
        tables: consentTables,
        migrationOrder: CONSENT_MIGRATION_ORDER,
        migrations: { "0001_init": consent_0001_init },
        retained: consentRetainedTables,
      },
    },
    /**
     * Compose the catalog: every composed capability's purposes, then the adopter's. An adopter purpose under a
     * composed capability's domain is refused here, at startup, naming it.
     */
    compose: ({ capabilities }) => {
      composition = capabilities;
      const declared = composedConsentPurposes(capabilities);
      const reserved = new Set(capabilities.map((composed) => composed.name));
      const adopter = parseConsentPurposes("consent({ purposes })", resolved.purposes, null, reserved);
      catalog = new Map([...declared, ...adopter].map((purpose) => [purpose.id, purpose]));
    },
    consentReader: reader,
    middleware: [mergeOnSignIn(options)],
    routes: registerConsentRoutes(options),
    adminRoutes: consentAdminRoutes(resolved.basePath),
    // The record is the proof processing was allowed and that it stopped: kept through a purge, with its basis, and
    // exported on an access request.
    purge: [consentUserPurge(visitorWindowMs)],
  });

  return Object.assign(capability, { consentConfig: resolved, consentCatalog: () => catalog });
}

export function isConsentCapability(c: Capability): c is ConsentCapability {
  return c.name === "consent" && "consentConfig" in c;
}
