// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { safeEmit } from "@pithy-sh/core/src/controlPlane/audit/actions";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { Context, MiddlewareHandler } from "hono";
import { PaymentsAuditActions } from "../audit/actions";
import type { PaymentsConfig } from "../config/config";
import type { PaymentsRail } from "../data/rail";
import { PAYMENTS_WEBHOOK_EVENTS_TABLE, paymentsDatabase } from "../data/tables";
import { isWebhookEventFinished, PaymentsWebhookEvent, webhookEventState } from "../data/webhookEvent";
import { PaymentsWebhookUnverifiedError } from "../error/errors";
import type { VerifiedNotification } from "../rails/contract";
import { type RailTrustOptions, resolveRailProvider } from "../rails/providers";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../secret/registry";

/**
 * The `signed-webhook` gate — the repo's first, and the shape the Google and Stripe webhooks will reuse.
 *
 * ## Why it reads the body itself
 *
 * All three rails prove authenticity over the **exact received bytes**: Apple signs them, Stripe HMACs them,
 * Google signs a token alongside them. A parsed-and-re-serialized object is different bytes — key order alone
 * changes it — so the gate must see what arrived, not a reconstruction. That is why the Biome plugin bans
 * `c.req.json()` under `src/http/**` but deliberately allows `c.req.text()`, `c.req.header()`, and
 * `c.req.raw`: reading the body for a signature check is the sanctioned use, and this is the module that has
 * it.
 *
 * `c.req.text()` rather than `c.req.raw.text()`, and that distinction matters. Hono caches its own body reads,
 * so the route's `zValidator("json", …)` afterwards is served from the same cache and sees identical bytes.
 * Reading `c.req.raw` directly would consume the stream and leave the validator with nothing.
 *
 * ## Why it persists before it hands off
 *
 * Every provider delivers at-least-once and retries, so a redelivery is expected rather than exceptional. The
 * row goes in first, keyed `UNIQUE (rail, providerEventId)`, and a delivery that has already been **finished
 * with** short-circuits with 200 instead of running again. Two things follow from that. A retry storm costs
 * one insert instead of a projection. And "why didn't this renew" becomes answerable: `receivedAt` says
 * whether the notification arrived at all, `processedAt` whether it was finished with, `abandonedAt` whether
 * a repair pass gave up on it, and `error` why.
 *
 * **Finished, not seen.** The distinction is the whole of #337 and it is worth the sentence. A delivery that
 * arrived and failed to project must be reprocessed by the next one — that is the only repair path this
 * package has, because a provider's retry and an operator's replay both reuse the original event id. So the
 * short-circuit reads {@link isWebhookEventFinished}, and only a row nothing is left to do with is answered
 * as a duplicate.
 *
 * A forgery is never persisted. Verification comes first, so the table holds only notifications the store
 * actually sent — otherwise anyone could fill it.
 *
 * ## Why the verified payload travels in a WeakMap
 *
 * The gate has already decoded the notification in order to verify it, and the handler needs that result. The
 * options were a `ContextVariableMap` augmentation, which would put a payments-only variable on the types of
 * every Hono app in an adopter's project including the ones that never compose payments; re-exporting an
 * unverified decoder for the handler to call, which is a function whose only safe use is the one place it is
 * called from; or this — a request-scoped map keyed on the `Request` object, read through an accessor that
 * throws when the gate did not run. The last is the only one with no way to reach an unverified payload and no
 * effect outside this package.
 */

/**
 * Our own name for what refused a delivery, for the audit row's `metadata.step`.
 *
 * Derived from the rail's error **code**, never from its `detail` or a raw `Error.message`: a code is a value
 * this package defined, where a message can carry text a sender influenced, and the trail must hold nothing a
 * forger wrote. An unrecognized throw is `unknown` rather than its message, for the same reason.
 *
 * `detail` on the 401 still carries the full reason for the operator reading logs — this is the queryable
 * half, and it is deliberately coarser.
 */
function failingStep(cause: unknown): string {
  return cause instanceof PithyError ? cause.payload.code : "unknown";
}

/** The codes a rail may raise that describe our side rather than the sender's, and so keep their own status. */
const PASS_THROUGH_CODES: ReadonlySet<string> = new Set([
  "payments/provider_unavailable",
  "payments/rail_not_configured",
]);

/** A verified delivery, as the handler receives it: the notification, and the row recording it. */
export interface VerifiedWebhook {
  /** Which rail delivered it. */
  rail: PaymentsRail;
  /** The verified, parsed notification. `event` is null when it reports no transaction state. */
  notification: VerifiedNotification;
  /** The `pithy_payments_webhook_events` row id, so the handler can mark it processed or failed. */
  eventRowId: string;
}

/**
 * Request-scoped, keyed on the `Request` object so an entry cannot outlive its request and cannot be reached
 * from another one. Weak, so a dropped request drops its entry with no bookkeeping.
 */
const verified = new WeakMap<Request, VerifiedWebhook>();

/**
 * The verified delivery for this request. Throws when the gate did not run, because a handler reading an
 * absent verification would be a handler processing an unverified notification.
 */
export function verifiedWebhook(c: Context<PithyHonoEnv>): VerifiedWebhook {
  const found = verified.get(c.req.raw);
  if (!found) {
    throw new InternalError({
      detail: "A payments webhook handler ran without its signed-webhook guard. Put the guard on the route line.",
    });
  }
  return found;
}

/** What the guard needs beyond the request: the catalog, and an injectable clock. */
export interface WebhookGuardOptions {
  /** The resolved catalog. Decides whether the rail is enabled at all. */
  config: PaymentsConfig;
  /** The clock, for signature freshness and `receivedAt`. Injected so tests are deterministic. */
  now?: () => Date;
  /** Additional certificate roots, additive only. Absent in production. */
  trust?: RailTrustOptions;
}

/** The app `DB` binding, or a wiring failure. */
function database(c: Context<PithyHonoEnv>): D1Database {
  const binding = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!binding) {
    throw new InternalError({
      message: "Payments is not configured.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "Payments requires a `DB` D1 binding; none was present on env.",
    });
  }
  return binding;
}

/**
 * Verify, record, and de-duplicate one rail's notification.
 *
 * Every failure to establish authenticity becomes `payments/webhook_unverified` (401), whatever the rail threw
 * underneath. The rails distinguish malformed from unverified for the client-submission path, where the
 * distinction helps a developer; on a webhook it would only tell a forger how close it got. The original code
 * rides in `detail`, which the HTTP codec strips.
 *
 * **Two codes pass through unchanged, because they are not the caller's failure.** A rail that cannot reach its
 * store (`payments/provider_unavailable`) or cannot use its own credentials (`payments/rail_not_configured`) has
 * not judged the delivery at all — Google's rail must call the Play Developer API to resolve a notification, and
 * an outage there is ours, not the sender's. Reporting either as a failed signature would send an operator
 * hunting for a rotated key while the real answer is in a status page, and would tell the audit trail a forgery
 * arrived when none did. Both remain non-2xx, so the provider still redelivers.
 */
export function requireSignedWebhook(
  rail: PaymentsRail,
  options: WebhookGuardOptions,
): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const now = options.now?.() ?? new Date();

    // Read the credentials at the point of need, through the one reader. Never off `env.X`, never cached in a
    // module variable, and never spread into a log or an audit payload.
    const secrets = await sharedSecretsStore(c.env as unknown as SecretsStoreEnv, paymentsSecretsRegistry);
    const provider = resolveRailProvider(
      rail,
      options.config,
      secrets.get(PAYMENTS_PROVIDER_SECRET),
      options.trust ?? {},
    );

    // The exact received bytes. Hono caches this read, so the route's json validator sees the same ones.
    const body = await c.req.text();

    let notification: VerifiedNotification;
    try {
      const deployment = (c.env as Record<string, unknown>).ENVIRONMENT;
      notification = await provider.parseNotification(
        { body, headers: c.req.raw.headers },
        { now, deployment: typeof deployment === "string" && deployment !== "" ? deployment : undefined },
      );
    } catch (cause) {
      // Not the sender's failure, so not the sender's error code. See the module doc.
      if (cause instanceof PithyError && PASS_THROUGH_CODES.has(cause.payload.code)) throw cause;

      // The one payments event that is about an attacker rather than about a customer. One rejection is
      // noise; a run of them against one endpoint is somebody probing a payment rail, and that pattern is
      // exactly what a trail is read for. Recorded through `safeEmit` because the 401 is already decided by
      // the time we get here — an audit write that threw would hand a forger a 500 for a failing store and a
      // 401 for a healthy one, which is both an availability bug and a signal it should not have.
      await safeEmit(
        c.var.emit,
        {
          action: PaymentsAuditActions.webhookUnverified,
          outcome: "denied",
          severity: "warning",
          actorType: "service",
          actorId: rail,
          resourceType: "webhook",
          resourceId: rail,
          // The rail and the step that failed, and nothing the sender supplied verbatim — not the body, not
          // the signature header, not an id it chose. The trail is queryable and long-lived, and a forger
          // must not be able to write into it. The step is our own code's name for what it refused.
          metadata: { rail, step: failingStep(cause) },
        },
        c.var.log,
      );

      throw new PaymentsWebhookUnverifiedError(
        {
          detail: `${rail}: ${cause instanceof PithyError ? `${cause.payload.code} — ${cause.payload.detail ?? cause.payload.message}` : "the notification could not be verified"}`,
        },
        { cause },
      );
    }

    const d1 = database(c);
    const db = paymentsDatabase(d1);
    const row = PaymentsWebhookEvent.encode({
      id: crypto.randomUUID(),
      rail,
      providerEventId: notification.providerEventId,
      payload: notification.payload,
      receivedAt: now,
      processedAt: null,
      error: null,
      createdAt: now,
    });

    // `DO NOTHING` rather than an upsert: the first delivery's record is the one worth keeping, and
    // overwriting it would erase the `error` that explains why the first attempt failed.
    await withD1Retry(() =>
      db
        .insertInto(PAYMENTS_WEBHOOK_EVENTS_TABLE)
        // biome-ignore lint/suspicious/noExplicitAny: an encoded row; Kysely's insert type derives from z.input.
        .values(row as any)
        .onConflict((oc) => oc.columns(["rail", "providerEventId"]).doNothing())
        .execute(),
    );

    const stored = await db
      .selectFrom(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      .select(["id", "processedAt", "abandonedAt", "error"])
      .where("rail", "=", rail)
      .where("providerEventId", "=", notification.providerEventId)
      .executeTakeFirst();
    if (!stored) {
      throw new InternalError({
        detail: `${rail}: notification ${notification.providerEventId} was recorded but could not be read back.`,
      });
    }

    // Already **finished** — not merely already seen. 200 rather than an error: the store did nothing wrong,
    // and answering non-2xx would make it retry a delivery that has already taken effect.
    //
    // A delivery that arrived and failed, and one a repair pass abandoned, both fall through to the handler
    // and are processed again. That is the point of #337: those are the two rows whose purchase has *not*
    // been projected, and short-circuiting them made a redelivery — and a manual replay, which reuses the
    // provider's event id — the one thing that could never repair them.
    if (isWebhookEventFinished(webhookEventState(stored))) {
      return c.json({ received: true, duplicate: true }, 200);
    }

    verified.set(c.req.raw, { rail, notification, eventRowId: stored.id });
    await next();
  };
}

/**
 * What became of a verified delivery, as the handler reports it. **Three cases, because there are three.**
 *
 * `{ at }` — it projected. Finished.
 *
 * `{ at, note }` — it was never going to project, and here is why. The rail read the notification and said
 * it carries no transaction state: a partial refund that takes nothing away, a token Play will not show us
 * — its rail's own words are "the answer will not change" — a subscription Lemon Squeezy no longer knows, a
 * type the store shipped after this package did. Also finished. **A later delivery of the same bytes gets
 * the same answer from the same build**, so the note is an explanation attached to a finished row, not a
 * failure.
 *
 * `{ at, error }` — it arrived carrying a purchase and did not project, and a later attempt still could.
 * The orphan whose account link has not arrived, the void naming a purchase not yet submitted, the SKU not
 * yet in the catalog. `processedAt` stays null so the redelivery, the replay, or the sweep runs it again.
 *
 * **Why `note` and `error` are separate when both land in the same column.** #337 made the presence of a
 * reason the discriminant, which split one state in two: a delivery with nothing to project was finished
 * when the rail said nothing about it, and outstanding when the rail explained why. The *explanation* was
 * the only difference, and an explanation must not be able to change a state.
 *
 * What that cost is the two things this column is read for. A null `processedAt` under an old `receivedAt`
 * is this table's documented drift signal, and every explained delivery became one permanently. And the
 * short-circuit is what makes a retry storm cost one insert instead of a projection — four of the five
 * rails have no repair pass at all, so those rows never settled, and each of the store's retries ran the
 * whole handler again.
 *
 * The three are a union rather than two optional fields so no call site can pass both and no reader has to
 * decide what a row means that claims to be finished and failed at once. That contradiction was #337.
 */
export type WebhookCompletion =
  | { readonly at: Date }
  | { readonly at: Date; readonly note: string }
  | { readonly at: Date; readonly error: string };

/**
 * Mark a recorded notification finished, or record why it is not.
 *
 * The outcome decides whether `processedAt` is written at all — see {@link WebhookCompletion}. Only the
 * repairable case withholds it, and withholding it is what keeps the row reprocessable: the guard's
 * short-circuit and the Paddle sweep's freshness check both read that column.
 *
 * That reverses what this function did before #337. Setting the timestamp beside an error read as "the
 * notification *was* handled" — but the guard short-circuits on that column, so it also meant a failed
 * delivery could never be repaired: the provider's retry was answered 200, a manual replay reuses the same
 * event id and was answered 200, and the sweep skipped it. Nothing in this package repaired a failed
 * delivery, on any rail. #339 is the other edge of the same cut: the fix withheld the timestamp from
 * deliveries that had nothing to repair, and made a repair pass chase them.
 *
 * **`abandonedAt` is never touched here.** It belongs to the repair pass that wrote it, and a webhook that
 * projects one of those rows sets `processedAt` — which wins, so the event reads finished while the row
 * still records that a sweep once gave up on it.
 *
 * A genuine D1 failure propagates rather than being swallowed, and that is the right direction: the store
 * would answer a 5xx by retrying, the projection is idempotent, and an unmarked row would otherwise leave a
 * notification looking permanently unprocessed.
 */
export async function completeWebhook(d1: D1Database, eventRowId: string, outcome: WebhookCompletion): Promise<void> {
  const repairable = "error" in outcome;
  const db = paymentsDatabase(d1);
  await withD1Retry(() =>
    db
      .updateTable(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      .set({
        processedAt: repairable ? null : outcome.at.getTime(),
        // One column: it is "why", and an operator reads it the same way whichever of the two it is.
        error: "error" in outcome ? outcome.error : "note" in outcome ? outcome.note : null,
        // biome-ignore lint/suspicious/noExplicitAny: encoded column values, not the app shape.
      } as any)
      .where("id", "=", eventRowId)
      .execute(),
  );
}
