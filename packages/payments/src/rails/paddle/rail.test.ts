// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS } from "@pithy-sh/core/src/http/signedWebhook";
import { describe, expect, test } from "vitest";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import { paddleRail } from "./rail";
import { signPaddleBody } from "./signature";

/**
 * What a `freshnessSeconds` an adopter sets on the rail actually reaches.
 *
 * `rail.ts` hands it to `webhook.ts`, which hands it to `signature.ts`, and each applies a default with `??` —
 * which catches `undefined` and never `NaN`. One layer refuses a bad number, the one that owns the comparison,
 * and these cases are what makes that a decision rather than three layers each assuming another one looked.
 *
 * Paddle's verifier is a second implementation of the scheme rather than a caller of the core primitive (see
 * `signature.ts` for why), so fixing the primitive does not fix this rail. That is exactly why it is tested
 * from its own entry point.
 */

const NOW = new Date("2026-08-12T09:00:10.000Z");

/** A decade before {@link NOW}. Outside every honest window, so only a broken one lets it through. */
const DECADE_AGO = new Date(NOW.getTime() - 10 * 365 * 24 * 3600 * 1000);

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};

/**
 * One authentic envelope, of a type this rail's map deliberately does nothing with.
 *
 * The projection is `webhook.test.ts`'s subject and has a fixture per event type there. These cases are about
 * whether the *signature* was judged, so the body only has to be an envelope Paddle would send — an event type
 * the map passes over keeps a failure here about the window and never about a field.
 */
const EVENT = {
  event_id: "evt_01hv8wptq8987qeep44cyrewp9",
  event_type: "report.created",
  occurred_at: "2026-08-12T09:00:00.000000Z",
  data: { id: "rep_01hv8wptq8987qeep44cyrewp9" },
};

/** One delivery Paddle would have sent at `timestamp`, correctly signed for these exact bytes. */
async function delivery(timestamp: Date) {
  const body = JSON.stringify(EVENT);
  const ts = Math.floor(timestamp.getTime() / 1000);
  const headers = new Headers();
  headers.set("paddle-signature", `ts=${ts};h1=${await signPaddleBody(ts, body, CREDENTIALS.webhookSecret)}`);
  return { body, headers };
}

/** Run the rail's webhook path and hand back the `PithyError`, or fail loudly when it accepted the delivery. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PithyError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal, got a pass");
}

/** The rail as a project composes it, with whatever freshness window a case is about. */
const rail = (freshnessSeconds?: number) =>
  paddleRail(CREDENTIALS, {
    environment: "production",
    clientToken: "live_pithySuiteOnlyClientToken",
    checkout: "overlay",
    freshnessSeconds,
  });

describe("paddleRail — a freshness window cannot be smuggled down through the layers", () => {
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative window", -1],
    ["wider than the maximum", SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS + 1],
  ])("a decade-old delivery is refused when the rail was given %s", async (_label, freshnessSeconds) => {
    const { payload } = await refusal(
      rail(freshnessSeconds).parseNotification(await delivery(DECADE_AGO), { now: NOW, deployment: "prod" }),
    );
    expect(payload.code).toBe("core/internal");
    expect(payload.status).toBe(500);
  });

  test("the same delivery is refused as an unverified webhook when the rail was given nothing", async () => {
    const { payload } = await refusal(
      rail().parseNotification(await delivery(DECADE_AGO), { now: NOW, deployment: "prod" }),
    );
    expect(payload.code).toBe("payments/verification_failed");
  });

  test("a finite window still reaches the comparison and still widens it", async () => {
    const notification = await rail(3000).parseNotification(await delivery(new Date(NOW.getTime() - 2_000_000)), {
      now: NOW,
      deployment: "prod",
    });
    expect(notification.providerEventId).toBe(EVENT.event_id);
  });
});
