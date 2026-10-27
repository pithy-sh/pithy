// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { ControlPlaneNotConnectedError } from "@pithy-sh/core/src/controlPlane/error/errors";
import { type Credential, controlPlaneCaller, keyCredential, trustCredential } from "./caller";
import { findConnection, type McpConnectionRecord, type StorePaths } from "./connections";
import { importSigningKey, type KeyFileChecks, readAgentKey } from "./keyFile";
import { controlPlaneMcpServer } from "./server";
import { type WorkloadTokenSeams, workloadTokens } from "./workload";

/**
 * `pithy mcp serve --connection <alias>` (#723): find the connection, prove the credential is usable, and serve.
 *
 * **Everything that can be refused is refused before the server starts.** A key file that is not this account's
 * alone, a record nobody wrote, a workload with no token — each stops here with a sentence on stderr, rather than
 * as a server that starts and then fails every call. A workload token is fetched once up front for the same
 * reason, and again before it expires.
 */

/** The credential a record names, ready to sign or present. */
export async function credentialFor(
  record: McpConnectionRecord,
  seams: { keyFile?: KeyFileChecks; workload?: WorkloadTokenSeams } = {},
): Promise<Credential> {
  const credential = record.credential;
  if (credential.kind === "key") {
    const key = await readAgentKey(credential.keyFile, seams.keyFile);
    return keyCredential({
      privateKey: await importSigningKey(key),
      keyId: credential.keyId,
      issuer: credential.issuer,
      connectionId: record.connectionId,
      // The audit row's actor id: which connection's agent acted. The connection names who sanctioned it.
      subject: record.alias,
    });
  }
  const tokens = workloadTokens(credential.source, credential.audience, seams.workload);
  // Fetched now, so a job missing `id-token: write` fails at spawn rather than at its first tool call.
  await tokens.current();
  return trustCredential({ trustId: credential.trustId, tokens });
}

/** The refusal for an alias neither store holds. */
export function notConnected(alias: string): ControlPlaneNotConnectedError {
  return new ControlPlaneNotConnectedError({
    message: `No connection called ${alias} here.`,
    action: `Run ${commandName("mcp connect")} in the project, naming its environment, or ${commandName("mcp status")} to list them.`,
    detail: `no record for ${alias} in the project's store or the operator's`,
  });
}

/** Options for {@link serveConnection}. */
export interface ServeConnectionOptions {
  readonly alias: string;
  readonly stores: StorePaths;
  /** The CLI's version, reported to the client. */
  readonly version: string;
  /** The transport. Stdio by default; a test passes one end of an in-memory pair. */
  readonly transport?: Transport;
  readonly fetch?: typeof fetch;
  readonly keyFile?: KeyFileChecks;
  readonly workload?: WorkloadTokenSeams;
}

/** Serve one connection until the client closes the transport. */
export async function serveConnection(options: ServeConnectionOptions): Promise<void> {
  const found = await findConnection(options.stores, options.alias);
  if (found === null) throw notConnected(options.alias);
  const { record } = found;
  const credential = await credentialFor(record, {
    ...(options.keyFile === undefined ? {} : { keyFile: options.keyFile }),
    ...(options.workload === undefined ? {} : { workload: options.workload }),
  });
  const caller = controlPlaneCaller({
    workerUrl: record.workerUrl,
    credential,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const server = controlPlaneMcpServer({
    caller,
    basePath: record.basePath,
    name: record.alias,
    version: options.version,
  });
  const transport =
    options.transport ?? new (await import("@modelcontextprotocol/sdk/server/stdio.js")).StdioServerTransport();
  await server.connect(transport);
}
