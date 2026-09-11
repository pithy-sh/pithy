// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import type { MigrationFanOutOptions } from "../migrations/run";
import deploy, { assertDeployFlags, deploySelection } from "./deploy";

/**
 * **`pithy deploy`'s pending-migration count resolved credentials for nobody in particular (#226).**
 *
 * The deploy itself has named its account since #206 — it is the pair handed to `wrangler deploy`, and
 * getting it wrong ships to another company's tenant and exits 0. But the warning line beside it goes
 * through the ledger read, which took the account as an *optional* parameter, and this command
 * omitted it. So one command resolved two different accounts in one run: the right one for the deploy,
 * the default file for the count. Best-effort is not the same as unattributed — a count read off
 * another account's D1 is a number about somebody else's schema, printed as though it were yours.
 */

/** The options every ledger read was handed. */
const counted = vi.hoisted(() => ({ calls: [] as unknown[] }));

/** What each half of the deploy was asked to do this run — the two named steps, observed. */
const ran = vi.hoisted(() => ({ apps: 0, kit: [] as unknown[] }));

/** The account the stubbed project names — a nickname *and* a pin, so both halves are asserted. */
const ACCOUNT = { accountName: "leed", accountId: "acct-leed" };

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  projectCloudflareAccount: async () => ACCOUNT,
  // The project name is a real read off `pithy.config.ts`, and this suite runs with the repository as
  // its cwd. The kit half needs one; what it is does not matter to any assertion here.
  loadProject: async () => ({ name: "acme" }),
  requireProjectName: () => "acme",
}));

vi.mock("../migrations/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrations/run")>()),
  readProjectLedger: async (options: unknown) => {
    counted.calls.push(options);
    return { pending: 0, undeclared: [] };
  },
}));

// Nothing is deployed here: the assertion is about what the count was told, and a real deploy would
// need wrangler, credentials, and an account this test must never reach.
vi.mock("../project/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/deploy")>()),
  deployProject: async () => {
    ran.apps += 1;
    return [];
  },
}));

// The kit half, observed rather than performed: what it would deploy is `deployKit.test.ts`'s subject,
// and what this file asks is which halves ran and what the payload carried.
vi.mock("../project/deployKit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/deployKit")>()),
  deployKitWorkers: async (options: unknown) => {
    ran.kit.push(options);
    return {
      workers: [{ capability: "email", worker: "acme-staging-email", outcome: "unchanged", reason: "current." }],
      problems: [],
    };
  },
}));

describe("deploy command", () => {
  test("the pending-migration count is resolved for the same account the deploy is", async () => {
    counted.calls.length = 0;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await deploy.run?.({
        args: { env: "staging", json: true, apps: true, kit: false, force: false },
        rawArgs: [],
      } as never);
    } finally {
      stdout.mockRestore();
    }
    expect(counted.calls).toHaveLength(1);
    expect((counted.calls[0] as MigrationFanOutOptions).account).toEqual(ACCOUNT);
  });

  // A bare `pithy deploy` ships each Worker's top-level stanza, whose schema is not the local dev D1 —
  // so there is no count to take, and no credential resolved for one either.
  test("a bare deploy takes no count at all", async () => {
    counted.calls.length = 0;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await deploy.run?.({ args: { json: true, apps: true, kit: false, force: false }, rawArgs: [] } as never);
    } finally {
      stdout.mockRestore();
    }
    expect(counted.calls).toEqual([]);
  });

  /**
   * **The count is best-effort; the account is not (#236).**
   *
   * `pendingFor` swallows every failure on purpose — a database it cannot reach costs a warning line, not
   * the deploy. An account mismatch is not a reachability failure: it is settled before the run begins,
   * and swallowed it becomes `pendingMigrations: null` in the `--json` line, an authoritative-looking
   * absence. So the account is settled ahead of it, and nothing best-effort ever sees the fault.
   */
  test("a pin the credentials contradict refuses before the count is even attempted", async () => {
    counted.calls.length = 0;
    const before = {
      config: process.env.PITHY_CONFIG_DIR,
      offline: process.env.PITHY_OFFLINE,
      account: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    };
    const configDir = await mkdtemp(join(tmpdir(), "pithy-deploy-config-"));
    process.env.PITHY_CONFIG_DIR = configDir;
    delete process.env.PITHY_OFFLINE;
    // The project pins `acct-leed`; the shell exported another tenant's pair hours ago. This is the
    // machine state that produced #236, verbatim.
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-somebody-else";
    process.env.CLOUDFLARE_API_TOKEN = "token-for-somebody-else";

    const written: string[] = [];
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture as never);
    // `withErrorReporting` renders the refusal and exits; the assertion is on what it rendered.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await deploy.run?.({
        args: { env: "staging", json: true, apps: true, kit: false, force: false },
        rawArgs: [],
      } as never);
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
      stdout.mockRestore();
      restoreEnv(before);
      await rm(configDir, { recursive: true, force: true });
    }

    const rendered = written.join("");
    expect(rendered).toContain("acct-leed");
    expect(rendered).toContain("acct-somebody-else");
    // The point of the test. The ledger read is best-effort and would have swallowed this refusal into a
    // missing number; it must never be reached, so ordering cannot be what keeps the refusal alive.
    expect(counted.calls).toEqual([]);
  });
});

/**
 * **A deploy is a deploy (#537).** `pithy deploy` ships the adopter's Workers *and* the kit's, and the
 * two are separate named steps so CI reads separate exit codes and a failure names which half broke.
 */
describe("deploySelection", () => {
  test("no selector is both halves — the whole project is what a deploy deploys", () => {
    expect(deploySelection({ apps: false, kit: false })).toEqual({ apps: true, kit: true });
  });

  test("--apps narrows to the adopter's Workers", () => {
    expect(deploySelection({ apps: true, kit: false })).toEqual({ apps: true, kit: false });
  });

  test("--kit narrows to the kit's", () => {
    expect(deploySelection({ apps: false, kit: true })).toEqual({ apps: false, kit: true });
  });

  test("both named is both, spelled out", () => {
    expect(deploySelection({ apps: true, kit: true })).toEqual({ apps: true, kit: true });
  });
});

describe("assertDeployFlags", () => {
  test("--apps --force is refused: the adopter's Workers were never gated", () => {
    expect(() => assertDeployFlags({ apps: true, kit: false, force: true, env: "prod" })).toThrowError(
      "--force has nothing to do with --apps.",
    );
  });

  test("--kit with no --env is refused, because a kit Worker is per environment", () => {
    expect(() => assertDeployFlags({ apps: false, kit: true, force: false })).toThrowError(
      "--kit needs an environment.",
    );
  });

  /**
   * **The rule is asked of the selection, not of the raw flags.**
   *
   * `deploySelection`'s own doc comment and `docs/commands/deploy.md` both say naming both halves is
   * the same as naming neither — and this was the one place that disagreed with them. `--apps --kit`
   * with no `--env` threw `--kit needs an environment.` while the identical selection typed as a bare
   * `pithy deploy` shipped `apps/` and printed the line saying the kit half needed one.
   */
  test("--apps --kit with no --env is a bare deploy, not a refusal", () => {
    expect(() => assertDeployFlags({ apps: true, kit: true, force: false })).not.toThrow();
  });

  test("--apps --kit --env dev is a bare deploy of dev, for the same reason", () => {
    expect(() => assertDeployFlags({ apps: true, kit: true, force: false, env: "dev" })).not.toThrow();
  });

  /**
   * **There is no deployed kit Worker in `dev`.** It is materialized under `.wrangler/pithy/hosts/`
   * and run by `pithy dev`, and `pithy <capability> provision` fans out over the managed environments
   * only. So a run narrowed to the kit half in `dev` has nothing whatever to do — and the action line
   * that used to offer `--env dev` steered the operator straight into a run that skipped every Worker
   * for having no `dev` address and exited 1.
   */
  test("--kit --env dev is refused, and the refusal names pithy dev", () => {
    const thrown = (() => {
      try {
        assertDeployFlags({ apps: false, kit: true, force: false, env: "dev" });
      } catch (error) {
        return error as PithyError;
      }
      return undefined;
    })();
    expect(thrown?.payload.message).toBe("--kit has nothing to deploy in dev.");
    expect(thrown?.payload.action).toBe(
      "Run pithy dev to run the kit's Workers locally, or pass --env staging or --env prod.",
    );
  });

  test("--force --env dev is refused too: there is no deploy to force", () => {
    expect(() => assertDeployFlags({ apps: false, kit: false, force: true, env: "dev" })).toThrowError(
      "--force has nothing to deploy in dev.",
    );
  });

  test("the no-env action line offers only the environments that have a kit Worker", () => {
    const thrown = (() => {
      try {
        assertDeployFlags({ apps: false, kit: true, force: false });
      } catch (error) {
        return error as PithyError;
      }
      return undefined;
    })();
    expect(thrown?.payload.action).toBe("Add --env staging or --env prod.");
  });

  test("--force with no --env is refused for the same reason", () => {
    expect(() => assertDeployFlags({ apps: false, kit: false, force: true })).toThrowError(
      "--force needs an environment.",
    );
  });

  test("a bare deploy still runs — it is the command's old behavior and it keeps working", () => {
    expect(() => assertDeployFlags({ apps: false, kit: false, force: false })).not.toThrow();
  });

  test("--kit --env is fine, and so is --apps --force's harmless sibling", () => {
    expect(() => assertDeployFlags({ apps: false, kit: true, force: true, env: "prod" })).not.toThrow();
    expect(() => assertDeployFlags({ apps: true, kit: false, force: false, env: "prod" })).not.toThrow();
  });
});

describe("the two halves", () => {
  /**
   * One run: what it printed, and the exit code it set.
   *
   * `process.exitCode` is put back either way — a command that failed would otherwise fail the whole
   * vitest process, which is also why it is read rather than left for the next test to find.
   */
  async function invokeRun(args: Record<string, unknown>): Promise<{ out: string; exitCode: unknown }> {
    ran.apps = 0;
    ran.kit.length = 0;
    const before = process.exitCode;
    process.exitCode = 0;
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      await deploy.run?.({
        args: { json: true, apps: false, kit: false, force: false, ...args },
        rawArgs: [],
      } as never);
    } finally {
      stdout.mockRestore();
    }
    const exitCode = process.exitCode;
    process.exitCode = before;
    return { out: written.join(""), exitCode };
  }

  /** The same run, when only the output matters. */
  async function invoke(args: Record<string, unknown>): Promise<string> {
    return (await invokeRun(args)).out;
  }

  test("no selector deploys both, and the payload carries a row per kit Worker", async () => {
    const line = JSON.parse(await invoke({ env: "staging" }));
    expect(ran.apps).toBe(1);
    expect(ran.kit).toHaveLength(1);
    expect(line.kit).toEqual([
      { capability: "email", worker: "acme-staging-email", outcome: "unchanged", reason: "current." },
    ]);
  });

  test("--apps touches no kit Worker, and says so by carrying no kit rows at all", async () => {
    const line = JSON.parse(await invoke({ env: "staging", apps: true }));
    expect(ran.apps).toBe(1);
    expect(ran.kit).toEqual([]);
    // `null`, not `[]`: the kit half did not run, which is a different fact from it finding nothing.
    expect(line.kit).toBeNull();
  });

  test("--kit touches nothing under apps/", async () => {
    const line = JSON.parse(await invoke({ env: "staging", kit: true }));
    expect(ran.apps).toBe(0);
    expect(ran.kit).toHaveLength(1);
    expect(line.workers).toEqual([]);
  });

  test("--force reaches the kit half, which is the only half a stamp gates", async () => {
    await invoke({ env: "staging", kit: true, force: true });
    expect((ran.kit[0] as { force?: boolean }).force).toBe(true);
  });

  /**
   * **`pithy deploy --env dev` exited 1 every time (#537).**
   *
   * `resolveWorkerAddress` answers `null` for `dev` unconditionally — a local run has no public
   * address — so every kit Worker became a `skipped` row saying it had no `dev` address, and an
   * all-skipped run fails the command. Meanwhile `docs/commands/deploy.md` listed `dev` as a valid
   * `--env` and this command's own action line offered it. The kit half simply has nothing to do in
   * `dev`: its Workers run locally under `pithy dev`. So it says that, and the run succeeds.
   */
  test("--env dev ships apps/ and says the kit's Workers are local — it does not fail", async () => {
    const { out, exitCode } = await invokeRun({ env: "dev", json: false });

    expect({ exitCode, appRuns: ran.apps, kitRuns: ran.kit.length, out }).toEqual({
      exitCode: 0,
      appRuns: 1,
      kitRuns: 0,
      out: "In dev the kit's Workers run locally under pithy dev, so none were deployed.\nDone.\n",
    });
  });

  test("--apps --env dev says nothing about the kit half, because nothing asked for it", async () => {
    const { out, exitCode } = await invokeRun({ env: "dev", apps: true, json: false });

    expect({ exitCode, out }).toEqual({ exitCode: 0, out: "Done.\n" });
  });

  // Naming both halves is naming neither, all the way through the command: the same run a bare
  // `pithy deploy` makes, down to the line it prints instead of deploying the kit's Workers.
  test("--apps --kit with no --env is a bare deploy, and says the kit half needed one", async () => {
    const { out, exitCode } = await invokeRun({ apps: true, kit: true, json: false });

    expect({ exitCode, appRuns: ran.apps, kitRuns: ran.kit.length, out }).toEqual({
      exitCode: 0,
      appRuns: 1,
      kitRuns: 0,
      out: "No --env, so the kit's Workers were not deployed. They are per environment — pass --env to ship them.\nDone.\n",
    });
  });

  test("the payload carries the kit half's problems beside its rows, and null when it did not run", async () => {
    expect(JSON.parse(await invoke({ env: "staging" })).kitProblems).toEqual([]);
    expect(JSON.parse(await invoke({ env: "staging", apps: true })).kitProblems).toBeNull();
    expect(JSON.parse(await invoke({ env: "dev" })).kitProblems).toBeNull();
  });

  test("a bare deploy ships apps/ and says out loud why the kit half did not run", async () => {
    ran.apps = 0;
    ran.kit.length = 0;
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      await deploy.run?.({ args: { json: false, apps: false, kit: false, force: false }, rawArgs: [] } as never);
    } finally {
      stdout.mockRestore();
    }
    expect(ran.apps).toBe(1);
    expect(ran.kit).toEqual([]);
    expect(written.join("")).toContain(
      "No --env, so the kit's Workers were not deployed. They are per environment — pass --env to ship them.",
    );
  });
});

/** Put back exactly what was there, `undefined` included — a leaked credential variable poisons the suite. */
function restoreEnv(before: { config?: string; offline?: string; account?: string; token?: string }): void {
  const entries: [string, string | undefined][] = [
    ["PITHY_CONFIG_DIR", before.config],
    ["PITHY_OFFLINE", before.offline],
    ["CLOUDFLARE_ACCOUNT_ID", before.account],
    ["CLOUDFLARE_API_TOKEN", before.token],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
