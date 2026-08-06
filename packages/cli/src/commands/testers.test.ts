// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Logger } from "@pithy-sh/core/src/logger/logger";
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

/** Every argument each read command handed `readCohort`, so the sixth can be inspected. */
const roster = vi.hoisted(() => ({ readCohortCalls: [] as unknown[][] }));

const COHORT = { id: "c1", name: "closed-test", targetSize: 20, windowDays: 14, closedAt: null };

// The optional package, stubbed at the CLI's one guarded-import seam. Enough surface for the three read
// commands to run to their `--json` line and no more.
vi.mock("../capabilities/testersLoader", () => ({
  loadTesters: async () => ({
    isTestersCapability: (capability: { name: string }) => capability.name === "testers",
    testersDatabase: () => ({}),
    listCohorts: async () => [COHORT],
    resolveCohortRef: async () => COHORT,
    listSnapshots: async () => [],
    toCohortView: () => ({ name: COHORT.name, members: [] }),
    readCohort: async (...args: unknown[]) => {
      roster.readCohortCalls.push(args);
      return { cohort: COHORT, clock: { estimatedOptedInCount: 3, estimatedHeldDays: 2 }, readings: [], events: [] };
    },
  }),
}));

// `projectCapabilities` stays real — only the filesystem scan is stubbed.
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => [
    {
      name: "api",
      dir: "/does/not/exist",
      capabilities: [{ name: "testers", testersConfig: { activeWithinDays: 7 } }],
    },
  ],
}));

// No Miniflare, no D1. The read commands only pass the handle through to the stubbed reader.
vi.mock("../seed/drivers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../seed/drivers")>()),
  openSeedDriver: async () => ({ d1: () => ({}), dispose: async () => {} }),
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

/**
 * When the activity read fails, `resolveActivity` marks the whole roster unobservable and every tester
 * reads "never signed in" — identical to a cohort nobody ever used. The only thing that tells them apart
 * is the `warn` the reader emits, and it goes nowhere unless the command supplies a logger. All three
 * read commands once called `readCohort` with five arguments and printed the plausible answer in silence.
 */
describe("the read commands hand readCohort a logger", () => {
  beforeEach(() => {
    roster.readCohortCalls.length = 0;
  });

  // `--json` keeps stdout to one parseable line; the logger it builds still writes to stderr at `warn`
  // (pinned by terminal/logger.test.ts), so the degradation reaches the developer either way.
  test.each([
    ["list", {}],
    ["roster", { cohort: COHORT.name }],
    ["status", { cohort: COHORT.name }],
  ])("%s", async (name, extra) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await subcommand(name).run?.({ args: { env: "dev", json: true, ...extra }, rawArgs: [] } as never);
    } finally {
      stdout.mockRestore();
    }
    expect(roster.readCohortCalls).toHaveLength(1);
    const log = roster.readCohortCalls[0]?.[5] as Logger | undefined;
    expect(typeof log?.warn).toBe("function");
  });
});
