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
   * **The second half of the same rule: an `account` that may be *omitted* (#226, #230).**
   *
   * The table above holds every deliberate `null` to a written reason, and it was believed to be the
   * whole gate. It is not, because it can only see a value. Four call sites — `pithy env`, `pithy
   * migrate`, `pithy deploy`'s pending count, and the roster commands' seed driver — passed it while
   * naming no account at all, because the parameter they were omitting was declared `account?:`.
   *
   * An omission and a deliberate `null` are the same bytes at the call site: nothing. So the compiler
   * says nothing, this gate saw nothing, and a reviewer had nothing to look at. That is precisely what
   * #206 argued a *required* argument removes — and `account?: T | null` puts it back, with the added
   * cruelty that the type reads as though it had been thought about.
   *
   * So an optional declaration is itself the reviewable act now. The table below is the complete set
   * still in shipped source; the test holds it to both halves, exactly as the one above does, so a new
   * one cannot appear quietly and a fixed one cannot be left listed.
   *
   * Every entry is **debt, not a design**. The reason each carries is what it would cost to make it
   * required, which is the only honest thing to write when the answer is "not in this change".
   *
   * **It is empty, and that is the finished state (#234).** All six declarations #226's audit found are
   * required now, and the two seams that carried no account at all — `SeedProjectOptions` and
   * `dashboard/registry.ts`'s `OpenDriver` — carry one. An empty table is not a table with nothing left
   * to say: it is the assertion that *nowhere in shipped source* can a credential-resolving parameter be
   * omitted, kept by the walk below rather than by anybody's memory. The next optional account fails
   * this test on the commit that writes it, and the only way past is a line here with a reason on it.
   */
  const OPTIONAL_ACCOUNT_OWED: Record<string, string> = {};

  /**
   * An optional `account` property, or one defaulted to `null` in a parameter list. Both are omissions
   * the compiler permits; a default is the sneakier of the two, because the `null` is written down at
   * the declaration and so reads like a claim somebody made at the call site.
   */
  const OPTIONAL_ACCOUNT =
    /account\?:\s*CloudflareAccountSelection|account:\s*CloudflareAccountSelection[^,;=]*=\s*null/;

  test("every optional account is declared, and every declaration is still optional", () => {
    const found = new Set<string>();
    for (const path of walked) {
      const source = readSource(path);
      if (source === null) continue;
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      if (OPTIONAL_ACCOUNT.test(code)) found.add(named(path));
    }
    expect({
      undeclared: [...found].filter((path) => !(path in OPTIONAL_ACCOUNT_OWED)).sort(),
      stale: Object.keys(OPTIONAL_ACCOUNT_OWED)
        .filter((path) => !found.has(path))
        .sort(),
    }).toEqual({ undeclared: [], stale: [] });
  });

  /**
   * **Every declaration the audit found, pinned by name.**
   *
   * The walk above cannot see this, and that is the gap this closes. It fails on an account that is
   * *optional*; a declaration deleted outright, or renamed, or moved behind a different type, leaves it
   * with nothing to find and nothing to say — the quietest possible revert. So each module that reached
   * required is named here with the shape it reached, and the two assertions are opposite halves: the
   * required form is present, and no optional form is.
   *
   * `envInventory.ts` is the one #226 fixed — `pithy env` *prints* an account id and builds every
   * dashboard link out of it, so an inventory resolved against the default file labels this project's
   * bindings with another company's account and links there. The other five are #234's, and the two at
   * the end are seams that carried no account **at all** until it, which is why plumbing had to come
   * before threading: `seed/run.ts` could not pass one to a driver that had just started requiring it.
   */
  const REQUIRED_ACCOUNT = [
    "project/envInventory.ts",
    "migrations/run.ts",
    "seed/drivers.ts",
    "capabilities/addBootstrap.ts",
    "doctor/projectName.ts",
    "seed/run.ts",
    "dashboard/registry.ts",
  ];

  test.each(REQUIRED_ACCOUNT)("%s takes a required account", (relativePath) => {
    const source = readSource(resolve(PACKAGES, "cli", "src", relativePath)) ?? "";
    expect({ file: relativePath, declares: /account:\s*CloudflareAccountSelection\s*\|\s*null/.test(source) }).toEqual({
      file: relativePath,
      declares: true,
    });
    expect({ file: relativePath, optional: OPTIONAL_ACCOUNT.test(source) }).toEqual({
      file: relativePath,
      optional: false,
    });
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
