// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { walkCommands } from "../docs/catalog";
import { main } from "../main";

/**
 * **Every command a doc tells the reader to run is a command that exists.**
 *
 * `docs/commands/payments.md` said `pithy secrets set payments-provider-credentials`, in two places, and
 * there is no `set` subcommand — the spellings are `create`, `update`, `rotate`, `rm`, `ls`, `edit`,
 * `provision`, `deprovision` (#503). That line is the documented path for every externally issued
 * credential in the product: Apple's `.p8`, Google's service-account key, Stripe's pair, Lemon Squeezy's
 * and Paddle's keys. A reader following it exactly gets an unknown-command error on the one step nothing
 * can do for them.
 *
 * The same class as #489, one surface over: an instruction naming a command that cannot be followed. That
 * one was action lines, checked by `actionLines.test.ts`; this is prose, and nothing was checking it. Docs
 * are part of the product (CLAUDE.md §Definition of done), so a command name in a doc is as much a claim
 * about the CLI as one in an error is.
 *
 * ## Why it reads code spans and not prose
 *
 * `docs/commands/secrets.md` writes "`pithy secrets` never invents a name". Scanning raw prose, `never`
 * follows a command that has subcommands and the check fails on correct writing — and a gate that fails on
 * correct behavior gets switched off, taking the real assertions with it. Inside a code span the same
 * sentence is just `pithy secrets`, with no second token to mistake. So spans are the unit: what a reader
 * copies is what is checked.
 */

/** The repository root, from this file's own location — the same anchor `actionLines.test.ts` uses. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Inline code spans and fenced-block lines — the parts of a doc a reader copies verbatim. */
function codeSpans(markdown: string): string[] {
  const spans: string[] = [];
  for (const match of markdown.matchAll(/`{1,3}([^`]+)`{1,3}/g)) {
    const text = match[1];
    if (text !== undefined) spans.push(...text.split("\n"));
  }
  return spans;
}

/**
 * Every `.md` under `docs/`, as `[relative path, contents]`.
 *
 * Node's own recursive listing rather than a traversal of ours — `ci/sourceFiles.ts` is the router for
 * source files and this wants markdown, and a seventh private walk is the thing four issues have been
 * spent removing.
 */
function docFiles(dir: string): [string, string][] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .map((name) => [name.split(sep).join("/"), readFileSync(join(dir, name), "utf8")]);
}

describe("commands named in docs", () => {
  test("every `pithy <command> <subcommand>` in a doc names a real subcommand", async () => {
    const commands = await walkCommands(main);
    const paths = new Set(commands.map((command) => command.path));
    // Only a command that *has* subcommands can be followed by a wrong one. `pithy add payments` is a
    // command and its argument, not a path, and asking `add` for a subcommand named `payments` would fail
    // on the most-written line in the docs.
    const parents = new Set(
      commands.filter((command) => command.path.includes(" ")).map((command) => command.path.split(" ")[0]),
    );

    const wrong: string[] = [];
    for (const [file, markdown] of docFiles(join(REPO_ROOT, "docs"))) {
      for (const span of codeSpans(markdown)) {
        for (const match of span.matchAll(/\bpithy ([a-z][a-z-]*) ([a-z][a-z-]*)/g)) {
          const [, parent, sub] = match;
          if (parent === undefined || sub === undefined) continue;
          if (!parents.has(parent)) continue;
          if (paths.has(`${parent} ${sub}`)) continue;
          wrong.push(`docs/${file}: pithy ${parent} ${sub}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  // The floor. A reader that found no commands, or no docs, reports every page clean — which is the one
  // result this test must never produce quietly. `secrets create` is asserted by name because it is the
  // spelling #503 was wrong about, so a walk that silently stopped returning subcommands fails here.
  test("the walk and the docs are both non-empty", async () => {
    const commands = await walkCommands(main);
    expect(commands.map((command) => command.path)).toContain("secrets create");
    expect(docFiles(join(REPO_ROOT, "docs")).length).toBeGreaterThan(10);
  });
});
