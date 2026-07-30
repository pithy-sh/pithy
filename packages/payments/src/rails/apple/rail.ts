import { z } from "zod";
import type { PaymentsPurchase } from "../../data/purchase";
import { PaymentsInvalidReceiptError } from "../../error/errors";
import type { PaymentsAppleCredentials } from "../../secret/registry";
import type {
  PaymentsRailProvider,
  RailRequestContext,
  UnboundProviderEvent,
  VerifiedNotification,
  VerifiedPurchase,
  WebhookDelivery,
} from "../contract";
import { APPLE_ROOT_CERTIFICATES } from "./certs";
import type { AppleHttpFetch } from "./http";
import { parseAppleNotification } from "./notification";
import { refreshAppleSubscription } from "./serverApi";
import { verifyAppleTransaction } from "./verify";

/**
 * The Apple rail as one provider object — the two halves of the contract, closed over the app's identity.
 *
 * Built per request from credentials the caller resolved through the secrets store, rather than reading them
 * itself. That keeps the rail a pure function of its inputs (so every test above runs with no secrets
 * machinery), and it keeps the read at the point of need, which is what CLAUDE.md asks for.
 *
 * Apple needs no credential to *verify* anything: authenticity rests on the public certificate chain pinned
 * in `certs.ts`. What it needs from the bundle is the `bundleId` — the app's identity, checked on every
 * payload, because Apple signs every developer's notifications with the same chain. The App Store Connect key
 * in the same block is for calling the App Store Server API, which the reconciliation Workflow does.
 */

/**
 * Apple's webhook body: one field, carrying the whole signed notification.
 *
 * Declared here as well as in `http/schemas.ts`, and the duplication is the lesser evil. The rail parses the
 * bytes it was handed in order to *verify* them; the route's validator gives the handler a typed value. The
 * rail is the lower layer, so it must not import an HTTP schema, and re-exporting one across the seam would
 * be worse than six lines. The two must agree — change one, change the other.
 */
const AppleWebhookBody = z
  .object({
    signedPayload: z
      .string()
      .min(1)
      .describe("The App Store Server Notification V2, as a compact JWS. Everything else about the delivery is in it."),
  })
  .describe("The body Apple POSTs to the notification endpoint.");

/**
 * How the Apple rail's trust set may be widened, and the only two callers with a reason to.
 *
 * Apple's pinned roots are always trusted and can never be removed — `trustedRoots` is additive, so no caller
 * can narrow production's trust to nothing. It exists because two legitimate chains are not Apple's: the tests,
 * which mint their own chain so signature verification is exercised for real, and **Xcode's StoreKit local
 * testing**, whose transactions are signed by a per-machine root that only exists on the developer's Mac.
 */
export interface AppleRailOptions {
  /** Roots to accept *in addition to* Apple's pinned ones, base64 DER. Empty in production. */
  trustedRoots?: readonly string[];
  /** The HTTP seam the App Store Server API is reached through. Defaults to the runtime's `fetch`. */
  transport?: AppleHttpFetch;
  /**
   * An App Store Connect token already minted, so a batch of refreshes pays for one. Passed down by the
   * reconciliation Workflow; absent everywhere else, where one call mints its own and drops it.
   */
  apiToken?: string;
}

/** The Apple rail. Verifies client submissions locally, and App Store Server Notifications V2 on the webhook. */
export function appleRail(credentials: PaymentsAppleCredentials, options: AppleRailOptions = {}): PaymentsRailProvider {
  const roots = options.trustedRoots?.length ? [...APPLE_ROOT_CERTIFICATES, ...options.trustedRoots] : undefined;

  return {
    rail: "apple",

    async verify(receipt: string, context: RailRequestContext): Promise<VerifiedPurchase> {
      return verifyAppleTransaction(receipt, { bundleId: credentials.bundleId, roots, now: context.now });
    },

    async parseNotification(delivery: WebhookDelivery, context: RailRequestContext): Promise<VerifiedNotification> {
      let body: unknown;
      try {
        body = JSON.parse(delivery.body) as unknown;
      } catch (cause) {
        throw new PaymentsInvalidReceiptError({ detail: "Apple: the notification body is not JSON." }, { cause });
      }
      const parsed = AppleWebhookBody.safeParse(body);
      if (!parsed.success) {
        throw new PaymentsInvalidReceiptError({ detail: "Apple: the notification body carries no signedPayload." });
      }
      return parseAppleNotification(parsed.data.signedPayload, {
        bundleId: credentials.bundleId,
        roots,
        now: context.now,
      });
    },

    async refresh(purchase: PaymentsPurchase, context: RailRequestContext): Promise<UnboundProviderEvent | undefined> {
      // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt* the
      // rejection rather than raising it, and workerd then reports the adopted promise as an unhandled
      // rejection even though the Workflow step catches it and retries.
      return await refreshAppleSubscription(purchase, {
        credentials,
        now: context.now,
        transport: options.transport,
        roots,
        token: options.apiToken,
      });
    },
  };
}
