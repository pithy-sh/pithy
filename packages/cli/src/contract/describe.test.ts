// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { type CommandDef, defineCommand } from "citty";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { GLOBAL_FLAGS } from "../declaredFlags";
import { main } from "../main";
import { ErrorLine } from "../terminal/errorLine";
import { EXIT, EXIT_CLASSES, ExitClass } from "../terminal/exitClass";
import { CliDescription } from "./cliSchema";
import { withContract } from "./commandContract";
import { describeCli, describeCommand, errorCodes, exitCodes, globalFlags, walkTree } from "./describe";

/**
 * **The CLI's description of itself (#697)** — each section composed from the module that decides it,
 * so it is a fact about the code rather than a second copy of one.
 */

describe("describeCli", () => {
  test("the whole tree parses as what `pithy schema` says it publishes", async () => {
    const cli = await describeCli(main);
    expect(CliDescription.parse(cli)).toEqual(cli);
    expect(cli.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("every command in the tree is described, groups included, and sorted by path", async () => {
    const cli = await describeCli(main);
    const paths = cli.commands.map((command) => command.path);
    expect(paths).toEqual([...paths].sort((left, right) => left.localeCompare(right)));
    expect(paths).toContain("token");
    expect(paths).toContain("token mint");
    expect(paths).toContain("dev logs");
    expect(paths).toContain("schema");
  });

  test("the error line is published once, and every command points at it", async () => {
    const cli = await describeCli(main);
    expect(cli.errorLine).toEqual(z.toJSONSchema(ErrorLine, { io: "input" }));
    for (const command of cli.commands) expect(command.errorLine).toEqual({ $ref: "#/errorLine" });
  });
});

describe("describeCommand", () => {
  const leaf = withContract(
    defineCommand({
      meta: { name: "probe", description: "A probe", alias: ["p"] },
      args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
      run: () => undefined,
    }),
    {
      output: "document",
      schemaVersion: 1,
      payload: z.object({ command: z.literal("probe").describe('`"probe"`.') }).describe("A probe."),
      mutates: false,
      idempotent: true,
      needsNetwork: false,
    },
  );

  test("publishes the payload's JSON Schema open, so an added key breaks no validator", async () => {
    const described = await describeCommand({ path: ["probe"], cmd: leaf as CommandDef });
    expect(described.payload).toMatchObject({ type: "object", properties: { command: { const: "probe" } } });
    expect(described.payload).not.toHaveProperty("additionalProperties", false);
  });

  /** A caller learns which version of the shape to expect before it runs anything (#697). */
  test("publishes the payload's schemaVersion, and the payload's JSON Schema names it", async () => {
    const described = await describeCommand({ path: ["probe"], cmd: leaf as CommandDef });
    expect(described.schemaVersion).toBe(1);
    expect(described.payload).toMatchObject({
      properties: { schemaVersion: { const: 1 } },
      required: expect.arrayContaining(["command", "schemaVersion"]),
    });
    expect(described.events).toBeNull();
  });

  test("publishes the --events record beside the payload, at the same version", async () => {
    const streaming = withContract(defineCommand({ meta: { name: "long" }, run: () => undefined }), {
      output: "document",
      schemaVersion: 2,
      payload: z.object({ command: z.literal("long").describe('`"long"`.') }).describe("Done."),
      events: z.object({ event: z.literal("start").describe("Start.") }).describe("A record."),
      mutates: true,
      idempotent: true,
      needsNetwork: false,
    });
    const described = await describeCommand({ path: ["long"], cmd: streaming as CommandDef });
    expect(described.events).toMatchObject({ properties: { event: { const: "start" }, schemaVersion: { const: 2 } } });
  });

  test("names a command's own aliases", async () => {
    expect((await describeCommand({ path: ["probe"], cmd: leaf as CommandDef })).aliases).toEqual(["p"]);
  });

  test("a command with no contract is a group: it runs nothing, writes nothing and changes nothing", async () => {
    const group = defineCommand({ meta: { name: "group" }, subCommands: { probe: leaf } });
    expect(await describeCommand({ path: ["group"], cmd: group })).toMatchObject({
      runs: false,
      subcommands: ["group probe"],
      output: "none",
      payload: null,
      schemaVersion: null,
      events: null,
      mutates: false,
      idempotent: true,
      needsNetwork: false,
    });
  });

  test("walks every spelling citty accepts for a subcommand: a value, a promise and a thunk", async () => {
    const root = defineCommand({
      meta: { name: "root" },
      subCommands: async () => ({ a: leaf, b: Promise.resolve(leaf), c: () => leaf }),
    });
    expect((await walkTree(root)).map((node) => node.path.join(" "))).toEqual(["a", "b", "c"]);
  });
});

describe("globalFlags", () => {
  test("every spelling bin.ts answers before citty is published exactly once", () => {
    const spellings = globalFlags().flatMap((flag) => [flag.name, ...flag.aliases]);
    expect(spellings.sort()).toEqual([...GLOBAL_FLAGS].sort());
  });

  test("the hidden pair is published and marked, everything else is not hidden", () => {
    const hidden = globalFlags()
      .filter((flag) => flag.hidden)
      .map((flag) => flag.name);
    expect(hidden.sort()).toEqual(["--pithier", "--pithiest"]);
    for (const flag of globalFlags()) expect(flag.description).not.toBe("");
  });
});

describe("exitCodes", () => {
  test("success, every class in order of its code, then an interrupt and a broken pipe", () => {
    const codes = exitCodes();
    expect(codes.map((row) => row.exit)).toEqual([EXIT.ok, 1, 2, 3, 4, 5, EXIT.interrupted, EXIT.brokenPipe]);
    for (const exitClass of ExitClass.options) {
      expect(codes.find((row) => row.exitClass === exitClass)).toEqual({ exitClass, ...EXIT_CLASSES[exitClass] });
    }
  });
});

/**
 * **`docs/CLI.md` §3.8 says what `pithy schema` says, 0 and 130 included.** The class rows are pinned by
 * `exitClass.test.ts`; the two bookends are composed here, and the `AGENTS.md` block renders these same
 * rows, so a page that told a script one thing about an interrupt and the binary another would be caught.
 */
test("docs/CLI.md §3.8 states exactly the rows exitCodes publishes, in order", () => {
  const page = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "docs", "CLI.md"), "utf8");
  const start = page.indexOf("### 3.8 Exit codes");
  const section = page.slice(start, page.indexOf("\n## ", start));
  const published = exitCodes().map((row) => {
    const exitClass = row.exitClass === null ? "—" : `\`${row.exitClass}\``;
    return `| \`${row.exit}\` | ${exitClass} | ${row.meaning} | ${row.agentShould} |`;
  });
  const stated = section.split("\n").filter((line) => /^\| `\d+` \|/.test(line));
  expect(stated.length).toBeGreaterThan(6);
  expect(stated).toEqual(published);
});

describe("errorCodes", () => {
  test("every kit code, once, sorted, with its status", () => {
    const rows = errorCodes();
    expect(rows.map((row) => row.code)).toEqual(
      KitErrorPayload.options.map((member) => member.shape.code.value).sort((a, b) => a.localeCompare(b)),
    );
  });
});
