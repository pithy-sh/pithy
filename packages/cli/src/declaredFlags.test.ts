// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ArgsDef, CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import { flagsOf, refuseUndeclaredFlags, undeclaredFlags } from "./declaredFlags";
import { ownNamesOnly } from "./dispatch";
import { main } from "./main";

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

  test("names every undeclared flag, and says so when a command takes none", async () => {
    const error = (await refuseUndeclaredFlags(tree, ["token", "mint", "--a", "--b"]).catch((e: unknown) => e)) as
      | ValidationError
      | undefined;
    expect(error?.payload.message).toBe("Unknown flags: --a, --b.");
    expect(error?.payload.action).toBe("`pithy token mint` takes no flags.");
  });

  test("an invocation whose flags are all declared passes", async () => {
    await expect(refuseUndeclaredFlags(tree, ["doctor", "--json"])).resolves.toBeUndefined();
  });
});

/** Every command in the tree, found by walking it, with the path a caller types and its resolved parser. */
async function everyCommand(root: CommandDef): Promise<{ path: string[]; args: ArgsDef }[]> {
  const found: { path: string[]; args: ArgsDef }[] = [];
  async function walk(cmd: CommandDef, path: string[]): Promise<void> {
    found.push({ path, args: cmd.args === undefined ? {} : await resolve(cmd.args) });
    if (cmd.subCommands === undefined) return;
    const children = (await resolve(cmd.subCommands)) as Record<string, CommandDef | (() => Promise<CommandDef>)>;
    for (const [name, child] of Object.entries(children)) await walk(await resolve(child), [...path, name]);
  }
  await walk(root, []);
  return found;
}

/**
 * **The sweep: every registered command, found by walking the tree `bin.ts` dispatches, not listed.**
 *
 * Both halves, over the same population. An undeclared flag is refused in every spelling a caller can
 * type — and every flag a command *does* declare still passes, read off that command's own `args` rather
 * than off `flagsOf`, so a refusal that grew too eager fails here instead of in somebody's CI.
 *
 * What the sweep does not see: the `bin.ts` wiring. That is held by the spawned cases below.
 */
describe("the sweep over every registered command", () => {
  const root = ownNamesOnly(main);

  test("walks the whole tree the root declares", async () => {
    const commands = await everyCommand(root);
    const roots = new Set(commands.map(({ path }) => path[0]).filter((name) => name !== undefined));
    expect([...roots].sort()).toEqual(Object.keys(await resolve(main.subCommands ?? {})).sort());
    expect(commands.some(({ path }) => path.length === 2)).toBe(true);
  }, 120_000);

  test("an undeclared flag is refused on every command, in every spelling", async () => {
    const missed: string[] = [];
    for (const { path } of await everyCommand(root)) {
      for (const [typed, named] of [
        [["--bogus-flag", "yes"], "--bogus-flag"],
        [["--bogus-flag=yes"], "--bogus-flag"],
        [["--no-bogus-flag"], "--no-bogus-flag"],
        [["-Z"], "-Z"],
      ] as const) {
        const refusal = await undeclaredFlags(root, [...path, ...typed]);
        if (refusal?.undeclared.includes(named) !== true || refusal.path.join(" ") !== path.join(" ")) {
          missed.push(`pithy ${[...path, ...typed].join(" ")}`);
        }
      }
    }
    expect(missed).toEqual([]);
  }, 120_000);

  test("every flag a command declares is still accepted on it", async () => {
    const refused: string[] = [];
    let checked = 0;
    for (const { path, args } of await everyCommand(root)) {
      for (const [name, def] of Object.entries(args)) {
        if (def.type === "positional") continue;
        const spellings =
          def.type === "boolean" ? [[`--${name}`], [`--no-${name}`]] : [[`--${name}`, "value"], [`--${name}=value`]];
        for (const typed of spellings) {
          checked += 1;
          const refusal = await undeclaredFlags(root, [...path, ...typed]);
          if (refusal !== null)
            refused.push(`pithy ${[...path, ...typed].join(" ")}: ${refusal.undeclared.join(", ")}`);
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
  test("`pithy doctor --bogus-flag yes` exits 1 naming the flag and doctor's real flags", async () => {
    const { code, stdout, stderr } = await pithy("doctor", "--bogus-flag", "yes");
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown flag: --bogus-flag.");
    expect(stderr).toContain("`pithy doctor` takes --worker,");
    expect(stderr).toContain("--json");
  }, 120_000);

  test("`--json` reports the refusal as one machine-readable line", async () => {
    const { code, stdout, stderr } = await pithy("doctor", "--json", "--bogus-flag", "yes");
    expect(code).toBe(1);
    expect(stdout).toBe("");
    const lines = stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    const { error } = JSON.parse(lines[0] as string) as { error: { code: string; message: string } };
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toBe("Unknown flag: --bogus-flag.");
  }, 120_000);

  test("a group given a flag is refused rather than answered with its usage", async () => {
    const { code, stderr } = await pithy("token", "--bogus-flag");
    expect(code).toBe(1);
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
      expect(`${early}: exit ${code}`).toBe(`${early}: exit 1`);
      expect(stdout).toBe("");
      expect(stderr).toContain("--bogus-flag");
    }
  }, 120_000);
});
