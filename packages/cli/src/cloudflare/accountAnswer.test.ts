// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { answerOnConfirmedAccount, findOnConfirmedAccount } from "./accountAnswer";

/**
 * The three states, and the one that used to be spelled the same as another (#378).
 *
 * Every literal account id below is written out here rather than imported or composed. A gate that built
 * its expectation from the code under test would pass whatever that code did with it.
 */
describe("answerOnConfirmedAccount", () => {
  test("a hit on a confirmed account is `found`, carrying what the listing returned", async () => {
    const answer = await answerOnConfirmedAccount({
      accountId: "acct-ours",
      confirmation: "pinned",
      what: "the acme-prod-secrets Worker",
      find: async () => ({ id: "acme-prod-secrets" }),
    });
    expect(answer).toEqual({ state: "found", value: { id: "acme-prod-secrets" } });
  });

  test("a miss on a confirmed account is `absent` — a fact a teardown may act on", async () => {
    for (const confirmation of ["pinned", "named", "recorded"] as const) {
      const answer = await answerOnConfirmedAccount({
        accountId: "acct-ours",
        confirmation,
        what: "the acme-prod-secrets Worker",
        find: async () => null,
      });
      expect(answer).toEqual({ state: "absent" });
    }
  });

  test("an unconfirmed account is `unconfirmed`, not `absent` — the two used to be one empty array", async () => {
    const answer = await answerOnConfirmedAccount({
      accountId: "acct-stranger",
      confirmation: "ambient",
      what: "the acme-prod-secrets Worker",
      find: async () => null,
    });
    expect(answer).toEqual({ state: "unconfirmed", accountId: "acct-stranger" });
  });

  test("the listing is never asked when nothing vouches for the account", async () => {
    const find = vi.fn(async () => null);
    await answerOnConfirmedAccount({
      accountId: "acct-stranger",
      confirmation: "ambient",
      what: "the acme-prod-secrets Worker",
      find,
    });
    expect(find).not.toHaveBeenCalled();
  });
});

describe("findOnConfirmedAccount", () => {
  test("hands back the value on a hit and null on a confirmed miss", async () => {
    expect(
      await findOnConfirmedAccount({
        accountId: "acct-ours",
        confirmation: "recorded",
        what: "the acme-prod-secrets Worker",
        find: async () => ({ id: "acme-prod-secrets" }),
      }),
    ).toEqual({ id: "acme-prod-secrets" });
    expect(
      await findOnConfirmedAccount({
        accountId: "acct-ours",
        confirmation: "recorded",
        what: "the acme-prod-secrets Worker",
        find: async () => null,
      }),
    ).toBeNull();
  });

  test("refuses on an unconfirmed account, naming that account id and changing nothing", async () => {
    const refusal = await findOnConfirmedAccount({
      accountId: "acct-stranger",
      confirmation: "ambient",
      what: "the acme-prod-secrets Worker",
      find: async () => null,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(PithyError);
    const payload = (refusal as PithyError).payload;
    expect(payload.message).toBe(
      "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.",
    );
    expect(payload.code).toBe("core/conflict");
    // The remedy is the operator's, so it is an `action` — and it is one line of config, either way.
    expect(payload.action).toContain("cloudflare.accountId");
    expect(payload.action).toContain("cloudflare.accountName");
  });

  test("the thing being looked for stays in `detail`, which the display boundary strips", async () => {
    const refusal = (await findOnConfirmedAccount({
      accountId: "acct-stranger",
      confirmation: "ambient",
      what: "the acme-prod-secrets Worker",
      find: async () => null,
    }).catch((error: unknown) => error)) as PithyError;

    expect(refusal.payload.detail).toContain("the acme-prod-secrets Worker");
    expect(refusal.payload.message).not.toContain("acme-prod-secrets");
  });
});
