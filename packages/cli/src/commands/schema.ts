// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandNameOfPath, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type CommandDef, defineCommand } from "citty";
import { z } from "zod";
import { CliDescription, CommandTree } from "../contract/cliSchema";
import { withContract } from "../contract/commandContract";
import { formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy schema [command…] [--json]` — the CLI, described by the binary that is installed (#697).
 *
 * Without a command: every command in the tree, the flags every command takes, the environment variables,
 * the exit codes and the error codes. With one: that command and everything beneath it. Either way the
 * answer is read off the tree this binary dispatches on, so it is true of the installed version and of no
 * other — which is what `docs/catalog.generated.json`, generated from the same walk, cannot be.
 *
 * **The command is any number of words**, `pithy schema token mint`, read off citty's positional list.
 * One positional is declared so `--help` names it; the rest are the words after it. The contract marks it
 * variadic, so `pithy schema` publishes it as one argument of many words and `--help` prints `[COMMAND…]`.
 *
 * **The answer is JSON with or without `--json`.** It is a document for a program to read, and there is
 * no shorter human rendering of it that would not be `--help` again. `--json` is accepted, as everywhere,
 * so a caller can say what it expects; without it, the line is formatted for whoever is reading, exactly
 * as a `--json` line is (`PITHY_JSON`, `--pretty`).
 */

/** What `pithy schema` writes: the whole tree, or one command's subtree. */
export const SchemaPayload = z
  .union([
    CliDescription.extend({ command: z.literal("schema").describe('`"schema"`.') }).describe(
      "`pithy schema`: the whole tree.",
    ),
    CommandTree.extend({ command: z.literal("schema").describe('`"schema"`.') }).describe(
      "`pithy schema <command>`: that command and everything beneath it.",
    ),
  ])
  .describe("The CLI, described by itself.");
export type SchemaPayload = z.infer<typeof SchemaPayload>;

/**
 * Refuse a path the tree does not have, naming what the deepest real prefix of it does have — or, when that
 * prefix is a leaf, saying so and pointing at its own schema.
 */
function unknownPath(words: readonly string[], paths: readonly string[]): ValidationError {
  const typed = words.join(" ");
  let prefix = words.slice(0, -1);
  while (prefix.length > 0 && !paths.includes(prefix.join(" "))) prefix = prefix.slice(0, -1);
  const parent = prefix.join(" ");
  const depth = prefix.length + 1;
  const siblings = paths
    .filter((path) => (parent === "" || path.startsWith(`${parent} `)) && path.split(" ").length === depth)
    .map((path) => path.split(" ").at(-1) as string);
  const where = `\`${commandNameOfPath(prefix)}\``;
  // A leaf has nothing beneath it to list: the words past it are a value, not a command.
  const action =
    siblings.length === 0
      ? `${where} takes no subcommand; its arguments are in \`${pithyCommand("schema", { args: prefix as [string, ...string[]], flags: { "--json": true } })}\`.`
      : `${where} has ${siblings.join(", ")}.`;
  return new ValidationError({
    message: `No command is named \`${typed}\`.`,
    action,
    issues: [{ path: ["command"], code: "invalid_value", message: `\`${typed}\` is not a command.` }],
  });
}

/**
 * The document for `words`, read off `root`. Exported for the tests, which hand it a tree of their own;
 * the command hands it `main`.
 *
 * With a command, only that command's subtree is resolved and described (`describeSubtree`): the whole tree
 * is walked only to name what a path the tree does not have could have been.
 */
export async function schemaDocument(
  root: CommandDef,
  words: readonly string[],
): Promise<CliDescription | CommandTree> {
  const { describeCli, describeSubtree, walkTree } = await import("../contract/describe");
  if (words.length === 0) return describeCli(root);
  const subtree = await describeSubtree(root, words);
  if (subtree !== undefined) return subtree;
  throw unknownPath(
    words,
    (await walkTree(root)).map((node) => node.path.join(" ")),
  );
}

export default withContract(
  defineCommand({
    meta: { name: "schema", description: "Describe every command, flag, payload and error code as JSON" },
    args: {
      command: {
        type: "positional",
        required: false,
        description: "Describe only this command and those beneath it, e.g. token mint",
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const { main } = await import("../main");
        const document = await schemaDocument(main, args._);
        process.stdout.write(`${formatJsonLine({ command: "schema", ...document })}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: SchemaPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: false,
    // Every word after `schema` is the command: `pithy schema token mint`.
    flags: { command: { variadic: true } },
  },
);
