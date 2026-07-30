import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type { CheckoutSessionInput } from "../contract";
import { createStripeCheckoutSession } from "./checkout";
import {
  STRIPE_TEST_SECRET_KEY,
  STRIPE_TEST_WEBHOOK_SECRET,
  type StripeRecordedCall,
  type StripeStubAnswer,
  stripeStubTransport,
} from "./fixtures/events";

const CREDENTIALS: PaymentsStripeCredentials = {
  secretKey: STRIPE_TEST_SECRET_KEY,
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
};

const INPUT: CheckoutSessionInput = {
  providerProductId: "price_1Abc",
  subscription: true,
  userId: "ada",
  successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://acme.example/pricing",
};

const CREATED: StripeStubAnswer = {
  body: {
    id: "cs_test_pithyPro",
    object: "checkout.session",
    url: "https://checkout.stripe.com/c/pay/cs_test_pithyPro",
  },
};

/** Create a session and hand back both the answer and what was sent. */
async function create(input: Partial<CheckoutSessionInput> = {}, answer: StripeStubAnswer = CREATED) {
  const calls: StripeRecordedCall[] = [];
  const session = await createStripeCheckoutSession(
    { ...INPUT, ...input },
    { credentials: CREDENTIALS, transport: stripeStubTransport({ "/checkout/sessions": answer }, calls) },
  );
  return { session, sent: decodeURIComponent(calls[0]?.init?.body ?? ""), url: calls[0]?.url ?? "" };
}

/** The refusal a create produced. Fails the test when it succeeded. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("createStripeCheckoutSession", () => {
  test("returns the hosted URL Stripe answered with", async () => {
    const { session, url } = await create();
    expect(session.url).toBe("https://checkout.stripe.com/c/pay/cs_test_pithyPro");
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
  });

  test("names the purchaser in client_reference_id, which is the only hook back to a Pithy user", async () => {
    // A Stripe purchase is only ever heard about through a webhook, and that webhook carries `cus_…` and nothing
    // else. This value is what pairs the two, so it comes from the authenticated caller and from nowhere else.
    const { sent } = await create();
    expect(sent).toContain("client_reference_id=ada");
    expect(sent).toContain("metadata[pithy_account_reference]=ada");
  });

  test("stamps the reference onto the subscription too, so every later event carries it", async () => {
    // Stripe copies `subscription_data[metadata]` onto the subscription it creates, and `customer.subscription.*`
    // may be delivered before `checkout.session.completed`. Without this, a first renewal could arrive before the
    // pairing existed.
    const { sent } = await create();
    expect(sent).toContain("subscription_data[metadata][pithy_account_reference]=ada");
    // A subscription-mode session may not carry payment-intent parameters at all.
    expect(sent).not.toContain("payment_intent_data");
  });

  test("stamps the price, because a session payload never carries its line items", async () => {
    const { sent } = await create();
    expect(sent).toContain("metadata[pithy_price_id]=price_1Abc");
    expect(sent).toContain("line_items[0][price]=price_1Abc");
    expect(sent).toContain("line_items[0][quantity]=1");
  });

  test("a one-time product buys in payment mode, and stamps the payment intent instead", async () => {
    const { sent } = await create({ subscription: false, providerProductId: "price_1Coins" });
    expect(sent).toContain("mode=payment");
    expect(sent).toContain("payment_intent_data[metadata][pithy_price_id]=price_1Coins");
    expect(sent).not.toContain("subscription_data");
  });

  test("a subscription buys in subscription mode", async () => {
    expect((await create()).sent).toContain("mode=subscription");
  });

  test("reuses the customer this buyer already has", async () => {
    // One buyer, one Stripe customer. Without this every checkout mints a new one, and the billing portal a
    // buyer's first purchase created would not show their second.
    const { sent } = await create({ providerAccountId: "cus_PithyAda" });
    expect(sent).toContain("customer=cus_PithyAda");
    // Stripe refuses both together, and there is nothing to create.
    expect(sent).not.toContain("customer_creation");
  });

  test("asks Stripe to create a customer on a first one-time purchase", async () => {
    // Payment mode creates no customer by default, so a one-time buyer would never appear in the account map.
    const { sent } = await create({ subscription: false, providerAccountId: null });
    expect(sent).toContain("customer_creation=always");
  });

  test("sends the return URLs verbatim, template token and all", async () => {
    // `{CHECKOUT_SESSION_ID}` is Stripe's own placeholder, and rewriting an adopter's URL would be surprising.
    const { sent } = await create();
    expect(sent).toContain("success_url=https://acme.example/thanks?session={CHECKOUT_SESSION_ID}");
    expect(sent).toContain("cancel_url=https://acme.example/pricing");
  });

  test("a price Stripe does not have is rail_not_configured, with Stripe's own words", async () => {
    const error = await refusal(
      create(
        {},
        { status: 400, body: { error: { code: "resource_missing", message: "No such price: 'price_1Abc'" } } },
      ),
    );
    expect(error.payload.code).toBe("payments/rail_not_configured");
    expect(error.payload.detail).toContain("No such price");
    // The client is told the payment method is unavailable and nothing about our Stripe account.
    expect(error.payload.message).toBe("That payment method is not available.");
  });

  test("a session with no URL is provider_unavailable rather than a broken redirect", async () => {
    const error = await refusal(create({}, { body: { id: "cs_test_pithyPro", object: "checkout.session" } }));
    expect(error.payload.code).toBe("payments/provider_unavailable");
  });

  test("no refusal carries the secret key", async () => {
    const error = await refusal(create({}, { status: 401 }));
    expect(JSON.stringify(error.payload)).not.toContain(STRIPE_TEST_SECRET_KEY);
  });
});
