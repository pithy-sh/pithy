// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";
import { beforeEach, describe, expect, test, vi } from "vitest";
import testers from "./testers";

/**
 * The project name is resolved at this command edge, and the provisioning subcommands lead every name
 * with it — the daily-pass host, its Workflow, and the `<project>-global-email-suppressions` database the
 * pass reads to reconcile bounced addresses. The roster subcommands provision nothing and need no name;
 * only `provision` and `deprovision` refuse without one.
 */

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

function subcommand(name: string): CommandDef {
  const entry = (testers.subCommands as Record<string, CommandDef>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return entry;
}

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

describe("pithy testers", () => {
  beforeEach(() => {
    root.config = {};
  });

  test("provision refuses a project with no name, before it reaches Cloudflare", async () => {
    const error = await failure("provision", { json: true });
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });

  test("deprovision refuses a project with no name rather than deleting nothing and exiting 0", async () => {
    const error = await failure("deprovision", { json: true });
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });
});
