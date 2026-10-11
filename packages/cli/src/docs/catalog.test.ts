// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import type { CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import { CATALOG } from "../capabilities/catalog";
import { HIDDEN_ROOT_FLAGS } from "../commands/alias";
import { describeCli, walkTree } from "../contract/describe";
import { flagsOf } from "../declaredFlags";
import { main } from "../main";
import { ROOT_FLAGS } from "../rootFlags";
import { EXIT_CLASSES, exitClassOf } from "../terminal/exitClass";
import { buildDocsCatalog, CATALOG_PATH, renderDocsCatalog } from "./catalog";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** `flagsOf` and its own cases live in `../declaredFlags`; what it is complete over is a fact about this tree. */
describe("the arg names flagsOf reads", () => {
  /**
   * The narrow `camelSpelling` transform is only complete because every arg name in the CLI is lowercase
   * kebab. That is a property of the command tree, not of the transform, so it is asserted rather than
   * assumed — an arg named `dryRun` tomorrow would need the kebab direction too.
   */
  test("every arg name the CLI declares is lowercase kebab, which is what makes the transform complete", async () => {
    const names = new Set<string>();
    for (const command of (await buildDocsCatalog()).commands) {
      for (const flag of command.flags) if (flag.startsWith("--")) names.add(flag.slice(2));
    }
    expect(names.size).toBeGreaterThan(20);
    expect([...names].filter((name) => !/^[a-z][a-z0-9-]*$/.test(name) && !/^[a-z][a-zA-Z0-9]*$/.test(name))).toEqual(
      [],
    );
  });
});

/**
 * Every command under `root`, each with every spelling of its flags: `pithy schema`'s walk, which
 * `buildDocsCatalog` projects to `{ path, flags }`.
 */
async function walkCommands(root: CommandDef): Promise<{ path: string; flags: string[] }[]> {
  return (await describeCli(root)).commands.map((command) => ({
    path: command.path,
    flags: command.flags.flatMap((flag) => [flag.name, ...flag.aliases.map((alias) => alias.flag)]),
  }));
}

describe("the catalog's walk of a command tree", () => {
  /** citty accepts a definition, a promise of one, or a thunk. A walk that reads only the first is blind. */
  const tree: CommandDef = {
    meta: { name: "pithy" },
    subCommands: {
      add: { args: { list: { type: "boolean" } } },
      token: {
        subCommands: {
          mint: () => Promise.resolve({ args: { env: { type: "string" } } }),
          list: Promise.resolve({ args: { json: { type: "boolean" } } }),
          // citty types `args` as `Resolvable<ArgsDef>`, so a command may hand back a promise of its
          // parser. Reading it unawaited yields `Object.entries` of a promise — no keys, no flags, and
          // a command that silently accepts nothing.
          revoke: { args: Promise.resolve({ yes: { type: "boolean" } }) },
          rotate: { args: () => ({ overlap: { type: "string" } }) },
        },
      },
    },
  };

  test("names every command by the path a caller types", async () => {
    expect((await walkCommands(tree)).map((command) => command.path)).toEqual([
      "add",
      "token",
      "token list",
      "token mint",
      "token revoke",
      "token rotate",
    ]);
  });

  test("resolves a thunk and a promise, not just a literal", async () => {
    const walked = await walkCommands(tree);
    expect(walked.find((command) => command.path === "token mint")?.flags).toEqual(["--env"]);
    expect(walked.find((command) => command.path === "token list")?.flags).toEqual(["--json", "--no-json"]);
  });

  test("resolves a parser that is itself a promise or a thunk", async () => {
    const walked = await walkCommands(tree);
    expect(walked.find((command) => command.path === "token revoke")?.flags).toEqual(["--yes", "--no-yes"]);
    expect(walked.find((command) => command.path === "token rotate")?.flags).toEqual(["--overlap"]);
  });

  test("a group that only dispatches carries no flags of its own", async () => {
    expect((await walkCommands(tree)).find((command) => command.path === "token")?.flags).toEqual([]);
  });

  test("the root is not a command anybody types, so it is not in the list", async () => {
    expect((await walkCommands(tree)).map((command) => command.path)).not.toContain("");
  });

  /**
   * The container is a `Resolvable` as much as its members, and this repository builds the lazy form:
   * `dispatch.ts`'s `ownNamesOnly` returns `subCommands: async () => …`, which `bin.ts` wraps the tree
   * in. Read unawaited it is a function, `Object.entries` of it is empty, and the whole tree disappears
   * from the export — while `buildDocsCatalog`'s non-empty guard stays satisfied by the other sections.
   */
  test("resolves a lazy `subCommands` container, the shape `ownNamesOnly` produces", async () => {
    const lazy: CommandDef = {
      meta: { name: "pithy" },
      subCommands: async () => ({ add: { args: { list: { type: "boolean" } } } }),
    };
    expect(await walkCommands(lazy)).toEqual([{ path: "add", flags: ["--list", "--no-list"] }]);
  });
});

describe("buildDocsCatalog", () => {
  test("names every capability `pithy add` accepts, and the package each ships in", async () => {
    const built = await buildDocsCatalog();
    expect(built.capabilities).toEqual(
      [...CATALOG]
        .map((entry) => ({ name: entry.name, package: entry.package }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  test("names every command the CLI ships, subcommands included", async () => {
    const built = await buildDocsCatalog();
    const paths = built.commands.map((command) => command.path);
    expect(paths).toContain("add");
    expect(paths).toContain("token mint");
    expect(paths).toEqual([...paths].sort());
  });

  test("names every error code the kit defines, with the status it pins", async () => {
    const built = await buildDocsCatalog();
    expect(built.errorCodes.map(({ code, status }) => ({ code, status }))).toEqual(
      KitErrorPayload.options
        .map((member) => ({ code: member.shape.code.value, status: member.shape.status.value }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
  });

  /**
   * **And what a caller should do about each one (#697)** — the exit class the CLI ends with, its number,
   * whether a retry can help, and the remedy that class names. Beside `code` and `status`, never in place
   * of them: the site's checker reads those two by name.
   */
  test("gives every error code its exit class, exit code, retryability and remedy, from the one table", async () => {
    const built = await buildDocsCatalog();
    for (const entry of built.errorCodes) {
      const exitClass = exitClassOf({ code: entry.code });
      expect(entry).toEqual({
        code: entry.code,
        status: entry.status,
        exitClass,
        exit: EXIT_CLASSES[exitClass].exit,
        retryable: EXIT_CLASSES[exitClass].retryable,
        remedy: EXIT_CLASSES[exitClass].agentShould,
      });
    }
    expect(built.errorCodes.find((entry) => entry.code === "core/upstream_timeout")).toMatchObject({
      exit: 4,
      retryable: true,
    });
  });

  /**
   * The hole this closed. `--pithier` and `--pithiest` are answered in `bin.ts` before citty parses, so
   * the command walk cannot see them and the first version of this export did not carry them — which
   * made `docs/commands/alias.md`, a page the kit's own tests pin, read as citing two flags that do not
   * exist. Hidden from `--help` is not hidden from a docs check.
   */
  test("names every flag parsed outside a command's args, hidden ones included", async () => {
    expect((await buildDocsCatalog()).globalFlags).toEqual([
      "--help",
      "--no-input",
      "--no-pretty",
      "--pithier",
      "--pithiest",
      "--pretty",
      "--version",
      "-h",
      "-v",
    ]);
  });

  /**
   * Asked of the modules that answer them rather than of the list above, so a seventh out-of-band flag
   * lands in the export with nothing to remember here. A literal list is how the first two went missing.
   */
  test("takes them from the modules that answer them, not from a list of its own", async () => {
    const global = new Set((await buildDocsCatalog()).globalFlags);
    for (const flag of [...ROOT_FLAGS, ...HIDDEN_ROOT_FLAGS]) expect(global).toContain(flag);
    expect(global.size).toBe(ROOT_FLAGS.length + HIDDEN_ROOT_FLAGS.length);
  });

  /**
   * The gate over the whole pre-citty path: every `--flag` literal `bin.ts` and the two modules behind
   * it hold is a flag the export names. A scan, and honest about it — a flag composed at runtime would
   * escape — but both that escaped were literals, which is the case this covers.
   */
  test("no `--flag` literal on the pre-citty path is missing from the export", async () => {
    const global = new Set((await buildDocsCatalog()).globalFlags);
    const HERE = dirname(fileURLToPath(import.meta.url));
    const found = new Set<string>();
    for (const file of ["../bin.ts", "../rootFlags.ts", "../commands/alias.ts"]) {
      for (const match of readFileSync(join(HERE, file), "utf8").matchAll(/"(--[a-z][a-z0-9-]*)"/g)) {
        found.add(match[1] as string);
      }
    }
    // Anti-vacuous: a regex that stopped matching would make the assertion below pass over nothing.
    expect(found.size).toBeGreaterThan(3);
    // `alias.ts` is also `pithy alias`, and its contract names that command's own declared flags (#697).
    // Those are citty's, in `alias`'s `args`, and the catalog lists them under `alias` rather than here.
    const aliasArgs = (await import("../commands/alias")).default.args;
    const declared = new Set(flagsOf(typeof aliasArgs === "function" ? await aliasArgs() : await aliasArgs));
    expect([...found].filter((flag) => !global.has(flag) && !declared.has(flag)).sort()).toEqual([]);
  });

  /**
   * A generated file says so at the top. This one cannot say it in a comment, so it says it in a field,
   * and the field has to name the command that regenerates it or it is decoration.
   */
  test("opens by saying it is generated, and by what", async () => {
    const built = await buildDocsCatalog();
    expect(Object.keys(built)[0]).toBe("$generated");
    expect(built.$generated).toContain("bun run docs-catalog");
  });
});

/**
 * **The catalog and `pithy schema` are one answer (#697).** The catalog is the committed copy another
 * repository reads; `pithy schema` is the installed binary's own account. Both come from `describeCli`,
 * and these hold the projection to it — and to the parser, which is the third party to the agreement:
 * a flag the catalog lists and `bin.ts` refuses would send the site's checker and an agent different ways.
 */
describe("the catalog is a projection of pithy schema", () => {
  test("every command, every spelling of every flag, every global flag and every error code", async () => {
    const [catalog, cli] = await Promise.all([buildDocsCatalog(), describeCli(main)]);
    expect(catalog.commands).toEqual(
      cli.commands.map((command) => ({
        path: command.path,
        flags: command.flags.flatMap((flag) => [flag.name, ...flag.aliases.map((alias) => alias.flag)]),
      })),
    );
    expect(catalog.globalFlags).toEqual(cli.globalFlags.flatMap((flag) => [flag.name, ...flag.aliases]).sort());
    expect(catalog.errorCodes).toEqual(cli.errorCodes);
  });

  test("lists exactly the spellings the parser accepts, command by command", async () => {
    const catalog = await buildDocsCatalog();
    const nodes = await walkTree(main);
    expect(nodes.length).toBeGreaterThan(80);
    for (const node of nodes) {
      const args = typeof node.cmd.args === "function" ? await node.cmd.args() : await node.cmd.args;
      const listed = catalog.commands.find((command) => command.path === node.path.join(" "))?.flags;
      expect({ path: node.path.join(" "), flags: listed }).toEqual({ path: node.path.join(" "), flags: flagsOf(args) });
    }
  });
});

describe("renderDocsCatalog", () => {
  test("writes strict JSON, because the reader is another repository's JSON.parse", () => {
    const rendered = renderDocsCatalog({
      $generated: "generated, do not edit",
      capabilities: [{ name: "auth", package: "@pithy-sh/auth" }],
      commands: [{ path: "add", flags: ["--json"] }],
      globalFlags: ["--help"],
      errorCodes: [
        {
          code: "core/not_found",
          status: 404,
          exitClass: "precondition",
          exit: 3,
          retryable: false,
          remedy: "Run the `fix` command",
        },
      ],
    });
    expect(() => JSON.parse(rendered) as unknown).not.toThrow();
    expect(rendered.endsWith("\n")).toBe(true);
  });
});

describe("the committed catalog", () => {
  /**
   * The gate. `docs/catalog.generated.json` is read by a script in another repository, so a stale one is a check
   * reporting `ok` against a kit that has moved — the failure `scripts/check/slugs.mjs` guards with a
   * count because it has nothing better to guard with. This is the better thing.
   */
  test("is what the kit would generate today", async () => {
    const committed = readFileSync(join(REPO_ROOT, CATALOG_PATH), "utf8");
    expect(committed, `${CATALOG_PATH} is stale. Run \`bun run docs-catalog\`.`).toBe(
      renderDocsCatalog(await buildDocsCatalog()),
    );
  });
});
