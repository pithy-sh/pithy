// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../main";
import { COMMAND_CATALOG_PATH, commandCatalogOf, renderCommandCatalog } from "./commandCatalog";
import { describeCli } from "./describe";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("commandCatalogOf", () => {
  const flag = { aliases: [], description: "", repeatable: false, required: false } as const;
  const cli = {
    globalFlags: [{ name: "--pretty", aliases: ["--no-pretty"], description: "", hidden: false }],
    commands: [
      {
        path: "secrets",
        runs: false,
        positionals: [],
        flags: [],
        flagGroups: [],
      },
      {
        path: "secrets rm",
        runs: true,
        positionals: [{ name: "name", required: true, variadic: false, description: "" }],
        flags: [
          { ...flag, name: "--env", type: "string" as const, default: "dev" },
          { ...flag, name: "--backend", type: "string" as const, enum: ["d1", "store"] },
          { ...flag, name: "--json", type: "boolean" as const, default: false },
        ],
        flagGroups: [{ kind: "atMostOne" as const, flags: ["--env", "--backend"], rule: "Not both." }],
      },
    ],
  } as unknown as Parameters<typeof commandCatalogOf>[0];

  test("keeps the commands that run, with what a builder checks, and lists the groups apart", () => {
    expect(commandCatalogOf(cli)).toEqual({
      commands: {
        "secrets rm": {
          positionals: [{ name: "name", required: true, variadic: false }],
          flags: {
            "--env": { type: "string", required: false, repeatable: false, default: "dev" },
            "--backend": { type: "string", required: false, repeatable: false, enum: ["d1", "store"] },
            "--json": { type: "boolean", required: false, repeatable: false },
          },
          groups: [{ kind: "atMostOne", flags: ["--env", "--backend"] }],
        },
      },
      globalFlags: ["--no-pretty", "--pretty"],
      groups: ["secrets"],
    });
  });

  test("renders a module core can import, typed as const", () => {
    const rendered = renderCommandCatalog(commandCatalogOf(cli));
    expect(rendered).toMatch(/^\/\/ SPDX-FileCopyrightText/);
    expect(rendered).toContain('export const COMMANDS = {\n  "secrets rm": {');
    expect(rendered).toContain("} as const;\n");
    expect(rendered).toContain('export const GROUPS = [\n  "secrets"\n] as const;');
  });
});

/**
 * **The committed catalog is the tree the CLI runs (#711).** The builder refuses a command by this file, so a file
 * behind the tree refuses a command that exists, and a file ahead of it builds one that does not.
 */
test("the committed command catalog is current: run `bun run command-catalog`", async () => {
  const expected = renderCommandCatalog(commandCatalogOf(await describeCli(main)));
  expect(readFileSync(join(REPO_ROOT, COMMAND_CATALOG_PATH), "utf8")).toBe(expected);
});
