// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
});
