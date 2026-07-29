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
  test("registers init, add, remove, migrate, deploy, and token", () => {
    expect(Object.keys(main.subCommands as object)).toEqual(
      expect.arrayContaining(["init", "add", "remove", "migrate", "deploy", "token"]),
    );
  });

  test("registers the six commands added for the standard surface (docs/CLI.md §1.1)", () => {
    expect(Object.keys(main.subCommands as object)).toEqual(
      expect.arrayContaining(["worker", "dev", "env", "upgrade", "alias", "doctor"]),
    );
  });

  test("worker exposes add, list, and remove subcommands", async () => {
    const worker = await subcommand("worker");
    expect(Object.keys(worker.subCommands ?? {})).toEqual(expect.arrayContaining(["add", "list", "remove"]));
  });

  test("the new commands are agent-drivable — every one supports --json", async () => {
    for (const name of ["dev", "env", "upgrade", "alias", "doctor"]) {
      expect(await argNames(name)).toContain("json");
    }
  });

  test("remove takes --drop and --env", async () => {
    expect(await argNames("remove")).toEqual(expect.arrayContaining(["capability", "drop", "env"]));
  });

  test("token exposes mint, list, rotate, and revoke subcommands", async () => {
    const token = await subcommand("token");
    expect(Object.keys(token.subCommands ?? {})).toEqual(expect.arrayContaining(["mint", "list", "rotate", "revoke"]));
  });

  test("every command supports --json — agent-drivable, spec §10.20", async () => {
    for (const name of ["init", "add", "migrate", "deploy"]) {
      expect(await argNames(name)).toContain("json");
    }
  });

  test("deploy takes --env and --json", async () => {
    expect(await argNames("deploy")).toEqual(expect.arrayContaining(["env", "json"]));
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
