// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **An `env.<name>` stanza is built by the one module that knows what an environment does not inherit.**
 *
 * A stanza inherits none of `vars`, `version_metadata` or their thirty-nine siblings from the top level of
 * a `wrangler.jsonc` — `project/wranglerInheritance.ts` states that list and gates it against wrangler's
 * own. So a stanza created empty and filled with one thing (ids, a route, a sitekey) is a Worker deployed
 * without every one of them, with no error and one warning in a stream nobody reads.
 *
 * #581 taught two writers that and missed the third. `provision/wranglerEnv.ts` created its stanza as
 * `config.env[key] ?? {}` and wrote ids into it, and because `env.feature` can never pre-exist in a tracked
 * config, **every feature deploy shipped a Worker with no `vars` at all** — no `ENVIRONMENT`, no `PROJECT`,
 * no `WORKER`, no `CF_VERSION_METADATA`. Four more modules had the same three lines. Six writers of one
 * thing is the defect, and a gate naming the six would be that defect with a list in front of it: the third
 * writer did not exist when #581 landed.
 *
 * So the rule is about the *class*, in two halves that have to hold together:
 *
 * 1. **The set of modules that write into a config's `env` map is {@link ENV_MAP_WRITERS}** — the reader
 *    itself and the one rebuild that cannot route through it, each named with the reason. A seventh writer
 *    is caught by its first assignment, before it has written a byte.
 * 2. **Each of them reaches a seeding function.** Half 1 alone would pass a module that calls `stanzaFor`
 *    on one line and hand-rolls `config.env[e] ??= {}` on the next, which is precisely the shape being
 *    closed; half 2 alone would pass the same module for the same reason. Together they do not.
 *
 * **What this gate does not see, and what does.** `project/workerScaffold.ts` emits its stanzas as JSON
 * text in a template literal rather than by mutating a tree, so no rule about assignment can reach it.
 * `commands/doctorEnvironmentInheritance.test.ts` is where that writer is held: it scaffolds a project with
 * the real scaffolder, adds a Worker with the real `pithy worker add`, and runs the real
 * `checkEnvironmentInheritance` over the result. The two gates answer for the two shapes a stanza is
 * written in, and neither is a substitute for the other.
 *
 * The extractor **refuses what it cannot name**. An assignment whose target is an `env` member, in a form
 * it does not recognize, throws rather than answering "not a writer" — a sweep whose unrecognized case is
 * silently empty cannot observe the thing it was built for.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/** The functions that hand back a stanza already carrying what an environment does not inherit. */
const SEEDING_FUNCTIONS = ["stanzaFor", "topLevelKeysToRepeat"];

/** Every module that may write an `env` map directly, and why it is the one doing it rather than a caller. */
const ENV_MAP_WRITERS = new Map<string, string>([
  ["project/wranglerInheritance.ts", "the reader itself — `stanzaFor` is where a stanza is created"],
  [
    "project/scaffold.ts",
    // Not routable through `stanzaFor`, which seeds *one* absent stanza and leaves a present one alone.
    // `stampEnvironmentStanzas` replaces the whole map on a directory `pithy init` made moments earlier,
    // to put the declared environment names in it — there is no stanza to leave alone yet. It builds each
    // one from `topLevelKeysToRepeat`, which is the same seeding and why half 2 below holds it too.
    "replaces the whole map at `init`, building each stanza from `topLevelKeysToRepeat`",
  ],
]);

/**
 * Every write into an `env` member this extractor understands.
 *
 * Four forms, because four are how a stanza is reached: indexed assignment (`config.env[e] = …`), indexed
 * defaulting (`config.env[e] ??= {}`), a named member (`config.env.staging = …`), and replacing the map
 * outright (`config.env = …`). A fifth spelling is a hole, which is why {@link writesEnvMap} throws on an
 * `env` write it cannot place in one of them.
 */
const ENV_WRITE = /(\w+(?:\.\w+)*)\.env\s*(?:\.\w+|\[[^\]]*\])?\s*(?:\?\?|\|\||&&)?=(?!=)/;

/**
 * The receivers whose `.env` is the **process** environment rather than a `wrangler.jsonc`'s stanza map.
 *
 * Named rather than inferred: every other receiver is read as a config, which is the side to err on. A
 * gate that guessed "probably not a config" would let the next writer through for being called something
 * this file had not thought of.
 */
const PROCESS_ENVS = ["process", "import.meta"];

/**
 * The left-hand side of the first plain assignment on a line, or `null` where there is none.
 *
 * `==`, `!=`, `<=`, `>=` and `=>` are not assignments; `??=`, `||=` and `&&=` are. Reading the *target* is
 * what tells `config.env[e] = stanza` (a write) from `const before = config.env?.[e]` (a read) without
 * either of them having to be spelled out.
 */
function assignmentTarget(line: string): string | null {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "=") continue;
    if (line[index + 1] === "=" || line[index + 1] === ">") continue;
    const before = line[index - 1] ?? "";
    if (before === "=" || before === "!" || before === "<" || before === ">") continue;
    return line.slice(0, index);
  }
  return null;
}

/** Whether a module writes into a config's `env` map — and so creates or replaces `env.<name>` stanzas. */
function writesEnvMap(path: string, source: string): boolean {
  let writes = false;
  for (const line of blankComments(source).split("\n")) {
    const target = assignmentTarget(line);
    // Bracketed subscripts come out first, so `domains[answer.env] = …` is read as an assignment to
    // `domains` — which it is. `.env` inside an index expression is somebody else's `env`, and a gate that
    // could not tell the two apart would throw on a line that touches no stanza.
    if (target === null || !target.replace(/\[[^\]]*\]/g, "").includes(".env")) continue;
    const match = ENV_WRITE.exec(line);
    if (!match) {
      throw new Error(
        `${path} assigns to an env member in a form this gate cannot classify: ${line.trim()}\nTeach the extractor this form — a shape it cannot read is a writer it cannot catch.`,
      );
    }
    if (PROCESS_ENVS.includes(match[1] ?? "")) continue;
    writes = true;
  }
  return writes;
}

/** Whether a module reaches a seeding function, under whatever name it imported it as. */
function reachesSeeding(source: string): boolean {
  const blanked = blankComments(source);
  return SEEDING_FUNCTIONS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(blanked));
}

describe("an env.<name> stanza is built by the module that knows what an environment does not inherit", () => {
  // The shared walk (#185), never a hand-rolled one.
  const files = sourceFiles(CLI_SRC);
  const named = (path: string): string => relative(CLI_SRC, path).split("\\").join("/");

  it("finds the CLI's sources", () => {
    // Non-vacuity, and by name the module every other writer now defers to.
    expect(files.length).toBeGreaterThanOrEqual(185);
    expect(files.some((file) => named(file.path) === "project/wranglerInheritance.ts")).toBe(true);
    expect(files.some((file) => named(file.path) === "provision/wranglerEnv.ts")).toBe(true);
  });

  it("only these modules write an env map", () => {
    const writers = files
      .filter((file) => writesEnvMap(named(file.path), file.text))
      .map((file) => named(file.path))
      .sort();
    expect(
      writers,
      "An `env.<name>` stanza inherits nothing from the top level, so one created empty deploys a Worker without every key the top level declares. Build it with `stanzaFor` from project/wranglerInheritance.ts, or add this module here with the reason it cannot.",
    ).toEqual([...ENV_MAP_WRITERS.keys()].sort());
  });

  it("and each of them builds what it writes from the top level", () => {
    // The second half. A module on the list above that stopped seeding would satisfy the set and still
    // ship the defect — and a module that seeds one stanza while hand-rolling another satisfies this and
    // fails the set. Neither half is the rule on its own.
    for (const writer of ENV_MAP_WRITERS.keys()) {
      const file = files.find((candidate) => named(candidate.path) === writer);
      expect(file, `${writer} is named as an env-map writer and is not in the tree`).toBeDefined();
      expect(reachesSeeding(file?.text ?? ""), `${writer} writes stanzas without seeding them`).toBe(true);
    }
  });

  it("the extractor sees every spelling it is asked about, and refuses the ones it is not", () => {
    // The gate over the gate. `writesEnvMap` answering "no" everywhere would make the set above green and
    // empty, which is how this defect survived #581 in the first place.
    expect(writesEnvMap("indexed.ts", "config.env[env] = stanza;")).toBe(true);
    expect(writesEnvMap("defaulted.ts", "config.env[env] ??= {};")).toBe(true);
    expect(writesEnvMap("whole.ts", "config.env = Object.fromEntries(pairs);")).toBe(true);
    expect(writesEnvMap("nested.ts", "parsed.worker.env ??= {};")).toBe(true);
    expect(writesEnvMap("member.ts", 'config.env.staging = { name: "acme-staging-api" };')).toBe(true);
    // A read is not a write, however much `.env` is on the line.
    expect(writesEnvMap("read.ts", "const before = JSON.stringify(config.env?.[env] ?? null);")).toBe(false);
    expect(writesEnvMap("keys.ts", "return Object.keys(config.env ?? {});")).toBe(false);
    expect(writesEnvMap("compared.ts", "if (config.env === undefined) return;")).toBe(false);
    expect(writesEnvMap("subscript.ts", "domains[answer.env] = parsed.data;")).toBe(false);
    expect(writesEnvMap("arrow.ts", "const of = (config) => config.env;")).toBe(false);
    // The process environment is a different `env`, and is named rather than guessed at.
    expect(writesEnvMap("process.ts", 'process.env[ENVIRONMENT_VAR] = "dev";')).toBe(false);
    expect(writesEnvMap("processMember.ts", 'process.env.NO_COLOR = "1";')).toBe(false);
    // A commented-out write is not a write.
    expect(writesEnvMap("commented.ts", "// config.env[env] = stanza;")).toBe(false);
    // The unnameable case throws rather than answering "no".
    expect(() => writesEnvMap("destructured.ts", "({ env: config.env } = next);")).toThrow(/cannot classify/);
  });

  it("reads a seeding function under any name the importer gave it", () => {
    expect(reachesSeeding('import { stanzaFor } from "./wranglerInheritance";\nstanzaFor(config, env);')).toBe(true);
    expect(reachesSeeding("const repeated = topLevelKeysToRepeat(config);")).toBe(true);
    expect(reachesSeeding("config.env[env] ??= {};")).toBe(false);
  });
});
