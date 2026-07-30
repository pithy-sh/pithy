import type { CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import { main } from "../main";
import ui from "./ui";

/** The args are static object literals on these commands — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown; required?: boolean };

function subcommand(name: string): CommandDef {
  const found = (ui.subCommands as Record<string, CommandDef>)[name];
  if (!found) throw new Error(`expected subcommand "${name}"`);
  return found;
}

function args(name: string): Record<string, ArgSpec> {
  return (subcommand(name).args ?? {}) as Record<string, ArgSpec>;
}

describe("ui command", () => {
  test("is a noun group: add, sync, list", () => {
    expect(ui.meta).toMatchObject({ name: "ui" });
    expect(Object.keys(ui.subCommands ?? {})).toEqual(["add", "sync", "list"]);
  });

  test("add takes a framework positional, --worker, one flag per screen set, and --json", () => {
    expect(Object.keys(args("add"))).toEqual(["framework", "worker", "auth", "payments", "json"]);
    expect(args("add").framework).toMatchObject({ type: "positional", required: true });
    expect(args("add").worker).toMatchObject({ type: "string" });
    expect(args("add").json).toMatchObject({ type: "boolean", default: false });
  });

  test("no screen-set flag carries a default, so `neither flag given` stays distinguishable", () => {
    // A default of false would make --no-auth unobservable and kill the "default to yes when the
    // capability is composed" rule; a default of true would scaffold broken imports on a worker without it.
    for (const screens of ["auth", "payments"]) {
      expect(args("add")[screens], screens).toMatchObject({ type: "boolean" });
      expect(args("add")[screens]?.default, screens).toBeUndefined();
    }
  });

  test("there are no provider flags — the sign-in screen reads pithy.config.ts instead", () => {
    for (const provider of ["google", "apple", "facebook", "github"]) {
      expect(Object.keys(args("add"))).not.toContain(provider);
    }
    expect(subcommand("add").meta).toBeDefined();
  });

  test("every subcommand is agent-drivable", () => {
    for (const name of ["add", "sync", "list"]) {
      expect(Object.keys(args(name)), name).toContain("json");
      expect(args(name).json, name).toMatchObject({ type: "boolean", default: false });
    }
  });

  test("sync takes the same --worker resolution as add", () => {
    expect(Object.keys(args("sync"))).toEqual(["worker", "json"]);
  });

  test("pithy registers it, lazily", async () => {
    const entry = (main.subCommands as Record<string, () => Promise<CommandDef>>).ui;
    expect(typeof entry).toBe("function");
    expect(await entry?.()).toBe(ui);
  });
});
