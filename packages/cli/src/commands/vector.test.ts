import type { CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import vector from "./vector";

/**
 * The command surface, asserted rather than assumed: every vector command is `--env`-targeted and
 * `--json`-capable (CLAUDE.md: agent-drivable), and `reset` takes `--confirm-reset` and **not** `--yes`.
 *
 * That last one is the whole point of `docs/CLI.md` §7.5. `--yes` means "yes, this is not dev" and was
 * designed to authorize additive writes; a reset deletes every vector in an environment. If `--yes` ever
 * appears on this command, a script that knew only to pass it could destroy a staging index.
 */

function subcommand(name: string): CommandDef {
  const entry = (vector.subCommands as Record<string, CommandDef>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return entry;
}

function argNames(name: string): string[] {
  return Object.keys((subcommand(name).args ?? {}) as object);
}

describe("pithy vector", () => {
  test("exposes provision, reset, and reprocess", () => {
    expect(Object.keys(vector.subCommands ?? {})).toEqual(["provision", "reset", "reprocess"]);
  });

  test("every command is --env-targeted and --json-capable", () => {
    for (const name of ["provision", "reset", "reprocess"]) {
      expect(argNames(name)).toEqual(expect.arrayContaining(["env", "json"]));
    }
  });

  test("every command defaults to dev, so nothing reaches staging by omission", () => {
    for (const name of ["provision", "reset", "reprocess"]) {
      const args = subcommand(name).args as Record<string, { default?: unknown }>;
      expect(args.env?.default).toBe("dev");
    }
  });

  test("reset takes --confirm-reset and refuses to know about --yes", () => {
    expect(argNames("reset")).toContain("confirm-reset");
    expect(argNames("reset")).not.toContain("yes");
  });

  test("--confirm-reset is a phrase, not a flag", () => {
    const args = subcommand("reset").args as Record<string, { type?: string }>;
    expect(args["confirm-reset"]?.type).toBe("string");
  });

  test("reprocess is fully flag-driven: an index, a full pass, and a scoping filter", () => {
    expect(argNames("reprocess")).toEqual(expect.arrayContaining(["index", "all", "filter"]));
  });

  test("no command requires an argument, so each one runs headlessly", () => {
    for (const name of ["provision", "reset", "reprocess"]) {
      const args = subcommand(name).args as Record<string, { required?: boolean }>;
      expect(Object.values(args).some((arg) => arg.required === true)).toBe(false);
    }
  });
});
