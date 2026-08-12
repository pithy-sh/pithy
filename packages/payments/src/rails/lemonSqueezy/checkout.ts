// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { PaymentsDiscountInvalidError, PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { CheckoutSessionInput, HostedSession } from "../contract";
import { type LemonSqueezyHttpFetch, lemonSqueezyHttpFetch, lemonSqueezyJson } from "./api";
import {
  accountReferenceProof,
  LEMON_SQUEEZY_CUSTOM_ACCOUNT,
  LEMON_SQUEEZY_CUSTOM_ENV,
  LEMON_SQUEEZY_CUSTOM_PROOF,
} from "./objects";

/**
 * Hosted checkout, and nothing else.
 *
 * Lemon Squeezy presents the payment page, takes the money as **merchant of record**, and owns the sales
 * tax, the VAT registration, the invoice and the dunning. Pithy sends a browser there and hears the outcome
 * on a webhook. That division is the whole reason this rail exists, and there is no card field anywhere in
 * this package.
 *
 * ## What this call stamps, and why each of them
 *
 * **The authenticated purchaser, in `checkout_data.custom`.** A Lemon Squeezy purchase is only ever heard
 * about through a webhook, and that webhook carries a `customer_id` and no Pithy user. This is the pairing,
 * and it is why the `/checkout` route takes the purchaser from `c.var.auth` and never from a request body: a
 * client that could name it could attach its purchase to somebody else's account, or somebody else's
 * purchase to its own.
 *
 * **This deployment's environment, in the same place.** A Lemon Squeezy store is one namespace across every
 * environment — test mode is a flag on an object, not a separate store — so `dev` and `staging` pointed at
 * one store hear each other's webhooks. The stamp is what lets each ignore the other's.
 *
 * **Both keys are snake_case.** Lemon Squeezy normalizes custom keys before echoing them back, so a
 * camelCase key sent is a snake_case key returned, and a reader looking for what it sent finds nothing. The
 * binding silently never happens. Both sides read the same two constants, and a round-trip test pins it.
 *
 * ## What it deliberately does not do
 *
 * No quantity, no discount code, no plan-change or proration logic, and no price. The variant *is* the
 * price — that is Lemon Squeezy's model — and a checkout that could name an amount would be a checkout a
 * client could name an amount on.
 */

/** What creating a checkout needs beyond the input: the credentials, the deployment, and the transport. */
export interface LemonSqueezyCheckoutOptions {
  /** The rail's credentials. `apiKey` creates the checkout; `storeId` says which store it belongs to. */
  credentials: PaymentsLemonSqueezyCredentials;
  /** This deployment's `ENVIRONMENT`, stamped so its own webhooks are recognisable. */
  deployment?: string;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
}

/** A created checkout, narrowed to the one field a browser needs. */
const LemonSqueezyCheckout = z
  .object({
    data: z
      .object({
        id: z.string().describe("The checkout's id."),
        attributes: z
          .object({ url: z.string().min(1).describe("The hosted page to send the browser to.") })
          .loose()
          .describe("The checkout's fields."),
      })
      .loose(),
  })
  .describe("A created Lemon Squeezy checkout, as much of it as a redirect needs.");

/** Create a hosted checkout for one product, and return where to send the browser. */
export async function createLemonSqueezyCheckoutSession(
  input: CheckoutSessionInput,
  options: LemonSqueezyCheckoutOptions,
): Promise<HostedSession> {
  const custom: Record<string, string> = { [LEMON_SQUEEZY_CUSTOM_ACCOUNT]: input.userId };
  if (options.deployment !== undefined) {
    custom[LEMON_SQUEEZY_CUSTOM_ENV] = options.deployment;
    // The proof, without which the two values above are worth nothing: a stranger can set them from a
    // public storefront buy link, and both key names are exported constants. This is the part they cannot
    // produce. See `accountReferenceProof`.
    custom[LEMON_SQUEEZY_CUSTOM_PROOF] = await accountReferenceProof(
      input.userId,
      options.deployment,
      options.credentials.webhookSecret,
    );
  }

  const created = await withDiscountRefusal(input.discountCode, () =>
    lemonSqueezyJson(options.transport ?? lemonSqueezyHttpFetch, "/checkouts", {
      what: "a checkout",
      apiKey: options.credentials.apiKey,
      body: {
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              // The authenticated purchaser, echoed back on every webhook this purchase produces.
              custom,
              // The code, handed over exactly as the caller typed it. Lemon Squeezy resolves it and computes
              // the price; nothing here validates it or multiplies anything. Unlike Stripe there is no id to
              // look up — the store takes the customer-facing string — so an unusable code is learned from
              // the store's own refusal, which `lemonSqueezyJson` surfaces below.
              ...(input.discountCode === undefined ? {} : { discount_code: input.discountCode }),
            },
            product_options: {
              redirect_url: input.successUrl,
            },
            checkout_options: {
              // Lemon Squeezy's own page, unembedded. Pithy owns no payment UI.
              embed: false,
            },
          },
          relationships: {
            store: { data: { type: "stores", id: options.credentials.storeId } },
            variant: { data: { type: "variants", id: input.providerProductId } },
          },
        },
      },
    }),
  );

  const parsed = LemonSqueezyCheckout.safeParse(created);
  if (!parsed.success) {
    // Lemon Squeezy created something and did not say where to send the browser. A redirect to an absent
    // URL is worse than a refusal the caller can retry.
    throw new PaymentsProviderUnavailableError({
      detail: "Lemon Squeezy created a checkout with no URL to redirect to.",
    });
  }
  return { url: parsed.data.data.attributes.url };
}

/**
 * Re-read a refused checkout as a refused *code*, when a code was sent.
 *
 * Lemon Squeezy takes the customer-facing string rather than an id, so there is no lookup to learn a bad
 * code from before the fact — the store's refusal of the whole checkout is the first news of it. Left alone
 * that surfaces as `payments/rail_not_configured`, which tells a customer this payment method is
 * unavailable when what actually happened is that their code was not accepted.
 *
 * The reclassification is narrow and its reasoning is the same one `api.ts` uses to call a 4xx a
 * configuration failure: **every other input to this request comes from config, the credential bundle, or a
 * row we wrote.** The discount code is the only caller-influenced value in it, so when one was sent and the
 * store refuses on the caller's side of the line, the code is what it refused. A 5xx or a 429 is untouched —
 * that is the store struggling, not judging — and so is a refusal when no code was sent at all.
 *
 * The store's own sentence rides in `detail` for the operator; the customer gets the code back and an action
 * they can take.
 */
async function withDiscountRefusal<T>(code: string | undefined, call: () => Promise<T>): Promise<T> {
  if (code === undefined) return await call();
  try {
    return await call();
  } catch (cause) {
    // A 401 or a 403 is our credentials, not their code, and `api.ts` folds both into
    // `rail_not_configured` — so reclassifying every one of those would tell a customer their perfectly
    // good code was rejected while the real fault is an API key nobody rotated. `detail` still carries the
    // status, which is what distinguishes them.
    const credentials = /with 40[13]\./.test(cause instanceof PithyError ? (cause.payload.detail ?? "") : "");
    if (cause instanceof PithyError && cause.payload.code === "payments/rail_not_configured" && !credentials) {
      throw new PaymentsDiscountInvalidError(
        {
          message: `"${code}" is not a discount code we can accept.`,
          detail: `Lemon Squeezy refused a checkout carrying discount code "${code}". ${cause.payload.detail ?? ""}`,
        },
        { cause },
      );
    }
    throw cause;
  }
}
