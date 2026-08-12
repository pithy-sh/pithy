// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError, PaymentsRailNotConfiguredError } from "../../error/errors";

/**
 * The one door out to Lemon Squeezy, and the mapping from how it answered to what that means.
 *
 * Reached with `fetch` and JSON:API rather than through the `@lemonsqueezy/lemonsqueezy.js` package, for the
 * reason `stripe/api.ts` gives: four calls are needed — create a checkout, read an order, read a
 * subscription, read a customer — and each is one request. Every other third-party API in this repo is
 * spoken to the same way: `fetch` out, Zod in.
 *
 * ## JSON:API, and the one thing it costs
 *
 * Lemon Squeezy speaks JSON:API, so every answer is `{ data: { id, type, attributes: {…} } }` and every
 * request body is the same shape. The `id` is a **string containing an integer**, and the integers are
 * **per object type**: order `8801` and subscription-invoice `8801` are different objects. Nothing in this
 * module cares, but {@link namespacedId} exists because the projection very much does — see `objects.ts`.
 *
 * The `Accept` and `Content-Type` are `application/vnd.api+json`, which the API enforces. A request sent as
 * `application/json` is refused with a 415, and that refusal reads as a configuration failure rather than
 * as anything a buyer did — which is exactly how the mapping below treats it.
 *
 * ## How an answer is read
 *
 * **A 5xx or a 429 is `payments/provider_unavailable` (503).** Lemon Squeezy is up but not answering. The
 * caller retries, and on the webhook path that code passes through the guard unchanged so the store
 * redelivers rather than being told its signature was bad.
 *
 * **Every other 4xx is `payments/rail_not_configured` (404).** A 4xx here is never the buyer's fault: these
 * requests are built entirely from config, from the credential bundle, and from rows we wrote. A rejected
 * API key, a variant that does not belong to this store, a store id that is not ours — all one statement,
 * that this project's Lemon Squeezy rail is not set up to do what it was asked.
 *
 * **A 404 is an absent resource only for a caller that said it was probing.** `absentOn404` is how a
 * refresh distinguishes "Lemon Squeezy no longer knows this subscription" — a normal answer, which the
 * contract says is `undefined` — from "our API key is wrong". Only a caller that knows the difference may
 * claim it.
 *
 * **Nothing in a refusal carries the API key.** `detail` is written to an operator's logs, so anything
 * key-shaped in a message is redacted before it gets there.
 */

/** Lemon Squeezy's REST base. Public and stable, so it is pinned rather than configured. */
export const LEMON_SQUEEZY_API_BASE = "https://api.lemonsqueezy.com/v1";

/** The media type JSON:API mandates, and which this API enforces on both directions. */
const JSON_API_MEDIA_TYPE = "application/vnd.api+json";

/** One outbound request, narrowed to what this rail's endpoints need. */
export interface LemonSqueezyHttpRequest {
  /** The HTTP method. */
  method?: string;
  /** Request headers — the bearer key and the JSON:API media type. */
  headers?: Record<string, string>;
  /** The JSON:API body, on a POST. */
  body?: string;
}

/** What this rail needs of a response. Structural, so a test can answer without building a `Response`. */
export interface LemonSqueezyHttpResponse {
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The body as text — read once, then parsed here, so a non-JSON body is reportable rather than a throw. */
  text(): Promise<string>;
}

/** The HTTP seam. One explicit parameter defaulting to the runtime's `fetch`, as every rail has. */
export type LemonSqueezyHttpFetch = (url: string, init?: LemonSqueezyHttpRequest) => Promise<LemonSqueezyHttpResponse>;

/** The runtime's own `fetch`, adapted to the seam. */
export const lemonSqueezyHttpFetch: LemonSqueezyHttpFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<LemonSqueezyHttpResponse>;

/** Lemon Squeezy's error envelope — JSON:API's `errors` array, of which only the first is worth reporting. */
const LemonSqueezyApiError = z.object({
  errors: z.array(
    z.object({ status: z.string().optional(), title: z.string().optional(), detail: z.string().optional() }),
  ),
});

/** What one call needs: what it is for, the key, and optionally a body or a probe flag. */
export interface LemonSqueezyJsonOptions {
  /** What was being asked for, in an operator's words. Lands in every refusal's `detail`. */
  what: string;
  /** The Lemon Squeezy API key. */
  apiKey: string;
  /** The JSON:API request body, on a POST. */
  body?: unknown;
  /** The query string, already composed. */
  query?: Record<string, string>;
  /** Whether a 404 means "no such object" rather than "this rail is misconfigured". */
  absentOn404?: boolean;
}

/**
 * One call to Lemon Squeezy. Returns the parsed body, or `undefined` for a probing caller's 404.
 *
 * `unknown` rather than a typed answer: the caller narrows with its own Zod object, because what a
 * subscription looks like is `objects.ts`'s business and not this module's.
 */
export async function lemonSqueezyJson(
  transport: LemonSqueezyHttpFetch,
  path: string,
  options: LemonSqueezyJsonOptions,
): Promise<unknown | undefined> {
  const query =
    options.query === undefined || Object.keys(options.query).length === 0
      ? ""
      : `?${new URLSearchParams(options.query).toString()}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.apiKey}`,
    accept: JSON_API_MEDIA_TYPE,
  };
  if (options.body !== undefined) headers["content-type"] = JSON_API_MEDIA_TYPE;

  let response: LemonSqueezyHttpResponse;
  try {
    response = await transport(`${LEMON_SQUEEZY_API_BASE}${path}${query}`, {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    throw new PaymentsProviderUnavailableError(
      { detail: `Lemon Squeezy did not answer when asked for ${options.what}.` },
      { cause },
    );
  }

  const text = await response.text();

  if (!response.ok) {
    if (response.status === 404 && options.absentOn404) return undefined;
    throw refusal(response.status, text, options);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PaymentsProviderUnavailableError(
      { detail: `Lemon Squeezy answered with a non-JSON body when asked for ${options.what}.` },
      { cause },
    );
  }
}

/** The refusal for a non-2xx answer: retryable if the store is struggling, a configuration failure otherwise. */
function refusal(status: number, body: string, options: LemonSqueezyJsonOptions): PaymentsProviderUnavailableError {
  if (status === 429 || status >= 500) {
    return new PaymentsProviderUnavailableError({
      detail: `Lemon Squeezy answered ${status} when asked for ${options.what}. ${lemonSqueezySaid(body)}`,
    });
  }

  const key = status === 401 || status === 403 ? " Check the API key stored for this environment." : "";
  return new PaymentsRailNotConfiguredError({
    detail: `Lemon Squeezy refused the request for ${options.what} with ${status}.${key} ${lemonSqueezySaid(body)}`,
  });
}

/** Lemon Squeezy's own account of the failure, redacted. Empty when the body was not its error envelope. */
function lemonSqueezySaid(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return "";
  }
  const envelope = LemonSqueezyApiError.safeParse(parsed);
  if (!envelope.success) return "";
  const first = envelope.data.errors[0];
  if (first === undefined) return "";
  const parts = [first.title, first.detail].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "" : `Lemon Squeezy said: ${redactLemonSqueezySecrets(parts.join(" / "))}.`;
}

/**
 * Blank out anything key-shaped in text bound for a log.
 *
 * Belt and braces, exactly as the Stripe rail's equivalent: `detail` is written to an operator's logs, and
 * a credential that reaches one has to be rotated. Lemon Squeezy API keys are long opaque strings with no
 * fixed prefix, so what is matched is the shape a JWT-ish or base64url key takes at 40 characters or more —
 * long enough that a variant id, a store id, or an ordinary sentence cannot trip it.
 */
export function redactLemonSqueezySecrets(text: string): string {
  return text.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "…");
}
