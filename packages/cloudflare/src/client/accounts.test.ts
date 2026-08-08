// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { CfAccount, listCloudflareAccounts } from "./accounts";

/** A source that yields whatever the API is pretending to have returned. Nothing here reaches Cloudflare. */
function source(...records: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const record of records) yield record;
    },
  };
}

describe("listCloudflareAccounts", () => {
  test("reads the accounts a token can see, name-sorted so a picker is stable between runs", async () => {
    const accounts = await listCloudflareAccounts({
      apiToken: "tok",
      accounts: () => source({ id: "b2", name: "Zeta" }, { id: "a1", name: "Acme" }),
    });
    expect(accounts).toEqual([
      { id: "a1", name: "Acme" },
      { id: "b2", name: "Zeta" },
    ]);
  });

  test("a record that is not an account is dropped rather than handed on as one", async () => {
    // The account id becomes `cloudflare.accountId` in a repository and the account every resource is
    // created under. A record missing either field is not one this may guess at.
    const accounts = await listCloudflareAccounts({
      apiToken: "tok",
      accounts: () => source({ id: "a1" }, { name: "No id" }, { id: 7, name: "Numeric" }, { id: "b2", name: "Real" }),
    });
    expect(accounts).toEqual([{ id: "b2", name: "Real" }]);
  });

  test("a token that cannot list accounts fails as a PithyError, never as a raw throw", async () => {
    const failing = await listCloudflareAccounts({
      apiToken: "tok",
      accounts: () => {
        throw new Error("Authentication error");
      },
    }).catch((error: unknown) => error);
    expect(failing).toBeInstanceOf(PithyError);
  });

  test("an empty account list is an answer, not a failure", async () => {
    expect(await listCloudflareAccounts({ apiToken: "tok", accounts: () => source() })).toEqual([]);
  });

  test("stops at the cap, so a token seeing hundreds does not become an unbounded walk", async () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      id: `id-${index}`,
      name: `acct-${String(index).padStart(3, "0")}`,
    }));
    const accounts = await listCloudflareAccounts({ apiToken: "tok", accounts: () => source(...many) });
    expect(accounts).toHaveLength(100);
  });
});

describe("CfAccount", () => {
  test("keeps only the two fields anything here uses", () => {
    expect(CfAccount.parse({ id: "a1", name: "Acme", settings: { enforce_twofactor: true } })).toEqual({
      id: "a1",
      name: "Acme",
    });
  });
});
