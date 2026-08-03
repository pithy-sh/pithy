// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";
import { beforeEach, describe, expect, test, vi } from "vitest";
import vector from "./vector";

const root = vi.hoisted(() => ({ config: {} as { name?: string } }));

// Belt and braces: no credentials resolve, so nothing here can reach a real Cloudflare account even if the
// name check is ever moved later in the command. The refusal under test is local and comes first anyway.
vi.mock("@pithy-sh/cloudflare/src/env/devVars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/env/devVars")>()),
  loadCloudflareEnv: () => ({}),
}));

// Only the root config is stubbed. `requireProjectName` stays real, so this exercises the actual refusal.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => root.config,
}));

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

/**
 * The project name is resolved at this command edge, and every index name leads with it. An index is
 * *found by name and reused*, so a guessed project (the alphabetically first worker, the directory
 * basename) would let one project embed its corpus into another's index. The name is required, not
 * guessed, and the refusal comes before a single Cloudflare call.
 */
describe("pithy vector — the project name", () => {
  /** Run a subcommand to its first failure and return the `--json` error payload it reported. */
  async function failure(name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    // withErrorReporting exits the process after reporting; throwing instead keeps the run in this test.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    try {
      await expect(subcommand(name).run?.({ args, rawArgs: [] } as never)).rejects.toThrow("exited");
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
    return JSON.parse(lines.join("")).error;
  }

  beforeEach(() => {
    root.config = {};
  });

  test("provision refuses a project with no name, before it reaches Cloudflare", async () => {
    const error = await failure("provision", { json: true, env: "dev" });
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });

  test("reprocess refuses a project with no name rather than re-embedding a guessed index", async () => {
    const error = await failure("reprocess", { json: true, env: "dev", all: false });
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });
});
