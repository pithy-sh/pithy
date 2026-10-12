// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import type { CommandDef, CommandMeta } from "citty";
import { z } from "zod";
import { HIDDEN_ROOT_FLAG_DESCRIPTIONS } from "../commands/alias";
import { ROOT_FLAG_DESCRIPTIONS } from "../rootFlags";
import { ErrorLine } from "../terminal/errorLine";
import { EXIT, EXIT_CLASSES, ExitClass, exitClassOf } from "../terminal/exitClass";
import { describeArgs } from "./args";
import {
  type CliDescription,
  type CommandDescription,
  ERROR_LINE_REF,
  type ErrorCodeRow,
  type ExitCodeRow,
  type GlobalFlag,
} from "./cliSchema";
import { contractOf, publishedEvents, publishedPayload } from "./commandContract";
import { ENVIRONMENT_VARIABLES } from "./environment";

/**
 * **The CLI, described by itself (#697).** What `pithy schema` publishes and what `docs/catalog.generated.json`
 * is projected from: one walk of the command tree the binary dispatches on, so the answer is the installed
 * version's and the two documents cannot disagree.
 *
 * Every command contributes two halves. Its parser's facts — positionals, flags, their spellings — are
 * read off citty's `args` by `args.ts`. Its promises — the `--json` payload's JSON Schema and `schemaVersion`
 * (and its `--events` record, where it streams one), whether it mutates, whether a rerun is safe, whether it
 * needs the network, the flag groups citty cannot express — are read off the contract it declares (`commandContract.ts`). A group declares no contract, because it
 * does nothing but print help.
 */

/** citty's `Resolvable<T>`: a value, a promise of one, or a thunk returning either. */
type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);

/** One `Resolvable`, resolved. Reading one unawaited is silent: `Object.entries` of a function is `[]`. */
async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

/** One node of the tree: the path a caller types, and the command it reaches. */
export interface TreeNode {
  /** From the root down. Empty for the root itself. */
  readonly path: readonly string[];
  readonly cmd: CommandDef;
}

/** The subcommands one command declares, resolved, in declaration order. */
async function childrenOf(cmd: CommandDef): Promise<[string, CommandDef][]> {
  if (cmd.subCommands === undefined) return [];
  const declared = (await resolve(cmd.subCommands)) as Record<string, Resolvable<CommandDef>>;
  const children: [string, CommandDef][] = [];
  for (const [name, value] of Object.entries(declared)) children.push([name, await resolve(value)]);
  return children;
}

/** The one subcommand of `cmd` named `name`, resolved alone, or `undefined` when it declares none by that name. */
async function childNamed(cmd: CommandDef, name: string): Promise<CommandDef | undefined> {
  if (cmd.subCommands === undefined) return undefined;
  const declared = (await resolve(cmd.subCommands)) as Record<string, Resolvable<CommandDef>>;
  return Object.hasOwn(declared, name) ? await resolve(declared[name] as Resolvable<CommandDef>) : undefined;
}

/**
 * Every command under `root`, the root excluded, sorted by the path a caller types.
 *
 * All three of citty's subcommand spellings are resolved. This CLI writes thunks so the tree stays lazy,
 * and `dispatch.ts`'s `ownNamesOnly` wraps the container itself in one — reading only the literal form
 * would find the root's names and none of their flags.
 */
export async function walkTree(root: CommandDef, prefix: readonly string[] = []): Promise<TreeNode[]> {
  const found: TreeNode[] = [];
  for (const [name, cmd] of await childrenOf(root)) {
    const path = [...prefix, name];
    found.push({ path, cmd });
    found.push(...(await walkTree(cmd, path)));
  }
  return found.sort((left, right) => left.path.join(" ").localeCompare(right.path.join(" ")));
}

/**
 * The JSON Schema of one Zod schema, as published: the side a parse **accepts**, so every object is open.
 * A key added to a payload is not a breaking change (`schemaVersion` is bumped only for a removed or
 * retyped one), and a published `additionalProperties: false` would make it one for every consumer that
 * validates with it. The tests hold real output to the closed set instead (`test-utils/payloadContract.ts`).
 */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

/** A declared alias list, whichever shape `meta.alias` was declared in. */
function commandAliases(meta: CommandMeta | undefined): string[] {
  const alias = meta?.alias;
  if (typeof alias === "string") return [alias];
  return Array.isArray(alias) ? [...alias] : [];
}

/** One command, both halves. */
export async function describeCommand(node: TreeNode): Promise<CommandDescription> {
  const { cmd } = node;
  const meta = cmd.meta === undefined ? undefined : await resolve(cmd.meta);
  const args = cmd.args === undefined ? undefined : await resolve(cmd.args);
  const contract = contractOf(cmd);
  const payload = contract === undefined ? undefined : publishedPayload(contract);
  const events = contract === undefined ? undefined : publishedEvents(contract);
  const { positionals, flags } = describeArgs(args, contract?.flags);
  const path = node.path.join(" ");
  return {
    path,
    description: meta?.description ?? "",
    aliases: commandAliases(meta),
    subcommands: (await childrenOf(cmd)).map(([name]) => `${path} ${name}`),
    runs: typeof cmd.run === "function",
    positionals,
    flags,
    flagGroups: [...(contract?.flagGroups ?? [])],
    output: contract?.output ?? "none",
    payload: payload === undefined ? null : jsonSchemaOf(payload),
    schemaVersion: contract?.schemaVersion ?? null,
    events: events === undefined ? null : jsonSchemaOf(events),
    errorLine: { $ref: ERROR_LINE_REF },
    mutates: contract?.mutates ?? false,
    idempotent: contract?.idempotent ?? true,
    needsNetwork: contract?.needsNetwork ?? false,
  };
}

/** Every flag `bin.ts` answers before a command runs, the hidden two included and marked. */
export function globalFlags(): GlobalFlag[] {
  return [
    ...ROOT_FLAG_DESCRIPTIONS.map((flag) => ({ ...flag, aliases: [...flag.aliases], hidden: false })),
    ...HIDDEN_ROOT_FLAG_DESCRIPTIONS.map((flag) => ({ ...flag, aliases: [], hidden: true })),
  ];
}

/** The exit-code table: the classes `exitClass.ts` defines, between success and the two a signal would leave. */
export function exitCodes(): ExitCodeRow[] {
  return [
    { exit: EXIT.ok, exitClass: null, meaning: "Done", agentShould: "Continue", retryable: false },
    ...ExitClass.options
      .map((exitClass) => ({ exitClass, ...EXIT_CLASSES[exitClass] }))
      .sort((left, right) => left.exit - right.exit),
    { exit: EXIT.interrupted, exitClass: null, meaning: "Interrupted", agentShould: "Stop", retryable: false },
    {
      exit: EXIT.brokenPipe,
      exitClass: null,
      meaning: "Output closed early",
      agentShould: "Read what arrived",
      retryable: false,
    },
  ];
}

/** Every kit error code, sorted, each with the class it exits with. */
export function errorCodes(): ErrorCodeRow[] {
  return KitErrorPayload.options
    .map((member) => {
      const code = member.shape.code.value;
      const exitClass = exitClassOf({ code });
      const { exit, retryable, agentShould } = EXIT_CLASSES[exitClass];
      return { code, status: member.shape.status.value, exitClass, exit, retryable, remedy: agentShould };
    })
    .sort((left, right) => left.code.localeCompare(right.code));
}

/** The JSON Schema every command's `errorLine` points at. */
export function errorLineSchema(): Record<string, unknown> {
  return jsonSchemaOf(ErrorLine);
}

/** The version `root` declares, which for `main` is the installed package's. */
async function versionOf(root: CommandDef): Promise<string> {
  const meta = root.meta === undefined ? undefined : await resolve(root.meta);
  return meta?.version ?? "";
}

/** One command and everything beneath it: what `pithy schema <command>` publishes beside its `path`. */
export interface SubtreeDescription {
  version: string;
  path: string;
  commands: CommandDescription[];
  errorLine: Record<string, unknown>;
}

/**
 * The command at `words` and everything beneath it, or `undefined` when the tree has no such command.
 *
 * **Only that subtree is resolved and described (#697).** The node is reached by name, one level at a time,
 * so a sibling's lazily imported module is never loaded and its payload never turned into a JSON Schema. What
 * it returns is exactly what {@link describeCli}'s commands filtered to the path would be, in the same order.
 */
export async function describeSubtree(
  root: CommandDef,
  words: readonly string[],
): Promise<SubtreeDescription | undefined> {
  let cmd: CommandDef | undefined = root;
  for (const word of words) {
    cmd = await childNamed(cmd, word);
    if (cmd === undefined) return undefined;
  }
  const nodes = [{ path: [...words], cmd }, ...(await walkTree(cmd, words))].sort((left, right) =>
    left.path.join(" ").localeCompare(right.path.join(" ")),
  );
  const commands: CommandDescription[] = [];
  for (const node of nodes) commands.push(await describeCommand(node));
  return { version: await versionOf(root), path: words.join(" "), commands, errorLine: errorLineSchema() };
}

/** The whole tree, every section. */
export async function describeCli(root: CommandDef): Promise<CliDescription> {
  const commands: CommandDescription[] = [];
  for (const node of await walkTree(root)) commands.push(await describeCommand(node));
  return {
    version: await versionOf(root),
    commands,
    globalFlags: globalFlags(),
    environmentVariables: [...ENVIRONMENT_VARIABLES],
    exitCodes: exitCodes(),
    errorCodes: errorCodes(),
    errorLine: errorLineSchema(),
  };
}
