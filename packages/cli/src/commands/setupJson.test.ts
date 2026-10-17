// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import type { SetupResult } from "../setup/run";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * **What `pithy setup --json` writes, held to the schema `pithy schema setup` publishes (#764).** One line, one
 * outcome, in each of its shapes. The steps are `setup/run.ts`'s and are replaced here by the result they return,
 * so what runs is the command's own body: the outcome it derives and the keys it publishes.
 */

const results = vi.hoisted(() => ({ next: undefined as unknown as SetupResult }));

vi.mock("../setup/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../setup/run")>()),
  setupCheckout: async () => results.next,
}));

const PATH = "/home/you/.config/pithy/acme/secrets.jsonc";
const INSTALL = {
  packageManager: "bun" as const,
  lockfile: "bun.lock",
  command: "bun",
  args: ["install", "--frozen-lockfile"],
};

function ready(overrides: Partial<Exclude<SetupResult, { blocked: string }>> = {}): SetupResult {
  return {
    dryRun: false,
    project: "acme",
    install: INSTALL,
    secrets: { path: PATH, minted: ["SECRETS_ENCRYPTION_KEYS"], adopted: [], refused: [] },
    migrations: ["0100_secrets_0001_init"],
    plannedMigrations: [],
    dev: {
      dev: {
        version: 1,
        branch: "main",
        ports: { index: 0, base: 8787, size: 20 },
        workers: { "acme-api": { port: 8787, origin: "http://localhost:8787" } },
      },
      allocated: true,
      devVars: [`${process.cwd()}/apps/api`],
      devVarsDirs: [`${process.cwd()}/apps/api`],
      seededSecrets: [],
      notes: [],
    },
    seed: { state: "held", held: [{ worker: "acme-api", binding: "DB", table: "pithy_auth_users" }] },
    seedReport: null,
    external: ["auth-github-client-secret"],
    notes: [],
    changed: true,
    ...overrides,
  };
}

async function line(): Promise<Record<string, unknown>> {
  return JSON.parse((await runCaptured("setup", ["--json"])).join("")) as Record<string, unknown>;
}

describe("pithy setup --json conforms to its published payload", () => {
  test("a run that set the checkout up", async () => {
    results.next = ready();
    await expectConforms("setup", await runCaptured("setup", ["--json"]));
    const written = await line();
    expect(written.outcome).toBe("ready");
    expect(written.devVarsWritten).toEqual(["apps/api"]);
    expect(written.next).toEqual([
      { command: "pithy dev", why: "Setup starts nothing. The Workers run under pithy dev." },
    ]);
    expect("plan" in written).toBe(false);
  });

  test("a run that found it set up says unchanged", async () => {
    results.next = ready({ changed: false });
    await expectConforms("setup", await runCaptured("setup", ["--json"]));
    expect((await line()).outcome).toBe("unchanged");
  });

  test("a dry run carries the plan and no next step", async () => {
    results.next = ready({ dryRun: true, changed: false });
    await expectConforms("setup", await runCaptured("setup", ["--dry-run", "--json"]));
    const written = await line();
    expect(written.outcome).toBe("planned");
    expect(written.plan).toBeDefined();
    expect("next" in written).toBe(false);
  });

  test("a dry run that could plan only the install", async () => {
    results.next = { dryRun: true, install: INSTALL, blocked: "Cannot find package '@pithy-sh/auth'." };
    await expectConforms("setup", await runCaptured("setup", ["--dry-run", "--json"]));
    const written = await line();
    expect(written.outcome).toBe("blocked");
    expect(written.blocked).toBe("Cannot find package '@pithy-sh/auth'.");
  });
});

describe("pithy setup is dev only, without exception", () => {
  test("no flag names an environment or an account", async () => {
    const setup = (await import("./setup")).default as { args?: Record<string, unknown> };
    expect(Object.keys(setup.args ?? {}).sort()).toEqual(["dry-run", "json", "skip-install"]);
  });
});
