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
import { ROOT_FLAGS } from "../rootFlags";
import { buildDocsCatalog, CATALOG_PATH, flagsOf, renderDocsCatalog, walkCommands } from "./catalog";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("flagsOf", () => {
  test("names every flag a parser accepts, long form first", () => {
    expect(flagsOf({ json: { type: "boolean" }, worker: { type: "string" } })).toEqual([
      "--json",
      "--no-json",
      "--worker",
    ]);
  });

  test("carries an alias in the spelling a caller types", () => {
    expect(flagsOf({ force: { type: "boolean", alias: "f" } })).toEqual(["--force", "-f", "--no-force"]);
    expect(flagsOf({ force: { type: "boolean", alias: ["f", "yes"] } })).toEqual([
      "--force",
      "-f",
      "--yes",
      "--no-force",
    ]);
  });

  test("a positional is not a flag", () => {
    expect(flagsOf({ capability: { type: "positional" }, list: { type: "boolean" } })).toEqual(["--list", "--no-list"]);
  });

  /**
   * citty aliases every arg to its camel **and** kebab spelling (`parseArgs`, `citty/dist/index.mjs`),
   * so `--withPrerequisites` reaches the same value. This file used to claim citty does no case mapping.
   */
  test("a kebab-case arg also answers to its camelCase spelling", () => {
    expect(flagsOf({ "with-prerequisites": { type: "boolean" } })).toEqual([
      "--with-prerequisites",
      "--withPrerequisites",
      "--no-with-prerequisites",
    ]);
  });

  /**
   * The false failure this closed. citty strips `--no-` from any argument before parsing, and the CLI
   * documents the result — `ui.ts`'s own description offers `--no-auth`, and `docs/commands/ui.md` puts
   * `[--auth | --no-auth]` in its synopsis. An export without it makes that page read as citing a flag
   * that does not exist, which is the cries-wolf failure the export exists to avoid.
   */
  test("a boolean also answers to its `--no-` form, and a string does not", () => {
    expect(flagsOf({ auth: { type: "boolean" } })).toEqual(["--auth", "--no-auth"]);
    expect(flagsOf({ worker: { type: "string" } })).toEqual(["--worker"]);
  });

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

  test("a command with no args accepts no flags", () => {
    expect(flagsOf(undefined)).toEqual([]);
  });
});

describe("walkCommands", () => {
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
    expect(built.errorCodes).toEqual(
      KitErrorPayload.options
        .map((member) => ({ code: member.shape.code.value, status: member.shape.status.value }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
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
      "--pithier",
      "--pithiest",
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
    expect([...found].filter((flag) => !global.has(flag)).sort()).toEqual([]);
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

describe("renderDocsCatalog", () => {
  test("writes strict JSON, because the reader is another repository's JSON.parse", () => {
    const rendered = renderDocsCatalog({
      $generated: "generated, do not edit",
      capabilities: [{ name: "auth", package: "@pithy-sh/auth" }],
      commands: [{ path: "add", flags: ["--json"] }],
      globalFlags: ["--help"],
      errorCodes: [{ code: "core/not_found", status: 404 }],
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
