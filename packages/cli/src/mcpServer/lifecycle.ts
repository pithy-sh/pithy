// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { commandName, personDecision } from "@pithy-sh/core/src/cli/command";
import { TRUST_REVOCATION_LATENCY } from "@pithy-sh/core/src/controlPlane/data/oidcTrust";
import { ControlPlaneNotConnectedError } from "@pithy-sh/core/src/controlPlane/error/errors";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { ConflictError, PithyError, PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { connectDashboard } from "../dashboard/connect";
import type { ConnectionRegistry } from "../dashboard/registry";
import { clientById, type McpClient, type Scope, type StdioServer, scopesOf, stdioClient } from "../mcp/clients";
import {
  type ConnectResult,
  connect,
  type DisconnectResult,
  disconnect,
  type McpOptions,
  targetFor,
} from "../mcp/connect";
import {
  connectionAlias,
  type FoundConnection,
  findConnection,
  type McpConnectionRecord,
  removeConnection,
  type StorePaths,
  type StoreScope,
  saveConnection,
} from "./connections";
import { generateAgentKey, keyFilePath, removeAgentKey, writeAgentKey } from "./keyFile";
import type { WorkloadTokenSource } from "./workload";

/**
 * `pithy mcp connect | disconnect | status`'s orchestration (#723, `docs/AGENT-ACCESS.md` §3, §6), with every I/O
 * boundary injected: the registry is the adopter's D1, the stores and key directory are paths, and the client
 * configuration goes through `mcp/connect.ts` like `pithy docs connect`'s.
 *
 * **Registration goes through the paths that already exist, not around them.** A key is registered the way
 * `pithy dashboard connect --public-key` registers one, and a trust the way `--oidc-issuer` does — the same
 * `connectDashboard`, so the session's principal, the required purpose, the derived grant and every refusal are
 * the ones those paths already enforce. What this adds is the half they leave to the operator: generating the key
 * and keeping it, and telling an MCP client how to start the server.
 */

/** The `iss` an agent key signs as. A URN, because a stdio server has no origin; the connection stores it. */
export const MCP_ISSUER = "urn:pithy:mcp";

/** The command every client entry runs. The alias is the only argument that varies, and it is not a credential. */
export function serveCommand(alias: string): StdioServer {
  return { name: alias, command: "pithy", args: ["mcp", "serve", "--connection", alias] };
}

/** How a connection proves itself, as `connect` was asked for it. */
export type CredentialRequest =
  | { readonly kind: "key" }
  | {
      readonly kind: "oidc";
      readonly issuer: string;
      readonly claims: Record<string, string>;
      readonly audience?: string;
      readonly source: WorkloadTokenSource;
    };

/** Options for {@link connectMcp}. */
export interface ConnectMcpOptions {
  readonly registry: ConnectionRegistry;
  readonly project: string;
  readonly environment: string;
  readonly workerUrl?: string;
  readonly basePath?: string;
  /** What the Worker composes — the default grant is derived from it. */
  readonly capabilities: readonly Capability[];
  /** The grant `--scope` named. Sent whenever given, so a trust joining a connection is refused it by name. */
  readonly scopes?: readonly ControlPlaneScope[];
  /**
   * Decide the grant when `--scope` named none — the prompt, at a terminal. Called only when this run creates the
   * connection: a trust joining one takes that connection's grant, so a question there would be thrown away.
   * Absent, or answering nothing, takes the derived default.
   */
  readonly decideScopes?: () => Promise<readonly ControlPlaneScope[] | undefined>;
  readonly purpose?: string;
  readonly askPurpose?: () => Promise<string>;
  /** The signed-in session's principal — `requireRegisteringPrincipal`. */
  readonly principal: () => Promise<string>;
  /** The `pithy dashboard connect` a refusal names. */
  readonly connect: () => Promise<string>;
  readonly credential: CredentialRequest;
  /** The clients to write an entry into. */
  readonly clients: readonly McpClient[];
  /** The project root and how the operator's directories resolve. */
  readonly mcp: McpOptions;
  /** The stores, and the keys directory a key file is written in. */
  readonly stores: StorePaths;
  /** Checks a trust's issuer. Network by default. */
  readonly resolveIssuer?: (issuer: string) => Promise<string>;
  readonly now?: () => Date;
}

/** What `pithy mcp connect` did. */
export interface McpConnectReport {
  readonly alias: string;
  readonly environment: string;
  readonly connectionId: string;
  readonly workerUrl: string;
  readonly credential: "key" | "oidc";
  /** The key file written, or `null` for a trust, which writes none. */
  readonly keyFile: string | null;
  /** The trust registered, or `null` for a key. */
  readonly trustId: string | null;
  readonly scopes: readonly string[];
  /** `registered` for a key — proven by the server's first call — or `awaiting_first_call` for a trust. */
  readonly status: "registered" | "awaiting_first_call";
  /** Where the record went. */
  readonly store: StoreScope;
  /** One line per client entry written, or refused with its reason. */
  readonly clients: readonly ConnectResult[];
}

/** The scope a credential's client entries are written in: a key is this machine's, a trust is the repository's. */
function entryScope(credential: CredentialRequest["kind"]): Scope {
  return credential === "key" ? "user" : "project";
}

/** Write the entry into each client, in the scope the credential decides. A client without it is refused, said. */
async function writeEntries(
  clients: readonly McpClient[],
  alias: string,
  scope: Scope,
  mcp: McpOptions,
): Promise<ConnectResult[]> {
  const results: ConnectResult[] = [];
  for (const client of clients) {
    const row = stdioClient(client, serveCommand(alias));
    if (!scopesOf(client).includes(scope)) {
      results.push({
        client: client.id,
        scope,
        path: "",
        state: "refused",
        reason: `${client.label} has no ${scope} configuration, and this connection's entry belongs in one.`,
        snippet: null,
      });
      continue;
    }
    results.push(await connect(targetFor(row, scope, mcp)));
  }
  return results;
}

/** Refuse a second connect for an alias already served. */
async function refuseExisting(stores: StorePaths, alias: string, environment: string): Promise<void> {
  if ((await findConnection(stores, alias)) === null) return;
  throw new ConflictError({
    message: `${alias} is already connected.`,
    action: `To change its grant, run ${commandName("mcp connect")} for ${environment} again, with --update and every --scope it should hold. Disconnecting first is the way to connect again. ${personDecision("mcp disconnect", { flags: { "--connection": alias } })}`,
    detail: `a connection record for ${alias} exists`,
  });
}

/** The grant this run sends: the one named, or — only when it creates the connection — the one decided now. */
async function grantFor(
  options: ConnectMcpOptions,
  creating: boolean,
): Promise<{ scopes?: readonly ControlPlaneScope[] }> {
  if (options.scopes !== undefined) return { scopes: options.scopes };
  if (!creating) return {};
  const decided = await options.decideScopes?.();
  return decided === undefined ? {} : { scopes: decided };
}

/**
 * Refuse an agent's credential joining a connection that is not an agent's. The Worker audits a call with its
 * connection's kind, not its credential's, so an agent's trust on the dashboard's connection would be audited as the
 * dashboard and hold the dashboard's whole grant. A key is no different: on a connection holding no key — a CI
 * script's trust — the `--public-key` path would take it, and relabel the script's connection `agent` besides.
 */
function refuseForeignConnection(
  existing: { actorKind: string | null; id: string },
  environment: string,
  credential: CredentialRequest["kind"],
): void {
  if (existing.actorKind === "agent") return;
  const kind = existing.actorKind ?? "an unattributed client";
  throw new ConflictError({
    message: `${environment} is connected to ${kind === "dashboard" ? "the dashboard" : kind}, and an agent's ${credential === "key" ? "key" : "trust"} cannot join it.`,
    action: `Its calls would be audited as ${kind}, with that grant. An agent connects to an environment with no other connection. ${personDecision("dashboard disconnect", { flags: { "--env": environment } })}`,
    detail: `connection ${existing.id} has actorKind ${existing.actorKind ?? "null"}`,
  });
}

/**
 * Register an agent's credential and write the client entries that start its server.
 *
 * **A key** is generated here, registered as kind `agent` through the `--public-key` path, and written `0600` only
 * once the registration stands — a key nothing trusts is not worth keeping. **A trust** is registered through
 * #722's path and writes no key at all; its record is committed with the project, so CI finds it in the checkout.
 */
export async function connectMcp(options: ConnectMcpOptions): Promise<McpConnectReport> {
  const alias = connectionAlias(options.project, options.environment, options.credential.kind);
  await refuseExisting(options.stores, alias, options.environment);
  // A credential joining a connection takes the connection's grant and kind, so they are decided and sent only when
  // this registration creates it — and never onto a connection that is not an agent's.
  const existing = await options.registry.read();
  if (existing !== null) refuseForeignConnection(existing, options.environment, options.credential.kind);
  const creating = existing === null;
  const shared = {
    registry: options.registry,
    project: options.project,
    environment: options.environment,
    connect: options.connect,
    capabilities: options.capabilities,
    principal: options.principal,
    ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
    ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
    ...(options.resolveIssuer === undefined ? {} : { resolveIssuer: options.resolveIssuer }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  if (options.credential.kind === "key") {
    // The `--public-key` path applies a grant to an existing connection only under `--update`, so a `--scope` named
    // here would be dropped without a word. Refused by name instead, as `connectTrust` refuses a trust's.
    if (!creating && options.scopes !== undefined) {
      throw new ConflictError({
        message: `${options.environment} already has an agent's connection, and a key joining it takes its grant.`,
        action: `Connect without --scope. To change the grant, run ${commandName("mcp connect")} for ${options.environment} with --update and every --scope it should hold.`,
        detail: `--scope named for a key joining connection ${existing?.id}`,
      });
    }
    const keyId = `mcp-${crypto.randomUUID().slice(0, 8)}`;
    const key = await generateAgentKey(keyId);
    const report = await connectDashboard({
      ...shared,
      ...(await grantFor(options, creating)),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.askPurpose === undefined ? {} : { askPurpose: options.askPurpose }),
      publicKey: { keyId, publicKey: { kty: "OKP", crv: "Ed25519", x: key.x }, issuer: MCP_ISSUER, kind: "agent" },
    });
    const keyFile = keyFilePath(report.connectionId, options.stores.keys);
    await writeAgentKey(keyFile, key);
    const clients = await writeEntries(options.clients, alias, entryScope("key"), options.mcp);
    const record: McpConnectionRecord = {
      alias,
      project: options.project,
      environment: options.environment,
      connectionId: report.connectionId,
      workerUrl: report.workerUrl,
      basePath: await basePathOf(options),
      credential: { kind: "key", keyId, issuer: MCP_ISSUER, keyFile },
      clients: written(clients),
    };
    const store = await saveConnection(options.stores, record);
    return {
      alias,
      environment: options.environment,
      connectionId: report.connectionId,
      workerUrl: report.workerUrl,
      credential: "key",
      keyFile,
      trustId: null,
      scopes: report.scopes,
      status: "registered",
      store,
      clients,
    };
  }

  // A trust joining a connection takes its purpose too, and `connectTrust` refuses any of them named. A `--scope`
  // named anyway is still sent, so it is refused by name rather than dropped.
  const trust = options.credential;
  const report = await connectDashboard({
    ...shared,
    ...(await grantFor(options, creating)),
    ...(creating && options.purpose !== undefined ? { purpose: options.purpose } : {}),
    ...(creating && options.askPurpose !== undefined ? { askPurpose: options.askPurpose } : {}),
    trust: {
      issuer: trust.issuer,
      claims: trust.claims,
      ...(trust.audience === undefined ? {} : { audience: trust.audience }),
      ...(creating ? { kind: "agent" as const } : {}),
    },
  });
  const registered = report.trust;
  if (registered === undefined) {
    throw new PithyError({
      code: "core/internal",
      status: 500,
      message: "The trust was not registered.",
      detail: "connectDashboard returned no trust for a trust registration",
    });
  }
  const clients = await writeEntries(options.clients, alias, entryScope("oidc"), options.mcp);
  const record: McpConnectionRecord = {
    alias,
    project: options.project,
    environment: options.environment,
    connectionId: report.connectionId,
    workerUrl: report.workerUrl,
    basePath: await basePathOf(options),
    credential: { kind: "oidc", trustId: registered.trustId, audience: registered.audience, source: trust.source },
    clients: written(clients),
  };
  const store = await saveConnection(options.stores, record);
  return {
    alias,
    environment: options.environment,
    connectionId: report.connectionId,
    workerUrl: report.workerUrl,
    credential: "oidc",
    keyFile: null,
    trustId: registered.trustId,
    scopes: report.scopes,
    status: "awaiting_first_call",
    store,
    clients,
  };
}

/** The base path the registry recorded, which is the one the Worker serves. */
async function basePathOf(options: ConnectMcpOptions): Promise<string> {
  return (await options.registry.read())?.basePath ?? options.basePath ?? "/control-plane";
}

/** The targets a run actually wrote, for `disconnect` to take back out. */
function written(results: readonly ConnectResult[]): McpConnectionRecord["clients"] {
  return results.filter((result) => result.state !== "refused").map(({ client, scope }) => ({ client, scope }));
}

/** Options for {@link updateMcpGrant}. */
export interface UpdateMcpGrantOptions {
  readonly registry: ConnectionRegistry;
  readonly project: string;
  readonly environment: string;
  /** Exactly the grant the connection should hold. */
  readonly scopes: readonly ControlPlaneScope[];
  readonly principal: () => Promise<string>;
  readonly stores: StorePaths;
  readonly now?: () => Date;
}

/** What `pithy mcp connect --update` did. */
export interface McpUpdateReport {
  readonly alias: string;
  readonly environment: string;
  readonly connectionId: string;
  readonly scopesBefore: readonly string[];
  readonly scopes: readonly string[];
}

/**
 * Replace a connection's grant with exactly the scopes given, as `pithy dashboard connect --update` does — and
 * refused without a session like a registration, because a grant is what a standing credential may do.
 */
export async function updateMcpGrant(options: UpdateMcpGrantOptions): Promise<McpUpdateReport> {
  // A key's record and a trust's are two aliases for one connection; either one here is enough to change its grant.
  const found: FoundConnection[] = [];
  for (const credential of ["key", "oidc"] as const) {
    const record = await findConnection(
      options.stores,
      connectionAlias(options.project, options.environment, credential),
    );
    if (record !== null) found.push(record);
  }
  const first = found[0];
  if (first === undefined) {
    const alias = connectionAlias(options.project, options.environment);
    throw new ControlPlaneNotConnectedError({
      message: `${alias} is not connected here.`,
      action: `Run ${commandName("mcp connect")} for ${options.environment} in this project first.`,
      detail: `no connection record for ${alias}`,
    });
  }
  await options.principal();
  const existing = await options.registry.read();
  if (existing === null) {
    throw new ControlPlaneNotConnectedError({
      action: `The Worker holds no connection, so this one cannot be changed; disconnect it and connect again. ${personDecision("mcp disconnect", { flags: { "--connection": first.record.alias } })}`,
      detail: `--update with no connection registered for ${options.environment}`,
    });
  }
  // The Worker holds one connection per environment, and it may no longer be this agent's — `pithy dashboard
  // disconnect` and a later `dashboard connect` leave the local record behind. Its grant is another actor's to change.
  const own = found.find(({ record }) => record.connectionId === existing.id);
  if (own === undefined || existing.actorKind !== "agent") {
    throw new ConflictError({
      message: `${options.environment}'s connection is no longer ${first.record.alias}'s, so its grant was left as it was.`,
      action: `Disconnect this record, then connect the agent again. ${personDecision("mcp disconnect", { flags: { "--connection": first.record.alias } })}`,
      detail: `record names connection ${first.record.connectionId}; the Worker holds ${existing.id} with actorKind ${existing.actorKind ?? "null"}`,
    });
  }
  const alias = own.record.alias;
  // Through `save`, which records `controlplane/connection_updated` naming the grant before and after (#294).
  await options.registry.save({ ...existing, scopes: [...options.scopes], updatedAt: options.now?.() ?? new Date() });
  return {
    alias,
    environment: options.environment,
    connectionId: existing.id,
    scopesBefore: existing.scopes,
    scopes: [...options.scopes],
  };
}

/** Options for {@link disconnectMcp}. */
export interface DisconnectMcpOptions {
  /** The registry of the project this runs in — which must be the record's. */
  readonly registry: ConnectionRegistry;
  /** The project this runs in. A record of another project's is refused: this registry does not hold its credential. */
  readonly project: string;
  readonly record: McpConnectionRecord;
  readonly scope: StoreScope;
  readonly mcp: McpOptions;
  readonly stores: StorePaths;
  readonly now?: () => Date;
}

/** What `pithy mcp disconnect` did. */
export interface McpDisconnectReport {
  readonly alias: string;
  readonly environment: string;
  readonly credential: "key" | "oidc";
  /**
   * Whether the Worker held the credential to revoke. A re-run finds it already revoked, and a connection removed
   * from the Worker holds nothing at all; neither is an error.
   */
  readonly revoked: boolean;
  /** Whether a key file was removed. */
  readonly keyFileRemoved: boolean;
  readonly clients: readonly DisconnectResult[];
  /** For a trust: a token already minted stays usable until it expires. */
  readonly latency?: string;
}

/**
 * Revoke the credential, then remove the key file, the client entries and the record — in that order, so a
 * failure part way leaves the credential dead rather than the entries gone and the credential live.
 */
export async function disconnectMcp(options: DisconnectMcpOptions): Promise<McpDisconnectReport> {
  const { record } = options;
  if (record.project !== options.project) {
    // Another project's registry does not hold this credential, so revoking here would find nothing, report it
    // revoked, and delete the only local trace of a key its own Worker still trusts.
    throw new PreconditionFailedError({
      message: `${record.alias} belongs to the project ${record.project}, and this is ${options.project}.`,
      action: `Run ${commandName("mcp disconnect")} from ${record.project}'s directory, where its registry is.`,
      detail: `record.project ${record.project}, current project ${options.project}`,
    });
  }
  const now = options.now?.() ?? new Date();
  const credential = record.credential;
  // A connection the Worker no longer holds — `pithy dashboard disconnect`, a reset database — took every key and
  // trust with it, so there is nothing to revoke and the local half is still cleaned up.
  // So does one replaced since: the Worker's connection now is another actor's, and revoking there is not this record's.
  const registered = (await options.registry.read())?.id === record.connectionId;
  const revoked = !registered
    ? false
    : credential.kind === "key"
      ? (await options.registry.revokeKey(credential.keyId, now)) !== null
      : (await options.registry.revokeTrust(credential.trustId, now)) !== null;
  const keyFileRemoved = credential.kind === "key" ? await removeAgentKey(credential.keyFile) : false;

  const clients: DisconnectResult[] = [];
  for (const target of record.clients) {
    const client = clientById(target.client);
    if (client === undefined) continue;
    const row = stdioClient(client, serveCommand(record.alias));
    clients.push(await disconnect(targetFor(row, target.scope, options.mcp)));
  }
  await removeConnection(options.stores, options.scope, record.alias);
  return {
    alias: record.alias,
    environment: record.environment,
    credential: credential.kind,
    revoked,
    keyFileRemoved,
    clients,
    ...(credential.kind === "oidc" ? { latency: TRUST_REVOCATION_LATENCY } : {}),
  };
}
