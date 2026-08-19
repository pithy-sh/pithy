// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { payments as paymentsCapability } from "@pithy-sh/payments/src/capability";
import type { CommandDef } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ResolvedWorker } from "../project/workerScope";
import payments from "./payments";

/**
 * The project name is resolved at this command edge, and both payments names lead with it — the deployed
 * reconcile worker and the Workflow it hosts. `reconcile` needs it as much as `provision` does: it starts
 * a Workflow on the worker whose name it recomputes, so a guessed name reaches a script that does not
 * exist, and the answer would be a raw Cloudflare error rather than the one line that explains it.
 *
 * And `--rail` is the other edge: the flag is a plain string until the params schema parses it, so this is
 * where a rail the kit ships either reaches the Workflow or is refused in the terminal. Every rail runs the
 * same path, so the test for the fourth is the test for the first.
 */

const root = vi.hoisted(() => ({ config: {} as { name?: string } }));

/** What the mocked Workflows client was asked to dispatch — the pass that would have run. */
const dispatched = vi.hoisted(() => ({ calls: [] as { name: string; params: unknown }[] }));

/** The project's Workers, as `loadPaymentsConfig` and the audit emitter discover them. */
const scope = vi.hoisted(() => ({ workers: [] as unknown[] }));

// The one hop `reconcile` makes off this machine. Replaced rather than the provisioner itself, so the
// command's own wiring — the credentials, the catalog, the Workflow name — is exercised for real.
vi.mock("@pithy-sh/cloudflare/src/workflows/workflowsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/workflows/workflowsClient")>()),
  CloudflareWorkflowsClient: class {
    async dispatchAndPoll(name: string, params: unknown): Promise<unknown> {
      dispatched.calls.push({ name, params });
      return { scanned: 4, drifted: 0, unchanged: 4, skipped: 0, failed: 0 };
    }
  },
}));

// Capabilities are per Worker, and there is no `apps/` under the test runner's cwd. The set is supplied
// here so the catalog the command serializes is a real `payments()` capability.
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => scope.workers,
}));

// Belt and braces: no credentials resolve, so nothing here can reach a real Cloudflare account even if the
// name check is ever moved later in the command. The refusal under test is local and comes first anyway.
vi.mock("@pithy-sh/cloudflare/src/env/devVars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/env/devVars")>()),
  loadCloudflareEnv: () => ({}),
}));

// Only the root config is stubbed. `requireProjectName` stays real, so this exercises the actual refusal.
// The account goes with it: this project pins none, which is what makes the credentials come from the
// environment the test stubs rather than from whatever `cloudflare.json` this machine holds.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => root.config,
  projectCloudflareAccount: async () => null,
}));

function subcommand(name: string): CommandDef {
  const entry = (payments.subCommands as Record<string, CommandDef>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return entry;
}

/** Run a subcommand to its first failure and return the `--json` error payload it reported. */
async function failure(
  name: string,
  args: Record<string, unknown>,
  // `action` is the operator half of the payload and `operatorError` puts it on the `--json` line. Declared
  // optional because not every refusal carries one, and asserted where a test is about what to do next.
): Promise<{ code: string; message: string; action?: string }> {
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

/** Run a subcommand to completion and return the single `--json` line it wrote to stdout. */
async function succeed(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await subcommand(name).run?.({ args, rawArgs: [] } as never);
  } finally {
    stdout.mockRestore();
  }
  return JSON.parse(lines.join("")) as Record<string, unknown>;
}

/**
 * A one-Worker project selling one product through Lemon Squeezy — the catalog the command serializes and
 * the capability `loadPaymentsConfig` finds. Built through `payments()` rather than as a literal, so a
 * catalog this test accepts is one the capability accepts.
 */
function lemonSqueezyWorker(): ResolvedWorker[] {
  const capability = paymentsCapability({
    billingSubject: "user",
    rails: { lemonSqueezy: true },
    lemonSqueezy: { successUrl: "https://app.example.com/thanks" },
    products: {
      pro_monthly: {
        type: "subscription",
        name: "Pro",
        entitlements: ["pro"],
        lemonSqueezy: { variantId: "123456" },
      },
    },
  });
  return [
    { name: "board", dir: "/nowhere/apps/board", config: {}, capabilities: [capability], target: {} },
  ] as unknown as ResolvedWorker[];
}

describe("pithy payments", () => {
  beforeEach(() => {
    root.config = {};
    dispatched.calls = [];
    scope.workers = [];
  });

  test("provision refuses a project with no name, before it reaches Cloudflare", async () => {
    const error = await failure("provision", { json: true });
    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });

  test("reconcile refuses a project with no name rather than dispatching to a guessed worker", async () => {
    const error = await failure("reconcile", { json: true, env: "staging", "dry-run": true });
    expect(error.message).toBe("pithy.config.ts has no `name`.");
  });
});

/**
 * `--rail`, headlessly. The flag is a plain citty string, so the params schema is the only thing standing
 * between what somebody typed and a Workflow instance — which makes the accepted spelling a property of
 * this command rather than of the package it parses with.
 */
describe("pithy payments reconcile --rail", () => {
  beforeEach(() => {
    root.config = { name: "acme" };
    dispatched.calls = [];
    scope.workers = lemonSqueezyWorker();
    // Credentials for the account this project does not pin — `cloudflareEnv` overlays the environment
    // per key, and the unit-test config unsets all four.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    vi.stubEnv("SECRETS_STORE_ID", "store-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("lemonSqueezy reaches the deployed Workflow, like every rail before it", async () => {
    const line = await succeed("reconcile", {
      json: true,
      env: "staging",
      rail: "lemonSqueezy",
      "dry-run": false,
    });

    // Dispatched by the Workflow's own name — the CLI has no bindings — with the rail exactly as typed.
    expect(dispatched.calls).toEqual([{ name: "acme-staging-payments-reconcile", params: { rail: "lemonSqueezy" } }]);
    expect(line).toEqual({
      command: "payments reconcile",
      env: "staging",
      report: { scanned: 4, drifted: 0, unchanged: 4, skipped: 0, failed: 0 },
    });
  });

  test("a dry run narrowed to one holder and lemonSqueezy carries both, and writes nothing", async () => {
    await succeed("reconcile", {
      json: true,
      env: "staging",
      subject: "user:ada",
      rail: "lemonSqueezy",
      "dry-run": true,
    });

    expect(dispatched.calls[0]?.params).toEqual({
      subjectType: "user",
      subjectId: "ada",
      rail: "lemonSqueezy",
      dryRun: true,
    });
  });

  test("an organization is as narrow a holder as a person", async () => {
    await succeed("reconcile", { json: true, env: "staging", subject: "organization:acme" });

    expect(dispatched.calls[0]?.params).toEqual({ subjectType: "organization", subjectId: "acme" });
  });

  test("a bare id is refused here, because it names whichever holder happens to carry it", async () => {
    // The shape somebody types from memory, and the one a lenient read would answer about the wrong holder
    // for. `user` and `organization` id spaces are not disjoint, so `ada` is a question with two answers.
    const error = await failure("reconcile", { json: true, env: "staging", subject: "ada" });

    expect(error.message).toContain('"ada" does not name a holder.');
    expect(error.action).toContain("--subject user:<id>");
    expect(dispatched.calls).toEqual([]);
  });

  test("the kebab spelling is refused here, not by a Workflow that already started", async () => {
    // `lemon-squeezy` is the webhook path, and the rail is `lemonSqueezy`. The one place kebab is right is
    // the URL, so the plausible typo gets the two-line refusal rather than a stack trace.
    const error = await failure("reconcile", { json: true, env: "staging", rail: "lemon-squeezy" });

    expect(error.code).toBe("validation/invalid_input");
    expect(error.message).toContain("lemonSqueezy");
    expect(dispatched.calls).toEqual([]);
  });
});
