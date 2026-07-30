import { z } from "zod";
import { PaymentsProviderUnavailableError, PaymentsRailNotConfiguredError } from "../../error/errors";

/**
 * The one door out to Stripe, and the mapping from how it answered to what that means.
 *
 * Stripe is reached with `fetch` and form encoding rather than through the `stripe` npm package, deliberately.
 * Three calls are needed for hosted-only payments — create a Checkout Session, create a Billing Portal session,
 * retrieve a Checkout Session — and each is one form POST or GET. The SDK would add a dependency with its own
 * runtime shims, its own retry policy, and its own idea of what an error is, to save perhaps forty lines. Every
 * other third-party API in this repo is spoken to the same way: `fetch` out, Zod in.
 *
 * **The API version is pinned.** Stripe decides response shapes from the *account's* default version unless a
 * request names one, so an account upgraded in the dashboard would silently change what this code parses. Pinning
 * it here means an upgrade is a deliberate edit with a test run behind it. Webhook payload shapes are a separate
 * matter — those follow the endpoint's own configured version, which is why `objects.ts` accepts both spellings of
 * the fields Stripe has moved.
 *
 * ## How an answer is read
 *
 * **A 5xx or a 429 is `payments/provider_unavailable` (503).** Stripe is up but not answering, or is asking us to
 * slow down. The caller retries and the reconciliation pass covers whatever a retry never fixes.
 *
 * **Every other 4xx is `payments/rail_not_configured` (404), and that is the deliberate part.** A 4xx from Stripe
 * is never the buyer's fault — we build these requests entirely from config and from rows we wrote, so "No such
 * price", "No such customer", a rejected key, and a missing Billing Portal configuration are all one statement:
 * this project's Stripe rail is not set up to do what it was asked. 503 would tell a caller to retry something
 * that will never succeed; 400 would blame a request the caller did not make. 404 says the payment method is not
 * available here, which is true, and `detail` carries Stripe's own sentence for the operator who can fix it.
 *
 * **A 404 is an absent resource only for a caller that said it was probing.** `absentOn404` is how a Checkout
 * Session retrieve distinguishes "no such session" from "our Stripe account is wrong", and only a caller that
 * knows the difference may claim it.
 *
 * **Nothing in a refusal carries the secret key.** Stripe redacts keys in its own messages, but `detail` is
 * written to an operator's logs, so anything key-shaped in a message is redacted again here before it gets there.
 */

/** Stripe's REST base. Public and stable, so it is pinned rather than configured. */
export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * The API version every request pins.
 *
 * To move it: read Stripe's changelog for the shape changes between the two, adjust `objects.ts`, run the suite,
 * and change this line. Never bump it to match an account — the point of pinning is that the account cannot
 * decide what this code parses.
 */
export const STRIPE_API_VERSION = "2025-04-30.basil";

/** One outbound request, narrowed to what Stripe's three endpoints need. */
export interface StripeHttpRequest {
  /** The HTTP method. */
  method?: string;
  /** Request headers — the bearer key, the pinned version, and a form content type on a POST. */
  headers?: Record<string, string>;
  /** The form-encoded body, on a POST. */
  body?: string;
}

/** The response shape this module reads. Structural, so a test's transport need not be a whole `Response`. */
export interface StripeHttpResponse {
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The status code, which is what decides the mapping. */
  status: number;
  /** The body as text. Read as text rather than JSON so a non-JSON answer is a diagnosis, not a throw. */
  text(): Promise<string>;
}

/**
 * The HTTP seam for Stripe's endpoints.
 *
 * Injectable for one reason: **no test may reach a live Stripe account**, and a rail whose network call could not
 * be substituted would have to be tested through a stub of itself. One explicit parameter beats reassigning a
 * global, which leaks between suites and hides which module was exercised.
 */
export type StripeHttpFetch = (url: string, init?: StripeHttpRequest) => Promise<StripeHttpResponse>;

/** The default transport: the runtime's own `fetch`. */
export const stripeHttpFetch: StripeHttpFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<StripeHttpResponse>;

/** A value Stripe's form encoding can carry. Nested objects and arrays become bracketed keys. */
export type StripeFormValue = string | number | boolean | null | undefined | StripeFormObject | StripeFormValue[];

/** One level of a Stripe form body. */
export interface StripeFormObject {
  [key: string]: StripeFormValue;
}

/**
 * Encode a nested object the way Stripe's API reads a form body: `line_items[0][price]=price_1`.
 *
 * `URLSearchParams` alone cannot produce that, which is the whole reason this exists. `undefined` and `null` are
 * dropped rather than sent empty, because Stripe reads an empty value as "unset this field" — so omitting an
 * optional parameter and sending it blank are two different requests.
 */
export function stripeForm(input: StripeFormObject): string {
  const params = new URLSearchParams();
  append(params, "", input);
  return params.toString();
}

/** What one request is for, and how its answers should be read. */
export interface StripeJsonOptions {
  /** What is being fetched, in a `detail` line: "a Checkout Session". Never the URL, never the body. */
  what: string;
  /** The Stripe secret key. Read through the secrets store by the caller, never off an env binding. */
  secretKey: string;
  /** The form body. Its presence is what makes the request a POST. */
  form?: StripeFormObject;
  /** Query parameters, encoded in Stripe's own bracket notation — `expand[0]=subscription`. */
  query?: StripeFormObject;
  /**
   * Whether a 404 means "no such resource" rather than a misconfigured account. Set only by a caller that is
   * deliberately probing for something that may legitimately not exist.
   */
  absentOn404?: boolean;
}

/** Stripe's error envelope, as much of it as a `detail` line needs. */
const StripeApiError = z
  .object({
    error: z
      .object({
        type: z.string().min(1).optional().describe("Stripe's error class — `invalid_request_error`, `api_error`."),
        code: z.string().min(1).optional().describe("The machine-readable reason — `resource_missing`."),
        param: z.string().min(1).optional().describe("Which request parameter Stripe blamed."),
        message: z.string().min(1).optional().describe("Stripe's own sentence. Redacted before it reaches a log."),
      })
      .loose()
      .describe("The error Stripe reported."),
  })
  .loose()
  .describe("Stripe's error response envelope.");

/**
 * One request to Stripe, and its parsed JSON body — or `undefined` when a 404 was a legitimate answer.
 *
 * The body comes back as `unknown`. Reaching an endpoint proves who answered, never what they said, so every
 * caller Zod-parses its own shape.
 */
export async function stripeJson(
  transport: StripeHttpFetch,
  path: string,
  options: StripeJsonOptions,
): Promise<unknown | undefined> {
  const query = options.query === undefined ? "" : `?${stripeForm(options.query)}`;
  const url = `${STRIPE_API_BASE}${path}${query}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.secretKey}`,
    "stripe-version": STRIPE_API_VERSION,
  };
  if (options.form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";

  let response: StripeHttpResponse;
  try {
    response = await transport(url, {
      method: options.form === undefined ? "GET" : "POST",
      headers,
      body: options.form === undefined ? undefined : stripeForm(options.form),
    });
  } catch (cause) {
    throw new PaymentsProviderUnavailableError(
      { detail: `Stripe did not answer when asked for ${options.what}.` },
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
      { detail: `Stripe answered with a non-JSON body when asked for ${options.what}.` },
      { cause },
    );
  }
}

/** The refusal for a non-2xx answer: retryable if Stripe is struggling, a configuration failure otherwise. */
function refusal(status: number, body: string, options: StripeJsonOptions): PaymentsProviderUnavailableError {
  if (status === 429 || status >= 500) {
    return new PaymentsProviderUnavailableError({
      detail: `Stripe answered ${status} when asked for ${options.what}. ${stripeSaid(body)}`,
    });
  }

  const key = status === 401 || status === 403 ? " Check the secret key stored for this environment." : "";
  return new PaymentsRailNotConfiguredError({
    detail: `Stripe refused the request for ${options.what} with ${status}.${key} ${stripeSaid(body)}`,
  });
}

/** Stripe's own account of the failure, redacted. Empty when the body was not a Stripe error envelope. */
function stripeSaid(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return "";
  }
  const envelope = StripeApiError.safeParse(parsed);
  if (!envelope.success) return "";
  const { type, code, param, message } = envelope.data.error;
  const parts = [type, code, param === undefined ? undefined : `param ${param}`, message].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? "" : `Stripe said: ${redactStripeSecrets(parts.join(" / "))}.`;
}

/**
 * Blank out anything key-shaped in text bound for a log.
 *
 * Stripe already redacts keys in its messages, so this is belt and braces — but `detail` is written to an
 * operator's logs and read by whoever has them, and a credential that reaches one has to be rotated. Cheap
 * insurance against a message format changing.
 */
export function redactStripeSecrets(text: string): string {
  return text.replace(
    /\b(sk|rk|whsec)_(test_|live_)?[A-Za-z0-9]+/g,
    (_match, prefix, mode) => `${prefix}_${mode ?? ""}…`,
  );
}

/** Append one value under a bracketed key path, recursing into objects and arrays. */
function append(params: URLSearchParams, prefix: string, value: StripeFormValue): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) append(params, `${prefix}[${index}]`, entry);
    return;
  }

  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      append(params, prefix === "" ? key : `${prefix}[${key}]`, entry);
    }
    return;
  }

  params.append(prefix, String(value));
}
