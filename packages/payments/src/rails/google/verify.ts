import { z } from "zod";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import type { VerifiedPurchase } from "../contract";
import {
  fetchPlayProduct,
  fetchPlaySubscription,
  type PlayApiOptions,
  playProductEvent,
  playSubscriptionEvent,
} from "./playApi";

/**
 * The client-submission path for Google: a Play purchase token, verified at Google.
 *
 * **There is no offline verification here, and that is Play's design rather than ours.** Play Billing hands the
 * app a purchase token and, optionally, a signature over the receipt JSON made with the app's licensing key —
 * which is a key Google publishes per app in the Play Console and which is not in this rail's credential bundle
 * on purpose. Checking it would prove the JSON came from Play; it would not prove the purchase still stands, and
 * a refunded purchase's receipt keeps verifying forever. So the token is looked up. One round-trip buys the
 * current state, which is the thing an entitlement should rest on.
 *
 * Nothing about correctness rests on this path in any case. The webhook produces the identical row through the
 * same idempotent writer, so a dropped submission costs nothing and a replayed one changes nothing. What it buys
 * is immediacy: the buyer sees their entitlement the moment they buy, rather than when Pub/Sub gets round to it.
 *
 * ## Why a client-declared product id is safe here
 *
 * `PurchaseSubmission` carries no product id, deliberately — a client-declared product would let a caller
 * present a cheap receipt as an expensive one. What the receipt *does* carry, because Play Billing puts it
 * there, is the product the app thinks it bought, and that value is used as **a lookup key and never as a
 * claim**: Play's one-time endpoint takes the product id as a path segment and answers 404 when the token does
 * not belong to it. So a lie fails at Google rather than being believed here, and the id that lands in the
 * purchase row is the one Google confirmed by answering.
 *
 * ## Why the subscription lookup goes first
 *
 * Play has no call that says what kind of purchase a token is. The subscription endpoint takes a token alone, so
 * it can answer without believing anything the client said; its 404 is then how a one-time purchase identifies
 * itself, and only then is the declared product id used at all.
 */

/** The longest a product id may be, matching the catalog's own bound. */
const MAX_SKU_LENGTH = 200;

/** The longest a purchase token may be. Play's are around a hundred characters; this is generous. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * What a client submits for the Google rail: `Purchase.getOriginalJson()`, verbatim.
 *
 * `.loose()` because Play Billing's JSON carries more than this and its shape moves between library versions.
 * Both product spellings are accepted: Play Billing 4 and earlier emit `productId`, 5 and later emit a
 * `productIds` array, and which one arrives depends on the app's library version rather than on anything a
 * server decides.
 */
export const GooglePlayReceipt = z
  .object({
    purchaseToken: z
      .string()
      .min(1)
      .max(MAX_TOKEN_LENGTH)
      .describe("Play's own token for the purchase. The only field this path cannot do without."),
    productId: z
      .string()
      .min(1)
      .max(MAX_SKU_LENGTH)
      .optional()
      .describe(
        "What the app thinks it bought, as Play Billing 4 and earlier report it. A lookup key, never a claim — Play answers 404 when the token does not belong to it.",
      ),
    productIds: z
      .array(z.string().min(1).max(MAX_SKU_LENGTH).describe("One product the order covers."))
      .min(1)
      .optional()
      .describe("The same thing as Play Billing 5 and later report it. The first entry is the product looked up."),
  })
  .loose()
  .describe("A Play purchase as the Billing Library's `getOriginalJson()` returns it.");
export type GooglePlayReceipt = z.infer<typeof GooglePlayReceipt>;

/** Verify a client-submitted Play purchase and normalize it. The caller binds the authenticated purchaser. */
export async function verifyGooglePurchase(receipt: string, options: PlayApiOptions): Promise<VerifiedPurchase> {
  let raw: unknown;
  try {
    raw = JSON.parse(receipt) as unknown;
  } catch (cause) {
    // Never echo the receipt: it is caller-supplied, and it is what a stolen one would look like in a log.
    throw new PaymentsInvalidReceiptError({ detail: "Google: the submitted purchase is not JSON." }, { cause });
  }

  const parsed = GooglePlayReceipt.safeParse(raw);
  if (!parsed.success) {
    throw new PaymentsInvalidReceiptError({
      detail: `Google: the submitted purchase is not a Play receipt — ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ")}.`,
    });
  }
  const { purchaseToken } = parsed.data;
  const productId = parsed.data.productId ?? parsed.data.productIds?.[0];

  // A client submission is a read of the current state, so the clock is the honest event time: there is no
  // provider timestamp on a Play purchase, and inventing an older one would make a submission lose to a
  // notification it is newer than.
  const context = { purchaseToken, eventAt: options.now };

  // The token alone. Nothing the client said is used yet.
  const subscription = await fetchPlaySubscription(purchaseToken, options);
  if (subscription !== undefined) return playSubscriptionEvent(subscription, context);

  if (productId === undefined) {
    throw new PaymentsVerificationFailedError({
      detail:
        "Google: the purchase is not a subscription and the receipt names no product id, so there is no one-time purchase to look up. Submit `Purchase.getOriginalJson()` unaltered.",
    });
  }

  const product = await fetchPlayProduct(productId, purchaseToken, options);
  if (product !== undefined) return playProductEvent(product, { ...context, productId });

  // Play knows neither a subscription nor a one-time purchase under this token and product. Either the token is
  // not ours, or it is not for the product it claims. Both are the same statement to a client.
  throw new PaymentsVerificationFailedError({
    detail: `Google: Play has no subscription under this token and no "${productId}" purchase under it either.`,
  });
}
