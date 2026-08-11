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
import { PaymentsWebhookEvent } from "../data/webhookEvent";
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
 * row goes in first, keyed `UNIQUE (rail, providerEventId)`, and a delivery that has already been processed
 * short-circuits with 200 instead of running again. Two things follow from that. A retry storm costs one
 * insert instead of a projection. And "why didn't this renew" becomes answerable: `receivedAt` says whether
 * the notification arrived at all, `processedAt` whether it was projected, and `error` why not.
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
      .select(["id", "processedAt"])
      .where("rail", "=", rail)
      .where("providerEventId", "=", notification.providerEventId)
      .executeTakeFirst();
    if (!stored) {
      throw new InternalError({
        detail: `${rail}: notification ${notification.providerEventId} was recorded but could not be read back.`,
      });
    }

    // Already handled. 200 rather than an error: the store did nothing wrong, and answering non-2xx would make
    // it retry a delivery that has already taken effect.
    if (stored.processedAt !== null) {
      return c.json({ received: true, duplicate: true }, 200);
    }

    verified.set(c.req.raw, { rail, notification, eventRowId: stored.id });
    await next();
  };
}

/**
 * Mark a recorded notification processed, or record why it was not.
 *
 * A genuine D1 failure here propagates rather than being swallowed, and that is the right direction: the store
 * would answer to a 5xx by retrying, the projection is idempotent, and an unmarked row would otherwise leave a
 * notification looking permanently unprocessed.
 */
export async function completeWebhook(
  d1: D1Database,
  eventRowId: string,
  outcome: { at: Date; error?: string },
): Promise<void> {
  const db = paymentsDatabase(d1);
  await withD1Retry(() =>
    db
      .updateTable(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      .set({
        // `processedAt` is set even when there was an error: the notification *was* handled, and the pairing
        // of a timestamp with an error is what distinguishes "tried and could not" from "never arrived".
        processedAt: outcome.at.getTime(),
        error: outcome.error ?? null,
        // biome-ignore lint/suspicious/noExplicitAny: encoded column values, not the app shape.
      } as any)
      .where("id", "=", eventRowId)
      .execute(),
  );
}
