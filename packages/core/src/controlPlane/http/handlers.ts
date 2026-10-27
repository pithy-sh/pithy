// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { Capability, PithyHonoEnv } from "../../capability/capability";
import { commandName } from "../../cli/command";
import { causeMessage } from "../../error/cause";
import type { RouteGroup } from "../../openapi/document";
import type { PresenceDeclaration } from "../../presence/declaration";
import { privacyAttestation, privacyPosture } from "../../privacy/posture";
import type { PrivacyInventory } from "../../privacy/report";
import type { RetirementVerdict } from "../../privacy/retirement";
import { workerVersionMetadata } from "../../worker/identity";
import { ControlPlaneAuditActions, safeEmit } from "../audit/actions";
import type { ControlPlaneConfig } from "../config/config";
import type { ControlPlaneContext } from "../context";
import { ControlPlaneConnection, type RegisteredKey } from "../data/connection";
import { appendKey, expireKey, pruneKeys } from "../data/keyLifecycle";
import type { OidcTrust } from "../data/oidcTrust";
import { CONTROL_PLANE_CONNECTIONS_TABLE, type ControlPlaneDatabase } from "../data/tables";
import type { CapabilityDeclaration, ControlPlaneManifestWire } from "../discovery/adminRoute";
import { type CapabilityHealthSource, readCapabilityHealth } from "../discovery/health";
import { healthWire } from "../discovery/healthSummary";
import { ControlPlaneInvalidCredentialError, ControlPlaneKeyConflictError } from "../error/errors";
import { readEvidencePack } from "../evidence/pack";
import { type ComposedMigrationDatabase, readDatabaseMigrations } from "../migrationState/migrationState";
import type {
  ControlPlaneEvidenceResponse,
  ControlPlaneKeysResponse,
  ControlPlaneMigrationsResponse,
  ControlPlanePingResponse,
  ControlPlanePrivacyResponse,
  ExpireKeyResponse,
  PublicKeyView,
  RegisterKeyResponse,
  TrustView,
} from "./responses";
import type { ExpireKeyParams, ExpireKeyRequest, RegisterKeyRequest } from "./schemas";

/**
 * The seam's own route handlers.
 *
 * Every one runs behind `requireControlPlane`, so `c.var.controlPlane` is set by the time any of them
 * is entered. They read it rather than re-deriving anything: the verification decision is made once,
 * in `verify.ts`, and a handler that second-guessed it would be a second place for the rules to drift.
 *
 * **Nothing here returns a key's private half, because none is ever held.** `GET /control-plane/keys`
 * returns public keys and their windows, which is exactly what a management client needs to see that a
 * key is ageing and exactly what an attacker learns nothing from.
 *
 * **Every response has an exported schema**, in `responses.ts`, and each `c.json` below is
 * `satisfies`-checked against it. A management client imports the same object and validates with it
 * rather than hand-writing a mirror that drifts. The check is at compile time on purpose: parsing every
 * response would spend a validation pass on values this Worker just built, and would turn a shape
 * mistake into a 500 in production rather than a red build.
 */

/** A day, in ms — `keyRetentionDays` is expressed in days because that is how anyone reasons about it. */
const MS_PER_DAY = 86_400_000;

/** The pieces of the composed capability a handler needs. Passed in, so nothing reaches for a global. */
export interface ControlPlaneHandlerDeps {
  /** The resolved seam config — pruning bounds, mostly. */
  config: ControlPlaneConfig;
  /** The app database, resolved per request from the `DB` binding. */
  database: (c: Context<PithyHonoEnv>) => ControlPlaneDatabase;
  /**
   * The names of every capability this Worker composed, captured by the capability's `compose` hook at
   * assembly. A thunk because that hook runs after the routes closure is built.
   *
   * This is assembly-time knowledge no capability has about its siblings, and it is what makes
   * **discovery over configuration** work: a management client builds its navigation *and its calls*
   * from what a Worker declares, so a Worker without payments simply has no purchases pane, and
   * `pithy add support` produces a working support pane with nothing for either side to configure.
   */
  composedCapabilities: () => readonly CapabilityDeclaration[];
  /**
   * The health summary each capability contributes, by capability name — captured by the same `compose`
   * hook, and checked there against the scopes that capability's own routes require.
   *
   * Separate from {@link composedCapabilities} because a declaration is the same for every caller and a
   * value is not: the numbers are resolved per request, behind the scope each one is declared under.
   */
  composedHealth: () => ReadonlyMap<string, CapabilityHealthSource>;
  /**
   * Every database this Worker binds, with the provider this build composes for it — captured by the same
   * `compose` hook through `collectMigrationSets`, the function `pithy migrate` composes with (#729).
   */
  composedMigrations: () => readonly ComposedMigrationDatabase[];
  /**
   * The privacy inventory of every storage schema this Worker composed (#132), walked on the first call and
   * cached for the isolate. A thunk, so a Worker whose control plane is never called never walks.
   */
  privacyInventory: () => PrivacyInventory;
  /**
   * The field key's retirement verdict (#390): the guard over this Worker's encrypted columns, read through its own
   * bindings. Never throws: whatever it cannot read is incomplete coverage.
   */
  retirement: (env: Record<string, unknown>) => Promise<RetirementVerdict>;
  /**
   * Every presence room kind this Worker composed, by kind, with the declaration that serves it — captured
   * by the same `compose` hook. A thunk for the same reason as {@link composedCapabilities}.
   */
  composedPresence: () => ReadonlyMap<string, PresenceDeclaration>;
  /**
   * Every capability this Worker composed, as the objects themselves — the evidence pack reads which one records
   * audit events and the bindings it writes through (#821). A thunk for the same reason as the rest.
   */
  composition: () => readonly Capability[];
  /**
   * The route table `createBackend` recorded for the app these routes mounted on, or `undefined` for an app it did
   * not assemble. Read per call, after every capability's routes have mounted, so the evidence pack sees them all.
   */
  routeGroups: () => readonly RouteGroup[] | undefined;
  /** The clock, injected so a test can stand at any instant. */
  now: () => Date;
}

/** The verified caller. Never null here — `requireControlPlane` ran first, or this code is unreachable. */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    // Defense in depth against a route line assembled without the gate. It cannot happen through
    // `registerControlPlaneRoutes`, and if it ever did the failure must be a denial rather than a
    // handler reading `undefined` and carrying on.
    throw new ControlPlaneInvalidCredentialError({ detail: "handler reached with no verified control-plane caller" });
  }
  return context;
}

/** Load the connection this call authenticated against. It verified moments ago, so it exists. */
async function loadConnection(
  db: ControlPlaneDatabase,
  connectionId: string,
): Promise<{ connection: ControlPlaneConnection }> {
  const row = await db
    .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
    .selectAll()
    .where("id", "=", connectionId)
    .executeTakeFirst();
  if (!row) {
    // The row was deleted between verification and here — a revocation landing mid-request. Denying is
    // the correct answer: revocation is meant to be immediate.
    throw new ControlPlaneInvalidCredentialError({ detail: `connection ${connectionId} disappeared mid-request` });
  }
  return { connection: ControlPlaneConnection.parse(row) };
}

/** Write a connection's key array back, stamping `updatedAt`. One UPDATE — a rotation cannot half-apply. */
async function saveKeys(
  db: ControlPlaneDatabase,
  connectionId: string,
  keys: readonly RegisteredKey[],
  now: Date,
): Promise<void> {
  const encoded = ControlPlaneConnection.shape.keys.encode([...keys]);
  await db
    .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
    .set({ keys: encoded, updatedAt: ControlPlaneConnection.shape.updatedAt.encode(now) })
    .where("id", "=", connectionId)
    .execute();
}

/**
 * The public view of one registered key. Windows and ages, never anything secret.
 *
 * The return type is `z.output` of the exported schema, so what this sends and what a management
 * client validates against are one declaration rather than two that drift. It was
 * `Record<string, unknown>`, which is not a contract at all.
 */
function publicKeyView(key: RegisteredKey): PublicKeyView {
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    validFrom: key.validFrom.toISOString(),
    validUntil: key.validUntil?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

/** The public view of one OIDC trust: its issuer, audience and claims — the population it admits. */
function trustView(trust: OidcTrust): TrustView {
  return {
    trustId: trust.trustId,
    issuer: trust.issuer,
    audience: trust.audience,
    claims: { ...trust.claims },
    authorizedBy: trust.authorizedBy,
    validFrom: trust.validFrom.toISOString(),
    revokedAt: trust.revokedAt?.toISOString() ?? null,
    firstCallAt: trust.firstCallAt?.toISOString() ?? null,
  };
}

/**
 * Refuse a key write to a caller that verified under an OIDC trust (#722).
 *
 * A trust exists so that no key is held on the workload's host. Letting a trust's caller register a key would
 * turn a short-lived identity into a standing credential at the first call — an exchange by another name, and
 * the custody the trust was registered to avoid. Granting `keys:rotate` to a connection is a statement about
 * its keys, never a license for a workload to mint one.
 */
function refuseTrustCaller(context: ControlPlaneContext, what: string): void {
  if (context.credentialKind !== "trust") return;
  throw new ControlPlaneKeyConflictError({
    message: "A call under a workload trust cannot change this connection's keys.",
    action: `Register or expire a key from a client that holds one, or with ${commandName("dashboard connect")}.`,
    detail: `${what} refused: trust ${context.keyId} verified this call`,
  });
}

/**
 * `GET /control-plane/ping` — connectivity and key proof.
 *
 * The most important route here despite doing nothing, because it is what a management client calls to
 * prove a newly registered key **before** the key it replaces is expired. Requires a verified caller
 * and no scope: a connection granted nothing must still be able to prove a key, or rotation has a state
 * it cannot get out of.
 *
 * It echoes the `keyId` that verified the call, so the client can confirm *which* key answered rather
 * than inferring it from a 200.
 */
export function pingHandler(deps: ControlPlaneHandlerDeps) {
  return (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    return c.json({
      status: "ok",
      connectionId: context.connectionId,
      environment: context.environment,
      keyId: context.keyId,
      now: deps.now().toISOString(),
    } satisfies ControlPlanePingResponse);
  };
}

/**
 * `GET /control-plane/manifest` — what this Worker is, what it composes, and how each part is doing.
 *
 * Discovery over configuration. A client builds its navigation from this rather than from settings
 * someone maintains, so a Worker with no payments capability has no purchases pane as a matter of fact.
 *
 * **And the numbers a client would otherwise pay a second round trip for** (#317). Each capability's
 * bounded summary is resolved here, behind the scope that capability's own read is behind: a connection
 * without it gets no number rather than a zero, and never costs the adopter's Worker the query.
 *
 * **One capability's failure costs one capability's number** (#350). A producer that throws, or that
 * reports something its declaration cannot name, lands on `unavailable` for that entry alone —
 * `readCapabilityHealth` catches it, so nothing rejects, so `Promise.all` still resolves and every
 * sibling still reports. This route is what the whole management surface is built from; a manifest that
 * 500s takes every pane with it, and the capability at fault is the one thing the screen could not then
 * name.
 */
export function manifestHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    const sources = deps.composedHealth();
    // In parallel: each producer is bounded by its own declaration, and a Worker composing several has
    // no reason to serialize numbers that do not depend on each other.
    const capabilities = await Promise.all(
      deps.composedCapabilities().map(async (declaration) => ({
        ...declaration,
        // Spread, so the values and the failure flag are written together or not at all. A handler that
        // set one and forgot the other is the shape of defect the four-state value exists to prevent.
        ...healthWire(
          await readCapabilityHealth(sources.get(declaration.name), context.grantedScopes, (source) => source.read(c)),
        ),
      })),
    );
    // The build answering this call. Read per request rather than captured at assembly: it is the same
    // binding every log record and audit event reads, and there is one reader for it.
    const build = workerVersionMetadata(c.env);
    return c.json({
      environment: context.environment,
      connectionId: context.connectionId,
      version: build.id,
      // Beside the id, because the id alone cannot tell a deploy from a rollback (#132): a rollback
      // reactivates a version already seen, and this is the one field that moves backwards when it does.
      versionCreatedAt: build.createdAt,
      // Classes and counts, never field names — those are `GET /privacy`'s, behind their own scope. A project
      // that declared nothing walks nothing; otherwise the walk is the isolate's cached one.
      // The retirement verdict beside it (#390), so a dashboard reads the guard rather than inferring it.
      privacy: {
        ...privacyPosture(privacyAttestation(c.env), deps.privacyInventory),
        retirement: await deps.retirement(c.env as Record<string, unknown>),
      },
      capabilities,
      grantedScopes: [...context.grantedScopes],
    } satisfies ControlPlaneManifestWire);
  };
}

/**
 * `GET /control-plane/migrations` — where each database this Worker binds stands (#729).
 *
 * Read-only: it reports, and nothing over the seam runs, reverses or resets a migration.
 *
 * **One unreadable ledger costs one database its answer.** Each read catches its own failure and lands on
 * `unreadable`, so `Promise.all` still resolves and the route answers 200 with what it has. The cause is
 * logged here, for the operator, and never projected: a D1 error can name a table or a query.
 */
export function migrationsHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    const env = c.env as Record<string, unknown>;
    const databases = await Promise.all(
      deps.composedMigrations().map((entry) =>
        readDatabaseMigrations(env, entry, (failed, cause) =>
          c.var.log.warn("migration ledger unreadable", {
            database: failed.database,
            binding: failed.binding,
            reason: causeMessage(cause) ?? String(cause),
          }),
        ),
      ),
    );
    return c.json({ environment: context.environment, databases } satisfies ControlPlaneMigrationsResponse);
  };
}

/** `GET /control-plane/keys` — the registration state, so a client can surface a stale key. */
export function listKeysHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    const { connection } = await loadConnection(deps.database(c), context.connectionId);
    return c.json({
      connectionId: connection.id,
      environment: connection.environment,
      keys: connection.keys.map(publicKeyView),
      // The review a credential listing exists for needs these, and it is the adopter's to perform —
      // on their own side, from their own row (#721).
      authorizedBy: connection.authorizedBy,
      actorKind: connection.actorKind,
      purpose: connection.purpose,
      trusts: (connection.trusts ?? []).map(trustView),
    } satisfies ControlPlaneKeysResponse);
  };
}

/**
 * `POST /control-plane/keys` — register a new public key, authenticated by the key it succeeds.
 *
 * This is the route the whole rotation story rests on, and its authentication is the subtle part: the
 * request is signed with the key being replaced. That is what makes rotation self-bootstrapping —
 * trust flows forward from existing trust, exactly as a rotated refresh token does — and what makes an
 * unreachable Worker a deferral rather than a lockout.
 *
 * It appends and only appends. The new key's window opens now and no existing key's window moves.
 */
export function registerKeyHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, body: RegisterKeyRequest) => {
    const context = caller(c);
    refuseTrustCaller(context, "key registration");
    const db = deps.database(c);
    const now = deps.now();
    const { connection } = await loadConnection(db, context.connectionId);

    const appended = appendKey(
      connection.keys,
      { keyId: body.keyId, publicKey: body.publicKey, validFrom: now, validUntil: null, revokedAt: null },
      now,
    );
    const pruned = pruneKeys(appended, {
      now,
      retentionMs: deps.config.keyRetentionDays * MS_PER_DAY,
      maxKeys: deps.config.maxKeys,
    });
    await saveKeys(db, connection.id, pruned, now);

    await safeEmit(
      c.var.emit,
      {
        action: ControlPlaneAuditActions.keyRegistered,
        outcome: "success",
        severity: "warning",
        actorType: "control-plane",
        actorId: context.subject,
        resourceType: "controlplane_connection",
        resourceId: connection.id,
        requestId: c.req.header("cf-ray"),
        ip: c.req.header("cf-connecting-ip"),
        userAgent: c.req.header("user-agent"),
        // Key ids, never key material. A registered key changing in an adopter's system is exactly what
        // looks alarming during a security review, so the trail names both sides of the handover.
        metadata: {
          connectionId: connection.id,
          registeredKeyId: body.keyId,
          signedWithKeyId: context.keyId,
          connectionEnvironment: connection.environment,
        },
      },
      c.var.log,
    );

    return c.json(
      {
        keyId: body.keyId,
        validFrom: now.toISOString(),
        keys: pruned.map(publicKeyView),
      } satisfies RegisterKeyResponse,
      201,
    );
  };
}

/**
 * `POST /control-plane/keys/:keyId/expire` — retire a superseded key, once its replacement is proven.
 *
 * A separate call from registration, deliberately. Folding them into one would make append-and-expire
 * atomic, and atomic is precisely wrong here: the point is that the old key survives until the new one
 * has been proven against a live ping. `expireKey` enforces both halves of that — the named successor
 * must currently verify, and the expiry must not empty the connection's live set.
 *
 * **And the successor must be the key that signed this very request.** That is what "proof by use"
 * means, and checking only that `provenKeyId` names *some* live key would not deliver it: a client
 * still signing with the old key could name a successor it has never successfully used and retire the
 * one thing that currently works. The client asserts which key it believes proved itself, the seam
 * compares that against which key actually did, and a client that is wrong about its own rotation gets
 * a 409 instead of a lockout.
 */
export function expireKeyHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, params: ExpireKeyParams, body: ExpireKeyRequest) => {
    const context = caller(c);
    refuseTrustCaller(context, "key expiry");
    const db = deps.database(c);
    const now = deps.now();
    const { connection } = await loadConnection(db, context.connectionId);

    if (body.provenKeyId !== context.keyId) {
      throw new ControlPlaneKeyConflictError({
        message: "Sign this request with the replacement key you are naming as proven.",
        action: "Rotate to the new key, make a call with it, then expire the old one in that same call.",
        detail: `provenKeyId ${body.provenKeyId} is not the key that signed this request (${context.keyId})`,
      });
    }

    const expired = expireKey(connection.keys, params.keyId, { provenKeyId: body.provenKeyId, now });
    await saveKeys(db, connection.id, expired, now);

    await safeEmit(
      c.var.emit,
      {
        action: ControlPlaneAuditActions.keyExpired,
        outcome: "success",
        severity: "warning",
        actorType: "control-plane",
        actorId: context.subject,
        resourceType: "controlplane_connection",
        resourceId: connection.id,
        requestId: c.req.header("cf-ray"),
        ip: c.req.header("cf-connecting-ip"),
        userAgent: c.req.header("user-agent"),
        metadata: {
          connectionId: connection.id,
          expiredKeyId: params.keyId,
          provenKeyId: body.provenKeyId,
          connectionEnvironment: connection.environment,
        },
      },
      c.var.log,
    );

    return c.json({
      keyId: params.keyId,
      validUntil: now.toISOString(),
      keys: expired.map(publicKeyView),
    } satisfies ExpireKeyResponse);
  };
}

/**
 * `GET /control-plane/privacy` — the full privacy inventory (#132).
 *
 * Every storage schema this Worker composed that holds a marked field, each field's path and class, and where it
 * is stored — derived from the running code, so unmarking a field removes it on the next deploy with nothing in
 * between. Behind `privacy:read`, because field names are the kind of thing an adopter may withhold from a client
 * that has no business seeing them. Read-only.
 */
export function privacyHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    const inventory = deps.privacyInventory();
    return c.json({
      environment: context.environment,
      posture: {
        ...privacyPosture(privacyAttestation(c.env), () => inventory),
        retirement: await deps.retirement(c.env as Record<string, unknown>),
      },
      schemasWalked: inventory.schemasWalked,
      schemas: inventory.schemas.map((schema) => ({
        ...schema,
        fields: schema.fields.map((field) => ({ ...field })),
        encrypted: schema.encrypted.map((field) => ({ ...field })),
      })),
    } satisfies ControlPlanePrivacyResponse);
  };
}

/**
 * `GET /control-plane/evidence` — the evidence pack (#821).
 *
 * SOC 2 and ISO 27001 evidence derived from what this Worker composes, records and declares: each control's
 * references, the facts read and their sources, and `evidenced`, `gap` or `not-derivable` with the reason. It
 * proves controls present and performs nothing. Behind `evidence:read`, and it never widens another scope: what
 * a capability keeps behind its own read stays there. Read-only.
 */
export function evidenceHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    return c.json((await readEvidencePack(c, deps, context)) satisfies ControlPlaneEvidenceResponse);
  };
}
