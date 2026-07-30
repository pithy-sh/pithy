import { PaymentsProviderUnavailableError } from "../../error/errors";

/**
 * The one door out to Google, and the mapping from how it answered to what that means.
 *
 * **Why the Google rail reaches the network at all.** Apple hands us a signed transaction that verifies
 * offline; Play hands us a purchase token, which is a pointer and nothing more. So Google's rail has two
 * unavoidable round-trips — the JWKS that verifies a push token, and the Play Developer API that turns a
 * pointer into a state — and every failure mode of those round-trips has to land somewhere deliberate.
 *
 * **Every failure but one is `payments/provider_unavailable` (503).** A timeout, a 5xx, a rate limit, a
 * revoked service-account grant, an HTML error page from a proxy: from payments' side these are one
 * statement — *we could not learn the state* — and the correct response to not knowing is to say so and let
 * the caller retry. A silent skip would be the alternative, and a silent skip on a renewal notification
 * revokes a paying subscriber. The webhook route rethrows a 503 so Pub/Sub redelivers, and the
 * reconciliation Workflow repairs whatever redelivery never fixes.
 *
 * **The exception is a 404 the caller asked for.** Play has no "what kind of purchase is this token" call, so
 * a 404 from the subscription endpoint is how a one-time purchase identifies itself. That is a fact about the
 * purchase rather than a failure to reach the store, and only a caller that knows it is probing may treat it
 * as one — hence `absentOn404` rather than a blanket rule.
 *
 * **No refusal carries the URL or the response body.** A Play request URL ends in the purchase token, and
 * Google's error bodies quote the request. `detail` reaches an operator's logs, and a purchase token is a
 * bearer artifact — the same rule as a receipt.
 */

/** One outbound request, narrowed to what Google's two endpoints need. */
export interface GoogleHttpRequest {
  /** The HTTP method. Defaults to GET. */
  method?: string;
  /** Request headers — the bearer token, or the token endpoint's form content type. */
  headers?: Record<string, string>;
  /** The request body, already encoded. */
  body?: string;
}

/** The response shape this module reads. Structural, so a test's transport need not be a whole `Response`. */
export interface GoogleHttpResponse {
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The status code, which is what decides the mapping. */
  status: number;
  /** The body as text. Read as text rather than JSON so a non-JSON answer is a diagnosis, not a throw. */
  text(): Promise<string>;
}

/**
 * The HTTP seam for Google's endpoints.
 *
 * Injectable for exactly one reason: **no test may reach a live store**, and a rail whose network call could
 * not be substituted would have to be tested through a stub of itself, which proves nothing. One explicit
 * parameter is better than reassigning a global — a global stub leaks between suites and hides which module
 * was actually exercised.
 */
export type GoogleHttpFetch = (url: string, init?: GoogleHttpRequest) => Promise<GoogleHttpResponse>;

/** The default transport: the runtime's own `fetch`. */
export const googleHttpFetch: GoogleHttpFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<GoogleHttpResponse>;

/** What one request is for, and how its answers should be read. */
export interface GoogleJsonOptions {
  /** What is being fetched, in a `detail` line: "the subscription", "an access token". Never the URL. */
  what: string;
  /** The HTTP method. Defaults to GET. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** The request body, already encoded. */
  body?: string;
  /**
   * Whether a 404 means "no such purchase" rather than a failure. Set only by a caller that is deliberately
   * probing — Play's subscription endpoint answering 404 is how a one-time purchase is recognized.
   */
  absentOn404?: boolean;
}

/**
 * One request to Google, and its parsed JSON body — or `undefined` when a 404 was a legitimate answer.
 *
 * The body comes back as `unknown`. Reaching an endpoint proves who answered, never what they said, so every
 * caller Zod-parses its own shape.
 */
export async function googleJson(
  transport: GoogleHttpFetch,
  url: string,
  options: GoogleJsonOptions,
): Promise<unknown | undefined> {
  let response: GoogleHttpResponse;
  try {
    response = await transport(url, { method: options.method, headers: options.headers, body: options.body });
  } catch (cause) {
    throw unavailable(`Google did not answer when asked for ${options.what}.`, cause);
  }

  if (response.status === 404 && options.absentOn404) return undefined;

  if (!response.ok) {
    // 401 and 403 are the two an operator can actually fix, and they have one overwhelmingly common cause.
    const hint =
      response.status === 401 || response.status === 403
        ? " Check that the service account is linked in the Play Console under Users and permissions with financial-data access, and that the Google Play Android Developer API is enabled for its project."
        : "";
    throw unavailable(`Google answered ${response.status} when asked for ${options.what}.${hint}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    // An HTML error page behind a proxy is the realistic shape of this. Reading it as an absent purchase would
    // revoke somebody's subscription, so it is a failure to reach the store like any other.
    throw unavailable(`Google answered with a non-JSON body when asked for ${options.what}.`, cause);
  }
}

/** The 503, with the operator's context in `detail` and nothing about the request in either field. */
function unavailable(detail: string, cause?: unknown): PaymentsProviderUnavailableError {
  return new PaymentsProviderUnavailableError({ detail }, cause === undefined ? undefined : { cause });
}
