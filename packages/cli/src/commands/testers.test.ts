// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { CommandDef } from "citty";
import { beforeEach, describe, expect, test, vi } from "vitest";
import testers, { loadOptionalEmail } from "./testers";

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

/** The account the stubbed project names — a nickname *and* a pin, so both halves are asserted. */
const ACCOUNT = { accountName: "leed", accountId: "acct-leed" };

// Only the root config is stubbed. `requireProjectName` stays real, so this exercises the actual refusal.
// `projectCloudflareAccount` stands in for a config that names an account — the one source of a value.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => root.config,
  projectCloudflareAccount: async () => ACCOUNT,
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

/** The options every `openSeedDriver` call was handed. */
const opened = vi.hoisted(() => ({ calls: [] as unknown[] }));

// No Miniflare, no D1. The read commands only pass the handle through to the stubbed reader.
vi.mock("../seed/drivers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../seed/drivers")>()),
  openSeedDriver: async (options: unknown) => {
    opened.calls.push(options);
    return { d1: () => ({}), dispose: async () => {} };
  },
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

/**
 * **An installed-but-broken `@pithy-sh/email` is not an absent one (#230).**
 *
 * Two sites here loaded the email capability inside a bare `catch { … undefined }` — the enqueue seam
 * and the provisioner's sending identity. Both then reported `sends: false` and printed *"no email
 * capability is configured in this project."* That sentence is true for exactly one of the four
 * failures the catch admits, and wrong for the three that mean the package is right there: a
 * dependency that does not resolve, an export map that does not, and source that will not parse.
 *
 * That is the class #217 closed one level down, and `classifyCapabilityLoadFailure` is the function it
 * left behind (`docs/CONVENTIONS.md` §Refusals). Tested here as a pure function against real cause
 * shapes, per the same convention: the runtime the suite reaches is not the runtime that ships, so a
 * classifier reachable only through an integration path is tested for neither.
 */
describe("the optional email import classifies rather than asserts", () => {
  /** Node's shape for a package that is not installed. */
  const missingPackage = (specifier: string) =>
    Object.assign(new Error(`Cannot find package '${specifier}' imported from /somewhere/testers.ts`), {
      code: "ERR_MODULE_NOT_FOUND",
    });

  test("absent is the one thing that answers undefined", async () => {
    expect(
      await loadOptionalEmail(() => {
        throw missingPackage("@pithy-sh/email");
      }),
    ).toBeUndefined();
  });

  test("a resolved load is passed straight through", async () => {
    expect(await loadOptionalEmail(async () => ({ ok: true }))).toEqual({ ok: true });
  });

  // The #207 bug, one level up: the package is installed, something it imports is not, and `pithy add
  // email` reinstalls what is already there.
  test("installed with an unresolved dependency refuses, and does not claim absence", async () => {
    const thrown = await loadOptionalEmail(() => {
      throw missingPackage("some-transitive-dep");
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ValidationError);
    const { message, action } = (thrown as ValidationError).payload;
    expect(message).not.toMatch(/not installed/i);
    expect(action).toContain("some-transitive-dep");
    expect(action).not.toMatch(/pithy add email/);
  });

  test("installed and unparseable refuses, naming the package rather than the remedy for absence", async () => {
    const thrown = await loadOptionalEmail(() => {
      throw new SyntaxError("Unexpected token '}'");
    }).catch((error: unknown) => error);
    expect((thrown as ValidationError).payload.message).toBe("The email capability is installed and will not load.");
  });

  test("installed with a bad export map refuses as incomplete, not as absent", async () => {
    const thrown = await loadOptionalEmail(() => {
      throw Object.assign(new Error('Subpath is not defined by "exports"'), {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      });
    }).catch((error: unknown) => error);
    expect((thrown as ValidationError).payload.message).toBe("The email capability is installed but incomplete.");
  });

  // The `bin` ships on Bun, whose `ResolveMessage` is not `instanceof Error`. Vitest runs on Node, so a
  // fixture built out of `Error` proves nothing about the runtime adopters use.
  test("a Bun-shaped ResolveMessage for the package itself is still an absence", async () => {
    expect(
      await loadOptionalEmail(() => {
        throw { name: "ResolveMessage", message: "Could not resolve", specifier: "@pithy-sh/email" };
      }),
    ).toBeUndefined();
  });

  test("a Bun-shaped ResolveMessage for a dependency is not", async () => {
    const thrown = await loadOptionalEmail(() => {
      throw { name: "ResolveMessage", message: "Could not resolve", specifier: "react-email" };
    }).catch((error: unknown) => error);
    expect((thrown as ValidationError).payload.action).toContain("react-email");
  });
});

/**
 * **A remote seed driver writes rows into a real D1 and objects into a real R2 (#226, #230).**
 *
 * `openSeedDriver`'s own doc comment calls its `account` the #206 guard against writing this project's
 * fixtures into another company's tenant. It was optional, and the roster commands never passed it — so
 * `pithy testers roster --env production` resolved `<config>/cloudflare.json` and reached whatever
 * account that file happened to hold. `buildProvisioner` in this same file had named its account since
 * #206; the door beside it had not.
 */
describe("the roster commands open the driver for the account the project names", () => {
  beforeEach(() => {
    opened.calls.length = 0;
  });

  test.each(["list", "roster", "status"])("%s", async (name) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await subcommand(name).run?.({ args: { env: "dev", json: true, cohort: COHORT.name }, rawArgs: [] } as never);
    } finally {
      stdout.mockRestore();
    }
    expect(opened.calls).toHaveLength(1);
    expect((opened.calls[0] as { account?: unknown }).account).toEqual(ACCOUNT);
  });
});
