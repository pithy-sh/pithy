import type { CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import { main } from "./main";

/** Resolve a (possibly lazy) citty subcommand. */
async function subcommand(name: string): Promise<CommandDef> {
  const entry = (main.subCommands as Record<string, CommandDef | (() => Promise<CommandDef>)>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return typeof entry === "function" ? await entry() : entry;
}

async function argNames(name: string): Promise<string[]> {
  const command = await subcommand(name);
  const args = typeof command.args === "function" ? await command.args() : command.args;
  return Object.keys(args ?? {});
}

describe("main", () => {
  test("registers init, add, and migrate", () => {
    expect(Object.keys(main.subCommands as object)).toEqual(expect.arrayContaining(["init", "add", "migrate"]));
  });

  test("every command supports --json — agent-drivable, spec §10.20", async () => {
    for (const name of ["init", "add", "migrate"]) {
      expect(await argNames(name)).toContain("json");
    }
  });

  test("init takes --name and --dir", async () => {
    expect(await argNames("init")).toEqual(expect.arrayContaining(["name", "dir", "json"]));
  });

  test("add takes the capability positionally (optional, so --list works alone) and a --list flag", async () => {
    const add = await subcommand("add");
    const args = add.args as Record<string, { type?: string; required?: boolean }>;
    expect(args.capability?.type).toBe("positional");
    expect(args.capability?.required).toBe(false);
    expect(args.list?.type).toBe("boolean");
  });

  test("migrate takes --env and --rollback", async () => {
    expect(await argNames("migrate")).toEqual(expect.arrayContaining(["env", "rollback", "json"]));
  });
});
