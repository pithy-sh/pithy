// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection, Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { activeKeys } from "@pithy-sh/core/src/controlPlane/data/keyLifecycle";
import { ControlPlaneNotConnectedError } from "@pithy-sh/core/src/controlPlane/error/errors";
import { type ControlPlaneScope, SEAM_SCOPES } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { ConflictError, messageOf, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ConnectionHealth, DashboardClient, DeviceAuthorization } from "./api";
import type { ConnectionRegistry } from "./registry";

/**
 * `pithy dashboard`'s orchestration — connect, rotate, disconnect, status — with every I/O boundary
 * injected. The registry is the adopter's D1, the client is the management client, and nothing here
 * touches either directly.
 *
 * Three rules are load-bearing, and each of them is a failure mode this seam exists to prevent.
 *
 * **Nothing reports connected until a signed round-trip has succeeded.** A registration that was
 * written but cannot be reached is a dead link, and reporting it as connected is how an operator finds
 * out weeks later. The CLI holds no private key, so it cannot sign the ping itself — it asks the
 * management client to, which is why `verifyConnection` is on the contract at all.
 *
 * **The CLI never expires a key.** Rotation is append, prove, then expire (docs/CONTROL-PLANE.md §6),
 * and the third step belongs to the management client once *it* has proven the successor works from
 * *its* infrastructure. A CLI that expired the old key on the strength of its own ping would recreate
 * exactly the lockout the ordering exists to prevent — and the lockout is the one failure with no
 * authenticated path back.
 *
 * **Revocation is local and unilateral.** `disconnect` deletes the adopter's row first and tells the
 * dashboard afterwards, as a courtesy. A dashboard that is down, unreachable, or uncooperative must
 * not be able to keep a connection alive; that property is the reason granting this access is
 * defensible at all (§7).
 */

/** How a connect run ended. `registered` is the offline path: written, but not proven by a ping. */
export type ConnectStatus = "connected" | "needs_reconnect" | "registered";

/** What `pithy dashboard connect` did, in the shape `--json` emits and the human formatter renders. */
export interface ConnectReport {
  /** The environment the connection is bound to. */
  environment: string;
  /** The connection's id — the token `aud`, and the row's primary key. */
  connectionId: string;
  /** The management-client origin every token from this connection must carry. */
  issuer: string;
  /** The Worker URL the management client will call. */
  workerUrl: string;
  /** The operations granted, as stored on the row. */
  scopes: readonly string[];
  /** The key registered by this run, or null when `--update` only re-pointed. */
  keyId: string | null;
  /** Whether a signed ping proved the connection, or why it could not. */
  status: ConnectStatus;
  /** Operator-facing context for a status that is not `connected`. */
  detail?: string;
  /** True when an existing connection was re-pointed rather than a new one created. */
  updated: boolean;
}

/** A key the operator generated themselves — the offline registration path, with no dashboard at all. */
export interface OfflinePublicKey {
  /** The key's id, which the operator's own client will put in every token's `kid` header. */
  keyId: string;
  /** The Ed25519 public key to trust. */
  publicKey: Ed25519PublicJwk;
  /** The `iss` the operator's client will present. Required: verification compares it on every call. */
  issuer: string;
}

/** Turn a started device authorization into a connect token. Injected so tests never sleep or poll. */
export type Authorize = (client: DashboardClient) => Promise<string>;

/** Options for {@link authorizeDashboard}. */
export interface AuthorizeOptions {
  /** Where to show the user code and verification URI — stderr in the CLI, a spy in a test. */
  announce?: (authorization: DeviceAuthorization) => void;
  /** The wait between polls. Injected so a test does not spend the interval. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock, in milliseconds. */
  now?: () => number;
}

/**
 * Run the device-code flow and return the connect token.
 *
 * This leg is genuine user delegation — a human approving in a browser — which is why a browser
 * authorization flow belongs here and nowhere near the machine-to-machine leg. Polling stops at the
 * authorization's own expiry rather than running forever, and a `410` from the client is not retried:
 * the request is gone, and the answer is to start a new one.
 */
export async function authorizeDashboard(client: DashboardClient, options: AuthorizeOptions = {}): Promise<string> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  const authorization = await client.startDeviceAuthorization();
  options.announce?.(authorization);

  const deadline = now() + authorization.expiresInSeconds * 1000;
  while (now() < deadline) {
    const result = await client.pollForConnectToken(authorization.deviceCode);
    if (result !== "pending") return result.connectToken;
    await sleep(authorization.intervalSeconds * 1000);
  }

  throw new ValidationError({
    message: "That sign-in request expired.",
    action: "Run the command again and approve it in the browser.",
    detail: `device authorization ${authorization.deviceCode} was never approved`,
  });
}

/** Options for {@link connectDashboard}. */
export interface ConnectDashboardOptions {
  /** The adopter's registration store for this environment. */
  registry: ConnectionRegistry;
  /** The project's stable name, from the root `pithy.config.ts`. */
  project: string;
  /** The environment being connected. */
  environment: string;
  /** This environment's Worker URL. Required to create a connection; optional when only re-pointing. */
  workerUrl?: string;
  /** The scopes to grant. Defaults to the seam's own on a create; left alone on an update. */
  scopes?: readonly ControlPlaneScope[];
  /** Re-point an existing connection's URL and scopes instead of creating one. */
  update?: boolean;
  /** Register a key the operator generated. When set, no dashboard is contacted at all. */
  publicKey?: OfflinePublicKey;
  /** The management client. Absent only on the offline path. */
  client?: DashboardClient;
  /** The device-code flow (default: {@link authorizeDashboard}). */
  authorize?: Authorize;
  /** The clock. */
  now?: () => Date;
}

/**
 * Connect this environment to a management client, or re-point the connection it already has.
 *
 * Order matters. The row is written before the ping, because the ping only means something once the
 * Worker can actually load the key; and the report's status comes from the ping, not from the write
 * having succeeded.
 */
/**
 * The scopes to store, given what the operator asked for and what the client says it recorded.
 *
 * The answer is always the operator's list. The client's response is checked, not trusted: it may
 * decline a scope (returning fewer is its business), but a scope it returns that nobody requested is a
 * management client trying to widen its own grant, and the only safe response is to refuse the
 * connection outright rather than quietly store the narrower set and leave the two sides disagreeing.
 */
function assertNoScopeEscalation(requested: readonly string[], issued: readonly string[]): string[] {
  const escalated = issued.filter((scope) => !requested.includes(scope));
  if (escalated.length > 0) {
    throw new ValidationError({
      message: "The management client asked for more access than you granted.",
      action: "Nothing was registered. Re-run the connect, and report this to whoever operates that client.",
      detail: `client returned unrequested scopes [${escalated.join(", ")}]; requested [${requested.join(", ")}]`,
    });
  }
  return [...requested];
}

export async function connectDashboard(options: ConnectDashboardOptions): Promise<ConnectReport> {
  const now = options.now?.() ?? new Date();
  const existing = await options.registry.read();

  if (options.publicKey) return connectOffline(options, existing, now);

  const client = options.client;
  if (!client) {
    throw new ValidationError({
      message: "Nothing to connect with.",
      action:
        "Run pithy dashboard connect to use the dashboard, or pass --public-key and --issuer to register your own key.",
    });
  }

  const authorize = options.authorize ?? ((target: DashboardClient) => authorizeDashboard(target));
  const token = await authorize(client);

  if (options.update) {
    if (!existing) {
      throw new ControlPlaneNotConnectedError({
        action: "Connect this environment first: pithy dashboard connect --env <environment>.",
        detail: `--update with no connection registered for ${options.environment}`,
      });
    }
    const connection: ControlPlaneConnection = {
      ...existing,
      workerUrl: options.workerUrl ?? existing.workerUrl,
      scopes: options.scopes ? [...options.scopes] : existing.scopes,
      updatedAt: now,
    };
    await options.registry.save(connection);
    // Re-pointing is not a rotation. The keys are the client's, and they still work.
    const health = await probe(client, token, connection);
    return report(connection, { keyId: null, updated: true, health });
  }

  const workerUrl = requireWorkerUrl(options.workerUrl);
  const scopes = options.scopes ? [...options.scopes] : [...SEAM_SCOPES];
  const issued = await client.createConnection(token, {
    project: options.project,
    environment: options.environment,
    workerUrl,
    scopes,
  });

  const connection: ControlPlaneConnection = {
    id: issued.connectionId,
    environment: options.environment,
    issuer: issued.issuer,
    workerUrl,
    // **What the operator asked for, never what the client echoed back.** This row is the adopter's
    // enforcement copy, and it is the only thing their Worker consults — so writing the client's own
    // account of its grant would let the client decide what it may do, which is precisely the property
    // storing scopes on this side exists to prevent. A client that returns MORE than was asked for is
    // not a client to negotiate with, so `assertNoScopeEscalation` refuses the whole connection.
    scopes: assertNoScopeEscalation(scopes, issued.scopes),
    keys: [{ keyId: issued.keyId, publicKey: issued.publicKeyJwk, validFrom: now, validUntil: null, revokedAt: null }],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await options.registry.save(connection);

  const health = await probe(client, token, connection);
  return report(connection, { keyId: issued.keyId, updated: false, health });
}

/**
 * The offline path: register a key the operator generated, with no dashboard in the loop.
 *
 * **This has to genuinely work end to end.** The seam is MIT and ungated, and "build your own
 * management client against your own Worker" is only true if the CLI can register a key without us.
 *
 * It cannot report `connected`, and does not pretend to: proving a key needs the private half, which
 * lives with whoever generated it. The operator proves it with their own signed `ping`.
 */
async function connectOffline(
  options: ConnectDashboardOptions,
  existing: ControlPlaneConnection | null,
  now: Date,
): Promise<ConnectReport> {
  const offline = options.publicKey as OfflinePublicKey;

  if (!existing) {
    const connection: ControlPlaneConnection = {
      id: crypto.randomUUID(),
      environment: options.environment,
      issuer: offline.issuer,
      workerUrl: requireWorkerUrl(options.workerUrl),
      scopes: options.scopes ? [...options.scopes] : [...SEAM_SCOPES],
      keys: [{ keyId: offline.keyId, publicKey: offline.publicKey, validFrom: now, validUntil: null, revokedAt: null }],
      createdAt: now,
      updatedAt: now,
    };
    await options.registry.save(connection);
    return report(connection, { keyId: offline.keyId, updated: false, health: null });
  }

  // The issuer is verified on every call and is effectively permanent — changing it is a migration
  // across every registered connection, not a config edit. Silently overwriting it would strand a
  // client that still holds a working key.
  if (existing.issuer !== offline.issuer) {
    throw new ConflictError({
      message: "This environment is already connected to a different issuer.",
      action: `Run pithy dashboard disconnect --env ${options.environment} first, then connect again.`,
      detail: `registered issuer ${existing.issuer}, offered ${offline.issuer}`,
    });
  }

  if (options.update) {
    await options.registry.save({
      ...existing,
      workerUrl: options.workerUrl ?? existing.workerUrl,
      scopes: options.scopes ? [...options.scopes] : existing.scopes,
      updatedAt: now,
    });
  }
  const connection = await options.registry.appendKey(
    { keyId: offline.keyId, publicKey: offline.publicKey, validFrom: now, validUntil: null, revokedAt: null },
    now,
  );
  return report(connection, { keyId: offline.keyId, updated: options.update === true, health: null });
}

/** Options for {@link rotateDashboardKey}. */
export interface RotateDashboardKeyOptions {
  /** The adopter's registration store for this environment. */
  registry: ConnectionRegistry;
  /** The management client that generates and keeps the successor keypair. */
  client: DashboardClient;
  /** The environment being rotated. */
  environment: string;
  /** The device-code flow (default: {@link authorizeDashboard}). */
  authorize?: Authorize;
  /** The clock. */
  now?: () => Date;
}

/** What `pithy dashboard rotate` did. */
export interface RotateReport {
  /** The environment rotated. */
  environment: string;
  /** The connection the key was appended to. */
  connectionId: string;
  /** The newly registered key. */
  keyId: string;
  /** The keys that were already live, and that stay live. Two live keys is the normal state. */
  previousKeyIds: readonly string[];
  /** Whether a signed ping proved the new key. */
  status: "connected" | "needs_reconnect";
  /** Operator-facing context when the ping did not prove it. */
  detail?: string;
}

/**
 * Append a successor key and prove it.
 *
 * **The old key is deliberately left live.** Expiry is `POST /control-plane/keys/:keyId/expire`, and it
 * is the management client's call to make once it has proven the successor from its own
 * infrastructure — the CLI proving it once, from a developer's laptop, is not the same evidence. A
 * stale key costs nothing; expiring one that turns out to be the only working credential costs the
 * connection, with no authenticated path back.
 */
export async function rotateDashboardKey(options: RotateDashboardKeyOptions): Promise<RotateReport> {
  const now = options.now?.() ?? new Date();
  const connection = await options.registry.read();
  if (!connection) {
    throw new ControlPlaneNotConnectedError({
      action: `Connect this environment first: pithy dashboard connect --env ${options.environment}.`,
      detail: `rotate with no connection registered for ${options.environment}`,
    });
  }

  const authorize = options.authorize ?? ((target: DashboardClient) => authorizeDashboard(target));
  const token = await authorize(options.client);

  const previousKeyIds = activeKeys(connection.keys, now).map((key) => key.keyId);
  const issued = await options.client.rotateKey(token, connection.id);
  const updated = await options.registry.appendKey(
    { keyId: issued.keyId, publicKey: issued.publicKeyJwk, validFrom: now, validUntil: null, revokedAt: null },
    now,
  );

  const health = await probe(options.client, token, updated);
  return {
    environment: options.environment,
    connectionId: updated.id,
    keyId: issued.keyId,
    previousKeyIds,
    status: health.status,
    ...(health.detail === undefined ? {} : { detail: health.detail }),
  };
}

/** Options for {@link disconnectDashboard}. */
export interface DisconnectDashboardOptions {
  /** The adopter's registration store for this environment. */
  registry: ConnectionRegistry;
  /** The management client, told about the revocation as a courtesy. Optional. */
  client?: DashboardClient;
  /** The environment being revoked. */
  environment: string;
  /** The device-code flow (default: {@link authorizeDashboard}). */
  authorize?: Authorize;
}

/** What `pithy dashboard disconnect` did. */
export interface DisconnectReport {
  /** The environment revoked. */
  environment: string;
  /** The connection that was removed, or null when there was nothing registered. */
  connectionId: string | null;
  /** Whether a row was deleted. `false` on a re-run, which is not an error. */
  removed: boolean;
  /** Whether the management client was successfully told. Never gates the revocation. */
  dashboardNotified: boolean;
  /** Why the management client was not told, when it was not. */
  detail?: string;
}

/**
 * Revoke this environment's connection.
 *
 * **The row goes first.** Revocation is immediate, unilateral, and requires nothing from the
 * management client — that is the property that makes granting this access defensible. Telling the
 * dashboard is a courtesy that runs afterwards and cannot fail the command; a dashboard that is down
 * must not be able to keep a credential alive.
 */
export async function disconnectDashboard(options: DisconnectDashboardOptions): Promise<DisconnectReport> {
  const connection = await options.registry.read();
  if (!connection) {
    return { environment: options.environment, connectionId: null, removed: false, dashboardNotified: false };
  }

  await options.registry.remove();

  if (!options.client) {
    return { environment: options.environment, connectionId: connection.id, removed: true, dashboardNotified: false };
  }

  try {
    const authorize = options.authorize ?? ((target: DashboardClient) => authorizeDashboard(target));
    const token = await authorize(options.client);
    await options.client.deleteConnection(token, connection.id);
    return { environment: options.environment, connectionId: connection.id, removed: true, dashboardNotified: true };
  } catch (error) {
    return {
      environment: options.environment,
      connectionId: connection.id,
      removed: true,
      dashboardNotified: false,
      detail: messageOf(error),
    };
  }
}

/** One registered key, as `pithy dashboard status` reports it. */
export interface KeyReport {
  /** The key's id, as a token's `kid` names it. */
  keyId: string;
  /** Whether this key may verify a call right now. */
  live: boolean;
  /** How many whole days since the key became valid — the number a rotation policy is read against. */
  ageDays: number;
  /** When the key became valid, ISO-8601. */
  validFrom: string;
  /** When the key stops being accepted, or null while open-ended. */
  validUntil: string | null;
  /** When the key was revoked outright, or null. */
  revokedAt: string | null;
}

/** What `pithy dashboard status` found. */
export interface StatusReport {
  /** The environment inspected. */
  environment: string;
  /** Whether anything is registered at all. `false` is the shipped, denying state. */
  connected: boolean;
  /** The connection's id, or null when nothing is registered. */
  connectionId: string | null;
  /** The management-client origin this connection trusts. */
  issuer: string | null;
  /** The Worker URL the management client calls. */
  workerUrl: string | null;
  /** The operations granted. */
  scopes: readonly string[];
  /** Every registered key, live and superseded, newest window first as stored. */
  keys: readonly KeyReport[];
  /** `unverified` unless a probe was asked for — status never claims a round-trip it did not make. */
  status: "connected" | "needs_reconnect" | "unverified";
  /** Operator-facing context from the probe. */
  detail?: string;
}

/** Options for {@link dashboardStatus}. */
export interface DashboardStatusOptions {
  /** The adopter's registration store for this environment. */
  registry: ConnectionRegistry;
  /** The environment inspected. */
  environment: string;
  /**
   * Ask the management client for a signed round-trip. Optional, and off by default: `status` is the
   * command an operator runs to look, and making it require a browser sign-in every time would make
   * looking expensive. `--verify` wires it.
   */
  verify?: (connection: ControlPlaneConnection) => Promise<ConnectionHealth>;
  /** The clock. */
  now?: () => Date;
}

/** Report what is registered for this environment, and — when asked — whether it still answers. */
export async function dashboardStatus(options: DashboardStatusOptions): Promise<StatusReport> {
  const now = options.now?.() ?? new Date();
  const connection = await options.registry.read();
  if (!connection) {
    return {
      environment: options.environment,
      connected: false,
      connectionId: null,
      issuer: null,
      workerUrl: null,
      scopes: [],
      keys: [],
      status: "unverified",
    };
  }

  const live = new Set(activeKeys(connection.keys, now).map((key) => key.keyId));
  const keys = connection.keys.map((key) => ({
    keyId: key.keyId,
    live: live.has(key.keyId),
    ageDays: Math.floor((now.getTime() - key.validFrom.getTime()) / 86_400_000),
    validFrom: key.validFrom.toISOString(),
    validUntil: key.validUntil?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  }));

  const verify = options.verify;
  const health = verify ? await settle(() => verify(connection)) : null;
  return {
    environment: options.environment,
    connected: true,
    connectionId: connection.id,
    issuer: connection.issuer,
    workerUrl: connection.workerUrl,
    scopes: connection.scopes,
    keys,
    status: health?.status ?? "unverified",
    ...(health?.detail === undefined ? {} : { detail: health.detail }),
  };
}

/** The Worker URL, or the error that names the flag. A client cannot reach a Worker it cannot address. */
function requireWorkerUrl(workerUrl: string | undefined): string {
  if (workerUrl) return workerUrl;
  throw new ValidationError({
    message: "No worker URL for this environment.",
    action: "Pass --worker-url https://<your-worker> — it is the address the management client calls.",
  });
}

/** Ask the management client to sign a `ping`, and turn any failure into an honest health report. */
async function probe(
  client: DashboardClient,
  token: string,
  connection: ControlPlaneConnection,
): Promise<ConnectionHealth> {
  return settle(() => client.verifyConnection(token, connection.id, connection.workerUrl));
}

/**
 * Run a health check and never throw. A probe that fails is information, not an error: the
 * registration is real and the report has to say so *and* say the round-trip did not work. Throwing
 * here would lose the first half.
 */
async function settle(check: () => Promise<ConnectionHealth>): Promise<ConnectionHealth> {
  try {
    return await check();
  } catch (error) {
    // A non-Pithy throw is a bug in the client implementation, and its message is still the most
    // useful thing to show — but it is never swallowed silently: it lands in `detail`.
    return {
      status: "needs_reconnect",
      detail: error instanceof PithyError ? error.payload.message : messageOf(error),
    };
  }
}

/** Assemble the connect report from a saved connection and what the probe (if any) found. */
function report(
  connection: ControlPlaneConnection,
  outcome: { keyId: string | null; updated: boolean; health: ConnectionHealth | null },
): ConnectReport {
  const status: ConnectStatus = outcome.health === null ? "registered" : outcome.health.status;
  return {
    environment: connection.environment,
    connectionId: connection.id,
    issuer: connection.issuer,
    workerUrl: connection.workerUrl,
    scopes: connection.scopes,
    keyId: outcome.keyId,
    status,
    ...(outcome.health?.detail === undefined ? {} : { detail: outcome.health.detail }),
    updated: outcome.updated,
  };
}
