// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";

/**
 * **One rule, one expression of it.**
 *
 * Six capability provisioning commands each carried their own copy of the same closure — read the app
 * `wrangler.jsonc`, find the `DB` binding for this environment, throw when it has no `database_id`. Six
 * copies of one rule is how a rule drifts, and this repository has spent several issues removing exactly
 * that shape. They are one call to `environmentReadiness` now, and an environment with no app database is
 * skipped and reported rather than failing the run part way through (pithy-sh/pithy#512).
 *
 * This is the gate that keeps it one. It is a source scan, in the spirit of `capabilityVersions.test.ts`
 * and `compatibilityDates.test.ts`, because the property is only true as a *set*: a seventh command
 * hand-rolling the check would pass every behavioral test in the tree and still be the defect coming back.
 *
 * ## What a source scan may and may not stand in for
 *
 * **It may not stand in for behavior, and it did.** The exit-code rule — requirement 4, a run in which
 * every environment was skipped exits non-zero — was pinned here as
 * `expect(source).toContain("requireReadyEnvironments(")`, and that assertion survives deleting the actual
 * exit: the `--json` call site alone satisfies the scan, and so would a call in a comment. A check that
 * cannot fail is worse than none, because it also certifies what it missed. The rule now lives in
 * `commands/environmentSkipExit.test.ts`, which drives each real command against a real unprovisioned
 * `wrangler.jsonc` and asserts the code it exits with and the lines it printed.
 *
 * **And it must close over the directory, not over a list.** Every scan below enumerates
 * `packages/cli/src/commands` and derives its subject from what is there, so the seventh copy of the
 * pattern — the thing this file's own docstring says it exists to catch — is visible to it: a command that
 * consults the readiness helper is enrolled in the whole set of rules by that import alone, and a command
 * that hand-rolls the `DB` check anywhere in the directory fails unless it is declared as deliberately
 * single-environment.
 */

/** `packages/cli/src/ci` → `packages/cli/src`. */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `packages/cli/src/commands` — every scan below is over what is in here, never over a remembered list. */
const COMMANDS = join(SRC, "commands");

/**
 * The commands that fan a capability's provisioning out across a project's environments.
 *
 * Declared, and then held against the directory by the first test — the declaration is what the other
 * cases read, and the directory is what decides whether it is still complete.
 *
 * `testers` is here too, and its `--env` flag does not exempt it: the flag says which environments the
 * operator meant, readiness says which of those can be acted on, and they are different questions.
 */
const FAN_OUT_COMMANDS = ["email", "media", "payments", "storage", "support", "testers"] as const;

/**
 * The commands that read a `DB` binding and are deliberately **not** in the set above.
 *
 * `vector` takes a required environment argument on every subcommand, so nothing about it spans; its
 * refusal has one environment to be about and is correct as a refusal.
 *
 * **The skip is what it is out of, not the routing.** That distinction was lost the first time this
 * constant was written: `vector` was excused from the resolved-Worker rule as well, and it read the root
 * `wrangler.jsonc` in three places — the database id, the `VECTOR_PROVISIONED` record, and the `vectorize`
 * and `workflows` bindings — so every one of its subcommands died on a raw `ENOENT` in every scaffolded
 * project. The root-file rule below is quantified over the whole directory for exactly that reason: an
 * exclusion from one rule must not become an exclusion from another nobody re-read.
 */
const SINGLE_ENVIRONMENT_COMMANDS = ["vector"] as const;

/**
 * Every spelling that reaches a `wrangler.jsonc` **at the project root**, and the one an author would
 * recognize in a failure message.
 *
 * The rule is one sentence — *no command reads a root `wrangler.jsonc`* — and there is no root file to
 * read: every deployable Worker lives in `apps/<name>/` with its own config (CLAUDE.md §CLI), and
 * `project/scaffold.test.ts` asserts the root file's absence by name. A command that reaches for one is
 * not merely reading the wrong file; it is reading a file that does not exist, so it fails before it does
 * anything else. Five commands shipped that way (#512).
 */
const ROOT_WRANGLER_SPELLINGS: { pattern: RegExp; what: string }[] = [
  { pattern: /projectDir,\s*"wrangler\.jsonc"/, what: 'join(projectDir, "wrangler.jsonc")' },
  { pattern: /Wrangler(?:Config|MainModule)\(\s*projectDir\b/, what: "a wrangler-config helper on projectDir" },
  { pattern: /applyAppBindings\(\s*projectDir\b/, what: "applyAppBindings(projectDir, …)" },
  { pattern: /workerDir:\s*projectDir\b/, what: "workerDir: projectDir" },
];

/** Every command module the CLI ships, by name — the population every rule here is quantified over. */
async function commandNames(): Promise<string[]> {
  const entries = await readdir(COMMANDS);
  return entries
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => file.replace(/\.ts$/, ""))
    .sort();
}

async function source(command: string): Promise<string> {
  return readFile(join(COMMANDS, `${command}.ts`), "utf8");
}

/**
 * A command's source with its comments blanked — what the module actually *does*.
 *
 * The root-file rule needs it, because that rule is a **negative**: a docstring explaining the defect
 * (`vector.ts` carries one, naming the exact spelling it used to have) would fail a scan that reads prose,
 * and a gate that fires on correct writing is a gate somebody switches off, taking the real assertions with
 * it. `blankComments` rather than a `replace` of ours — `ci/commentStripping.test.ts` is the gate that says
 * no scan in this repository writes its own, and the two measured false negatives are in its docblock.
 *
 * The positive rules above deliberately keep reading raw source: for those a comment is a false *pass*
 * rather than a false failure, and this file's own docstring says why that is the direction that matters.
 */
async function code(command: string): Promise<string> {
  return blankComments(await source(command));
}

/** Every command whose source matches a predicate — the directory, filtered, never a list. */
async function commandsWhere(matches: (text: string) => boolean): Promise<string[]> {
  const names = await commandNames();
  const hits: string[] = [];
  for (const name of names) if (matches(await source(name))) hits.push(name);
  return hits;
}

describe("capability provisioning skips an environment rather than failing the run", () => {
  /**
   * The gate that closes over the directory rather than over `FAN_OUT_COMMANDS`. A seventh command that
   * consults readiness is enrolled here by that import, which fails this case until it is declared — and
   * declaring it enrolls it in every rule below, and in the behavioral exit-code file, which reads the same
   * directory the same way.
   */
  test("the fan-out set is exactly the commands that consult the shared helper", async () => {
    const consulting = await commandsWhere((text) => text.includes('from "../project/environmentReadiness"'));

    expect(consulting).toEqual([...FAN_OUT_COMMANDS].sort());
  });

  /**
   * The whole check, in one grep, over the whole directory: whoever writes this line again has written the
   * seventh copy — in any command, not only in the six that once carried it.
   */
  test("no command hand-rolls a DB-binding check outside the single-environment set", async () => {
    const handRolled = await commandsWhere((text) => text.includes('binding === "DB"'));

    expect(handRolled).toEqual([...SINGLE_ENVIRONMENT_COMMANDS].sort());
  });

  /**
   * **No command reads a root `wrangler.jsonc` — the whole directory, not the fan-out six.**
   *
   * There is no root Worker: every deployable Worker lives in `apps/<name>/` with its own config, and
   * `project/scaffold.test.ts` asserts the root file's absence by name (CLAUDE.md §CLI). Four of the six —
   * `media`, `payments`, `storage`, `testers` — passed `workerDir: projectDir` and read a file no project
   * has, so each died before reaching the partition, the skip, the report or the exit code. #512 claimed six
   * commands and delivered two, and the behavioral file did not notice because its fixture wrote the root
   * file the broken commands were looking for.
   *
   * The first version of this case was `test.each(FAN_OUT_COMMANDS)`, and quantifying it over the six is
   * what let the fifth command keep the defect: `vector` was excused from the *skip* — correctly, it takes
   * a required `--env` — and the exclusion was read as excusing it from the *routing* too, so it went on
   * reading the root file in three places and dying on a raw `ENOENT` in every scaffolded project. A rule
   * that holds of the whole directory is a rule no exclusion from a different rule can slip through.
   *
   * A source scan as well as `commands/environmentSkipExit.test.ts`, for the reason this whole file exists:
   * the property is only true as a *set*, and the next command to reach for a root file is caught by being
   * in the directory rather than by anyone remembering to enroll it.
   */
  test("no command reads a wrangler.jsonc at the project root", async () => {
    const offenders: string[] = [];
    for (const command of await commandNames()) {
      const text = await code(command);
      for (const { pattern, what } of ROOT_WRANGLER_SPELLINGS) {
        if (pattern.test(text)) offenders.push(`${command}: ${what}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The positive half, for the commands that partition environments: the directory readiness is read from
   * comes off a resolved Worker.
   */
  test.each(FAN_OUT_COMMANDS)("%s reads readiness from a resolved worker", async (command) => {
    const text = await source(command);

    expect(text).toContain("resolveSingleWorker(");
    expect(text).toContain("workerDir: appWorker.dir");
  });

  /**
   * The `--worker` flag is the other half of resolving one Worker: `resolveSingleWorker` refuses a project
   * with several and no name, and a refusal an operator cannot answer is a dead end.
   *
   * Over every command that resolves one, which is the six **and** `vector` — the flag is not about
   * fanning out, it is about there being no root Worker to fall back on.
   */
  test("every command that resolves a single worker exposes --worker", async () => {
    const resolving = await commandsWhere((text) => blankComments(text).includes("resolveSingleWorker("));
    expect(resolving).toEqual(expect.arrayContaining([...FAN_OUT_COMMANDS, ...SINGLE_ENVIRONMENT_COMMANDS]));

    const unanswerable: string[] = [];
    for (const command of resolving) {
      if (!/\n\s{4}worker: \{/.test(await source(command))) unanswerable.push(command);
    }

    expect(unanswerable).toEqual([]);
  });

  test.each(FAN_OUT_COMMANDS)("%s reports per environment, not one aggregate count", async (command) => {
    // A report that cannot tell *deployed* from *skipped* cannot answer "did production get its worker".
    expect(await source(command)).toContain("formatEnvironmentOutcomes(");
    expect(await source(command)).toContain("skippedEnvironments: readiness.skipped");
  });

  test.each(SINGLE_ENVIRONMENT_COMMANDS)("%s is outside the rule, and stays a refusal", async (command) => {
    const text = await source(command);
    expect(text).toContain('binding === "DB"');
    expect(text).not.toContain('from "../project/environmentReadiness"');
  });

  /**
   * `pithy secrets provision` spans every declared environment and must keep doing so — it *creates* each
   * one's database rather than reading one, and it is step 1 of any bring-up. The behavioral pin lives in
   * `packages/secrets/src/provision/provisionSecrets.test.ts`; this is the source-level half of it.
   *
   * Kept as its own case even though the first test would also catch it, because the two say different
   * things: that one says the set is complete, and this one says *this* command is deliberately out of it.
   */
  test("secrets provisioning is not swept in", async () => {
    const text = await source("secrets");
    expect(text).not.toContain('from "../project/environmentReadiness"');
  });
});
