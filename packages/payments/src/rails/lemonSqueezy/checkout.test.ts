// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { encodeSubjectReference } from "../../data/subject";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { CheckoutSessionInput } from "../contract";
import type { LemonSqueezyHttpFetch, LemonSqueezyHttpRequest } from "./api";
import { createLemonSqueezyCheckoutSession } from "./checkout";
import {
  accountReferenceOf,
  accountReferenceProof,
  LEMON_SQUEEZY_CUSTOM_ACCOUNT,
  LEMON_SQUEEZY_CUSTOM_ENV,
  LEMON_SQUEEZY_CUSTOM_PROOF,
  type LemonSqueezyWebhook,
} from "./objects";

const CREDENTIALS: PaymentsLemonSqueezyCredentials = {
  apiKey: "ls_api_test",
  webhookSecret: "ls_whsec_test",
  storeId: "42",
};

const INPUT: CheckoutSessionInput = {
  providerProductId: "55555",
  subscription: true,
  subject: { subjectType: "user", subjectId: "ada" },
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

/** A delivery envelope carrying nothing but the `custom_data` under test — all `accountReferenceOf` reads. */
function webhookCarrying(custom: Record<string, unknown>): LemonSqueezyWebhook {
  return { meta: { event_name: "order_created", custom_data: custom }, data: { id: "1", attributes: {} } };
}

describe("createLemonSqueezyCheckoutSession", () => {
  test("returns the hosted page to send the browser to", async () => {
    const transport = stub();
    const session = await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
    // The `redirect` member, named. A rail with a hosted page says so, so a screen narrows rather than guesses.
    expect(session).toEqual({ kind: "redirect", url: "https://acme.lemonsqueezy.com/buy/abc" });
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

  test("stamps the resolved subject, so the webhook arrives already naming a holder", async () => {
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, transport });
    // Both halves, as `encodeSubjectReference` writes them. Never the id alone — nothing keeps an
    // organization id from equalling some user's, and the far end would have to guess which it had.
    expect(stamped(transport)[LEMON_SQUEEZY_CUSTOM_ACCOUNT]).toBe("user:ada");
  });

  test("an organization stamps its own kind", async () => {
    const transport = stub();
    await createLemonSqueezyCheckoutSession(
      { ...INPUT, subject: { subjectType: "organization", subjectId: "ada" } },
      { credentials: CREDENTIALS, transport },
    );
    expect(stamped(transport)[LEMON_SQUEEZY_CUSTOM_ACCOUNT]).toBe("organization:ada");
  });

  test("what checkout stamps is what the webhook reader honors — the loop, both ends visible", async () => {
    const transport = stub();
    await createLemonSqueezyCheckoutSession(INPUT, { credentials: CREDENTIALS, deployment: "prod", transport });
    const custom = stamped(transport) as Record<string, string>;
    expect(await accountReferenceOf(webhookCarrying(custom), "prod", CREDENTIALS.webhookSecret)).toBe("user:ada");
  });

  test("a bare id binds nobody, proof and all — the shape a pre-subject build stamped", async () => {
    // Authentic and still nobody: the MAC is one this deployment's own secret produced, and the reference
    // is what every checkout wrote before subjects. Reading it as a user is how one holder's purchase
    // lands on whoever else holds that id, so the strict decoder refuses it and the purchase orphans.
    const reference = "ada";
    const bare = {
      [LEMON_SQUEEZY_CUSTOM_ACCOUNT]: reference,
      [LEMON_SQUEEZY_CUSTOM_ENV]: "prod",
      [LEMON_SQUEEZY_CUSTOM_PROOF]: await accountReferenceProof(reference, "prod", CREDENTIALS.webhookSecret),
    };
    expect(await accountReferenceOf(webhookCarrying(bare), "prod", CREDENTIALS.webhookSecret)).toBeNull();

    // Anti-vacuity: the same id encoded, proven the same way, does bind.
    const encoded = encodeSubjectReference({ subjectType: "user", subjectId: reference });
    const paired = {
      [LEMON_SQUEEZY_CUSTOM_ACCOUNT]: encoded,
      [LEMON_SQUEEZY_CUSTOM_ENV]: "prod",
      [LEMON_SQUEEZY_CUSTOM_PROOF]: await accountReferenceProof(encoded, "prod", CREDENTIALS.webhookSecret),
    };
    expect(await accountReferenceOf(webhookCarrying(paired), "prod", CREDENTIALS.webhookSecret)).toBe(encoded);
  });

  test("a kind this build does not know binds nobody either", async () => {
    const reference = "team:ada";
    const unknown = {
      [LEMON_SQUEEZY_CUSTOM_ACCOUNT]: reference,
      [LEMON_SQUEEZY_CUSTOM_ENV]: "prod",
      [LEMON_SQUEEZY_CUSTOM_PROOF]: await accountReferenceProof(reference, "prod", CREDENTIALS.webhookSecret),
    };
    expect(await accountReferenceOf(webhookCarrying(unknown), "prod", CREDENTIALS.webhookSecret)).toBeNull();
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
