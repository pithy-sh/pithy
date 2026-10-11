// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type CommandDef, defineCommand, renderUsage } from "citty";
import { describe, expect, test } from "vitest";
import { withContract } from "../contract/commandContract";
import { main } from "../main";
import { renderCommandUsage } from "./commandUsage";

/**
 * **`--help` marks a positional that takes many words the way the page's synopsis does (#697).** citty prints
 * `pithy schema [COMMAND]`, which reads as one word, while `docs/commands/schema.md` says `[command…]` and
 * `pithy schema` publishes `variadic: true`. Three answers to one question is two too many.
 */

/** The real `pithy schema`. */
async function schemaCommand(): Promise<CommandDef> {
  return (await import("../commands/schema")).default as CommandDef;
}

describe("renderCommandUsage", () => {
  test("pithy schema --help names its command as many words, in the usage line and the arguments", async () => {
    const rendered = await renderCommandUsage(await schemaCommand(), main);
    expect(rendered).toContain("pithy schema [OPTIONS] [COMMAND…]");
    expect(rendered).toMatch(/\n {2}COMMAND… {4}/);
    expect(rendered).not.toContain("[COMMAND]");
  });

  test("a command with no variadic positional renders exactly as citty renders it", async () => {
    const plain = withContract(
      defineCommand({
        meta: { name: "probe", description: "A probe" },
        args: {
          name: { type: "positional", description: "One name" },
          json: { type: "boolean", default: false, description: "Machine-readable output" },
        },
        run: () => undefined,
      }),
      { output: "none", mutates: false, idempotent: true, needsNetwork: false },
    );
    const probe = plain as unknown as CommandDef;
    expect(await renderCommandUsage(probe, main)).toBe(await renderUsage(probe, main));
  });

  test("a required variadic positional is marked inside its angle brackets", async () => {
    const many = withContract(
      defineCommand({
        meta: { name: "probe", description: "A probe" },
        args: { words: { type: "positional", description: "Every word" } },
        run: () => undefined,
      }),
      { output: "none", mutates: false, idempotent: true, needsNetwork: false, flags: { words: { variadic: true } } },
    );
    expect(await renderCommandUsage(many as unknown as CommandDef, main)).toContain("pithy probe [OPTIONS] <WORDS…>");
  });

  test("the command it was handed is not changed: only the renderer sees the marked copy", async () => {
    const command = await schemaCommand();
    await renderCommandUsage(command, main);
    const args = typeof command.args === "function" ? await command.args() : await command.args;
    expect(Object.keys(args ?? {})).toContain("command");
    expect(Object.keys(args ?? {})).not.toContain("command…");
  });
});
