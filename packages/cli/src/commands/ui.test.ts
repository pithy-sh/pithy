// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "../main";
import type { UiSyncReport } from "../ui/flow";
import ui from "./ui";

/** What the stubbed `runUiSync` answers. Rewritten per test; the command is the subject, not the flow. */
const stub = vi.hoisted(() => ({
  report: {
    worker: "board",
    before: [],
    after: [],
    changed: false,
    uncovered: [],
    unstyled: [],
    notFoundHandling: "single-page-application",
  } as UiSyncReport,
}));

vi.mock("../ui/flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/flow")>()),
  runUiSync: async () => stub.report,
}));

vi.mock("./add", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./add")>()),
  targetWorker: async () => ({ dir: "/project/apps/board", name: "replay-board", config: { capabilities: [] } }),
}));

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

  test("sync takes the same --worker resolution as add, plus the --check CI gate", () => {
    expect(Object.keys(args("sync"))).toEqual(["worker", "check", "json"]);
    // Defaulted, and defaulted to writing: a stale allowlist answers with the SPA shell and a 200, so
    // the repair is the ordinary run and the check is the one you ask for.
    expect(args("sync").check).toMatchObject({ type: "boolean", default: false });
  });

  test("pithy registers it, lazily", async () => {
    const entry = (main.subCommands as Record<string, () => Promise<CommandDef>>).ui;
    expect(typeof entry).toBe("function");
    expect(await entry?.()).toBe(ui);
  });
});

/**
 * **The report can fail a run (#401).**
 *
 * It could not before: the unstyled check ran once at `pithy ui add`, printed to stdout, and left the
 * exit status alone. A warning nothing acts on and nothing repeats is not a gate, and it had been read
 * as one. Stating the invariant is not proving it, so this drives the command and reads the exit.
 */
describe("ui sync --check turns a finding into an exit code", () => {
  /** Drive `pithy ui sync` with the stubbed flow: the exit status it left behind, and what it printed. */
  async function runSync(check: boolean): Promise<{ exit: number | undefined; output: string }> {
    process.exitCode = undefined;
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await (subcommand("sync").run as (context: { args: Record<string, unknown> }) => Promise<void>)({
        args: { check, json: false },
      });
    } finally {
      spy.mockRestore();
    }
    return { exit: process.exitCode, output: written.join("") };
  }

  afterEach(() => {
    process.exitCode = undefined;
    stub.report = { ...stub.report, uncovered: [], unstyled: [] };
  });

  test("a screen with no rules exits 1, and the classes are named", async () => {
    stub.report = { ...stub.report, unstyled: ["divider", "stack"] };
    const { exit, output } = await runSync(true);
    expect(exit).toBe(1);
    expect(output).toContain("divider");
    expect(output).toContain("stack");
    // Not "there are 2 problems". The list is the fix.
    expect(output).toContain("restore src/pithy-screens.css");
  });

  test("and a worker whose screens are all styled exits clean", async () => {
    // The calibration. Without it the reading above passes on a command that exits 1 unconditionally,
    // which is the same output as a gate and none of the meaning.
    stub.report = { ...stub.report, unstyled: [] };
    expect((await runSync(true)).exit).toBeUndefined();
  });

  test("the writing run says so and does not fail — it is the repair, not the gate", async () => {
    // `pithy ui sync` with no flag is somebody fixing an allowlist. Exiting 1 there would break every
    // script that runs the fix, over a stylesheet the command never touched.
    stub.report = { ...stub.report, unstyled: ["divider", "stack"] };
    const { exit, output } = await runSync(false);
    expect(exit).toBeUndefined();
    expect(output).toContain("divider");
  });
});
