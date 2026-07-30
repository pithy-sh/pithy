import type { Context } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { ControlPlaneAuditActions, safeEmit } from "../audit/actions";
import type { ControlPlaneConfig } from "../config/config";
import type { ControlPlaneContext } from "../context";
import { ControlPlaneConnection, type RegisteredKey } from "../data/connection";
import { appendKey, expireKey, pruneKeys } from "../data/keyLifecycle";
import { CONTROL_PLANE_CONNECTIONS_TABLE, type ControlPlaneDatabase } from "../data/tables";
import { ControlPlaneInvalidCredentialError, ControlPlaneKeyConflictError } from "../error/errors";
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
   * **discovery over configuration** work: a management client builds its navigation from what a Worker
   * declares it has, so a Worker without payments simply has no purchases pane, and `pithy add support`
   * produces a support pane with nothing for either side to configure.
   */
  composedCapabilities: () => readonly string[];
  /** The clock, injected so a test can stand at any instant. */
  now: () => Date;
}

/** The verified caller. Never null here — `requireControlPlane` ran first, or this code is unreachable. */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    // Defence in depth against a route line assembled without the gate. It cannot happen through
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

/** The public view of one registered key. Windows and ages, never anything secret. */
function publicKeyView(key: RegisteredKey): Record<string, unknown> {
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    validFrom: key.validFrom.toISOString(),
    validUntil: key.validUntil?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
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
    });
  };
}

/**
 * `GET /control-plane/manifest` — what this Worker is and what it composes.
 *
 * Discovery over configuration. A client builds its navigation from this rather than from settings
 * someone maintains, so a Worker with no payments capability has no purchases pane as a matter of fact.
 */
export function manifestHandler(deps: ControlPlaneHandlerDeps) {
  return (c: Context<PithyHonoEnv>) => {
    const context = caller(c);
    return c.json({
      environment: context.environment,
      connectionId: context.connectionId,
      capabilities: [...deps.composedCapabilities()],
      grantedScopes: [...context.grantedScopes],
    });
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
    });
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
          environment: connection.environment,
        },
      },
      c.var.log,
    );

    return c.json({ keyId: body.keyId, validFrom: now.toISOString(), keys: pruned.map(publicKeyView) }, 201);
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
          environment: connection.environment,
        },
      },
      c.var.log,
    );

    return c.json({ keyId: params.keyId, validUntil: now.toISOString(), keys: expired.map(publicKeyView) });
  };
}
