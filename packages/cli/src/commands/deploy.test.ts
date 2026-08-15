// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { MigrationFanOutOptions } from "../migrations/run";
import deploy from "./deploy";

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

/** The account the stubbed project names — a nickname *and* a pin, so both halves are asserted. */
const ACCOUNT = { accountName: "leed", accountId: "acct-leed" };

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  projectCloudflareAccount: async () => ACCOUNT,
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
  deployProject: async () => [],
}));

describe("deploy command", () => {
  test("the pending-migration count is resolved for the same account the deploy is", async () => {
    counted.calls.length = 0;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await deploy.run?.({ args: { env: "staging", json: true }, rawArgs: [] } as never);
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
      await deploy.run?.({ args: { json: true }, rawArgs: [] } as never);
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
      await deploy.run?.({ args: { env: "staging", json: true }, rawArgs: [] } as never);
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
