// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { PaymentsDiscountInvalidError, PaymentsRailNotConfiguredError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { CheckoutHandoff, CheckoutSessionInput } from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";
import {
  accountReferenceProof,
  PADDLE_CUSTOM_ACCOUNT,
  PADDLE_CUSTOM_ENV,
  PADDLE_CUSTOM_PROOF,
  PaddleTransaction,
} from "./objects";

/**
 * Checkout: one server path, three ways of handing it to a browser.
 *
 * The server does the same thing in every mode — `POST /transactions` with the price from the catalog,
 * the customer when the buyer has one, the ownership stamp, and the resolved discount. What differs is
 * only the handoff: `hosted` returns `transaction.checkout.url`, and `overlay` and `inline` return the
 * transaction for Paddle.js to open in place.
 *
 * ## What this call stamps, and why each of them
 *
 * **The authenticated purchaser, in `custom_data.pithy_user`.** A Paddle purchase is heard about through
 * a webhook carrying `ctm_…` and no Pithy user. This is the pairing, and it is why the `/checkout` route
 * takes the purchaser from `c.var.auth` and never from a request body.
 *
 * **This deployment's environment, beside it.** `dev` is not publicly routable, so a dev checkout's
 * webhooks land at `staging`, and both point at one Paddle sandbox with one set of destinations. The
 * stamp is what lets each ignore the other's traffic.
 *
 * **A MAC over both, which is the only part that makes either mean anything.** `Paddle.Checkout.open`
 * accepts `customData` beside an `items[]` array of price ids with nothing but the publishable client
 * token — the token this rail ships to every browser that loads a paywall. So a stranger can write the
 * first two values. They cannot write the third. See `objects.ts`.
 *
 * ## The idempotency key
 *
 * `Paddle-Idempotency-Key`, derived from the buyer, the price and the deployment. A double-submitted buy
 * button then creates one transaction rather than two — enforced by Paddle rather than by a check here,
 * which is the only place it can be enforced, since the two requests may land on different isolates.
 *
 * ## What it deliberately does not do
 *
 * No quantity, no amount, no proration, no plan change. The price *is* the price — that is Paddle's model
 * — and a checkout that could name an amount would be a checkout a client could name an amount on.
 */

/** What creating a checkout needs beyond the input. */
export interface PaddleCheckoutOptions {
  /** The rail's credentials. `apiKey` creates the transaction; `webhookSecret` keys the ownership proof. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to sell through. */
  environment: PaddleEnvironment;
  /** The publishable client token a browser initializes Paddle.js with. */
  clientToken: string;
  /** Which of the three modes this project uses. */
  checkout: "overlay" | "inline" | "hosted";
  /** This deployment's `ENVIRONMENT`, stamped so its own webhooks are recognisable. */
  deployment?: string;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/** Paddle's discount list, narrowed to the id a transaction needs. */
const PaddleDiscountMatches = z.array(z.object({ id: z.string().min(1) }).loose());

/** Create a checkout for one product, and say how the browser reaches it. */
export async function createPaddleCheckoutSession(
  input: CheckoutSessionInput,
  options: PaddleCheckoutOptions,
): Promise<CheckoutHandoff> {
  const transport = options.transport ?? paddleHttpFetch;

  // Resolved before the transaction is created, so an unusable code is refused as a *code* rather than
  // surfacing later as a checkout that failed with nothing to say.
  const discountId =
    input.discountCode === undefined ? undefined : await resolveDiscount(input.discountCode, options, transport);

  const custom: Record<string, string> = { [PADDLE_CUSTOM_ACCOUNT]: input.userId };
  if (options.deployment !== undefined) {
    custom[PADDLE_CUSTOM_ENV] = options.deployment;
    custom[PADDLE_CUSTOM_PROOF] = await accountReferenceProof(
      input.userId,
      options.deployment,
      options.credentials.webhookSecret,
    );
  }

  const answer = await paddleJson(transport, "/transactions", {
    what: "a transaction",
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    // Derived, not random. A retry of the same buy click must carry the same key or the header buys
    // nothing; two different buyers, prices or deployments must differ or one would suppress the other.
    //
    // **The discount code is in the key**, and its absence was a defect rather than a simplification: a
    // buyer who starts a checkout, closes it, types a code and starts again would otherwise be handed back
    // the transaction created *before* the code — charged full price by an idempotency key that was doing
    // exactly what it was asked to.
    idempotencyKey: `pithy:${options.deployment ?? "unknown"}:${input.userId}:${input.providerProductId}:${input.discountCode ?? ""}`,
    body: {
      items: [{ price_id: input.providerProductId, quantity: 1 }],
      // Reuse the buyer's existing Paddle customer, so one buyer keeps one account and their portal shows
      // everything they have bought rather than only the last thing.
      ...(input.providerAccountId ? { customer_id: input.providerAccountId } : {}),
      ...(discountId === undefined ? {} : { discount_id: discountId }),
      // Automatic, always. Manual collection raises an invoice and waits, which is a different product
      // and one this rail does not sell through.
      collection_mode: "automatic",
      custom_data: custom,
    },
  });

  const parsed = PaddleTransaction.safeParse(answer?.data);
  if (!parsed.success) {
    throw new PaymentsRailNotConfiguredError({
      detail:
        "Paddle created a transaction this build cannot read. Check `Paddle-Version: 1` against the account's default.",
    });
  }
  const transaction = parsed.data;

  if (options.checkout !== "hosted") {
    return {
      kind: "paddle",
      transactionId: transaction.id,
      clientToken: options.clientToken,
      environment: options.environment,
      displayMode: options.checkout,
    };
  }

  const url = transaction.checkout?.url;
  if (typeof url !== "string" || url === "") {
    // Paddle returns a null `checkout.url` when the account has no default payment link. A checkout button
    // that navigates nowhere is worse than a refusal naming the setting, and `pithy doctor` asks the same
    // question before a buyer finds it.
    throw new PaymentsRailNotConfiguredError({
      detail: `Paddle created transaction ${transaction.id} with no checkout URL. Set a default payment link under Checkout → Checkout settings in the Paddle dashboard, or use \`paddle.checkout: "overlay"\`.`,
    });
  }
  return { kind: "redirect", url };
}

/**
 * Turn the code a customer typed into the discount id a transaction wants.
 *
 * Paddle's `discount_id` takes a `dsc_…`, not the customer-facing string, so this lookup is unavoidable.
 * It is also where the code's validity is learned, and learning it *here* is what makes the refusal a good
 * one: an unknown, expired or exhausted code is refused before a transaction exists, as
 * `payments/discount_invalid` naming the code, rather than becoming a checkout that fails in front of the
 * customer with nothing to say but that something went wrong.
 *
 * `status=active` is part of the query rather than a check afterwards, so an expired or exhausted code
 * simply does not come back. Paddle decides what active means — nothing here reads `expires_at` or counts
 * redemptions, for the same reason nothing here computes a discounted price.
 *
 * **One refusal for all three cases**, and that is a decision rather than an omission. Naming which of
 * "no such code", "expired" and "limit reached" it was helps the buyer a little and tells an
 * unauthenticated enumerator which codes exist, which is worth more to them.
 */
async function resolveDiscount(
  code: string,
  options: PaddleCheckoutOptions,
  transport: PaddleHttpFetch,
): Promise<string> {
  let answer: Awaited<ReturnType<typeof paddleJson>>;
  try {
    answer = await paddleJson(transport, "/discounts", {
      what: `the discount code ${code}`,
      apiKey: options.credentials.apiKey,
      environment: options.environment,
      query: [
        ["code", code],
        ["status", "active"],
        ["per_page", "1"],
      ],
    });
  } catch (cause) {
    // Paddle refuses a malformed code outright rather than answering an empty list — its codes are
    // `^[a-zA-Z0-9]{1,32}$`, so anything with a dash or an underscore is a 400 with a bare "Invalid
    // request." Left alone that surfaces as `rail_not_configured`, which tells a customer this payment
    // method is unavailable when what happened is that their code was not one Paddle accepts.
    if (cause instanceof PithyError && cause.payload.code === "payments/rail_not_configured") {
      throw new PaymentsDiscountInvalidError(
        {
          message: `"${code}" is not a discount code we can accept.`,
          detail: `Paddle refused a lookup of discount code "${code}". ${cause.payload.detail ?? ""}`,
        },
        { cause },
      );
    }
    throw cause;
  }

  const matches = PaddleDiscountMatches.safeParse(answer?.data);
  const found = matches.success ? matches.data[0] : undefined;
  if (found === undefined) {
    throw new PaymentsDiscountInvalidError({
      message: `"${code}" is not a discount code we can accept.`,
      detail: `Paddle has no active discount matching "${code}" — unknown, expired, or fully redeemed.`,
    });
  }
  return found.id;
}
