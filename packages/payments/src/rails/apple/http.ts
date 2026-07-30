import { PaymentsProviderUnavailableError, PaymentsRailNotConfiguredError } from "../../error/errors";

/**
 * The one door out to Apple, and the mapping from how it answered to what that means.
 *
 * **Why the Apple rail reaches the network at all, when verification does not.** A StoreKit transaction is
 * signed, so a client submission and a notification both verify offline against the pinned chain. Neither
 * tells us anything about a subscription we have not heard from — and that silence is precisely what
 * reconciliation exists for: Apple stops renewing and sends nothing, or the notification it did send never
 * arrived. Answering that needs the App Store Server API, and this is the only module that talks to it.
 *
 * ## How an answer is read
 *
 * **A 429 or a 5xx is `payments/provider_unavailable` (503).** Apple is up and not answering, or is asking us
 * to slow down. The Workflow step fails and is retried, which is what durable execution is for.
 *
 * **Every other 4xx is `payments/rail_not_configured` (404), the same call Stripe's door makes.** A request
 * here is built entirely from our own credentials and from rows we wrote, so a 401 (the signing key or the
 * issuer id is wrong), a 400, and a 403 are one statement: this project's Apple rail is not set up to do what
 * it was asked. 503 would ask a caller to retry something that will never succeed, and no client is involved
 * to blame with a 400.
 *
 * **A 404 is an absent purchase only for a caller that said it was probing.** Apple answers 404 for a
 * transaction id it does not know — a sandbox id asked of production, or a purchase from a different app —
 * and only a caller that knows the difference between that and a misconfigured account may claim it.
 *
 * **No refusal carries the URL or the response body.** The URL ends in a transaction id and Apple's error
 * bodies quote the request. `detail` reaches an operator's log, and the same rule that keeps a receipt out of
 * one keeps these out too.
 */

/** One outbound request, narrowed to what the App Store Server API needs. Every call is an authorized GET. */
export interface AppleHttpRequest {
  /** The HTTP method. Defaults to GET. */
  method?: string;
  /** Request headers — the bearer assertion, and nothing else. */
  headers?: Record<string, string>;
}

/** The response shape this module reads. Structural, so a test's transport need not be a whole `Response`. */
export interface AppleHttpResponse {
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The status code, which is what decides the mapping. */
  status: number;
  /** The body as text. Read as text rather than JSON so a non-JSON answer is a diagnosis, not a throw. */
  text(): Promise<string>;
}

/**
 * The HTTP seam for the App Store Server API.
 *
 * Injectable for one reason: **no test may reach a live store**, and a rail whose network call could not be
 * substituted would have to be tested through a stub of itself. One explicit parameter beats reassigning a
 * global, which leaks between suites and hides which module was exercised.
 */
export type AppleHttpFetch = (url: string, init?: AppleHttpRequest) => Promise<AppleHttpResponse>;

/** The default transport: the runtime's own `fetch`. */
export const appleHttpFetch: AppleHttpFetch = (url, init) => fetch(url, init) as unknown as Promise<AppleHttpResponse>;

/** What one request is for, and how its answers should be read. */
export interface AppleJsonOptions {
  /** What is being fetched, in a `detail` line: "the subscription statuses". Never the URL. */
  what: string;
  /** Request headers — the bearer assertion. */
  headers?: Record<string, string>;
  /**
   * Whether a 404 means "no such transaction" rather than a misconfigured account. Set only by a caller that
   * is deliberately probing for something that may legitimately not exist.
   */
  absentOn404?: boolean;
}

/**
 * One request to Apple, and its parsed JSON body — or `undefined` when a 404 was a legitimate answer.
 *
 * The body comes back as `unknown`. Reaching an endpoint proves who answered, never what they said, so every
 * caller Zod-parses its own shape.
 */
export async function appleJson(
  transport: AppleHttpFetch,
  url: string,
  options: AppleJsonOptions,
): Promise<unknown | undefined> {
  let response: AppleHttpResponse;
  try {
    response = await transport(url, { headers: options.headers });
  } catch (cause) {
    throw new PaymentsProviderUnavailableError(
      { detail: `Apple did not answer when asked for ${options.what}.` },
      { cause },
    );
  }

  if (response.status === 404 && options.absentOn404) return undefined;

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new PaymentsProviderUnavailableError({
        detail: `Apple answered ${response.status} when asked for ${options.what}.`,
      });
    }
    // 401 is the one an operator can actually fix, and it has one overwhelmingly common cause.
    const hint =
      response.status === 401
        ? " Check the App Store Connect key id, issuer id, and private key in the payments provider secret — a token Apple will not accept is a credential problem, not an outage."
        : "";
    throw new PaymentsRailNotConfiguredError({
      detail: `Apple answered ${response.status} when asked for ${options.what}.${hint}`,
    });
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    // An HTML error page behind a proxy is the realistic shape of this. Reading it as an absent purchase would
    // leave a live subscription looking unreconciled forever, so it is a failure to reach the store like any other.
    throw new PaymentsProviderUnavailableError(
      { detail: `Apple answered with a non-JSON body when asked for ${options.what}.` },
      { cause },
    );
  }
}
