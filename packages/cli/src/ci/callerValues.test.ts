// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import {
  type Command,
  callerOf,
  personDecision,
  pithyCommand,
  pithyCommandOf,
  remedy,
  rerunCommand,
  rerunRemedy,
  workerDirOf,
} from "@pithy-sh/core/src/cli/command";
import { describe, expect, test } from "vitest";
import { addAgain, addCallerOf, addPlan } from "../capabilities/addCommand";
import { addRunCaller } from "../capabilities/flow";
import { kitAddFacts } from "../capabilities/kitAddFacts";
import { prerequisiteRequired } from "../capabilities/prerequisites";
import { capabilityProvisionRemedies, remediesSentence } from "../capabilities/provisionCommand";
import { fixOf } from "../terminal/exitClass";

/**
 * **A builder reached at run time never throws because of data (#711).**
 *
 * `pithy add email --worker api --set 'fromName=Acme <hi@acme.io>'` is a valid run, and the builder that named it
 * again read `<hi@acme.io>` as a placeholder and turned the add into `core/internal` after it had installed the
 * package. Cycle 1 fixed the production `--env` that did the same in `vector` and `testers`; the class came back
 * through a different value. So this drives every builder entry point a run reaches with values a caller can
 * supply — a placeholder's shape, quotes, a command substitution, backticks, a newline, nothing but whitespace,
 * unicode, a production environment — and holds two things of each:
 *
 * - **it does not throw**, whatever the value; and
 * - **the value comes back exact**: each command it names, split by a real POSIX shell, carries the caller's value
 *   as one word, character for character. Quoting that is safe but lossy fails here as surely as a throw.
 */

/** What a caller can hand a run: every shape a builder once read as something other than a value. */
const VALUES = [
  "<x>",
  "<hi@acme.io>",
  "Acme <hi@acme.io>",
  `it's "quoted"`,
  "$(rm -rf ~)",
  "`id`",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a parameter expansion a caller can pass, kept literal on purpose.
  "${HOME}",
  "line one\nline two",
  "   ",
  "\t",
  "ünïcødé ✓ 名前",
  "prod",
  "production",
  "a=b=c",
  "*",
  "~",
  "--json",
] as const;

/** The project's own production environments, beside the ones every project has. */
const PRODUCTION = ["live"];

const api = workerDirOf({ dir: "/project/apps/api" });

/** The words a POSIX shell splits `line` into: the shell itself, never a model of one. */
function shellWords(line: string): string[] {
  const out = execFileSync("sh", ["-c", `set -- ${line}\nprintf '%s\\0' "$@"`], { encoding: "utf8" });
  return out.split("\0").slice(0, -1);
}

/** The command a person's-decision sentence names: between its first backtick and the last before what it does. */
function decided(sentence: string): string {
  const named = /^`([\s\S]*)`(?: with its | deletes | runs against )/.exec(sentence);
  if (named?.[1] === undefined) throw new Error(`No command in: ${sentence}`);
  return named[1];
}

/** The command a remedy names: its `fix`, or the one its person's-decision sentence names. */
function lineOf(one: { fix: Command | undefined; say: (wrap: (command: string) => string) => string }): string {
  return one.fix ?? decided(one.say((command) => command));
}

/** `line`, split by the shell, carries `word` as one word — and every word it carries is one the line was built from. */
function carries(line: string, word: string): void {
  const words = shellWords(line);
  expect(words[0]).toBe("pithy");
  expect(words, line).toContain(word);
}

describe.each(VALUES.map((value) => [JSON.stringify(value), value] as const))("a caller's %s", (_label, value) => {
  test("pithyCommand and pithyCommandOf take it as an argument or a flag's value", () => {
    carries(pithyCommand("secrets update", { args: [value] }), value);
    carries(pithyCommand("testers run", { flags: { "--cohort": value, "--env": "staging" } }), value);
    carries(
      pithyCommandOf("add", { args: ["email"], flags: { "--worker": api, "--set": [`fromName=${value}`] } }),
      `fromName=${value}`,
    );
    carries(pithyCommandOf("secrets update", { args: [value] }), value);
  });

  test("pithyCommandOf at run time, as a deployed Worker builds its line", () => {
    carries(
      pithyCommandOf("add", { args: [value], flags: { "--with-prerequisites": true } }, { runtime: true }),
      value,
    );
  });

  test("remedy, as a command or as a person's decision, by its environment", () => {
    for (const options of [{}, { runtime: true }, { productionEnvironments: PRODUCTION }]) {
      carries(lineOf(remedy("vector provision", { flags: { "--env": value, "--worker": api } }, options)), value);
    }
    carries(remedy("secrets update", { args: [value], flags: { "--env": value } }).fix as Command, value);
  });

  test("personDecision", () => {
    carries(decided(personDecision("secrets rm", { args: [value], flags: { "--env": value } })), value);
    carries(decided(personDecision("vector reset", { flags: { "--worker": api, "--env": value } })), value);
  });

  test("rerunCommand and rerunRemedy, from the run's own arguments", () => {
    carries(rerunCommand(callerOf("add", { set: [`k=${value}`], worker: value }), { args: [value] }), `k=${value}`);
    carries(rerunCommand(callerOf("secrets update", { env: value }), { args: [value] }), value);
    const given = { "routing-zone": value, "inbound-address": value, "app-worker": value, json: true };
    carries(rerunRemedy(callerOf("email provision", given), { flags: { "--worker": api } }).fix as Command, value);
    for (const env of [value, "prod", "live"]) {
      const rerun = rerunRemedy(callerOf("testers provision", { env, json: true }), {
        flags: { "--worker": api },
        productionEnvironments: PRODUCTION,
      });
      carries(lineOf(rerun), env);
    }
  });

  test("addPlan, addAgain and addRunCaller carry it as the caller's --set", () => {
    const caller = addCallerOf({ capability: "email", setFlags: [`fromName=${value}`], dryRun: true, json: true }, []);
    const plan = addPlan({ capability: "email", workers: [api], factsFor: kitAddFacts, caller });
    expect(plan.commands.length).toBeGreaterThan(0);
    for (const command of plan.commands) carries(command, `fromName=${value}`);
    const again = addAgain(caller, { workerDir: "/nowhere/apps/api" });
    carries(again.slice(1, -1), `fromName=${value}`);
    const rerun = addAgain(
      addRunCaller({
        capability: "email",
        projectDir: "/nowhere",
        workerDir: "/nowhere/apps/api",
        setFlags: [`fromName=${value}`],
      }),
      { workerDir: "/nowhere/apps/api", projectDir: "/nowhere" },
    );
    carries(rerun.slice(1, -1), `fromName=${value}`);
  });

  test("prerequisiteRequired names the add, and its fix carries the value", () => {
    const error = prerequisiteRequired({
      capability: "auth",
      worker: api,
      missing: ["secrets", "email"],
      factsFor: kitAddFacts,
      composed: new Set(),
      caller: addCallerOf({ capability: "auth", setFlags: [`fromName=${value}`], json: true }, []),
    });
    carries(fixOf(error) as Command, `fromName=${value}`);
  });

  test("the provision remedies, for every environment a Worker declares", () => {
    const envs = [value, "staging", "prod", "live"];
    const remedies = capabilityProvisionRemedies("vector", api, envs, PRODUCTION);
    const named = remedies.map((one) => {
      const words = shellWords(lineOf(one));
      return words[words.indexOf("--env") + 1];
    });
    expect(named).toEqual(envs);
    expect(remediesSentence(remedies)).toContain("a person's decision");
  });
});
