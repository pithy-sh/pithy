// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import {
  clientById,
  DOCS_MCP_NAME,
  DOCS_MCP_URL,
  MCP_CLIENTS,
  type McpClient,
  type Scope,
  scopesOf,
} from "../mcp/clients";
import {
  type ClientStatus,
  type ConnectResult,
  connect,
  type DisconnectResult,
  detectedClients,
  disconnect,
  type McpOptions,
  snippetFor,
  status,
  targetFor,
} from "../mcp/connect";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";

/**
 * `pithy docs connect` — wire the Pithy documentation server into whichever AI clients are here.
 *
 * **The command knows one server.** It is not a manager for an adopter's own MCP servers, and every
 * refusal in it exists to keep that true: it sets one key, it removes one key, and a document it cannot
 * read with confidence is left alone with the snippet printed instead. What differs between ten tools is
 * a row in `mcp/clients.ts`, so this file has no per-client branch in it at all.
 *
 * **Scope is asked, never assumed.** A project file is committed and hands the docs to everyone on the
 * repository; a user file follows the operator into every project they open. Those are different
 * decisions with different blast radii, and the one users get wrong. So an interactive run asks, and a
 * non-interactive run without `--scope` is refused rather than defaulted — the flag path holds the same
 * line the prompt does. A client that declares only one scope takes it either way, because there was
 * never a choice to get wrong.
 *
 * **Nothing here writes a credential and nothing reads one.** The server runs OAuth 2.1 and offers
 * dynamic client registration, so a capable client discovers the flow from the URL and opens a browser
 * on first use; the one client whose config file cannot do that is pointed through `mcp-remote`, which
 * caches its token under the operator's own `~/.mcp-auth`. Pithy never holds a token, which is why
 * `@pithy-sh/secrets` is not involved and there is nothing to put in `.dev.vars`.
 */

/** `--json`, on every subcommand. */
const jsonArg = { json: { type: "boolean", default: false, description: "Machine-readable output" } } as const;

/** The flags that choose what to write and where. Shared by `connect` and `disconnect`. */
const targetArgs = {
  client: { type: "string", description: "One client id (see `pithy docs status`)" },
  all: { type: "boolean", default: false, description: "Every detected client" },
  scope: { type: "string", description: "`project` (committed, whole team) or `user` (just you)" },
} as const;

/** The scopes `--scope` accepts, as the error line lists them. */
const SCOPES: readonly Scope[] = ["project", "user"];

/**
 * The shape an unknown tool is most likely to want — the `mcpServers` map with a plain URL.
 *
 * `--print` answers for a client that is not in the table at all, because the alternative is telling
 * somebody running the eleventh tool that Pithy cannot help them with a two-line file. Eight of the ten
 * rows are this shape, so it is the best guess available and it is offered as one.
 */
const GENERIC_SNIPPET = `{
  "mcpServers": {
    "${DOCS_MCP_NAME}": {
      "type": "http",
      "url": "${DOCS_MCP_URL}"
    }
  }
}
`;

/** Whether a human is attached — the only condition under which this command prompts for anything. */
function interactive(json: boolean): boolean {
  return !json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Write one line to stdout. */
function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The client `--client` names, or a refusal that lists the ones there are. */
function requireClient(id: string): McpClient {
  const client = clientById(id);
  if (client === undefined) {
    throw new NotFoundError({
      message: `No client called ${id}.`,
      action: `Pass one of: ${MCP_CLIENTS.map((entry) => entry.id).join(", ")}.`,
    });
  }
  return client;
}

/** `--scope` as a scope, or a refusal naming what it takes. */
function requireScope(value: string): Scope {
  const scope = SCOPES.find((candidate) => candidate === value);
  if (scope === undefined) {
    throw new ValidationError({
      message: `--scope takes ${SCOPES.join(" or ")}, not ${value}.`,
      action: "Pass --scope project to commit it for the team, or --scope user for yourself.",
    });
  }
  return scope;
}

/** The refusal an unattended run gets when it named no scope. */
function scopeRequired(): ValidationError {
  return new ValidationError({
    message: "--scope is required when nothing can be asked.",
    action: "Pass --scope project to commit it for the team, or --scope user for yourself.",
  });
}

/**
 * Ask who the entry is for. `null` when the operator canceled.
 *
 * **Canceling is an answer, and it is the caller who decides what it costs.** `pithy docs connect` treats
 * it as abandoning the run; the offer at the end of `pithy init` treats it as "no thanks" and returns
 * quietly, because by then the project is scaffolded and `Done.` is already printed — exiting 1 there
 * would turn a successful `init` into a failed one over a question nobody had to answer. So this returns
 * the cancellation rather than acting on it.
 */
async function askScope(): Promise<Scope | null> {
  emit(dim("A project file is committed and gives the docs to everyone on this repository."));
  emit(dim("A user file follows you into every project you open."));
  const { isCancel, select } = await import("@clack/prompts");
  const answer = await select({
    message: "Who is this for?",
    options: [
      { value: "user", label: "Just me" },
      { value: "project", label: "Everyone on this repo" },
    ],
  });
  if (isCancel(answer)) return null;
  return requireScope(String(answer));
}

/** Ask, and end the run if the operator declines to answer. What the two subcommands do with a cancel. */
async function askScopeOrExit(): Promise<Scope> {
  const answer = await askScope();
  if (answer === null) {
    process.stderr.write("Canceled.\n");
    process.exit(1);
  }
  return answer;
}

/**
 * The clients to act on: the one named, or every one detected here.
 *
 * `--all` means every client this machine appears to have, not every client in the table — writing a Zed
 * config on a machine with no Zed is litter. A bare run means the same thing, once it has established
 * that somebody is there to be asked about it.
 */
async function resolveClients(
  args: { client?: string; all: boolean },
  json: boolean,
  options: McpOptions,
): Promise<McpClient[]> {
  if (args.client !== undefined && args.all) {
    throw new ValidationError({
      message: "Pass either --client or --all, not both.",
      action: "Choose one.",
    });
  }
  if (args.client !== undefined) return [requireClient(args.client)];
  if (!args.all && !interactive(json)) {
    throw new ValidationError({
      message: "Name what to connect.",
      action: "Pass --client <id> for one, or --all for every client detected here.",
    });
  }
  return detectedClients(options);
}

/**
 * The scope a client is actually written in.
 *
 * A client that declares one scope takes it whatever was asked for. That is not the request being
 * overridden — Goose and Claude Desktop have no project configuration to write, so `--scope project`
 * against them is a question with one answer, and refusing the run over it would make `--all --scope
 * project` unusable on a machine that happens to have Goose.
 */
function scopeFor(client: McpClient, asked: Scope): Scope {
  const available = scopesOf(client);
  return available.includes(asked) ? asked : available[0];
}

/** The options every resolution keys on. The project directory is the run's, and homes resolve for real. */
function optionsOf(): McpOptions {
  return { projectDir: process.cwd() };
}

/**
 * The human report: the tool, what happened to it, and the file — three columns, whitespace aligned.
 *
 * The state is padded on its own rather than folded into the label, because a reader scans that column
 * for the one row that says `refused` and a ragged column is exactly the one they miss.
 */
function reportRows(
  results: readonly { client: string; state: string; path: string; reason: string | null }[],
): string {
  const width = Math.max(0, ...results.map((result) => result.state.length));
  return formatList(
    results.map((result) => ({
      name: clientById(result.client)?.label ?? result.client,
      description: `${result.state.padEnd(width)}  ${result.reason === null ? result.path : `${result.path} — ${result.reason}`}`,
    })),
  );
}

/** Print the snippet a refused client needs pasted, so a refusal is still an answer. */
function printRefusals(results: readonly ConnectResult[]): void {
  for (const result of results) {
    if (result.state !== "refused" || result.snippet === null) continue;
    emit("");
    emit(`Add this to ${result.path} yourself:`);
    emit(result.snippet.trimEnd());
  }
}

/** Exit 1 only when every client asked for failed — a partial run is a run that did something. */
function exitFor(results: readonly { state: string }[]): number {
  if (results.length === 0) return 0;
  return results.every((result) => result.state === "refused") ? 1 : 0;
}

/**
 * Offer the connection once, at the end of `pithy init` (issue #652).
 *
 * **Offered only where it can be answered, and only where there is something to answer about.** A run
 * with no AI client on the machine says nothing at all rather than advertising a command for tools the
 * operator does not have, and a `--json` or piped run never reaches this — `init` gates the call.
 *
 * It asks the scope question rather than picking one, for the reason the whole command does: `init` has
 * just made a repository, so "everyone on this repo" is a genuinely live answer and guessing it would
 * commit a file the operator never chose to share.
 */
export async function offerDocs(): Promise<void> {
  const options = optionsOf();
  const detected = await detectedClients(options);
  if (detected.length === 0) return;

  const { confirm, isCancel } = await import("@clack/prompts");
  const names = detected.map((client) => client.label).join(", ");
  const wants = await confirm({ message: `Give your AI agent the Pithy docs? Found ${names}.` });
  if (isCancel(wants) || !wants) return;

  // A cancel here is "no thanks", not a failure: `init` has already scaffolded the project and printed
  // `Done.`, and exiting over an optional question would make a successful run look like a broken one.
  const asked = await askScope();
  if (asked === null) return;
  const written: ConnectResult[] = [];
  for (const client of detected) {
    written.push(await connect(targetFor(client, scopeFor(client, asked), options)));
  }
  emit(reportRows(written));
  printRefusals(written);
}

const connectCommand = defineCommand({
  meta: { name: "connect", description: "Write the Pithy docs MCP server into your AI clients" },
  args: {
    ...targetArgs,
    print: { type: "boolean", default: false, description: "Print the snippet; write nothing" },
    ...jsonArg,
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const options = optionsOf();

      // `--print` is the escape hatch, so it answers for a tool the table has never heard of rather than
      // refusing — but it says which of the two happened, because otherwise a typo'd `--client` and the
      // eleventh tool produce the same output and only one of them is what the operator meant.
      if (args.print) {
        const client = args.client === undefined ? undefined : clientById(args.client);
        const scope = args.scope === undefined ? undefined : requireScope(args.scope);
        const printed =
          client === undefined
            ? { client: null, path: null, snippet: GENERIC_SNIPPET }
            : {
                client: client.id,
                path: targetFor(client, scopeFor(client, scope ?? scopesOf(client)[0]), options).path,
                snippet: snippetFor(client),
              };
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "docs connect", printed })}\n`);
          return;
        }
        if (printed.client !== null) emit(`${printed.path}:`);
        else if (args.client !== undefined) emit(dim(`No client called ${args.client}. This is the shape most take.`));
        else emit(dim("No client named, so this is the shape most of them take."));
        process.stdout.write(printed.snippet);
        return;
      }

      const chosen = await resolveClients(args, args.json, options);
      // The scope is settled before the empty set is, so an unattended run refuses the same way on a
      // machine with no clients as on one with ten. A CI step that passes only because nothing happened
      // to be installed is a CI step that will fail on somebody's laptop.
      const flagged = args.scope === undefined ? undefined : requireScope(args.scope);
      if (flagged === undefined && !interactive(args.json)) throw scopeRequired();

      if (chosen.length === 0) {
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "docs connect", written: [] })}\n`);
          return;
        }
        emit("No AI clients detected here.");
        emit("Run `pithy docs connect --print` for the snippet to add by hand.");
        return;
      }

      const asked = flagged ?? (await askScopeOrExit());
      const written: ConnectResult[] = [];
      for (const client of chosen) {
        written.push(await connect(targetFor(client, scopeFor(client, asked), options)));
      }

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "docs connect", written })}\n`);
        process.exit(exitFor(written));
      }
      emit(reportRows(written));
      printRefusals(written);
      const code = exitFor(written);
      // `Done.` is a claim that something was done. A run where every client refused did nothing, so it
      // ends on the refusals and the exit code rather than on the brand's full stop.
      if (code === 0) emit(formatDone());
      else process.exit(code);
    }),
});

const disconnectCommand = defineCommand({
  meta: { name: "disconnect", description: "Remove the Pithy docs entry, leaving every other server alone" },
  args: { ...targetArgs, ...jsonArg },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const options = optionsOf();
      const chosen = await resolveClients(args, args.json, options);
      const flagged = args.scope === undefined ? undefined : requireScope(args.scope);
      if (flagged === undefined && !interactive(args.json)) throw scopeRequired();
      const asked = chosen.length === 0 ? "user" : (flagged ?? (await askScopeOrExit()));

      const disconnected: DisconnectResult[] = [];
      for (const client of chosen) {
        disconnected.push(await disconnect(targetFor(client, scopeFor(client, asked), options)));
      }

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "docs disconnect", disconnected })}\n`);
        process.exit(exitFor(disconnected));
      }
      if (disconnected.length === 0) {
        emit("No AI clients detected here.");
        return;
      }
      emit(reportRows(disconnected));
      const code = exitFor(disconnected);
      if (code === 0) emit(formatDone());
      else process.exit(code);
    }),
});

/** One line per client: whether it is here, and what each of its configurations says. */
function statusRows(clients: readonly ClientStatus[]): string {
  return formatList(
    clients.map((client) => {
      const wired = client.scopes.filter((scope) => scope.connected);
      const where = wired.map((scope) => `${scope.scope}${scope.current ? "" : " (stale)"}`).join(", ");
      const state = !client.detected ? "not detected" : wired.length === 0 ? "not connected" : `connected: ${where}`;
      return { name: client.label, description: state };
    }),
  );
}

const statusCommand = defineCommand({
  meta: { name: "status", description: "Report which AI clients are wired to the docs server, and where" },
  args: { ...jsonArg },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const clients = await status(optionsOf());
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "docs status", clients })}\n`);
        return;
      }
      emit(statusRows(clients));
    }),
});

export default defineCommand({
  meta: { name: "docs", description: "Connect the Pithy documentation server to your AI coding agent" },
  subCommands: { connect: connectCommand, disconnect: disconnectCommand, status: statusCommand },
});
