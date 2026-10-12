// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ExitClass } from "../terminal/exitClass";
import { DeclaredFlag, DeclaredPositional } from "./args";
import { FlagGroup, JsonOutput } from "./commandContract";

/**
 * **The shape of `pithy schema`'s answer (#697)**, apart from the walk that fills it (`describe.ts`), so
 * the command can declare its own payload without loading the tree to do it.
 */

/** One environment variable. */
export const EnvironmentVariable = z
  .object({
    name: z.string().describe("The variable's name."),
    values: z.string().describe("What it takes, in words: `1`, `compact` or `pretty`, any non-blank value."),
    description: z.string().describe("What setting it does."),
  })
  .describe("One environment variable the CLI reads.");
export type EnvironmentVariable = z.infer<typeof EnvironmentVariable>;

/** A JSON Schema document, as `z.toJSONSchema` writes one. */
export const JsonSchemaDocument = z
  .record(z.string().describe("A JSON Schema keyword."), z.unknown().describe("Its value."))
  .describe("A JSON Schema (draft 2020-12).");

/** Where every command's error line points: the one schema at the root of the document. */
export const ERROR_LINE_REF = "#/errorLine";

/** One command, as `pithy schema` publishes it. */
export const CommandDescription = z
  .object({
    path: z.string().describe("The command as typed after `pithy`: `add`, `token mint`."),
    description: z.string().describe("What it does, as `--help` says it."),
    aliases: z
      .array(z.string().describe("Another name that reaches this command."))
      .describe("Names this command also answers to. Empty for every command today."),
    subcommands: z
      .array(z.string().describe("A subcommand's path."))
      .describe("The commands beneath this one. A command with some and no action of its own prints help."),
    runs: z
      .boolean()
      .describe("Whether the command acts on its own. `false` for a group, which only prints its subcommands."),
    positionals: z.array(DeclaredPositional).describe("Its positional arguments, in order."),
    flags: z.array(DeclaredFlag).describe("Every flag it declares. The global flags work beside these."),
    flagGroups: z.array(FlagGroup).describe("Rules over several flags. Empty when there are none."),
    output: JsonOutput,
    payload: JsonSchemaDocument.nullable().describe(
      "The JSON Schema of its `--json` output: the one document, or any one record of a stream. `null` when `output` is `none`.",
    ),
    schemaVersion: z
      .number()
      .int()
      .nullable()
      .describe(
        "The version every `--json` line it writes carries as `schemaVersion`. Bumped only when a key is removed or retyped. `null` when `output` is `none`.",
      ),
    events: JsonSchemaDocument.nullable().describe(
      "The JSON Schema of one `--events` progress record, which every line but the last of a `--json --events` run is. `null` when it takes no `--events`.",
    ),
    errorLine: z
      .object({ $ref: z.literal(ERROR_LINE_REF).describe("A pointer to the document's `errorLine`.") })
      .describe("The JSON Schema of its error line on stderr — the same for every command, so it is published once."),
    mutates: z
      .boolean()
      .describe(
        "Whether a successful run can change anything: files, Cloudflare, a database, a store. It describes the default run, with no optional flag; a flag that changes the answer says so in its description. The CLI's own update-notifier cache is not counted.",
      ),
    idempotent: z
      .boolean()
      .describe(
        "Whether running it again with the same arguments, after it succeeded, succeeds and changes nothing further. A second run that is refused is not idempotent. The default run, as `mutates` is.",
      ),
    needsNetwork: z.boolean().describe("Whether it can reach the network: Cloudflare, npm, a browser flow."),
  })
  .describe("One command in the tree.");
export type CommandDescription = z.infer<typeof CommandDescription>;

/** One flag every command takes, answered before any command runs. */
export const GlobalFlag = z
  .object({
    name: z.string().describe("The canonical spelling."),
    aliases: z.array(z.string().describe("Another spelling.")).describe("Every other spelling."),
    description: z.string().describe("What it does."),
    hidden: z.boolean().describe("Whether `--help` leaves it out."),
  })
  .describe("A flag every command takes.");
export type GlobalFlag = z.infer<typeof GlobalFlag>;

/** One row of the exit-code table. */
export const ExitCodeRow = z
  .object({
    exit: z.number().int().describe("The process exit code."),
    exitClass: ExitClass.nullable().describe("The class an error line names for it. `null` for 0, 130 and 141."),
    meaning: z.string().describe("What it means, in a few words."),
    agentShould: z.string().describe("What a script or an agent should do on seeing it."),
    retryable: z.boolean().describe("Whether running the same command again, unchanged, can succeed."),
  })
  .describe("One exit code the CLI uses on purpose.");
export type ExitCodeRow = z.infer<typeof ExitCodeRow>;

/** One kit error code, its status, and what a CLI caller should do about it. */
export const ErrorCodeRow = z
  .object({
    code: z.string().describe("`domain/reason`, namespaced per capability."),
    status: z.number().int().describe("The HTTP status the kit pins to this code."),
    exitClass: ExitClass,
    exit: z.number().int().describe("The exit code a run that fails with it ends with."),
    retryable: z.boolean().describe("Whether running the same command again, unchanged, can succeed."),
    remedy: z.string().describe("What that class asks of the caller."),
  })
  .describe("One error code the kit defines.");
export type ErrorCodeRow = z.infer<typeof ErrorCodeRow>;

/** The whole tree. */
export const CliDescription = z
  .object({
    version: z.string().describe("The installed CLI's version. Everything here describes this version."),
    commands: z.array(CommandDescription).describe("Every command in the tree, groups included, sorted by path."),
    globalFlags: z.array(GlobalFlag).describe("Flags every command takes."),
    environmentVariables: z.array(EnvironmentVariable).describe("Every environment variable the CLI reads."),
    exitCodes: z.array(ExitCodeRow).describe("Every exit code the CLI uses on purpose, in order."),
    errorCodes: z.array(ErrorCodeRow).describe("Every error code the kit defines, sorted by code."),
    errorLine: JsonSchemaDocument.describe("The JSON Schema of the `--json` error line on stderr."),
  })
  .describe("The CLI, described by itself.");
export type CliDescription = z.infer<typeof CliDescription>;

/** `pithy schema` with a command: that command and everything beneath it. */
export const CommandTree = CliDescription.pick({ version: true, errorLine: true })
  .extend({
    path: z.string().describe("The command asked about, as typed after `pithy schema`."),
    commands: z
      .array(CommandDescription)
      .describe("That command first, then every command beneath it, sorted by path."),
  })
  .describe("One command and its subtree.");
export type CommandTree = z.infer<typeof CommandTree>;
