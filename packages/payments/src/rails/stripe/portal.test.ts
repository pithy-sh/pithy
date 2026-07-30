import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type { PortalSessionInput } from "../contract";
import {
  STRIPE_TEST_SECRET_KEY,
  STRIPE_TEST_WEBHOOK_SECRET,
  type StripeRecordedCall,
  type StripeStubAnswer,
  stripeStubTransport,
} from "./fixtures/events";
import { createStripePortalSession } from "./portal";

const CREDENTIALS: PaymentsStripeCredentials = {
  secretKey: STRIPE_TEST_SECRET_KEY,
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
};

const INPUT: PortalSessionInput = {
  providerAccountId: "cus_PithyAda",
  returnUrl: "https://acme.example/account",
};

const CREATED: StripeStubAnswer = {
  body: { id: "bps_1Pithy", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/live_abc" },
};

async function create(input: Partial<PortalSessionInput> = {}, answer: StripeStubAnswer = CREATED) {
  const calls: StripeRecordedCall[] = [];
  const session = await createStripePortalSession(
    { ...INPUT, ...input },
    { credentials: CREDENTIALS, transport: stripeStubTransport({ "/billing_portal/sessions": answer }, calls) },
  );
  return { session, sent: decodeURIComponent(calls[0]?.init?.body ?? ""), url: calls[0]?.url ?? "" };
}

async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

describe("createStripePortalSession", () => {
  test("returns the hosted URL for the customer it was asked about", async () => {
    const { session, sent, url } = await create();
    expect(session.url).toBe("https://billing.stripe.com/p/session/live_abc");
    expect(url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(sent).toContain("customer=cus_PithyAda");
    expect(sent).toContain("return_url=https://acme.example/account");
  });

  test("sends nothing but the customer and the return URL", async () => {
    // The portal's contents — what a subscriber may cancel, switch, or download — are configured in Stripe's
    // dashboard, not here. Pithy never owns plan changes or proration, and a parameter that decided them would be
    // exactly that.
    const { sent } = await create();
    expect(
      sent
        .split("&")
        .map((pair) => pair.split("=")[0])
        .sort(),
    ).toEqual(["customer", "return_url"]);
  });

  test("an unconfigured Billing Portal is rail_not_configured, with Stripe's own words", async () => {
    // The failure every adopter hits once: the portal has to be configured in the dashboard before a session can
    // be created. 404 reads as "not available here", which is exactly true, and `detail` says how to fix it.
    const error = await refusal(
      create(
        {},
        {
          status: 400,
          body: {
            error: {
              code: "resource_missing",
              message: "No configuration provided and your test mode default configuration has not been created.",
            },
          },
        },
      ),
    );
    expect(error.payload.code).toBe("payments/rail_not_configured");
    expect(error.payload.detail).toContain("default configuration has not been created");
  });

  test("a customer Stripe does not have is rail_not_configured, not a 500", async () => {
    const error = await refusal(create({}, { status: 404, body: { error: { code: "resource_missing" } } }));
    expect(error.payload.code).toBe("payments/rail_not_configured");
  });

  test("a session with no URL is provider_unavailable", async () => {
    expect((await refusal(create({}, { body: { id: "bps_1Pithy" } }))).payload.code).toBe(
      "payments/provider_unavailable",
    );
  });

  test("no refusal carries the secret key", async () => {
    expect(JSON.stringify((await refusal(create({}, { status: 500 }))).payload)).not.toContain(STRIPE_TEST_SECRET_KEY);
  });
});
