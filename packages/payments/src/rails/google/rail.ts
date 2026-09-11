// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { JwksCache } from "@pithy-sh/core/src/http/oidcWebhook";
import type { PaymentsPurchase } from "../../data/purchase";
import { PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsGoogleCredentials } from "../../secret/registry";
import type {
  PaymentsRailProvider,
  RailRequestContext,
  UnboundProviderEvent,
  VerifiedNotification,
  VerifiedPurchase,
  WebhookDelivery,
} from "../contract";
import type { GoogleHttpFetch } from "./http";
import { type GoogleJwk, verifyGoogleOidcToken } from "./oidc";
import { refreshPlayPurchase, resolvePlayPointer } from "./playApi";
import { parseGoogleNotification } from "./rtdn";
import { verifyGooglePurchase } from "./verify";

/**
 * The Google Play rail as one provider object — the two halves of the contract, closed over the app's identity.
 *
 * Built per request from credentials the caller resolved through the secrets store, rather than reading them
 * itself. That keeps the rail a pure function of its inputs, and it keeps the secret read at the point of need.
 *
 * ## Three checks, in this order, and each covers what the one before it cannot
 *
 * 1. **The OIDC token proves Google sent the delivery.** It arrives in the `Authorization` header rather than in
 *    the body, because a Pub/Sub push is not signed — the token is the whole proof.
 * 2. **The audience claim proves it was minted for *this* endpoint.** Google signs these tokens for every push
 *    subscription in the world with the same keys, so the signature alone is worth nothing. See `oidc.ts`.
 * 3. **The package name proves it concerns *this app*.** A token says who delivered it and nothing about what it
 *    is about, so without this any Play developer who can reach the endpoint could name a SKU in our catalog.
 *
 * ## And then a fourth call, which is Google's own doing
 *
 * A Real-time Developer Notification is a pointer: a purchase token and a notification type, with no state. So
 * every projectable notification costs a Play Developer API lookup. That is the shape of Play's API rather than
 * a choice here, and it is why an unreachable Play API is `payments/provider_unavailable` (503) — the route
 * rethrows that so Pub/Sub redelivers, because the alternative is projecting a guess.
 *
 * ## One gap, recorded rather than papered over
 *
 * A **voided one-time purchase** cannot be resolved on this path. Play's voided-purchase notification names an
 * order id and no product, and Play's one-time lookup takes the product id as a path segment — so there is no
 * call this module can make that turns that token into a state. The delivery is recorded with a note carrying
 * the order id, which is the key the purchase row is already stored under, and the reconciliation Workflow
 * resolves it with one query. Subscription refunds have no such gap: they arrive as `SUBSCRIPTION_REVOKED` and
 * project immediately.
 */

/**
 * How the Google rail's trust and transport may be widened, and the only callers with a reason to.
 *
 * `trustedKeys` is additive, so nothing can narrow production's trust: a token whose `kid` these do not cover is
 * still resolved against Google's published set. It exists for the tests, which mint their own key so the
 * signature check is exercised for real, and for a local **Pub/Sub emulator**, whose tokens are signed by a key
 * Google never saw.
 */
export interface GoogleRailOptions {
  /** Verification keys accepted in addition to Google's published set, matched by `kid`. */
  trustedKeys?: readonly GoogleJwk[];
  /** The HTTP seam Google's two endpoints are reached through. Defaults to the runtime's `fetch`. */
  transport?: GoogleHttpFetch;
  /**
   * A Play access token already minted, so a batch of refreshes pays for one round-trip instead of one each.
   * Passed down by the reconciliation Workflow; absent everywhere else, where one call mints its own.
   */
  accessToken?: string;
  /**
   * Where Google's published keys are held between deliveries, and it is **not optional on the webhook path**.
   *
   * A rail is built per request — `resolveRailProvider` runs inside the guard — so this object cannot own the
   * store, and a cache hung here would be one that has never held anything. It is passed in instead, from
   * whatever *does* outlive a request: `registerPaymentsRoutes` builds one per registered route tree, which is
   * once per isolate, and an adopter wanting a harder bound hands `RailTrustOptions.googleJwksCache` a store
   * over KV.
   *
   * Absent is core's fetch-per-call, which is correct on the `verify` and `refresh` paths (one caller, one
   * purchase, no flood to absorb) and is an outbound amplifier on the webhook: `parseNotification` resolves a
   * key *before* it can check a signature, so a 49-byte forged token buys a round trip to
   * `https://www.googleapis.com/oauth2/v3/certs`, 1:1, until Google rate-limits us and the genuine deliveries
   * 502 alongside the forgeries — and a 502 is in the webhook guard's pass-through set, so Pub/Sub redelivers
   * into the same uncached path. That is the hazard core's own `JwksCache` doc names, and this is the seam
   * that answers it here.
   *
   * **Whatever the `kid` claims**, which is the half the first round of this missed. Holding Google's keys
   * answers a token naming one of them and nothing else, and a `kid` is attacker-chosen: a random one is a
   * miss, and a miss is a refresh. So the store carries a refresh window too (`JwksCache.claimRefresh`), and
   * the bound it keeps is one ask per `OIDC_JWKS_MIN_REFRESH_SECONDS` per key endpoint rather than one per
   * `kid` somebody invents.
   */
  jwksCache?: JwksCache;
}

/** The `Authorization` scheme a Pub/Sub push uses for its OIDC token. */
const BEARER = "bearer ";

/** The Google Play rail. Verifies client submissions at Play, and Pub/Sub pushes on the webhook. */
export function googleRail(
  credentials: PaymentsGoogleCredentials,
  options: GoogleRailOptions = {},
): PaymentsRailProvider {
  return {
    rail: "google",

    async verify(receipt: string, context: RailRequestContext): Promise<VerifiedPurchase> {
      // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt* the
      // rejection rather than raising it, and workerd then reports the adopted promise as an unhandled rejection
      // even though Hono's `onError` answers the request correctly. A refused receipt is normal traffic — a
      // stale token, a product the token is not for — so it must not read as a runtime fault in a log.
      return await verifyGooglePurchase(receipt, {
        credentials,
        now: context.now,
        transport: options.transport,
      });
    },

    async parseNotification(delivery: WebhookDelivery, context: RailRequestContext): Promise<VerifiedNotification> {
      // The header, not the body. A Pub/Sub push body carries no signature at all, so nothing about it is
      // trustworthy until the token beside it verifies.
      const authorization = delivery.headers.get("authorization") ?? "";
      if (!authorization.toLowerCase().startsWith(BEARER)) {
        throw new PaymentsVerificationFailedError({
          detail:
            "Google: the push carries no Authorization bearer token. Configure the Pub/Sub push subscription to authenticate with a service account.",
        });
      }
      await verifyGoogleOidcToken(authorization.slice(BEARER.length).trim(), {
        audience: credentials.pubsubAudience,
        serviceAccountEmail: credentials.serviceAccountEmail,
        now: context.now,
        transport: options.transport,
        trustedKeys: options.trustedKeys,
        // The store the route owns, so one key fetch covers every delivery in its lifetime rather than one
        // per delivery. See {@link GoogleRailOptions.jwksCache} for why it cannot be built here.
        jwksCache: options.jwksCache,
      });

      const parsed = parseGoogleNotification(delivery.body, { packageName: credentials.packageName });
      if (parsed.pointer === null) {
        return {
          providerEventId: parsed.providerEventId,
          payload: parsed.payload,
          event: null,
          providerAccountId: null,
          // A void carries no state and needs none: the order id names the row, and the route owns the
          // database that has it. See `VerifiedNotification.voidedOrderId`.
          voidedOrderId: parsed.voidedOrderId,
          // `stated`: `parseGoogleNotification` reads the delivered bytes and nothing else, so this note is
          // what the notification says. The same bytes get the same answer for ever — terminal.
          note: parsed.note === null ? null : { stated: parsed.note },
        };
      }

      const state = await resolvePlayPointer(parsed.pointer, {
        credentials,
        now: context.now,
        transport: options.transport,
      });
      if (state === undefined) {
        // Authentic, and about a purchase Play will not show us — a token from a deleted app, or a
        // notification that raced its own purchase.
        //
        // **`read`, not `stated`, and that is #341.** This sentence is the output of a call to Play, and the
        // second reason above is a race by name: an RTDN is published before Play's own read-after-write has
        // settled often enough that Google documents the retry. The note said "the answer will not change",
        // which is true of the *bytes* and false of the *lookup* — so a note derived from it finished the row,
        // and the redelivery Pub/Sub was already queuing was answered `duplicate`. Repairable.
        return {
          providerEventId: parsed.providerEventId,
          payload: parsed.payload,
          event: null,
          providerAccountId: null,
          note: {
            read: `google: Play has no ${parsed.pointer.kind === "subscription" ? "subscription" : "one-time purchase"} under the token this notification points at.`,
          },
        };
      }

      return {
        providerEventId: parsed.providerEventId,
        payload: parsed.payload,
        event: state.event,
        providerAccountId: state.providerAccountId,
        note: null,
      };
    },

    async refresh(purchase: PaymentsPurchase, context: RailRequestContext): Promise<UnboundProviderEvent | undefined> {
      // `return await`, not `return` — see `verify` above for why the frame must raise rather than adopt.
      return await refreshPlayPurchase(purchase, {
        credentials,
        now: context.now,
        transport: options.transport,
        accessToken: options.accessToken,
      });
    },
  };
}
