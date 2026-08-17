// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCommand } from "citty";
import { describe, expect, test } from "vitest";
import { ownNamesOnly } from "../dispatch";
import { main } from "../main";
import { HELP_GROUP_ORDER } from "./groups";
import { renderRootUsage } from "./rootUsage";

/**
 * The root screen's branches, at the level the byte-for-byte pin cannot reach.
 *
 * `binDocs.test.ts` spawns the real bin and compares the whole screen to `docs/CLI.md` §4.1, which is the
 * assertion that matters and the one an author reads. It can only exercise what the real tree declares,
 * and the real tree declares no hidden command and no alias — so the two rules this renderer inherits
 * from citty are, in the pin's eyes, dead code. They are the rules that decide whether a command appears
 * on the screen at all, which makes "no test can see them" the wrong place for them to live.
 *
 * The layout assertions here are deliberately about the *rule* (the column is as wide as the widest
 * label, the gutter is four) rather than about the bytes. Restating the bytes would be a second pin that
 * disagrees with the first the day a description changes, and §4.1 is the one that governs.
 */

/** A small synthetic root, so a case can declare the thing `main.ts` does not. */
function tree(subCommands: Record<string, ReturnType<typeof defineCommand>>) {
  return defineCommand({
    meta: { name: "pithy", version: "9.9.9", description: "A backend kit for Cloudflare Workers." },
    subCommands,
  });
}

describe("the root help screen", () => {
  test("renders every group in order, each under its heading", async () => {
    const rendered = await renderRootUsage(ownNamesOnly(main));
    const headings: readonly string[] = HELP_GROUP_ORDER;
    const positions = headings.map((title) => rendered.indexOf(`\n  ${title}\n`));
    for (const [index, position] of positions.entries()) {
      expect(position, `${headings[index]} is missing its heading line`).toBeGreaterThan(-1);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("the USAGE line names no command, because the alternation was never information", async () => {
    const rendered = await renderRootUsage(ownNamesOnly(main));
    expect(rendered).toContain("USAGE pithy <command> [OPTIONS]");
    // The whole defect: twenty-six names before a single description.
    expect(rendered).not.toContain("init|add");
  });

  test("every command the tree declares reaches the screen", async () => {
    const rendered = await renderRootUsage(ownNamesOnly(main));
    const declared = Object.keys((await main.subCommands) as Record<string, unknown>);
    for (const name of declared)
      expect(rendered, `${name} is not on the screen`).toMatch(new RegExp(`\\s${name}\\s{4}`));
  });

  test("the name column is as wide as the widest label, right-aligned, with a four-space gutter", async () => {
    const rendered = await renderRootUsage(ownNamesOnly(main));
    const rows = rendered.split("\n").filter((line) => /^ {2,}\S+ {4}\S/.test(line));
    const widest = Math.max(...rows.map((row) => row.trimStart().split(" ")[0]?.length ?? 0));
    for (const row of rows) {
      const label = row.trimStart().split(" ")[0] ?? "";
      // Two of indent plus the padded column, so every description starts in the same place.
      expect(row.indexOf(label), row).toBe(2 + widest - label.length);
      expect(row.slice(row.indexOf(label) + label.length, row.indexOf(label) + label.length + 4)).toBe("    ");
    }
  });

  test("a hidden command is on neither the screen nor any group", async () => {
    const rendered = await renderRootUsage(
      tree({
        init: defineCommand({ meta: { name: "init", description: "Scaffold a new project" }, run: () => {} }),
        skulk: defineCommand({ meta: { name: "skulk", description: "Not for you", hidden: true }, run: () => {} }),
      }),
    );
    expect(rendered).toContain("init");
    expect(rendered).not.toContain("skulk");
    expect(rendered).not.toContain("Not for you");
  });

  test("an alias renders beside its command, citty's way", async () => {
    const rendered = await renderRootUsage(
      tree({
        remove: defineCommand({
          meta: { name: "remove", description: "Remove a capability", alias: "rm" },
          run: () => {},
        }),
      }),
    );
    expect(rendered).toContain("remove, rm");
  });

  // There is deliberately no case for "a command no group claims". `main.ts` declares one record with a
  // required `group`, so that state is a compile error rather than a screen this renderer has to cope
  // with — see `groups.ts`. A test for it would have to construct something the type system forbids.

  test("the header carries the description and version, and the closing pointer is kept", async () => {
    const rendered = await renderRootUsage(tree({}));
    expect(rendered.split("\n")[0]).toBe("A backend kit for Cloudflare Workers. (pithy v9.9.9)");
    expect(rendered).toContain("Use pithy <command> --help for more information about a command.");
  });

  test("the layout does not read the terminal, so the pin means the same thing on every machine", async () => {
    // `binDocs.test.ts` compares this screen to a document byte for byte. A width-aware renderer would
    // pass on the author's terminal and flake in CI, which is the one failure a pin cannot survive.
    const rendered = await renderRootUsage(ownNamesOnly(main));
    // Save and restore the real descriptor. `defineProperty` with a bare `value` defaults `writable` to
    // false, so fabricating one to "restore" would leave `process.stdout.columns` read-only for the rest
    // of the worker — and `tty.WriteStream._refreshSize()` assigns it on SIGWINCH.
    const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    try {
      Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true, writable: true });
      expect(await renderRootUsage(ownNamesOnly(main))).toBe(rendered);
    } finally {
      if (original === undefined) delete (process.stdout as { columns?: number }).columns;
      else Object.defineProperty(process.stdout, "columns", original);
    }
  });
});
