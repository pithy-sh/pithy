// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "../ci/sourceFiles";

/**
 * **Every resolution of Cloudflare credentials says which account it is for, and `null` is a claim.**
 *
 * `cloudflareEnv`, `resolveCloudflare`, `cloudflareConfigPath` and `writeCloudflareConfig` take the
 * account as a required argument, so *omitting* it is a type error and this gate has nothing to say
 * about it — the compiler already refuses. What the compiler cannot judge is the value: `account: null`
 * means "this project names no account", and it is also what somebody writes to make an error go away.
 *
 * That distinction is the whole of #206. The first shape of this change kept the account in a
 * process-wide holder that `loadProject` published into, and six call sites resolved credentials before
 * anything had published — `commands/token.ts`, `commands/deploy.ts`, `commands/add.ts`,
 * `project/deploy.ts`, `migrations/run.ts`, `seed/drivers.ts`, plus `project/askDomains.ts`. Every one of
 * them was silently correct on a single-account machine and silently wrong on any other, and the worst
 * was the pair handed to `wrangler deploy`: shipping to another company's tenant, exit 0, nothing said.
 *
 * Six is this repository's usual count for a rule living at call sites instead of at the thing being
 * called. The required argument moved the rule; this list is what keeps the *escape hatch* honest. A
 * seventh site cannot appear quietly, because the only two ways to write one are a type error and a line
 * in the table below.
 *
 * **A `null` inside a project-scoped command is almost always wrong.** Those have a `projectDir`, and
 * `projectCloudflareAccount(projectDir)` is the answer. The entries here are the genuine exceptions: a
 * command that runs before a project exists, one that sorts values that predate the whole idea, and the
 * tests' own fixtures — which is why tests are not walked.
 */
describe("a null account is a claim, and every claim is written down", () => {
  /** `packages/` — this file lives at `packages/cli/src/cloudflare/`. Asserted below, so a move fails loudly. */
  const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  /** A module's key in the table below: its path under `packages/`, in posix separators. */
  const named = (path: string): string => relative(PACKAGES, path).split(sep).join("/");

  /**
   * The deliberate "no account named here" answers: path → why `null` is the truth at that site and not
   * a shortcut past a `projectCloudflareAccount` call.
   *
   * An entry is a claim, and the test holds it to both halves — an undeclared `null` fails, and a
   * declared one that has since been fixed or moved fails too, so the list cannot go stale. Adding a
   * line is the reviewable act; that is the whole point of it.
   *
   * The question every `why` has to answer is the one the six sites failed: **is there a project here
   * whose account this could have asked for?** An answer of "no" is what makes `null` safe.
   */
  const NO_ACCOUNT_ON_PURPOSE: Record<string, string> = {
    "cli/src/adopt/adopt.ts":
      "`pithy adopt` moves credentials that predate the account-named file out of a checkout and into the unnamed one, and it runs in projects whose config may not load at all — sorting values is what it does *before* a project is in a fit state to be asked. Writing them into a named file would put an inherited `.dev.vars` token under a nickname nobody chose.",
    "cli/src/doctor/devVars.ts":
      "One sentence in the `Dev secrets:` block, about the *root* `.dev.vars` — a file that predates all of this and is not account-scoped. It names where those keys belong now, which is the unnamed file; a project that has since named an account is told by the `Cloudflare:` line instead.",
    "cli/src/commands/init.ts":
      "`init` resolves credentials before the project it is scaffolding exists, which is the one moment in the CLI where there is provably no account to ask for. It writes the named file itself, at the end, from what the token's own account listing answered.",
  };

  test("this file still sits where the paths above are relative to", () => {
    expect(named(fileURLToPath(import.meta.url))).toBe("cli/src/cloudflare/accountArgument.test.ts");
  });

  /**
   * Shipped source only. A test's `account: null` is a fixture describing a machine with one account,
   * which is the ordinary case and the thing most of these suites are about.
   */
  const walked = sourcePaths(resolve(PACKAGES, "cli", "src"));

  test("walks a tree big enough for the answer to mean something", () => {
    expect(walked.length).toBeGreaterThan(100);
  });

  test("every `account: null` in shipped source is declared, and every declaration is still real", () => {
    const found = new Set<string>();
    for (const path of walked) {
      const source = readSource(path);
      if (source === null) continue;
      // Comments stripped first, so prose *about* the rule never passes for a use of it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      if (/account:\s*null/.test(code)) found.add(named(path));
    }
    expect({
      undeclared: [...found].filter((path) => !(path in NO_ACCOUNT_ON_PURPOSE)).sort(),
      stale: Object.keys(NO_ACCOUNT_ON_PURPOSE)
        .filter((path) => !found.has(path))
        .sort(),
    }).toEqual({ undeclared: [], stale: [] });
  });

  /**
   * The six that started it, by name. Not a rule — a record, so the next person reading the required
   * argument and wondering whether it earns its keep has the list rather than the assertion.
   */
  test("the sites the ambient got wrong all resolve for an account now", () => {
    const REGRESSED = [
      "commands/token.ts",
      "commands/deploy.ts",
      "commands/add.ts",
      "project/deploy.ts",
      "migrations/run.ts",
      "seed/drivers.ts",
      "project/askDomains.ts",
    ];
    for (const relativePath of REGRESSED) {
      const source = readSource(resolve(PACKAGES, "cli", "src", relativePath));
      expect(source, relativePath).not.toBeNull();
      const code = (source ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      // No bare resolution left: every one of these now names an account in the call.
      expect({ file: relativePath, bare: /cloudflareEnv\(\s*\)/.test(code) }).toEqual({
        file: relativePath,
        bare: false,
      });
    }
  });
});
