// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ArgsDef, CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import {
  asksForJson,
  flagsOf,
  refuseEventsFlag,
  refuseJsonFlag,
  refuseNoInputFlag,
  refusePrettyFlags,
  refuseUndeclaredFlags,
  undeclaredFlags,
} from "./declaredFlags";
import { ownNamesOnly } from "./dispatch";
import { main } from "./main";
import { EXIT } from "./terminal/exitClass";
import { resolveInputForbidden } from "./terminal/inputMode";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");

/**
 * **Every flag an invocation carries is one its command declares.** (#594)
 *
 * citty parses a flag it was never told about without a word, so `pithy doctor --env prod` answered about
 * dev and exited 0, and a typo in a safety flag — `--dry-rn`, `--yse` — ran the unsafe version. The rule
 * is checked once, before citty is handed the arguments, over the same tree `bin.ts` dispatches through.
 */

/** citty's `Resolvable<T>`, resolved — the tree below is written lazily, as `main.ts` writes it. */
async function resolve<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

describe("flagsOf", () => {
  test("names every flag a parser accepts, long form first", () => {
    expect(flagsOf({ json: { type: "boolean" }, worker: { type: "string" } })).toEqual([
      "--json",
      "--no-json",
      "--worker",
    ]);
  });

  test("carries an alias in the spelling a caller types", () => {
    expect(flagsOf({ force: { type: "boolean", alias: "f" } })).toEqual(["--force", "-f", "--no-force"]);
    expect(flagsOf({ force: { type: "boolean", alias: ["f", "yes"] } })).toEqual([
      "--force",
      "-f",
      "--yes",
      "--no-force",
    ]);
  });

  test("a positional is not a flag", () => {
    expect(flagsOf({ capability: { type: "positional" }, list: { type: "boolean" } })).toEqual(["--list", "--no-list"]);
  });

  /**
   * citty aliases every arg to its camel **and** kebab spelling (`parseArgs`, `citty/dist/index.mjs`),
   * so `--withPrerequisites` reaches the same value. This file used to claim citty does no case mapping.
   */
  test("a kebab-case arg also answers to its camelCase spelling", () => {
    expect(flagsOf({ "with-prerequisites": { type: "boolean" } })).toEqual([
      "--with-prerequisites",
      "--withPrerequisites",
      "--no-with-prerequisites",
    ]);
  });

  /**
   * citty strips `--no-` from any argument before parsing, and the CLI documents the result — `ui.ts`'s
   * own description offers `--no-auth`, and `docs/commands/ui.md` puts `[--auth | --no-auth]` in its
   * synopsis.
   */
  test("a boolean also answers to its `--no-` form, and a string does not", () => {
    expect(flagsOf({ auth: { type: "boolean" } })).toEqual(["--auth", "--no-auth"]);
    expect(flagsOf({ worker: { type: "string" } })).toEqual(["--worker"]);
  });

  test("a command with no args accepts no flags", () => {
    expect(flagsOf(undefined)).toEqual([]);
  });
});

describe("undeclaredFlags", () => {
  const tree: CommandDef = {
    meta: { name: "pithy" },
    subCommands: {
      doctor: {
        args: {
          worker: { type: "string" },
          json: { type: "boolean" },
          "dry-run": { type: "boolean", alias: "n" },
          file: { type: "string", alias: "f" },
        },
        run: () => {},
      },
      add: { args: { capability: { type: "positional", required: true }, set: { type: "string" } }, run: () => {} },
      token: {
        subCommands: {
          mint: () => Promise.resolve({ args: () => ({ env: { type: "string" } }), run: () => {} }),
          list: Promise.resolve({ args: Promise.resolve({ json: { type: "boolean" } }), run: () => {} }),
        },
      },
      secrets: {
        subCommands: async () => ({
          list: { meta: { alias: "ls" }, args: { json: { type: "boolean" } }, run: () => {} },
        }),
      },
    },
  };

  test("names the flag a command does not declare, and the flags it does", async () => {
    expect(await undeclaredFlags(tree, ["doctor", "--bogus-flag", "yes"])).toEqual({
      path: ["doctor"],
      undeclared: ["--bogus-flag"],
      declared: ["--worker", "--json", "--dry-run", "--file"],
    });
  });

  test("a command whose flags are all declared is not refused", async () => {
    expect(await undeclaredFlags(tree, ["doctor", "--worker", "api", "--json"])).toBeNull();
    expect(await undeclaredFlags(tree, ["doctor", "--worker=api", "--no-json", "--dryRun"])).toBeNull();
    expect(await undeclaredFlags(tree, ["doctor", "-n", "-fplan.json", "-nf", "x"])).toBeNull();
    expect(await undeclaredFlags(tree, ["add", "auth", "--set", "a=b", "--set=c=d"])).toBeNull();
  });

  test("every spelling of an undeclared flag is named as it was typed", async () => {
    const named = async (...argv: string[]) => (await undeclaredFlags(tree, argv))?.undeclared;
    expect(await named("doctor", "--bogus-flag=yes")).toEqual(["--bogus-flag"]);
    expect(await named("doctor", "-z")).toEqual(["-z"]);
    expect(await named("doctor", "-nz")).toEqual(["-z"]);
    expect(await named("doctor", "--no-bogus")).toEqual(["--no-bogus"]);
    // `--no-` is a boolean's negation. A string declares no such spelling, whatever citty would do with it.
    expect(await named("doctor", "--no-worker")).toEqual(["--no-worker"]);
    expect(await named("doctor", "--dry-rn", "--yse")).toEqual(["--dry-rn", "--yse"]);
  });

  test("a declared string flag's value is its value, even when it starts with a dash", async () => {
    expect(await undeclaredFlags(tree, ["doctor", "--worker", "--bogus"])).toBeNull();
  });

  test("everything after `--` is payload, never a flag", async () => {
    expect(await undeclaredFlags(tree, ["doctor", "--", "--bogus"])).toBeNull();
  });

  test("a required positional does not stand in front of the refusal", async () => {
    expect((await undeclaredFlags(tree, ["add", "--bogus"]))?.undeclared).toEqual(["--bogus"]);
  });

  /**
   * The order people type: the thing, then the flags. Only a group stops owning its tokens at a positional,
   * because that positional names the command the rest belong to. A leaf's positional is its own argument,
   * and every flag on either side of it is the leaf's — so `secrets rotate API_KEY --dry-rn` is refused, not
   * run for real.
   */
  test("a flag after a command's positional is still that command's, and still checked", async () => {
    expect(await undeclaredFlags(tree, ["add", "auth", "--bogus"])).toEqual({
      path: ["add"],
      undeclared: ["--bogus"],
      declared: ["--set"],
    });
    expect((await undeclaredFlags(tree, ["add", "auth", "--set", "a=b", "--dorp"]))?.undeclared).toEqual(["--dorp"]);
    expect((await undeclaredFlags(tree, ["doctor", "stray", "--dry-rn"]))?.undeclared).toEqual(["--dry-rn"]);
    expect((await undeclaredFlags(tree, ["token", "mint", "ci", "--env", "prod", "--keep"]))?.undeclared).toEqual([
      "--keep",
    ]);
    expect(await undeclaredFlags(tree, ["add", "auth", "--set", "a=b"])).toBeNull();
    expect(await undeclaredFlags(tree, ["add", "auth", "--", "--bogus"])).toBeNull();
  });

  test("a flag given to a group is the group's, and a group declares none", async () => {
    expect(await undeclaredFlags(tree, ["token", "--json", "mint"])).toEqual({
      path: ["token"],
      undeclared: ["--json"],
      declared: [],
    });
    expect(await undeclaredFlags(tree, ["--json"])).toEqual({ path: [], undeclared: ["--json"], declared: [] });
  });

  test("resolves a lazy tree — thunked and promised commands, containers and parsers", async () => {
    expect(await undeclaredFlags(tree, ["token", "mint", "--env", "prod"])).toBeNull();
    expect((await undeclaredFlags(tree, ["token", "mint", "--bogus"]))?.path).toEqual(["token", "mint"]);
    expect(await undeclaredFlags(tree, ["token", "list", "--json"])).toBeNull();
    expect((await undeclaredFlags(tree, ["token", "list", "--bogus"]))?.declared).toEqual(["--json"]);
    expect(await undeclaredFlags(tree, ["secrets", "ls", "--json"])).toBeNull();
    expect((await undeclaredFlags(tree, ["secrets", "ls", "--bogus"]))?.path).toEqual(["secrets", "ls"]);
  });

  test("the flags every command answers before citty parses are declared everywhere", async () => {
    for (const flag of ["--help", "-h", "--version", "-v", "--pithier", "--pithiest"]) {
      expect(await undeclaredFlags(tree, ["doctor", flag])).toBeNull();
      expect(await undeclaredFlags(tree, ["token", flag])).toBeNull();
    }
  });

  test("a group handed no name runs its `default`, so the flags are the default's", async () => {
    const withDefault: CommandDef = {
      subCommands: {
        feature: { default: "start", subCommands: { start: { args: { slug: { type: "string" } }, run: () => {} } } },
      },
    };
    // `=` only: citty takes the first positional as a subcommand name before it considers the default,
    // so `feature --slug x` is its unknown command `x`, not the default given a value.
    expect(await undeclaredFlags(withDefault, ["feature", "--slug=x"])).toBeNull();
    expect(await undeclaredFlags(withDefault, ["feature", "--bogus"])).toEqual({
      path: ["feature"],
      undeclared: ["--bogus"],
      declared: ["--slug"],
    });
  });

  test("an unknown command is not this check's to answer — citty names it", async () => {
    expect(await undeclaredFlags(tree, ["nonsense", "--bogus"])).toBeNull();
    expect(await undeclaredFlags(tree, ["token", "nonsense", "--bogus"])).toBeNull();
  });
});

describe("refuseUndeclaredFlags", () => {
  const tree: CommandDef = {
    meta: { name: "pithy" },
    subCommands: {
      doctor: { args: { worker: { type: "string" }, json: { type: "boolean" } }, run: () => {} },
      token: { subCommands: { mint: { run: () => {} } } },
    },
  };

  test("refuses with the flag on the problem line and the command's real flags on the action line", async () => {
    const error = await refuseUndeclaredFlags(tree, ["doctor", "--bogus-flag", "yes"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    const { payload } = error as ValidationError;
    expect(payload.message).toBe("Unknown flag: --bogus-flag.");
    expect(payload.action).toBe("`pithy doctor` takes --worker, --json.");
    expect(payload.issues).toEqual([
      { path: ["--bogus-flag"], code: "unrecognized_keys", message: "`pithy doctor` does not declare --bogus-flag." },
    ]);
  });

  // `--help`, `--version`, `--pretty` and `--no-input` work on every command, a group's and the root included, so
  // "takes no flags" sent a caller away from flags that would have worked (#697).
  test("names every undeclared flag, and points a command with none of its own at the global ones", async () => {
    const error = (await refuseUndeclaredFlags(tree, ["token", "mint", "--a", "--b"]).catch((e: unknown) => e)) as
      | ValidationError
      | undefined;
    expect(error?.payload.message).toBe("Unknown flags: --a, --b.");
    expect(error?.payload.action).toBe(
      "`pithy token mint` takes only the global flags, which `pithy schema --json` lists.",
    );
    const group = (await refuseUndeclaredFlags(tree, ["token", "--a"]).catch((e: unknown) => e)) as ValidationError;
    expect(group.payload.action).toBe("`pithy token` takes only the global flags, which `pithy schema --json` lists.");
  });

  test("an invocation whose flags are all declared passes", async () => {
    await expect(refuseUndeclaredFlags(tree, ["doctor", "--json"])).resolves.toBeUndefined();
  });
});

/** One command in the tree: the path a caller types, its resolved parser, and whether it dispatches. */
interface FoundCommand {
  path: string[];
  args: ArgsDef;
  /** Whether it has subcommands — a positional handed to it names one, rather than being its argument. */
  dispatches: boolean;
}

/** Every command in the tree, found by walking it. */
async function everyCommand(root: CommandDef): Promise<FoundCommand[]> {
  const found: FoundCommand[] = [];
  async function walk(cmd: CommandDef, path: string[]): Promise<void> {
    const children =
      cmd.subCommands === undefined
        ? {}
        : ((await resolve(cmd.subCommands)) as Record<string, CommandDef | (() => Promise<CommandDef>)>);
    const dispatches = Object.keys(children).length > 0;
    found.push({ path, args: cmd.args === undefined ? {} : await resolve(cmd.args), dispatches });
    for (const [name, child] of Object.entries(children)) await walk(await resolve(child), [...path, name]);
  }
  await walk(root, []);
  return found;
}

/**
 * Where a flag can sit on one command, in the orders a caller types: straight after the command, after a
 * positional, and after a positional and one of the command's own flags with its value. A group gets the
 * first alone — a positional handed to a group names its subcommand, which is where its flags go.
 */
function placements({ args, dispatches }: FoundCommand): string[][] {
  if (dispatches) return [[]];
  const declared = Object.entries(args).find(([, def]) => def.type !== "positional");
  const own =
    declared === undefined ? [] : declared[1].type === "boolean" ? [`--${declared[0]}`] : [`--${declared[0]}`, "value"];
  return [[], ["stray"], ["stray", ...own]];
}

/**
 * **The sweep: every registered command, found by walking the tree `bin.ts` dispatches, not listed.**
 *
 * Both halves, over the same population. An undeclared flag is refused in every spelling a caller can
 * type — and every flag a command *does* declare still passes, read off that command's own `args` rather
 * than off `flagsOf`, so a refusal that grew too eager fails here instead of in somebody's CI.
 *
 * **Wherever the flag is typed** ({@link placements}): straight after the command, after a positional, and
 * after a positional and one of the command's own flags. The first shape alone was the sweep's first
 * version, and it passed a check that dropped every flag typed after a leaf's positional — the order
 * people type (`secrets rotate API_KEY --dry-rn`). Planted since, and red: that cut, and a cut after a leaf's
 * first flag with a value.
 *
 * What the sweep does not see: the `bin.ts` wiring, which the spawned cases below hold; and a flag placed
 * anywhere other than those three positions — after a second positional, say, or between a declared
 * flag and its value.
 */
describe("the sweep over every registered command", () => {
  const root = ownNamesOnly(main);

  test("walks the whole tree the root declares", async () => {
    const commands = await everyCommand(root);
    const roots = new Set(commands.map(({ path }) => path[0]).filter((name) => name !== undefined));
    expect([...roots].sort()).toEqual(Object.keys(await resolve(main.subCommands ?? {})).sort());
    expect(commands.some(({ path }) => path.length === 2)).toBe(true);
  }, 120_000);

  test("an undeclared flag is refused on every command, in every spelling, wherever it is typed", async () => {
    const missed: string[] = [];
    let afterPositional = 0;
    for (const command of await everyCommand(root)) {
      const { path } = command;
      for (const before of placements(command)) {
        if (before.length > 0) afterPositional += 1;
        for (const [typed, named] of [
          [["--bogus-flag", "yes"], "--bogus-flag"],
          [["--bogus-flag=yes"], "--bogus-flag"],
          [["--no-bogus-flag"], "--no-bogus-flag"],
          [["-Z"], "-Z"],
        ] as const) {
          const argv = [...path, ...before, ...typed];
          const refusal = await undeclaredFlags(root, argv);
          if (refusal?.undeclared.includes(named) !== true || refusal.path.join(" ") !== path.join(" ")) {
            missed.push(`pithy ${argv.join(" ")}`);
          }
        }
      }
    }
    expect(missed).toEqual([]);
    expect(
      afterPositional,
      "no command took a positional, so the placements after one checked nothing",
    ).toBeGreaterThan(0);
  }, 120_000);

  test("every flag a command declares is still accepted on it, wherever it is typed", async () => {
    const refused: string[] = [];
    let checked = 0;
    for (const command of await everyCommand(root)) {
      const { path, args } = command;
      for (const before of placements(command)) {
        for (const [name, def] of Object.entries(args)) {
          if (def.type === "positional") continue;
          const spellings =
            def.type === "boolean" ? [[`--${name}`], [`--no-${name}`]] : [[`--${name}`, "value"], [`--${name}=value`]];
          for (const typed of spellings) {
            checked += 1;
            const argv = [...path, ...before, ...typed];
            const refusal = await undeclaredFlags(root, argv);
            if (refusal !== null) refused.push(`pithy ${argv.join(" ")}: ${refusal.undeclared.join(", ")}`);
          }
        }
      }
    }
    expect(refused).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});

/** Spawn the real bin and report both streams and the exit status, never throwing on a non-zero exit. */
async function pithy(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], {
      env: { ...process.env, PITHY_NO_UPDATE_NOTIFIER: "1" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("the real bin", () => {
  test("`pithy doctor --bogus-flag yes` exits 2 naming the flag and doctor's real flags", async () => {
    const { code, stdout, stderr } = await pithy("doctor", "--bogus-flag", "yes");
    expect(code).toBe(EXIT.usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown flag: --bogus-flag.");
    expect(stderr).toContain("`pithy doctor` takes --worker,");
    expect(stderr).toContain("--json");
  }, 120_000);

  test("`--json` reports the refusal as one machine-readable line", async () => {
    const { code, stdout, stderr } = await pithy("doctor", "--json", "--bogus-flag", "yes");
    expect(code).toBe(EXIT.usage);
    expect(stdout).toBe("");
    const lines = stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    const { error } = JSON.parse(lines[0] as string) as { error: { code: string; message: string } };
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toBe("Unknown flag: --bogus-flag.");
  }, 120_000);

  /** citty reads `--json --no-json` as no JSON, so the refusal is text too — one reading, not two (#697 review). */
  test("`--json --no-json` reports the refusal as text, the way the command would have rendered", async () => {
    const { code, stderr } = await pithy("doctor", "--json", "--no-json", "--bogus-flag");
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain("Unknown flag: --bogus-flag.");
    expect(stderr.trimStart().startsWith("{")).toBe(false);
  }, 120_000);

  test("a typo after a positional is refused before the command runs", async () => {
    const { code, stdout, stderr } = await pithy("token", "rotate", "ci-system", "--env", "prod", "--keep-previos");
    expect(code).toBe(EXIT.usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown flag: --keep-previos.");
  }, 120_000);

  test("a group given a flag is refused rather than answered with its usage", async () => {
    const { code, stderr } = await pithy("token", "--bogus-flag");
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain("Unknown flag: --bogus-flag.");
  }, 120_000);

  /**
   * `--version` and `--pithiest` each answer and exit 0 before citty is reached, so a check placed after
   * either would let them print over a typo. `--pithier` is the third such branch and is not spawned: it
   * writes to a shell rc file.
   */
  test("a flag answered before any command runs does not hide an undeclared one", async () => {
    for (const early of ["--version", "--pithiest"]) {
      const { code, stdout, stderr } = await pithy("doctor", "--bogus-flag", early);
      expect(`${early}: exit ${code}`).toBe(`${early}: exit ${EXIT.usage}`);
      expect(stdout).toBe("");
      expect(stderr).toContain("--bogus-flag");
    }
  }, 120_000);
});

/**
 * **`--pretty` formats the `--json` line and changes nothing else, so without `--json` it changes
 * nothing at all.** One check, in one place, rather than fifty commands each restating a convention.
 *
 * `--no-pretty` is held to the same rule. It is the same flag with the opposite answer, and a flag that
 * silently does nothing is the ambient surprise this feature exists to close, not an exception to it.
 * `PITHY_JSON` is the session-wide lever for anyone who wants one set permanently.
 */
describe("refusePrettyFlags", () => {
  test("says nothing when neither is typed", () => {
    expect(() => refusePrettyFlags(["doctor"])).not.toThrow();
    expect(() => refusePrettyFlags([])).not.toThrow();
  });

  test("says nothing when both are typed, in either order and on any command", () => {
    expect(() => refusePrettyFlags(["doctor", "--json", "--pretty"])).not.toThrow();
    expect(() => refusePrettyFlags(["--pretty", "token", "mint", "--json"])).not.toThrow();
    expect(() => refusePrettyFlags(["migrate", "--json", "--no-pretty"])).not.toThrow();
  });

  test("refuses --pretty alone, naming the flag it needs", () => {
    let thrown: unknown;
    try {
      refusePrettyFlags(["doctor", "--pretty"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const { payload } = thrown as ValidationError;
    expect(payload.message).toContain("--pretty");
    expect(payload.message).toContain("--json");
    expect(payload.action).toContain("--json");
  });

  test("refuses --no-pretty alone, naming that spelling rather than the other one", () => {
    let thrown: unknown;
    try {
      refusePrettyFlags(["doctor", "--no-pretty"]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ValidationError).payload.message).toContain("--no-pretty");
  });

  /** `remove` is the one command with no `--json` at all (docs/CLI.md §1.2), so this is where it lands. */
  test("refuses `pithy remove --pretty` — the command that has no --json to format", () => {
    expect(() => refusePrettyFlags(["remove", "auth", "--pretty"])).toThrow(ValidationError);
  });

  test("a --pretty after `--` is payload, not a flag, so it is not refused", () => {
    expect(() => refusePrettyFlags(["dev", "--", "--pretty"])).not.toThrow();
  });

  /** `--json=false` asks for no JSON line, so there is still nothing for `--pretty` to format. */
  test("--json=false is not --json", () => {
    expect(() => refusePrettyFlags(["doctor", "--json=false", "--pretty"])).toThrow(ValidationError);
  });
});

describe("the pretty flags on the real command tree", () => {
  const root = ownNamesOnly(main);

  test("every command accepts both spellings, because they are global", async () => {
    for (const argv of [
      ["doctor", "--json", "--pretty"],
      ["doctor", "--json", "--no-pretty"],
      ["token", "mint", "--json", "--pretty"],
      ["remove", "auth", "--pretty"],
    ]) {
      expect(await undeclaredFlags(root, argv)).toBeNull();
    }
  });
});

/**
 * The `=value` spelling the parser lets through. Ignoring it left `--pretty=false` at a terminal
 * indenting the output the operator had just asked to keep on one line.
 */
describe("refusePrettyFlags — the `=value` spelling", () => {
  test("accepts true and false, paired with --json", () => {
    expect(() => refusePrettyFlags(["doctor", "--json", "--pretty=true"])).not.toThrow();
    expect(() => refusePrettyFlags(["doctor", "--json", "--no-pretty=false"])).not.toThrow();
  });

  test("refuses it unpaired, exactly as the bare spelling is refused", () => {
    expect(() => refusePrettyFlags(["doctor", "--pretty=true"])).toThrow(ValidationError);
    expect(() => refusePrettyFlags(["doctor", "--pretty=false"])).toThrow(ValidationError);
  });

  test("refuses a value that is neither, naming the token and the two it takes", () => {
    let thrown: unknown;
    try {
      refusePrettyFlags(["doctor", "--json", "--pretty=maybe"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const { payload } = thrown as ValidationError;
    expect(payload.message).toContain("--pretty=maybe");
    expect(payload.action).toContain("true");
    expect(payload.action).toContain("false");
  });

  /** The malformed value is refused before the pairing rule — it is the more specific mistake. */
  test("a malformed value with no --json reports the value, not the pairing", () => {
    let thrown: unknown;
    try {
      refusePrettyFlags(["doctor", "--pretty=maybe"]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ValidationError).payload.message).toContain("--pretty=maybe");
  });
});

/**
 * **`pithy dev logs` is walked into, so the reader's flags are checked against the reader** (#671).
 *
 * `dev` is the first command with a `run` of its own *and* subcommands, so it is also the first time this
 * walk's "a group owns the flags before its first positional" clause meets a command that is not a group.
 */
describe("the dev logs reader", () => {
  test("a flag the reader declares is accepted on it, and the session's own are not", async () => {
    expect(await undeclaredFlags(main, ["dev", "logs", "--follow", "--timestamps", "-n", "50"])).toBeNull();
    expect((await undeclaredFlags(main, ["dev", "logs", "--list"]))?.undeclared).toEqual(["--list"]);
    expect((await undeclaredFlags(main, ["dev", "logs", "--list"]))?.path).toEqual(["dev", "logs"]);
  });

  test("the session still owns the flags before the subcommand name", async () => {
    expect((await undeclaredFlags(main, ["dev", "--since", "5m", "logs"]))?.undeclared).toEqual(["--since"]);
  });

  test("bare pithy dev is unaffected by gaining a subcommand", async () => {
    expect(await undeclaredFlags(main, ["dev", "--app", "api", "--json"])).toBeNull();
    expect((await undeclaredFlags(main, ["dev", "--bogus"]))?.undeclared).toEqual(["--bogus"]);
  });

  /**
   * **The `--pretty` rule needs no code on the reader**, which is the point: `bin.ts` owns both flags for
   * every command, so without `--json` either is refused as formatting a line that is not being written.
   * With `--json` the reader is a stream and stays compact, exactly as `pithy dev` does.
   */
  test("--pretty without --json is refused on the reader by the one rule that covers every command", () => {
    expect(() => refusePrettyFlags(["dev", "logs", "--pretty"])).toThrow(ValidationError);
    expect(() => refusePrettyFlags(["dev", "logs", "--no-pretty"])).toThrow(ValidationError);
    expect(() => refusePrettyFlags(["dev", "logs", "--json", "--pretty"])).not.toThrow();
  });
});

/** `--no-input` needs no `--json`, but a value it cannot mean is refused rather than ignored (#697). */
describe("refuseNoInputFlag", () => {
  test("the bare flag and =true / =false pass, on any command, with or without --json", () => {
    expect(() => refuseNoInputFlag(["init", "--no-input"])).not.toThrow();
    expect(() => refuseNoInputFlag(["init", "--no-input=false", "--json"])).not.toThrow();
    expect(() => refuseNoInputFlag(["remove", "auth", "--no-input=true"])).not.toThrow();
  });

  test("a malformed value is refused, naming the token and the spellings it takes", () => {
    let thrown: unknown;
    try {
      refuseNoInputFlag(["init", "--no-input=1"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const payload = (thrown as ValidationError).payload;
    expect(payload.message).toBe("--no-input=1 is not a value --no-input takes.");
    expect(payload.action).toBe("Write --no-input on its own, or --no-input=true or --no-input=false.");
    expect(payload.issues[0]?.path).toEqual(["--no-input"]);
  });

  test("--no-input is declared on every command, so the undeclared-flag check lets it through", async () => {
    expect(await undeclaredFlags(ownNamesOnly(main), ["add", "auth", "--no-input"])).toBeNull();
    expect(await undeclaredFlags(ownNamesOnly(main), ["worker", "list", "--no-input=false"])).toBeNull();
  });
});

/**
 * **`--events` streams progress as `--json` records, so without `--json` there is nothing to stream it into
 * (#697).** Refused in one place, as `--pretty` is. `deploy` and `provision` are the commands that declare it;
 * every other command refuses it as undeclared before this rule is asked.
 */
/**
 * **`--json` is read once, the way citty parses it (#697 review).** `asksForJson` decides the shape of a refusal and
 * whether prompts are forbidden; the command reads its own `args.json` from citty. A bare `--no-json` wins wherever
 * it is, so `--json --no-json` is a text run with prompts allowed — it was a JSON refusal line with prompts
 * forbidden, beside a command that rendered text.
 */
describe("asksForJson", () => {
  test("--json --no-json is not a JSON run, and does not forbid prompts", () => {
    expect(asksForJson(["init", "--json", "--no-json"])).toBe(false);
    expect(resolveInputForbidden({ json: asksForJson(["init", "--json", "--no-json"]) })).toBe(false);
    expect(asksForJson(["init", "--no-json", "--json"])).toBe(false);
  });

  test("reads --json, --json=true and --json=<anything but false> as on, as citty does", () => {
    expect(asksForJson(["doctor", "--json"])).toBe(true);
    expect(asksForJson(["doctor", "--json=true"])).toBe(true);
    expect(asksForJson(["doctor", "--json=false"])).toBe(false);
    expect(asksForJson(["doctor", "--json=false", "--json"])).toBe(true);
    expect(asksForJson(["dev", "--", "--json"])).toBe(false);
  });
});

describe("refuseJsonFlag", () => {
  test("says nothing for the spellings citty reads as written", () => {
    for (const argv of [[], ["--json"], ["--no-json"], ["--json=true"], ["--json=false"], ["--json", "--no-json"]]) {
      expect(() => refuseJsonFlag(argv)).not.toThrow();
    }
  });

  test("refuses a value citty would read as on whatever it says, and a --no-json it would not read at all", () => {
    for (const token of ["--json=maybe", "--json=", "--no-json=true", "--no-json=false"]) {
      let thrown: unknown;
      try {
        refuseJsonFlag(["doctor", token]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      const { payload } = thrown as ValidationError;
      expect(payload.message).toBe(`${token} is not a spelling --json takes.`);
      expect(payload.action).toBe("Write --json, --no-json, --json=true or --json=false.");
    }
    expect(() => refuseJsonFlag(["dev", "--", "--json=maybe"])).not.toThrow();
  });
});

describe("refuseEventsFlag", () => {
  test("says nothing when it is not typed, or is typed beside --json", () => {
    expect(() => refuseEventsFlag(["deploy"])).not.toThrow();
    expect(() => refuseEventsFlag(["deploy", "--json", "--events"])).not.toThrow();
    expect(() => refuseEventsFlag(["--events", "provision", "--env", "staging", "--json"])).not.toThrow();
    expect(() => refuseEventsFlag(["deploy", "--json=true", "--events=true"])).not.toThrow();
  });

  test("the spellings that ask for nothing ask for nothing to stream, so they pass alone", () => {
    expect(() => refuseEventsFlag(["deploy", "--no-events"])).not.toThrow();
    expect(() => refuseEventsFlag(["deploy", "--events=false"])).not.toThrow();
  });

  test("refuses --events alone, in exactly the words the issue promises", () => {
    let thrown: unknown;
    try {
      refuseEventsFlag(["deploy", "--env", "staging", "--events"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const { payload } = thrown as ValidationError;
    expect(payload.message).toBe("--events needs --json.");
    expect(payload.action).toBe("Add --json, or drop --events.");
    expect(payload.issues[0]?.path).toEqual(["--events"]);
  });

  test("refuses a value that is neither true nor false, as --pretty does, before the --json rule", () => {
    for (const token of ["--events=maybe", "--events=", "--events=1"]) {
      let thrown: unknown;
      try {
        refuseEventsFlag(["deploy", "--json", token]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      const { payload } = thrown as ValidationError;
      const [name] = token.split("=") as [string];
      expect(payload.message).toBe(`${token} is not a value ${name} takes.`);
      expect(payload.action).toBe(`Write ${name} on its own, or ${name}=true or ${name}=false.`);
      expect(payload.issues[0]).toMatchObject({ path: [name], code: "invalid_value" });
    }
    // The value is the more specific mistake, so it is reported even where --json is missing too.
    expect(() => refuseEventsFlag(["deploy", "--events=maybe"])).toThrow(
      "--events=maybe is not a value --events takes.",
    );
  });

  test("passes every well-formed spelling beside --json, and --eventsx, which is not its token", () => {
    for (const token of ["--events", "--no-events", "--events=true", "--events=false", "--eventsx=1"]) {
      expect(() => refuseEventsFlag(["deploy", "--json", token]), token).not.toThrow();
    }
  });

  test("names the first malformed token, not a later one", () => {
    expect(() => refuseEventsFlag(["deploy", "--json", "--events=maybe", "--events=1"])).toThrow(
      "--events=maybe is not a value --events takes.",
    );
  });

  /** citty ignores `--no-events=<value>` outright, so the bin may not read it either way. */
  test("refuses a --no-events carrying any value, as a spelling citty does not read", () => {
    for (const argv of [
      ["provision", "--no-events=1"],
      ["deploy", "--json", "--events", "--no-events=true"],
      ["deploy", "--no-events=false"],
    ]) {
      const token = argv.find((arg) => arg.startsWith("--no-events=")) as string;
      expect(() => refuseEventsFlag(argv), token).toThrow(`${token} is not a spelling --events takes.`);
    }
  });

  test("a malformed value after `--` is payload, not a flag", () => {
    expect(() => refuseEventsFlag(["dev", "--", "--events=maybe"])).not.toThrow();
    expect(() => refuseEventsFlag(["deploy", "--json", "--", "--no-events=false"])).not.toThrow();
  });

  /**
   * **`--events --no-events=true` declines (#697 review).** citty ignores `--no-events=<value>` and would stream; a
   * reader that took it as "off" would let the run through on a reading the command never makes. So the token is
   * refused, with the spellings that do work, and nothing streams.
   */
  test("--no-events with a value is refused, because citty would read --events past it", () => {
    for (const argv of [
      ["deploy", "--json", "--events", "--no-events=true"],
      ["deploy", "--events", "--no-events=true"],
      ["deploy", "--json", "--no-events=false"],
    ]) {
      let thrown: unknown;
      try {
        refuseEventsFlag(argv);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      const { payload } = thrown as ValidationError;
      const token = argv.find((entry) => entry.startsWith("--no-events=")) as string;
      expect(payload.message).toBe(`${token} is not a spelling --events takes.`);
      expect(payload.action).toBe("Write --events, --no-events, --events=true or --events=false.");
      expect(payload.issues[0]).toMatchObject({ path: ["--no-events"], code: "invalid_value" });
    }
  });

  test("--json=false is not --json, and an --events after `--` is not a flag", () => {
    expect(() => refuseEventsFlag(["provision", "--json=false", "--events"])).toThrow(ValidationError);
    expect(() => refuseEventsFlag(["dev", "--", "--events"])).not.toThrow();
  });

  /** citty applies a bare `--no-json` after everything else, so it wins wherever it is typed (`booleanToken.ts`). */
  test("--json is read as citty reads it: a bare --no-json anywhere, else the last --json", () => {
    expect(() => refuseEventsFlag(["deploy", "--json", "--no-json", "--events"])).toThrow(ValidationError);
    expect(() => refuseEventsFlag(["deploy", "--no-json", "--json", "--events"])).toThrow(ValidationError);
    expect(() => refuseEventsFlag(["deploy", "--json", "--json=false", "--events"])).toThrow(ValidationError);
    expect(() => refuseEventsFlag(["deploy", "--json=false", "--json", "--events"])).not.toThrow();
  });

  test("only deploy and provision declare it, so the undeclared-flag check refuses it everywhere else", async () => {
    const root = ownNamesOnly(main);
    expect(await undeclaredFlags(root, ["deploy", "--json", "--events"])).toBeNull();
    expect(await undeclaredFlags(root, ["provision", "--env", "staging", "--json", "--events"])).toBeNull();
    expect((await undeclaredFlags(root, ["migrate", "--json", "--events"]))?.undeclared).toEqual(["--events"]);
  });

  test("the real bin refuses it before deploy runs, as a usage error", async () => {
    const { code, stdout, stderr } = await pithy("deploy", "--events");
    expect(code).toBe(EXIT.usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("--events needs --json.");
  }, 120_000);
});
