// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { accountCredentials, accountVarsReader, accountVarWriter } from "./accountVars";

const KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;

describe("the stamp reader for a project's account", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("no pair is no reader", async () => {
    expect(accountCredentials(null)).toBeUndefined();
    expect(await accountVarsReader(null)).toBeUndefined();
    expect(await accountVarWriter(null)).toBeUndefined();
  });

  test("half a pair is no reader either", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    expect(accountCredentials(null)).toBeUndefined();
  });

  test("a whole pair is the pair, and a reader", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.CLOUDFLARE_API_TOKEN = "token";
    expect(accountCredentials(null)).toEqual({ accountId: "acct", apiToken: "token" });
    expect(typeof (await accountVarsReader(null))).toBe("function");
    expect(typeof (await accountVarWriter(null))).toBe("function");
  });
});
