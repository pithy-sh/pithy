// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { noopEmit } from "../../audit/recorder";
import type { Capability, PithyHonoEnv } from "../../capability/capability";
import { causeMessage } from "../../error/cause";
import type { RouteGroup } from "../../openapi/document";
import { describedOperations } from "../../openapi/operations";
import { privacyAttestation } from "../../privacy/posture";
import type { PrivacyInventory } from "../../privacy/report";
import type { RetirementVerdict } from "../../privacy/retirement";
import { workerVersionMetadata } from "../../worker/identity";
import type { ControlPlaneContext } from "../context";
import { ControlPlaneConnection } from "../data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, type ControlPlaneDatabase } from "../data/tables";
import { type CapabilityHealthSource, readCapabilityHealth } from "../discovery/health";
import type { ControlPlaneEvidenceResponse } from "../http/responses";
import { type ComposedMigrationDatabase, readDatabaseMigrations } from "../migrationState/migrationState";
import { MIGRATIONS_READ_SCOPE } from "../scope/scope";
import {
  type ConnectionRecord,
  type Derived,
  deriveAuditLogging,
  deriveChangeHistory,
  deriveCsrf,
  deriveDataProtection,
  deriveKeyRotation,
  deriveManagementAccess,
  deriveRouteVerification,
  evidenceEntry,
  type SecretsRotationInput,
} from "./derive";
import { EVIDENCE_CONTROL_IDS, EVIDENCE_MAPPING_VERSION, type EvidenceControlId, SECRETS_CAPABILITY } from "./mapping";

/**
 * The reads behind the evidence pack (#821): what the Worker composes, records and declares, gathered once per
 * call and handed to the pure derivations in `./derive.ts`.
 *
 * **Every read reports what it found or that it could not look, and never throws past here.** One unreadable
 * table costs the controls that read it their answer — `not-derivable`, with the reason — and the pack still
 * answers. A cause goes to the Worker's log, for the operator, and never into the pack: a D1 error can name a
 * table or a query.
 *
 * **The pack never widens a scope.** Migration state is read only when the connection holds `migrations:read`,
 * and a capability's health only for the keys this connection is granted, exactly as the manifest reads them.
 */

/** What the pack reads from the composed seam. Thunks, because the `compose` hook fills them after routes mount. */
export interface EvidenceSources {
  /** Every capability this Worker composed. */
  composition: () => readonly Capability[];
  /** Every capability's health contribution, by name. */
  composedHealth: () => ReadonlyMap<string, CapabilityHealthSource>;
  /** Every database this Worker binds, with what this build declares for it. */
  composedMigrations: () => readonly ComposedMigrationDatabase[];
  /** The privacy inventory, walked once per isolate. */
  privacyInventory: () => PrivacyInventory;
  /** The field key's retirement guard. Never throws. */
  retirement: (env: Record<string, unknown>) => Promise<RetirementVerdict>;
  /** The route table `createBackend` recorded, or `undefined` for an app it did not assemble. */
  routeGroups: () => readonly RouteGroup[] | undefined;
  /** The app database for this request. */
  database: (c: Context<PithyHonoEnv>) => ControlPlaneDatabase;
  /** The clock. */
  now: () => Date;
}

/** Every connection registered for this environment, or null where the table could not be read. */
async function readConnections(
  c: Context<PithyHonoEnv>,
  sources: EvidenceSources,
  environment: string,
): Promise<ConnectionRecord[] | null> {
  try {
    const rows = await sources
      .database(c)
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("environment", "=", environment)
      .orderBy("createdAt")
      .execute();
    return rows.map((row) => {
      // Only the fields the pack reports and the key windows it ages. The public halves stay in the row.
      const connection = ControlPlaneConnection.parse(row);
      return {
        id: connection.id,
        authorizedBy: connection.authorizedBy,
        actorKind: connection.actorKind,
        purpose: connection.purpose,
        scopes: connection.scopes,
        keys: connection.keys.map(({ validFrom, validUntil, revokedAt }) => ({ validFrom, validUntil, revokedAt })),
      };
    });
  } catch (cause) {
    c.var.log.warn("evidence: connections unreadable", { reason: causeMessage(cause) ?? String(cause) });
    return null;
  }
}

/** The composed audit recorder and whether each binding it writes through is present, or null for none. */
function auditRecorder(capabilities: readonly Capability[], env: Record<string, unknown>) {
  const recorder = capabilities.find((capability) => capability.auditRecorder !== undefined);
  if (!recorder) return null;
  const bindings = [...new Set(Object.values(recorder.databases ?? {}).map((database) => database.binding))];
  return {
    capability: recorder.name,
    bindings: bindings.map((binding) => ({ binding, present: env[binding] != null })),
  };
}

/** Secrets' rotation status for this caller, read exactly as the manifest reads it. */
async function secretsRotation(
  c: Context<PithyHonoEnv>,
  sources: EvidenceSources,
  context: ControlPlaneContext,
): Promise<SecretsRotationInput> {
  if (!sources.composition().some((capability) => capability.name === SECRETS_CAPABILITY)) {
    return { state: "not-composed" };
  }
  const source = sources.composedHealth().get(SECRETS_CAPABILITY);
  const report = await readCapabilityHealth(source, context.grantedScopes, (found) => found.read(c));
  return { state: "composed", keys: source?.keys ?? [], report };
}

/** The privacy inventory, or null where the walk threw. */
function inventoryOf(c: Context<PithyHonoEnv>, sources: EvidenceSources): PrivacyInventory | null {
  try {
    return sources.privacyInventory();
  } catch (cause) {
    c.var.log.warn("evidence: privacy inventory unreadable", { reason: causeMessage(cause) ?? String(cause) });
    return null;
  }
}

/** Read everything the pack derives from, and derive it. */
export async function readEvidencePack(
  c: Context<PithyHonoEnv>,
  sources: EvidenceSources,
  context: ControlPlaneContext,
): Promise<ControlPlaneEvidenceResponse> {
  const env = c.env as Record<string, unknown>;
  const now = sources.now();
  const groups = sources.routeGroups();
  const operations = groups === undefined ? undefined : describedOperations(groups);
  const migrationsGranted = context.grantedScopes.includes(MIGRATIONS_READ_SCOPE);

  const [connections, secrets, retirement, databases] = await Promise.all([
    readConnections(c, sources, context.environment),
    secretsRotation(c, sources, context),
    sources.retirement(env),
    migrationsGranted
      ? Promise.all(
          sources.composedMigrations().map((entry) =>
            readDatabaseMigrations(env, entry, (failed, cause) =>
              c.var.log.warn("evidence: migration ledger unreadable", {
                database: failed.database,
                binding: failed.binding,
                reason: causeMessage(cause) ?? String(cause),
              }),
            ),
          ),
        )
      : Promise.resolve([]),
  ]);

  const derived: Record<EvidenceControlId, Derived> = {
    "audit-logging": deriveAuditLogging({
      recorder: auditRecorder(sources.composition(), env),
      emitting: c.var.emit !== noopEmit,
    }),
    "route-verification": deriveRouteVerification(operations),
    "management-access": deriveManagementAccess(connections),
    "key-rotation": deriveKeyRotation({ connections, now, secrets, retirement }),
    "change-history": deriveChangeHistory({ granted: migrationsGranted, databases }),
    "data-protection": deriveDataProtection({
      inventory: inventoryOf(c, sources),
      attestation: privacyAttestation(env),
    }),
    csrf: deriveCsrf({ operations, sameOriginPublished: c.var.sameOrigin !== null }),
  };

  return {
    environment: context.environment,
    generatedAt: now.toISOString(),
    version: workerVersionMetadata(c.env).id,
    mappingVersion: EVIDENCE_MAPPING_VERSION,
    controls: EVIDENCE_CONTROL_IDS.map((control) => evidenceEntry(control, derived[control])),
  };
}
