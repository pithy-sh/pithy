// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The audit **destination** env is not the env a command **acted on**, and neither may be mistaken for
 * the other.
 *
 * `CreateCliAuditOptions.env` selects which database a row is written to. Eight commands hardcode it to
 * `dev` precisely *because* they span environments — a provisioning run touches every managed
 * environment at once, and `pithy feature` deliberately writes to the project's durable database rather
 * than the feature's, which does not exist yet at `provision` and is deleted by `destroy`.
 *
 * Recording that routing choice as the environment acted on is not a missing value, it is a false one:
 * `pithy storage provision` would write the production R2 credential and record `environment = "dev"`,
 * so an operator asking who changed production would get no rows and the row that exists would blame
 * dev. That is exactly what shipped in an earlier draft of this change, and what these tests exist to
 * stop coming back.
 *
 * So: a command whose `env` is a destination must not pass `actedOn`. It states the environment on each
 * event instead, where the real answer is known.
 */

const CLI_SRC = join(import.meta.dirname, "..");
const COMMANDS = join(CLI_SRC, "commands");

/** Every command source, by file name. */
function commandSources(): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(COMMANDS)) {
    const path = join(COMMANDS, entry);
    if (!entry.endsWith(".ts") || entry.includes(".test.") || statSync(path).isDirectory()) continue;
    found.set(entry, readFileSync(path, "utf8"));
  }
  return found;
}

/** The `createCliAudit({ … })` call bodies in one source, brace-balanced. */
function auditOptionBodies(source: string): string[] {
  const bodies: string[] = [];
  const opener = /createCliAudit\(\{/g;
  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    let depth = 1;
    let index = match.index + match[0].length;
    for (; index < source.length && depth > 0; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
    }
    if (depth === 0) bodies.push(source.slice(match.index + match[0].length, index - 1));
  }
  return bodies;
}

describe("the audit destination is never recorded as the environment acted on", () => {
  const sources = commandSources();

  it("finds the command sources and their audit wiring", () => {
    // Non-vacuity, both halves: a walk that matched no files, or a matcher that found no call, would
    // make the rule below pass forever.
    expect(sources.size).toBeGreaterThan(15);
    const wired = [...sources.values()].filter((source) => auditOptionBodies(source).length > 0);
    expect(wired.length).toBeGreaterThan(8);
  });

  it("no command passes a hardcoded destination env as `actedOn`", () => {
    const offenders: string[] = [];
    for (const [name, source] of sources) {
      for (const body of auditOptionBodies(source)) {
        const hardcoded = /\benv:\s*("[^"]*"|AUDIT_DESTINATION_ENV)/.exec(body);
        if (!hardcoded) continue;
        // A literal or a named destination constant means this command's `env` is routing, not truth.
        // Claiming it as `actedOn` is the regression; stating nothing is correct.
        if (/\bactedOn:/.test(body)) offenders.push(`${name}: actedOn beside a fixed env (${hardcoded[1]})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a command whose env is a real variable does declare what it acted on", () => {
    // The other direction, so the rule above cannot be satisfied by simply never recording an
    // environment. `deploy`, `secrets`, `token` and `dashboard` each take a real `--env`; that IS the
    // acted-on one. `dashboard` is the least ambiguous of the four: a connection is per environment, so
    // the `--env` that decides which row is written is the same one the row is about (#294).
    const declaring: string[] = [];
    for (const [name, source] of sources) {
      for (const body of auditOptionBodies(source)) {
        if (/\benv,/.test(body) && /\bactedOn: env,/.test(body)) declaring.push(name);
      }
    }
    expect(declaring.sort()).toEqual(["dashboard.ts", "deploy.ts", "secrets.ts", "token.ts"]);
  });
});
