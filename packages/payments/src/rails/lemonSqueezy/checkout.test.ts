// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { CheckoutSessionInput } from "../contract";
import type { LemonSqueezyHttpFetch, LemonSqueezyHttpRequest } from "./api";
import { createLemonSqueezyCheckoutSession } from "./checkout";
import { LEMON_SQUEEZY_CUSTOM_ACCOUNT, LEMON_SQUEEZY_CUSTOM_ENV } from "./objects";

const CREDENTIALS: PaymentsLemonSqueezyCredentials = {
  apiKey: "ls_api_test",
  webhookSecret: "ls_whsec_test",
  storeId: "42",
};

const INPUT: CheckoutSessionInput = {
  providerProductId: "55555",
  subscription: true,
  userId: "user-ada",
  providerAccountId: null,
  successUrl: "https://acme.test/thanks",
};

interface Call {
  url: string;
  init: LemonSqueezyHttpRequest | undefined;
}

/** A transport answering with a created checkout, recording what it was asked. */
function stub(body?: unknown, status = 201): LemonSqueezyHttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const answer = body ?? {
    data: { type: "checkouts", id: "co_1", attributes: { url: "https://acme.lemonsqueezy.com/buy/abc" } },
  };
  const fetcher: LemonSqueezyHttpFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(answer)),
    });
  };
  return Object.assign(fetcher, { calls });
}

/** The parsed request body of the first call. */
function sent(transport: { calls: Call[] }): Record<string, unknown> {
  return JSON.parse(transport.calls[0]?.init?.body ?? "{}") as Record<string, unknown>;
}

/** The `checkout_data.custom` object the request stamped. */
function stamped(transport: { calls: Call[] }): Record<string, unknown> {
  const data = sent(transport).data as { attributes: { checkout_data: { custom: Record<string, unknown> } } };
  return data.attributes.checkout_data.custom;
}

describe("createLemonSqueezyCheckoutSession", () => {
  test("returns the hosted page to send the browser to", async () => {
    const transport = stub();
    const session = await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
    expect(session.url).toBe("https://acme.lemonsqueezy.com/buy/abc");
    expect(transport.calls[0]?.url).toContain("/checkouts");
  });

  test("names the variant from the catalog and the store from the credentials", async () => {
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
    const data = sent(transport).data as {
      relationships: { variant: { data: { id: string } }; store: { data: { id: string } } };
    };
    expect(data.relationships.variant.data.id).toBe("55555");
    expect(data.relationships.store.data.id).toBe("42");
  });

  test("stamps the authenticated purchaser, so the webhook arrives already bound to a user", async () => {
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
    expect(stamped(transport)[LEMON_SQUEEZY_CUSTOM_ACCOUNT]).toBe("user-ada");
  });

  test("stamps this deployment, so a store shared across environments can be told apart", async () => {
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, {
      credentials: CREDENTIALS,
      deployment: "staging",
      transport,
    });
    expect(stamped(transport)[LEMON_SQUEEZY_CUSTOM_ENV]).toBe("staging");
  });

  test("omits the environment stamp when this deployment does not know its own name", async () => {
    // Rather than stamping an empty string, which would fence against the literal "" and match nothing.
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
    expect(LEMON_SQUEEZY_CUSTOM_ENV in stamped(transport)).toBe(false);
  });

  test("every stamped key is snake_case, because that is what Lemon Squeezy echoes back", async () => {
    // The silent failure this prevents: send `pithyEnv`, read `pithy_env`, never match, and every purchase
    // arrives orphaned with nothing in any log to say why.
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, {
      credentials: CREDENTIALS,
      deployment: "prod",
      transport,
    });
    for (const key of Object.keys(stamped(transport))) {
      expect(key).toBe(key.toLowerCase());
      expect(key).not.toMatch(/[A-Z]/);
    }
  });

  test("sends no price, no quantity and no discount — the variant is the price", async () => {
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
    const body = transport.calls[0]?.init?.body ?? "";
    expect(body).not.toMatch(/"(price|custom_price|quantity|discount_code)"/);
  });

  test("refuses when Lemon Squeezy creates a checkout with no URL", async () => {
    const transport = stub({ data: { type: "checkouts", id: "co_1", attributes: {} } });
    await expect(
      createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport }),
    ).rejects.toBeInstanceOf(PithyError);
  });

  test("a rejected API key is a configuration failure, not something to retry forever", async () => {
    const transport = stub({ errors: [{ status: "401", title: "Unauthorized" }] }, 401);
    try {
      await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      if (error instanceof PithyError) expect(error.payload.code).toBe("payments/rail_not_configured");
    }
  });

  test("a 500 is retryable, because Lemon Squeezy is up and not answering", async () => {
    const transport = stub({ errors: [{ status: "500", title: "Server Error" }] }, 500);
    try {
      await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      if (error instanceof PithyError) expect(error.payload.code).toBe("payments/provider_unavailable");
    }
  });

  test("no refusal carries the API key into an operator's log", async () => {
    const secret = "ls_api_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const transport = stub({ errors: [{ status: "401", title: `key ${secret} rejected` }] }, 401);
    try {
      await createLemonSqueezyCheckoutSession(INPUT, { credentials: { ...CREDENTIALS, apiKey: secret }, transport });
      throw new Error("expected a refusal");
    } catch (error) {
      const detail = error instanceof PithyError ? (error.payload.detail ?? "") : "";
      expect(detail).not.toContain(secret);
    }
  });
});
