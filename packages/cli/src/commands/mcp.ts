// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { InputRequiredError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { z } from "zod";
import { type FlagGroup, withContract } from "../contract/commandContract";
import { parsePurpose } from "../dashboard/connect";
import { decideGrant, grantableScopes, isNarrowed, readScopeRequest, resolveScopeRequest } from "../dashboard/grant";
import { parseIssuer } from "../dashboard/oidc";
import { requireRegisteringPrincipal } from "../dashboard/principal";
import { composedForGrant, connectSentence, resolveConnectTarget } from "../dashboard/resolveTarget";
import { clientById, MCP_CLIENTS, type McpClient } from "../mcp/clients";
import { detectedClients, type McpOptions } from "../mcp/connect";
import { findConnection, listConnections, storePaths } from "../mcpServer/connections";
import { keyFileMode, keyFileProblem } from "../mcpServer/keyFile";
import {
  type CredentialRequest,
  connectMcp,
  disconnectMcp,
  type McpConnectReport,
  type McpDisconnectReport,
  type McpUpdateReport,
  updateMcpGrant,
} from "../mcpServer/lifecycle";
import { serveConnection } from "../mcpServer/serve";
import { defaultTokenSource, parseTokenSource } from "../mcpServer/workload";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { mayPrompt } from "../terminal/inputMode";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
import {
  collectRepeatedFlag,
  collectScopeFlags,
  promptPurpose,
  promptScopes,
  trustClaimsFor,
  withRegistry,
} from "./dashboard";

/**
 * `pithy mcp` — the control-plane MCP server, and the commands that connect an agent to it (#723,
 * `docs/AGENT-ACCESS.md` §3, §6).
 *
 * **A second transport over the client the CLI already is.** `connect` registers an agent's credential through the
 * paths `pithy dashboard connect` already has — a key through `--public-key`, a trust through `--oidc-issuer` —
 * and writes a client entry that runs `serve`. `serve` is what the client spawns: a stdio MCP server whose tools are
 * the Worker's own admin routes, offered only where this connection's grant reaches. Nothing is hosted.
 *
 * **One server entry per connection.** Environments run different versions, so a tool can take a different input
 * on staging than on production, and one tool publishes one schema. Each environment is its own entry,
 * `pithy-<project>-<env>` (`-ci` for a trust), serving exactly what its Worker declares.
 */

/** `--json`, on every subcommand that has a payload. */
const jsonArg = { json: { type: "boolean", default: false, description: "Machine-readable output" } } as const;

/** The CLI's version, which the server reports to a client. */
function cliVersion(): string {
  return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
    .version;
}

/** Where the client configurations and the stores resolve, for this directory. */
function mcpOptions(): McpOptions {
  return { projectDir: process.cwd() };
}

/** The clients `--client` and `--all` name. Neither writes no entry, and the report says how to add one. */
async function chosenClients(args: { client?: string; all: boolean }, options: McpOptions): Promise<McpClient[]> {
  if (args.client !== undefined && args.all) {
    throw new ValidationError({ message: "Pass either --client or --all, not both.", action: "Choose one." });
  }
  if (args.client !== undefined) {
    const client = clientById(args.client);
    if (client === undefined) {
      throw new ValidationError({
        message: `No client called ${args.client}.`,
        action: `Pass one of: ${MCP_CLIENTS.map((entry) => entry.id).join(", ")}.`,
      });
    }
    return [client];
  }
  return args.all ? detectedClients(options) : [];
}

const Alias = z
  .string()
  .describe("The connection's alias, `pithy-<project>-<env>` (`-ci` for a trust) — its client entries' key.");
const Environment = z.string().describe("The environment the connection is bound to.");
const CredentialKind = z
  .enum(["key", "oidc"])
  .describe("`key` for a registered key on this machine, `oidc` for a workload identity in CI.");
const ClientLine = z
  .object({
    client: z.string().describe("The client's id."),
    scope: z.enum(["project", "user"]).describe("Which of its configurations."),
    path: z.string().describe("The file, absolute; empty when the client has no configuration in that scope."),
    state: z.string().describe("`added`, `updated`, `unchanged`, `removed`, `absent`, or `refused`."),
    reason: z.string().nullable().describe("Why it was refused, or `null`."),
  })
  .describe("One client entry.");

/** `pithy mcp connect --json`. */
const McpConnectPayload = z
  .object({
    command: z.literal("mcp.connect").describe('`"mcp.connect"`.'),
    alias: Alias,
    environment: Environment,
    connectionId: z.string().describe("The connection's id."),
    workerUrl: z.string().describe("The Worker the server calls."),
    credential: CredentialKind,
    keyFile: z
      .string()
      .nullable()
      .describe("The private key written, `0600`, or `null` for a trust, which writes none."),
    trustId: z.string().nullable().describe("The trust registered, or `null` for a key."),
    scopes: z.array(z.string().describe("A granted scope.")).describe("The connection's grant."),
    status: z
      .enum(["registered", "awaiting_first_call"])
      .describe("`registered` for a key; `awaiting_first_call` for a trust, which nothing proves until a job calls."),
    store: z.enum(["project", "user"]).describe("Where the connection's record was written."),
    clients: z.array(ClientLine).describe("Each client entry written, or refused."),
  })
  .describe("What `pithy mcp connect` registered and wrote.");

/** `pithy mcp connect --update --json`. */
const McpUpdatePayload = z
  .object({
    command: z.literal("mcp.connect").describe('`"mcp.connect"`.'),
    alias: Alias,
    environment: Environment,
    connectionId: z.string().describe("The connection's id."),
    scopesBefore: z.array(z.string().describe("A scope.")).describe("The grant before."),
    scopes: z.array(z.string().describe("A scope.")).describe("The grant now: exactly the scopes given."),
  })
  .describe("What `pithy mcp connect --update` changed.");

/** `pithy mcp disconnect --json`. */
const McpDisconnectPayload = z
  .object({
    command: z.literal("mcp.disconnect").describe('`"mcp.disconnect"`.'),
    alias: Alias,
    connected: z.boolean().describe("Whether there was a connection by that alias. `false` on a re-run."),
    environment: Environment.optional(),
    credential: CredentialKind.optional(),
    revoked: z.boolean().optional().describe("Whether the Worker held the credential to revoke."),
    keyFileRemoved: z.boolean().optional().describe("Whether a key file was removed."),
    clients: z.array(ClientLine).optional().describe("Each client entry removed."),
    latency: z.string().optional().describe("For a trust: a token already minted stays usable until it expires."),
  })
  .describe("What `pithy mcp disconnect` revoked and removed.");

/** `pithy mcp status --json`. */
const McpStatusPayload = z
  .object({
    command: z.literal("mcp.status").describe('`"mcp.status"`.'),
    connections: z
      .array(
        z
          .object({
            alias: Alias,
            environment: Environment,
            workerUrl: z.string().describe("The Worker the server calls."),
            store: z.enum(["project", "user"]).describe("Where the record is."),
            credential: CredentialKind,
            keyFile: z.string().nullable().describe("The key file, or `null` for a trust."),
            keyMode: z.string().nullable().describe("The key file's mode, octal, or `null` when there is none."),
            keyProblem: z
              .string()
              .nullable()
              .describe("Why `serve` would refuse the key, or `null` when it would not."),
            tokenSource: z.string().nullable().describe("Where a trust's token comes from, or `null` for a key."),
            clients: z
              .array(z.string().describe("`<client> (<scope>)`."))
              .describe("The client entries written for it."),
          })
          .describe("One connection."),
      )
      .describe("Every connection this directory and this operator hold."),
  })
  .describe("What `pithy mcp status` found.");

/** The one line a client report prints per entry. */
function clientRows(
  lines: readonly { client: string; scope: string; path: string; state: string; reason: string | null }[],
) {
  return formatList(
    lines.map((line) => ({
      name: line.client,
      description: dim(line.state === "refused" ? `refused: ${line.reason ?? ""}` : `${line.state} ${line.path}`),
    })),
  );
}

/** Render a connect. */
function formatConnect(report: McpConnectReport): string {
  const rows = [
    { name: "Connection", description: dim(report.alias) },
    { name: "Worker", description: dim(report.workerUrl) },
    { name: "Scopes", description: dim(report.scopes.join(", ")) },
    report.keyFile === null
      ? { name: "Trust", description: dim(report.trustId ?? "") }
      : { name: "Key", description: dim(`${report.keyFile} (0600)`) },
  ];
  const clients =
    report.clients.length === 0
      ? `No client entry written. Pass --client <id> or --all to write one.\n`
      : `${clientRows(report.clients)}\n`;
  const next =
    report.status === "awaiting_first_call"
      ? "Nothing proves a trust until a job calls. Commit .pithy/mcp.jsonc and the client entry.\n"
      : "";
  return `${formatList(rows)}\n${clients}${next}${formatDone()}\n`;
}

const TARGET_GROUP: FlagGroup = {
  kind: "atMostOne",
  flags: ["--client", "--all"],
  rule: "Pass either --client or --all, not both.",
};

/** `pithy mcp connect` — register an agent's credential and write the entry that starts its server. */
const connectCommand = withContract(
  defineCommand({
    meta: {
      name: "connect",
      description: "Register an agent's key or workload trust, and write the client entry that serves it",
    },
    args: {
      env: ENV_ARG,
      worker: { type: "string", description: "Which worker composes the admin surface (apps/<name>)" },
      "worker-url": { type: "string", description: "Override the resolved worker URL for this environment" },
      purpose: { type: "string", description: "What this agent is for, in one line. Required to register" },
      scope: {
        type: "string",
        description:
          "Grant one scope (repeatable). --scope all grants every composed scope. With --update, the whole grant",
      },
      update: { type: "boolean", default: false, description: "Replace this connection's grant with exactly --scope" },
      "oidc-issuer": {
        type: "string",
        description: "Register a workload trust instead of a key: the exact iss of the CI job's tokens",
      },
      "oidc-claim": {
        type: "string",
        description: "With --oidc-issuer: a claim the token must carry, name=value (repeatable). At least one",
      },
      "oidc-audience": {
        type: "string",
        description: "With --oidc-issuer: the aud its tokens must name (default: this environment's worker origin)",
      },
      "oidc-token": {
        type: "string",
        description: "With --oidc-issuer: github, gitlab:<VARIABLE> or env:<VARIABLE> (default github for GitHub)",
      },
      client: { type: "string", description: "Write the entry into one client (see pithy docs status)" },
      all: { type: "boolean", default: false, description: "Write the entry into every detected client" },
      ...jsonArg,
    },
    run: ({ args, rawArgs }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        const scopeRequest = readScopeRequest(collectScopeFlags(rawArgs));
        const claimFlags = collectRepeatedFlag(rawArgs, "--oidc-claim");
        const trustPath = args["oidc-issuer"] !== undefined;
        if (
          !trustPath &&
          (claimFlags.length > 0 || args["oidc-audience"] !== undefined || args["oidc-token"] !== undefined)
        ) {
          throw new ValidationError({
            message: "--oidc-claim, --oidc-audience and --oidc-token only apply with --oidc-issuer.",
            action: "Pass --oidc-issuer with the exact iss the job's tokens carry, or drop them.",
          });
        }
        // Argument rules, settled before a project is read: a contradiction the operator typed is theirs to fix.
        if (args.update && trustPath) {
          throw new ValidationError({
            message: "--update replaces a grant, and --oidc-issuer registers a trust.",
            action: "Drop one of them.",
          });
        }
        if (args.client !== undefined && args.all) {
          throw new ValidationError({ message: "Pass either --client or --all, not both.", action: "Choose one." });
        }
        const purpose = args.purpose === undefined ? undefined : parsePurpose(args.purpose);
        const projectDir = process.cwd();
        const config = await loadProject(projectDir);
        const project = requireProjectName(config);
        const account = await projectCloudflareAccount(projectDir);
        const stores = storePaths(projectDir);
        const principal = () => requireRegisteringPrincipal({ account });

        if (args.update) {
          if (!isNarrowed(scopeRequest)) {
            throw new InputRequiredError({
              message: "--update needs the whole grant.",
              action: "Pass every --scope the connection should hold, or --scope all.",
              flag: "--scope",
            });
          }
          const composed = await composedForGrant({
            target: null,
            all: scopeRequest.all,
            projectDir,
            environment: env,
            ...(args.worker === undefined ? {} : { worker: args.worker }),
          });
          const scopes = resolveScopeRequest(scopeRequest, grantableScopes(composed));
          const report: McpUpdateReport = await withRegistry(
            { env, ...(args.worker === undefined ? {} : { worker: args.worker }) },
            (registry) => updateMcpGrant({ registry, project, environment: env, scopes, principal, stores }),
          );
          if (args.json) {
            process.stdout.write(`${formatJsonLine({ command: "mcp.connect", ...report })}\n`);
            return;
          }
          process.stdout.write(
            `${formatList([{ name: "Scopes", description: dim(report.scopes.join(", ")) }])}\n${formatDone()}\n`,
          );
          return;
        }

        const interactive = mayPrompt(args.json);
        let credential: CredentialRequest = { kind: "key" };
        if (trustPath) {
          const issuer = parseIssuer(args["oidc-issuer"] as string);
          const source =
            args["oidc-token"] === undefined ? defaultTokenSource(issuer) : parseTokenSource(args["oidc-token"]);
          if (source === undefined) {
            throw new InputRequiredError({
              message: "Say where the job's identity token comes from.",
              action:
                "Pass --oidc-token gitlab:<VARIABLE> for a GitLab id_tokens: variable, or env:<VARIABLE> for another issuer.",
              flag: "--oidc-token",
            });
          }
          credential = {
            kind: "oidc",
            issuer,
            claims: await trustClaimsFor({ issuer, claimFlags, interactive }),
            ...(args["oidc-audience"] === undefined ? {} : { audience: args["oidc-audience"] }),
            source,
          };
        }

        const target = await resolveConnectTarget({
          projectDir,
          environment: env,
          ...(args.worker === undefined ? {} : { worker: args.worker }),
          ...(args["worker-url"] === undefined ? {} : { workerUrl: args["worker-url"] }),
        });
        const composed = await composedForGrant({ target, all: scopeRequest.all, projectDir, environment: env });
        // A named `--scope` is resolved now. With none, the grant is decided by `connectMcp` only when this run
        // creates the connection — a trust joining one takes its grant, so a prompt there would be thrown away and
        // its answer refused as a `--scope` nobody typed.
        const decide = () =>
          decideGrant({ request: scopeRequest, composed, interactive, update: false, prompt: promptScopes });
        const grant = isNarrowed(scopeRequest) ? { scopes: await decide() } : { decideScopes: decide };
        const options = mcpOptions();
        const clients = await chosenClients(args, options);

        const report = await withRegistry(
          { env, ...(args.worker === undefined ? {} : { worker: args.worker }) },
          (registry) =>
            connectMcp({
              registry,
              project,
              environment: env,
              workerUrl: target.workerUrl,
              basePath: target.basePath,
              capabilities: composed,
              ...(grant.scopes === undefined ? {} : { scopes: grant.scopes }),
              ...(grant.decideScopes === undefined ? {} : { decideScopes: grant.decideScopes }),
              ...(purpose === undefined ? {} : { purpose }),
              ...(interactive ? { askPurpose: promptPurpose } : {}),
              principal,
              connect: () => connectSentence({ projectDir, environment: env }),
              credential,
              clients,
              mcp: options,
              stores,
            }),
        );
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "mcp.connect", ...report })}\n`);
          return;
        }
        process.stdout.write(formatConnect(report));
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: z.union([McpConnectPayload, McpUpdatePayload]).describe("What `pithy mcp connect` did."),
    mutates: true,
    idempotent: false,
    needsNetwork: true,
    flags: {
      scope: { repeatable: true },
      "oidc-claim": { repeatable: true },
      client: { enum: MCP_CLIENTS.map((client) => client.id) },
    },
    flagGroups: [
      TARGET_GROUP,
      {
        kind: "atMostOne",
        flags: ["--oidc-issuer", "--update"],
        rule: "--update replaces a grant, and --oidc-issuer registers a trust.",
      },
      {
        kind: "requires",
        flag: "--oidc-claim",
        needs: ["--oidc-issuer"],
        any: false,
        rule: "--oidc-claim, --oidc-audience and --oidc-token only apply with --oidc-issuer.",
      },
      {
        kind: "requires",
        flag: "--oidc-audience",
        needs: ["--oidc-issuer"],
        any: false,
        rule: "--oidc-claim, --oidc-audience and --oidc-token only apply with --oidc-issuer.",
      },
      {
        kind: "requires",
        flag: "--oidc-token",
        needs: ["--oidc-issuer"],
        any: false,
        rule: "--oidc-claim, --oidc-audience and --oidc-token only apply with --oidc-issuer.",
      },
    ],
  },
);

/** `pithy mcp serve --connection <alias>` — what an MCP client spawns. Speaks MCP on stdio, and nothing else there. */
const serveCommand = withContract(
  defineCommand({
    meta: { name: "serve", description: "Serve one connection's admin routes as MCP tools, on stdio" },
    args: {
      connection: {
        type: "string",
        required: true,
        description: "The connection's alias, pithy-<project>-<env>, -ci for a trust",
      },
    },
    run: async ({ args }) => {
      // stdout is the protocol, so every refusal goes to stderr and nothing else is ever printed there.
      await withErrorReporting(false, async () => {
        await serveConnection({ alias: args.connection, stores: storePaths(process.cwd()), version: cliVersion() });
      });
    },
  }),
  { output: "none", mutates: false, idempotent: true, needsNetwork: true },
);

/** `pithy mcp status` — every connection here, its credential, and for a key the file and its mode. */
const statusCommand = withContract(
  defineCommand({
    meta: { name: "status", description: "Report each MCP connection, its credential, and its key file's mode" },
    args: { ...jsonArg },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const found = await listConnections(storePaths(process.cwd()));
        const connections = await Promise.all(
          found.map(async ({ record, scope }) => {
            const credential = record.credential;
            const keyFile = credential.kind === "key" ? credential.keyFile : null;
            return {
              alias: record.alias,
              environment: record.environment,
              workerUrl: record.workerUrl,
              store: scope,
              credential: credential.kind,
              keyFile,
              keyMode: keyFile === null ? null : await keyFileMode(keyFile),
              keyProblem: keyFile === null ? null : await keyFileProblem(keyFile),
              tokenSource:
                credential.kind === "oidc"
                  ? credential.source.kind === "github"
                    ? "github"
                    : `${credential.source.kind}:${credential.source.variable}`
                  : null,
              clients: record.clients.map((target) => `${target.client} (${target.scope})`),
            };
          }),
        );
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "mcp.status", connections })}\n`);
          return;
        }
        if (connections.length === 0) {
          process.stdout.write(
            `No MCP connections here.\nRun ${commandName("mcp connect")} in a project, naming its environment, to make one.\n`,
          );
          return;
        }
        process.stdout.write(
          `${formatList(
            connections.map((connection) => ({
              name: connection.alias,
              description: dim(
                connection.credential === "key"
                  ? `key ${connection.keyFile} ${connection.keyMode ?? "missing"}${connection.keyProblem === null ? "" : ` — ${connection.keyProblem}`}`
                  : `trust, token from ${connection.tokenSource}`,
              ),
            })),
          )}\n`,
        );
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: McpStatusPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: false,
  },
);

/** `pithy mcp disconnect --connection <alias>` — revoke the credential, then remove the key file and the entries. */
const disconnectCommand = withContract(
  defineCommand({
    meta: {
      name: "disconnect",
      description: "Revoke a connection's key or trust, and remove its key file and entries",
    },
    args: {
      connection: {
        type: "string",
        required: true,
        description: "The connection's alias, pithy-<project>-<env>, -ci for a trust",
      },
      worker: { type: "string", description: "Which worker's wrangler.jsonc resolves the app database (apps/<name>)" },
      ...jsonArg,
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const stores = storePaths(projectDir);
        const found = await findConnection(stores, args.connection);
        if (found === null) {
          if (args.json) {
            process.stdout.write(
              `${formatJsonLine({ command: "mcp.disconnect", alias: args.connection, connected: false })}\n`,
            );
            return;
          }
          process.stdout.write(`No connection called ${args.connection} here.\n`);
          return;
        }
        // Read before the registry opens: a record of another project's is refused before this one's is touched.
        const project = requireProjectName(await loadProject(projectDir));
        const report: McpDisconnectReport = await withRegistry(
          { env: found.record.environment, ...(args.worker === undefined ? {} : { worker: args.worker }) },
          (registry) =>
            disconnectMcp({
              registry,
              project,
              record: found.record,
              scope: found.scope,
              mcp: mcpOptions(),
              stores,
            }),
        );
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "mcp.disconnect", connected: true, ...report })}\n`);
          return;
        }
        const latency = report.latency === undefined ? "" : `${report.latency}\n`;
        process.stdout.write(
          `${report.revoked ? "Revoked" : "Already revoked:"} ${report.alias}.\n${report.clients.length > 0 ? `${clientRows(report.clients)}\n` : ""}${latency}${formatDone()}\n`,
        );
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: McpDisconnectPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

export default defineCommand({
  meta: { name: "mcp", description: "Serve your Worker's admin routes to an AI agent, over MCP" },
  subCommands: { connect: connectCommand, serve: serveCommand, status: statusCommand, disconnect: disconnectCommand },
});
