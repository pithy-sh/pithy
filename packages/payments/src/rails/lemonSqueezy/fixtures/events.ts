// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  accountReferenceProof,
  LEMON_SQUEEZY_CUSTOM_ACCOUNT,
  LEMON_SQUEEZY_CUSTOM_ENV,
  LEMON_SQUEEZY_CUSTOM_PROOF,
} from "../objects";

/**
 * Lemon Squeezy deliveries, built rather than checked in as JSON.
 *
 * Built because every one of them has to be *signed*, and a signature is over exact bytes: a checked-in
 * JSON file plus a checked-in signature would be a pair that silently stops matching the moment either is
 * reformatted, and the test would still pass by verifying the wrong thing. So a fixture produces the body
 * and the test signs it with the same secret it hands the rail — verification is exercised for real.
 *
 * The shapes are Lemon Squeezy's own, trimmed to the fields this rail reads and the ones that prove it
 * reads the right one. `test_mode: false` throughout, because the projection refuses across environments
 * and every test that is not about that axis wants a production purchase.
 */

/** The store's ids, fixed so a test can assert on the exact namespaced key a row is written under. */
export const SUBSCRIPTION_ID = "90001";
export const INVOICE_ONE = "8001";
export const INVOICE_TWO = "8002";
export const ORDER_ID = "7001";
export const CUSTOMER_ID = 700;
export const VARIANT_ID = 55555;

/** The purchaser this deployment stamped into the checkout, echoed back by the store on every delivery. */
// An encoded subject reference, the exact string `encodeSubjectReference` produces (#412). A bare id is
// what this was, and the strict decoder now refuses one — a fixture carrying the old shape would prove a
// binding that production no longer makes.
export const ACCOUNT_REFERENCE = "user:ada";

/** What the fences are tested against. */
export const THIS_DEPLOYMENT = "staging";

/** The signing secret every fixture is minted against, matching what the tests hand the rail. */
export const FIXTURE_WEBHOOK_SECRET = "ls_whsec_test";

/**
 * The `meta.custom_data` a delivery carries when our own checkout created the purchase — **proof included**.
 *
 * The proof is computed with the real function rather than hard-coded, so a fixture cannot drift from the
 * verifier and quietly stop exercising it. `forge` mints the two public values with no proof, which is
 * exactly what a stranger can build from a storefront buy link.
 */
async function custom(
  deployment: string | undefined = THIS_DEPLOYMENT,
  options: { forge?: boolean } = {},
): Promise<Record<string, string>> {
  const data: Record<string, string> = { [LEMON_SQUEEZY_CUSTOM_ACCOUNT]: ACCOUNT_REFERENCE };
  if (deployment !== undefined) {
    data[LEMON_SQUEEZY_CUSTOM_ENV] = deployment;
    if (options.forge !== true) {
      data[LEMON_SQUEEZY_CUSTOM_PROOF] = await accountReferenceProof(
        ACCOUNT_REFERENCE,
        deployment,
        FIXTURE_WEBHOOK_SECRET,
      );
    }
  }
  return data;
}

/** One delivery envelope. */
async function delivery(
  eventName: string,
  id: string,
  type: string,
  attributes: Record<string, unknown>,
  options: { deployment?: string | undefined; stamped?: boolean; forge?: boolean } = {},
): Promise<string> {
  const meta: Record<string, unknown> = { event_name: eventName, test_mode: false };
  if (options.stamped !== false) meta.custom_data = await custom(options.deployment, { forge: options.forge });
  return JSON.stringify({ meta, data: { type, id, attributes } });
}

/** A subscription object, as `subscription_*` delivers it. */
export function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store_id: 1,
    customer_id: CUSTOMER_ID,
    variant_id: VARIANT_ID,
    status: "active",
    renews_at: "2026-02-01T10:00:00.000000Z",
    ends_at: null,
    created_at: "2026-01-01T10:00:00.000000Z",
    updated_at: "2026-01-01T10:00:00.000000Z",
    test_mode: false,
    ...overrides,
  };
}

/** A subscription-invoice object, as `subscription_payment_*` delivers it. Carries no `variant_id`. */
export function invoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store_id: 1,
    subscription_id: Number(SUBSCRIPTION_ID),
    customer_id: CUSTOMER_ID,
    status: "paid",
    refunded: false,
    refunded_at: null,
    currency: "USD",
    total: 999,
    created_at: "2026-01-01T10:00:05.000000Z",
    updated_at: "2026-01-01T10:00:05.000000Z",
    test_mode: false,
    ...overrides,
  };
}

/** An order object, as `order_*` delivers it. */
export function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store_id: 1,
    customer_id: CUSTOMER_ID,
    status: "paid",
    refunded: false,
    refunded_at: null,
    currency: "USD",
    total: 4900,
    first_order_item: { variant_id: VARIANT_ID },
    created_at: "2026-03-01T09:00:00.000000Z",
    updated_at: "2026-03-01T09:00:00.000000Z",
    test_mode: false,
    ...overrides,
  };
}

/** A subscription-domain delivery. */
export async function subscriptionDelivery(
  eventName: string,
  overrides: Record<string, unknown> = {},
  options: { deployment?: string | undefined; stamped?: boolean; forge?: boolean } = {},
): Promise<string> {
  return await delivery(eventName, SUBSCRIPTION_ID, "subscriptions", subscription(overrides), options);
}

/** An invoice-domain delivery. */
export async function invoiceDelivery(
  eventName: string,
  id: string = INVOICE_ONE,
  overrides: Record<string, unknown> = {},
  options: { deployment?: string | undefined; stamped?: boolean; forge?: boolean } = {},
): Promise<string> {
  return await delivery(eventName, id, "subscription-invoices", invoice(overrides), options);
}

/** An order-domain delivery. */
export async function orderDelivery(
  eventName: string,
  overrides: Record<string, unknown> = {},
  options: { deployment?: string | undefined; stamped?: boolean; forge?: boolean } = {},
): Promise<string> {
  return await delivery(eventName, ORDER_ID, "orders", order(overrides), options);
}

/** A delivery of a type this build does not map — a licence key, say. */
export async function unknownDelivery(): Promise<string> {
  return await delivery("license_key_created", "42", "license-keys", {
    status: "active",
    created_at: "2026-04-01T00:00:00Z",
  });
}

/** The JSON:API answer `GET /v1/subscriptions/{id}` gives, for the transport stub. */
export function subscriptionResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: { type: "subscriptions", id: SUBSCRIPTION_ID, attributes: subscription(overrides) },
  });
}

/** The JSON:API answer `GET /v1/orders/{id}` gives. */
export function orderResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ data: { type: "orders", id: ORDER_ID, attributes: order(overrides) } });
}
