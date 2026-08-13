// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError, PaymentsRailNotConfiguredError } from "../../error/errors";

/**
 * The one door out to Paddle, and the mapping from how it answered to what that means.
 *
 * Reached with `fetch` and JSON rather than through `@paddle/paddle-node-sdk`, for the reason
 * `stripe/api.ts` and `lemonSqueezy/api.ts` both give: a handful of calls are needed and each is one
 * request. Every other third-party API in this repo is spoken to the same way — `fetch` out, Zod in — and
 * a Node SDK in a Workers bundle buys nothing but weight.
 *
 * **Paddle Billing, not Paddle Classic.** `api.paddle.com` in production and `sandbox-api.paddle.com` in
 * sandbox, with `Paddle-Version: 1` pinned on every request so a future default at Paddle cannot silently
 * reshape a response this package parses.
 *
 * ## How an answer is read
 *
 * **A 5xx or a 429 is `payments/provider_unavailable` (503).** Paddle is up but not answering. The caller
 * retries, and on the webhook path that code passes through the guard unchanged so Paddle redelivers
 * rather than being told its signature was bad.
 *
 * **Every other 4xx is `payments/rail_not_configured` (404).** A 4xx here is never the buyer's fault:
 * these requests are built from config, from the credential bundle, and from rows we wrote. A rejected
 * API key, a price that is not in this account, a customer that is not ours — one statement, that this
 * project's Paddle rail is not set up to do what it was asked.
 *
 * **A 404 is an absent resource only for a caller that said it was probing.** `absentOn404` is how a
 * refresh distinguishes "Paddle no longer knows this subscription" — a normal answer, which the contract
 * says is `undefined` — from "our API key is wrong". Only a caller that knows the difference may claim it.
 *
 * ## Two of Paddle's refusals are the adopter's account rather than their credentials
 *
 * `transactions.create` refuses account-wide with *"Cannot create a transaction or open a checkout as no
 * default payment link has been set for this account"* until somebody sets one in the Paddle dashboard.
 * Verified live against the assigned sandbox, where it is still true. It arrives as an ordinary 4xx and
 * would read as "the rail is misconfigured", which is correct but useless — so {@link paddleSaid} keeps
 * Paddle's own sentence in `detail`, and `pithy doctor` asks the same question before a buyer does.
 *
 * **Nothing in a refusal carries the API key.** `detail` is written to an operator's logs, so anything
 * key-shaped in a message is redacted before it gets there.
 */

/** Paddle's production API. Public and stable, so it is pinned rather than configured. */
export const PADDLE_API_BASE = "https://api.paddle.com";

/** Paddle's sandbox API. A separate host, not a flag — sandbox and live are separate accounts entirely. */
export const PADDLE_SANDBOX_API_BASE = "https://sandbox-api.paddle.com";

/**
 * The API version every request pins.
 *
 * Sent on every call so a future default at Paddle cannot reshape a response this package's schemas parse
 * — the failure would be a webhook that stops projecting, discovered by a customer.
 */
export const PADDLE_API_VERSION = "1";

/** Which Paddle account a deployment sells through. Two hosts, two sets of credentials, one code path. */
export type PaddleEnvironment = "sandbox" | "production";

/** The base URL for an environment. */
export function paddleApiBase(environment: PaddleEnvironment): string {
  return environment === "production" ? PADDLE_API_BASE : PADDLE_SANDBOX_API_BASE;
}

/** One outbound request, narrowed to what this rail's endpoints need. */
export interface PaddleHttpRequest {
  /** The HTTP method. */
  method?: string;
  /** Request headers — the bearer key, the pinned version, and any idempotency key. */
  headers?: Record<string, string>;
  /** The JSON body, on a POST. */
  body?: string;
}

/** What this rail needs of a response. Structural, so a test can answer without building a `Response`. */
export interface PaddleHttpResponse {
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The body as text — read once, then parsed here, so a non-JSON body is reportable rather than a throw. */
  text(): Promise<string>;
}

/** The HTTP seam. One explicit parameter defaulting to the runtime's `fetch`, as every rail has. */
export type PaddleHttpFetch = (url: string, init?: PaddleHttpRequest) => Promise<PaddleHttpResponse>;

/** The runtime's own `fetch`, adapted to the seam. */
export const paddleHttpFetch: PaddleHttpFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<PaddleHttpResponse>;

/** Paddle's error envelope, of which only the human parts are worth reporting. */
const PaddleApiError = z.object({
  error: z
    .object({
      type: z.string().optional(),
      code: z.string().optional(),
      detail: z.string().optional(),
    })
    .loose(),
});

/** A Paddle success envelope: the entity under `data`, and pagination under `meta` for a list. */
const PaddleEnvelope = z
  .object({
    data: z.unknown(),
    meta: z
      .object({ pagination: z.object({ has_more: z.boolean().optional() }).loose().optional() })
      .loose()
      .optional(),
  })
  .loose();

/** What one call needs: what it is for, the key, and optionally a body, a query, or a probe flag. */
export interface PaddleJsonOptions {
  /** What was being asked for, in an operator's words. Lands in every refusal's `detail`. */
  what: string;
  /** The Paddle API key — `pdl_live_apikey_…` or `pdl_sdbx_apikey_…`. */
  apiKey: string;
  /** Which account to reach. Decides the host, and nothing else. */
  environment: PaddleEnvironment;
  /** The HTTP method. Defaults to GET, or POST when a body is present. */
  method?: string;
  /** The JSON request body. */
  body?: unknown;
  /**
   * The query string as pairs. A repeated key is how Paddle takes an array — `event_type[]` — so this is
   * a list of pairs rather than a record.
   */
  query?: readonly (readonly [string, string])[];
  /**
   * An idempotency key, so a request Paddle already performed is not performed twice.
   *
   * The one place this matters is checkout: a double-submitted buy button must create one transaction,
   * not two, and Paddle's own header is what guarantees that rather than a check of ours.
   */
  idempotencyKey?: string;
  /** Whether a 404 means "no such object" rather than "this rail is misconfigured". */
  absentOn404?: boolean;
}

/** One Paddle answer: the entity, and whether the list it came from has more. */
export interface PaddleAnswer {
  /** The `data` member, unnarrowed — the caller parses it with its own Zod object. */
  data: unknown;
  /** Whether a paginated list has another page. False for a single entity. */
  hasMore: boolean;
}

/**
 * One call to Paddle. Returns the parsed envelope, or `undefined` for a probing caller's 404.
 *
 * `unknown` inside rather than a typed answer: what a subscription looks like is `objects.ts`'s business
 * and not this module's.
 */
export async function paddleJson(
  transport: PaddleHttpFetch,
  path: string,
  options: PaddleJsonOptions,
): Promise<PaddleAnswer | undefined> {
  const search = new URLSearchParams();
  for (const [key, value] of options.query ?? []) search.append(key, value);
  const query = [...search].length === 0 ? "" : `?${search.toString()}`;

  const headers: Record<string, string> = {
    authorization: `Bearer ${options.apiKey}`,
    accept: "application/json",
    "paddle-version": PADDLE_API_VERSION,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey !== undefined) headers["paddle-idempotency-key"] = options.idempotencyKey;

  let response: PaddleHttpResponse;
  try {
    response = await transport(`${paddleApiBase(options.environment)}${path}${query}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    throw new PaymentsProviderUnavailableError(
      { detail: `Paddle did not answer when asked for ${options.what}.` },
      { cause },
    );
  }

  const text = await response.text();

  if (!response.ok) {
    if (response.status === 404 && options.absentOn404) return undefined;
    throw refusal(response.status, text, options);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PaymentsProviderUnavailableError(
      { detail: `Paddle answered with a non-JSON body when asked for ${options.what}.` },
      { cause },
    );
  }

  const envelope = PaddleEnvelope.safeParse(parsed);
  if (!envelope.success) {
    throw new PaymentsProviderUnavailableError({
      detail: `Paddle answered for ${options.what} with a body carrying no \`data\`.`,
    });
  }
  return { data: envelope.data.data, hasMore: envelope.data.meta?.pagination?.has_more === true };
}

/** The refusal for a non-2xx answer: retryable if Paddle is struggling, a configuration failure otherwise. */
function refusal(status: number, body: string, options: PaddleJsonOptions): PaymentsProviderUnavailableError {
  if (status === 429 || status >= 500) {
    return new PaymentsProviderUnavailableError({
      detail: `Paddle answered ${status} when asked for ${options.what}. ${paddleSaid(body)}`,
    });
  }

  const key = status === 401 || status === 403 ? " Check the API key stored for this environment." : "";
  return new PaymentsRailNotConfiguredError({
    detail: `Paddle refused the request for ${options.what} with ${status}.${key} ${paddleSaid(body)}`,
  });
}

/**
 * Paddle's own account of the failure, redacted. Empty when the body was not its error envelope.
 *
 * Worth carrying rather than dropping, because Paddle's most consequential refusal is a sentence and not
 * a code: *"Cannot create a transaction or open a checkout as no default payment link has been set for
 * this account."* Without it an operator sees a 400 on `/transactions` and has nothing to act on.
 */
export function paddleSaid(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return "";
  }
  const envelope = PaddleApiError.safeParse(parsed);
  if (!envelope.success) return "";
  const parts = [envelope.data.error.code, envelope.data.error.detail].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return parts.length === 0 ? "" : `Paddle said: ${redactPaddleSecrets(parts.join(" / "))}.`;
}

/**
 * Blank out anything key-shaped in text bound for a log.
 *
 * Paddle's credentials carry fixed prefixes, which makes this sharper than the Lemon Squeezy equivalent:
 * an API key is `pdl_live_apikey_…` or `pdl_sdbx_apikey_…`, a destination secret is `pdl_ntfset_…`, and a
 * client token is `live_…` or `test_…`. The token is publishable, but a log is not where it belongs
 * either, and a rule with an exception is a rule somebody eventually reads wrong.
 */
export function redactPaddleSecrets(text: string): string {
  return text.replace(/\bpdl_[A-Za-z0-9_]+/g, "…").replace(/\b(?:live|test)_[A-Za-z0-9]{16,}\b/g, "…");
}
