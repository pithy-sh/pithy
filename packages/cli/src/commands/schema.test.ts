// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { type CommandDef, defineCommand } from "citty";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { withContract } from "../contract/commandContract";
import { main } from "../main";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import schema, { SchemaPayload, schemaDocument } from "./schema";

/**
 * **`pithy schema` answers for the tree it is handed (#697)** — the real one in the cases that matter, a
 * small one where the point is the shape of the answer rather than the CLI's contents.
 */

const Minted = z.object({ command: z.literal("token mint").describe('`"token mint"`.') }).describe("A mint.");

/** A tree with a group, a leaf under it, and a leaf at the top. */
const tree: CommandDef = defineCommand({
  meta: { name: "pithy", version: "9.9.9" },
  subCommands: {
    token: defineCommand({
      meta: { name: "token", description: "Tokens" },
      subCommands: {
        mint: withContract(
          defineCommand({
            meta: { name: "mint", description: "Mint one" },
            args: { profile: { type: "positional", description: "Which" } },
            run: () => undefined,
          }),
          {
            output: "document",
            schemaVersion: 1,
            payload: Minted,
            mutates: true,
            idempotent: false,
            needsNetwork: true,
          },
        ),
      },
    }),
    env: withContract(defineCommand({ meta: { name: "env", description: "Inventory" }, run: () => undefined }), {
      output: "none",
      mutates: false,
      idempotent: true,
      needsNetwork: false,
    }),
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schemaDocument", () => {
  test("with no command, the whole tree and every section", async () => {
    const document = await schemaDocument(tree, []);
    expect(document.version).toBe("9.9.9");
    expect(document.commands.map((command) => command.path)).toEqual(["env", "token", "token mint"]);
    expect(Object.keys(document).sort()).toEqual(
      ["commands", "environmentVariables", "errorCodes", "errorLine", "exitCodes", "globalFlags", "version"].sort(),
    );
  });

  test("with a command, that command and everything beneath it, and nothing else", async () => {
    const group = await schemaDocument(tree, ["token"]);
    expect(group).toMatchObject({ path: "token" });
    expect(group.commands.map((command) => command.path)).toEqual(["token", "token mint"]);
    expect(Object.keys(group).sort()).toEqual(["commands", "errorLine", "path", "version"]);

    const leaf = await schemaDocument(tree, ["token", "mint"]);
    expect(leaf.commands.map((command) => command.path)).toEqual(["token mint"]);
    expect(leaf.commands[0]).toMatchObject({
      runs: true,
      output: "document",
      schemaVersion: 1,
      mutates: true,
      idempotent: false,
      needsNetwork: true,
      positionals: [{ name: "profile", required: true, description: "Which" }],
      errorLine: { $ref: "#/errorLine" },
    });
  });

  test("a group runs nothing, publishes nothing and changes nothing", async () => {
    const [group] = (await schemaDocument(tree, ["token"])).commands;
    expect(group).toMatchObject({
      runs: false,
      output: "none",
      payload: null,
      mutates: false,
      subcommands: ["token mint"],
    });
  });

  test("a path the tree does not have is refused, naming what the nearest command has", async () => {
    const refused = await schemaDocument(tree, ["token", "mnt"]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PithyError);
    const { payload } = refused as PithyError;
    expect(payload.code).toBe("validation/invalid_input");
    expect(payload.message).toBe("No command `pithy token mnt`.");
    expect(payload.action).toBe("`pithy token` has mint.");

    const top = (await schemaDocument(tree, ["nonsense"]).catch((error: unknown) => error)) as PithyError;
    expect(top.payload.action).toBe("`pithy` has env, token.");
  });

  /** A command plus a value, `pithy schema token mint extra`, reaches a leaf with nothing beneath it to name. */
  test("words past a leaf are refused, naming the leaf and where its arguments are", async () => {
    const underMint = (await schemaDocument(tree, ["token", "mint", "extra"]).catch(
      (error: unknown) => error,
    )) as PithyError;
    expect(underMint).toBeInstanceOf(PithyError);
    expect(underMint.payload.message).toBe("No command `pithy token mint extra`.");
    expect(underMint.payload.action).toBe(
      "`pithy token mint` takes no subcommand; its arguments are in `pithy schema token mint --json`.",
    );

    const underEnv = (await schemaDocument(tree, ["env", "x", "y"]).catch((error: unknown) => error)) as PithyError;
    expect(underEnv.payload.action).toBe(
      "`pithy env` takes no subcommand; its arguments are in `pithy schema env --json`.",
    );
  });

  /**
   * **One command is described alone (#697).** `pithy schema deploy --json` is what an agent asks before a
   * deploy, and describing the whole tree to answer it resolved every command module and built every payload's
   * JSON Schema only to throw all but one away. The requested node is found by its path and only its subtree is
   * walked, so a sibling's thunk is never called.
   */
  test("a command's document never resolves a sibling's module", async () => {
    let resolved = 0;
    const lazy: CommandDef = defineCommand({
      meta: { name: "pithy", version: "9.9.9" },
      subCommands: {
        token: () => tree.subCommands && (tree.subCommands as Record<string, CommandDef>).token,
        env: () => {
          resolved += 1;
          return (tree.subCommands as Record<string, CommandDef>).env as CommandDef;
        },
      },
    } as CommandDef);
    const leaf = await schemaDocument(lazy, ["token", "mint"]);
    expect(leaf.commands.map((command) => command.path)).toEqual(["token mint"]);
    expect(resolved).toBe(0);
    await schemaDocument(lazy, []);
    expect(resolved).toBe(1);
  });

  /** The subtree, described alone, is byte for byte what filtering the whole description gave. */
  test.each([["token"], ["token", "mint"], ["deploy"], ["secrets"], ["secrets", "create"], ["schema"]])(
    "pithy schema %s is the whole tree's description, filtered, byte for byte",
    async (...words: string[]) => {
      const { describeCli } = await import("../contract/describe");
      const cli = await describeCli(main);
      const path = words.join(" ");
      const commands = cli.commands.filter((command) => command.path === path || command.path.startsWith(`${path} `));
      const expected = { version: cli.version, path, commands, errorLine: cli.errorLine };
      expect(JSON.stringify(await schemaDocument(main, words))).toBe(JSON.stringify(expected));
    },
  );

  test("what it returns is what the command publishes as its own payload", async () => {
    expect(SchemaPayload.safeParse({ command: "schema", ...(await schemaDocument(tree, [])) }).success).toBe(true);
    expect(SchemaPayload.safeParse({ command: "schema", ...(await schemaDocument(tree, ["token"])) }).success).toBe(
      true,
    );
  });
});

describe("pithy schema", () => {
  test("is a leaf with a positional, so `pithy schema token mint` is its argument and not a subcommand", () => {
    expect(schema.subCommands).toBeUndefined();
    expect(schema.args).toMatchObject({ command: { type: "positional", required: false }, json: { type: "boolean" } });
  });

  /** The real tree, through the real command, held to the schema it publishes for itself (#697). */
  test("its own output conforms to its published payload, whole and narrowed", async () => {
    await expectConforms("schema", await runCaptured("schema", ["--json"]));
    await expectConforms("schema", await runCaptured("schema", ["token", "mint", "--json"]));
    await expectConforms("schema", await runCaptured("schema", ["dashboard", "--json"]));
  });

  test("describes itself among the rest", async () => {
    const document = await schemaDocument(main, ["schema"]);
    expect(document.commands).toHaveLength(1);
    expect(document.commands[0]).toMatchObject({
      path: "schema",
      output: "document",
      schemaVersion: 1,
      mutates: false,
      idempotent: true,
    });
  });

  test("marks a camelCase spelling as an alias of its canonical name", async () => {
    const [connect] = (await schemaDocument(main, ["dashboard", "connect"])).commands;
    const workerUrl = connect?.flags.find((flag) => flag.name === "--worker-url");
    expect(workerUrl?.aliases).toEqual([{ flag: "--workerUrl", kind: "camelCase" }]);
  });

  test("publishes provision's exclusive pair", async () => {
    const [provision] = (await schemaDocument(main, ["provision"])).commands;
    expect(provision?.flagGroups).toContainEqual(
      expect.objectContaining({ kind: "exactlyOne", flags: ["--env", "--feature"] }),
    );
  });
});
