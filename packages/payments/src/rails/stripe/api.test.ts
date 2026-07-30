import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  STRIPE_API_BASE,
  STRIPE_API_VERSION,
  type StripeHttpFetch,
  type StripeHttpRequest,
  stripeForm,
  stripeJson,
} from "./api";
import { STRIPE_TEST_SECRET_KEY } from "./fixtures/events";

/** One recorded call, so a test can assert what left the Worker rather than only what came back. */
interface Recorded {
  url: string;
  init?: StripeHttpRequest;
}

/** A transport that records the call and answers with whatever the case wants. */
function transport(answer: { ok?: boolean; status?: number; body?: string }, calls: Recorded[] = []): StripeHttpFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      text: async () => answer.body ?? "{}",
    };
  };
}

/** The refusal a call produced. Fails the test when the call succeeded. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

const call = (options: Parameters<typeof stripeJson>[2], answer: Parameters<typeof transport>[0] = {}) => {
  const calls: Recorded[] = [];
  return { calls, result: stripeJson(transport(answer, calls), "/checkout/sessions", options) };
};

describe("stripeForm", () => {
  test("encodes a flat object", () => {
    expect(stripeForm({ mode: "payment", customer: "cus_1" })).toBe("mode=payment&customer=cus_1");
  });

  test("encodes Stripe's bracket notation for arrays of objects", () => {
    // The shape every Stripe create call needs, and the one reason this encoder exists: `line_items[0][price]`
    // is not something `URLSearchParams` produces on its own.
    expect(stripeForm({ line_items: [{ price: "price_1", quantity: 1 }] })).toBe(
      "line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1",
    );
  });

  test("encodes nested objects to any depth", () => {
    expect(stripeForm({ subscription_data: { metadata: { pithy_account_reference: "ada" } } })).toBe(
      "subscription_data%5Bmetadata%5D%5Bpithy_account_reference%5D=ada",
    );
  });

  test("encodes booleans as Stripe reads them", () => {
    expect(stripeForm({ allow_promotion_codes: true, expand: ["subscription"] })).toBe(
      "allow_promotion_codes=true&expand%5B0%5D=subscription",
    );
  });

  test("drops undefined and null rather than sending an empty string", () => {
    // Stripe treats an empty value as "unset this field", so sending one for an absent optional parameter would
    // be a different request from omitting it.
    expect(stripeForm({ customer: undefined, client_reference_id: null, mode: "payment" })).toBe("mode=payment");
  });

  test("escapes values, so a URL in a parameter cannot break out of the encoding", () => {
    expect(stripeForm({ success_url: "https://acme.example/ok?s={CHECKOUT_SESSION_ID}&a=b" })).toBe(
      "success_url=https%3A%2F%2Facme.example%2Fok%3Fs%3D%7BCHECKOUT_SESSION_ID%7D%26a%3Db",
    );
  });
});

describe("stripeJson", () => {
  test("authenticates with the secret key and pins the API version", async () => {
    // The version is pinned because Stripe's account default decides response shapes. An account upgraded in the
    // dashboard would otherwise silently change what this code parses.
    const { calls, result } = call({ what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY });
    await result;
    expect(calls[0]?.url).toBe(`${STRIPE_API_BASE}/checkout/sessions`);
    expect(calls[0]?.init?.headers?.authorization).toBe(`Bearer ${STRIPE_TEST_SECRET_KEY}`);
    expect(calls[0]?.init?.headers?.["stripe-version"]).toBe(STRIPE_API_VERSION);
  });

  test("a form body makes it a POST with the form content type", async () => {
    const { calls, result } = call({
      what: "a Checkout Session",
      secretKey: STRIPE_TEST_SECRET_KEY,
      form: { mode: "payment" },
    });
    await result;
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]?.init?.body).toBe("mode=payment");
  });

  test("no form means a GET with no body at all", async () => {
    const { calls, result } = call({ what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY });
    await result;
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers?.["content-type"]).toBeUndefined();
  });

  test("a query is encoded onto the URL in Stripe's own notation", async () => {
    const { calls, result } = call({
      what: "a Checkout Session",
      secretKey: STRIPE_TEST_SECRET_KEY,
      query: { expand: ["subscription"] },
    });
    await result;
    expect(calls[0]?.url).toBe(`${STRIPE_API_BASE}/checkout/sessions?expand%5B0%5D=subscription`);
  });

  test("returns the parsed body", async () => {
    const { result } = call(
      { what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY },
      { body: JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }) },
    );
    expect(await result).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  });

  test("a transport that throws is provider_unavailable", async () => {
    const failing: StripeHttpFetch = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const error = await refusal(
      stripeJson(failing, "/checkout/sessions", { what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY }),
    );
    expect(error.payload.code).toBe("payments/provider_unavailable");
    expect(error.payload.status).toBe(503);
  });

  test("a 5xx or a 429 is provider_unavailable — the one shape a caller should retry", async () => {
    for (const status of [429, 500, 502, 503]) {
      const { result } = call({ what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY }, { ok: false, status });
      expect((await refusal(result)).payload.code).toBe("payments/provider_unavailable");
    }
  });

  test("a 401 is rail_not_configured — a rejected key is provisioning, not an outage", async () => {
    // 503 would tell the caller to retry a call that will never succeed until somebody rotates a secret.
    const { result } = call(
      { what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY },
      { ok: false, status: 401, body: JSON.stringify({ error: { type: "invalid_request_error" } }) },
    );
    const error = await refusal(result);
    expect(error.payload.code).toBe("payments/rail_not_configured");
    expect(error.payload.detail).toContain("secret key");
  });

  test("a 400 carries Stripe's own words for the operator", async () => {
    // "No such price" is the failure an adopter will actually hit, and the only useful thing in a log is Stripe's
    // sentence and the parameter it blamed.
    const { result } = call(
      { what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY },
      {
        ok: false,
        status: 400,
        body: JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "resource_missing",
            param: "line_items[0][price]",
            message: "No such price: 'price_nope'",
          },
        }),
      },
    );
    const error = await refusal(result);
    expect(error.payload.code).toBe("payments/rail_not_configured");
    expect(error.payload.detail).toContain("resource_missing");
    expect(error.payload.detail).toContain("No such price: 'price_nope'");
    expect(error.payload.detail).toContain("line_items[0][price]");
  });

  test("a key that leaked into Stripe's message is redacted before it reaches a log", async () => {
    // Stripe redacts keys in its own error text, but `detail` is written to an operator's logs and a secret that
    // arrives in one is a secret in a log. Cheap to make certain of.
    const { result } = call(
      { what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY },
      {
        ok: false,
        status: 401,
        body: JSON.stringify({
          error: { message: `Invalid API Key provided: ${STRIPE_TEST_SECRET_KEY}, and whsec_abc123 too` },
        }),
      },
    );
    const detail = (await refusal(result)).payload.detail ?? "";
    expect(detail).not.toContain(STRIPE_TEST_SECRET_KEY);
    expect(detail).not.toContain("whsec_abc123");
    expect(detail).toContain("sk_test_…");
  });

  test("no refusal ever carries the secret key", async () => {
    for (const status of [400, 401, 404, 500]) {
      const { result } = call({ what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY }, { ok: false, status });
      expect(JSON.stringify((await refusal(result)).payload)).not.toContain(STRIPE_TEST_SECRET_KEY);
    }
  });

  test("a 404 is undefined only for a caller that said it was probing", async () => {
    const probing = call(
      { what: "the Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY, absentOn404: true },
      { ok: false, status: 404 },
    );
    expect(await probing.result).toBeUndefined();

    const notProbing = call(
      { what: "the Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY },
      { ok: false, status: 404 },
    );
    expect((await refusal(notProbing.result)).payload.code).toBe("payments/rail_not_configured");
  });

  test("a non-JSON body is provider_unavailable, never an absent resource", async () => {
    // A proxy's HTML error page is the realistic shape of this. Reading it as "no such subscription" would revoke
    // somebody's access.
    const { result } = call({ what: "a Checkout Session", secretKey: STRIPE_TEST_SECRET_KEY }, { body: "<html>502" });
    expect((await refusal(result)).payload.code).toBe("payments/provider_unavailable");
  });

  test("names what it was fetching, so a log line says which call failed", async () => {
    const { result } = call({ what: "a Billing Portal session", secretKey: STRIPE_TEST_SECRET_KEY }, { body: "nope" });
    expect((await refusal(result)).payload.detail).toContain("a Billing Portal session");
  });
});
