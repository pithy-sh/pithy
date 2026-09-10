// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError, UpstreamTimeoutError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import { MAX_WORKFLOW_STEP_TEXT } from "@pithy-sh/core/src/workflow/stepMessage";
import type { z } from "zod";

/**
 * Cloudflare REST client throw sugar. The `cloudflare/*` codes live in core's closed
 * `KitErrorPayload` union (CLAUDE.md §Errors: capabilities add their codes to the one union); these
 * subclasses are the package-local vehicles that set one of those members — the same pattern as
 * core's `NotFoundError`/`InternalError`, just owned here. Runtime code in this package throws
 * one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface CloudflareErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

/** A required piece of configuration (token, account id, resource id) is missing. */
export class CloudflareNotConfiguredError extends PithyError {
  constructor(args: CloudflareErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "cloudflare/not_configured",
        status: 500,
        message: args.message ?? "The Cloudflare REST client is not fully configured.",
        action: args.action ?? "Provide apiToken, accountId, and any required resource id.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A call to the Cloudflare REST API failed (network error, 4xx/5xx from the API).
 *
 * **The `apiAnswer` default is the guarantee, not a convenience.** `core`'s `GUARANTEED_ERROR_PARAMS`
 * declares that every throw of `cloudflare/request_failed` passes `apiAnswer`, and a locale wrote a
 * `{apiAnswer}` against that declaration — so a path that omits it renders the placeholder literally on
 * a Spanish reader's screen. Guaranteed means every throw, so the promise is kept where the code is
 * fixed rather than at each of the sites that construct one: an empty answer is what "the call never
 * reached Cloudflare" renders as, and it is the honest value for any path that has nothing to report.
 */
export class CloudflareRequestError extends PithyError {
  constructor(args: CloudflareErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "cloudflare/request_failed",
        status: 502,
        message: args.message ?? "A Cloudflare REST API call failed.",
        action: args.action,
        detail: args.detail,
        params: { apiAnswer: "", ...args.params },
      },
      options,
    );
  }
}

/** A Cloudflare REST API response did not match its expected shape (failed Zod validation). */
export class CloudflareInvalidResponseError extends PithyError {
  constructor(args: CloudflareErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "cloudflare/invalid_response",
        status: 502,
        message: args.message ?? "A Cloudflare REST API response had an unexpected shape.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * One entry of Cloudflare's `errors[]` array — the API's own answer to a failed call.
 *
 * Every v4 endpoint answers a failure with `{ success: false, errors: [{ code, message,
 * documentation_url }] }`, and the SDK already parses it onto the thrown `APIError`. Until #534 we
 * projected none of it: a refusal named the operation and stopped, so a token missing one product's
 * grant, a revoked token, a wrong account and an outage all rendered as the same sentence.
 */
export interface CloudflareApiError {
  /** Cloudflare's numeric error code — the stable discriminator (`10000` is its auth-class code). */
  code?: number;
  /** Cloudflare's own sentence for the failure ("Authentication error"). */
  message?: string;
  /** The docs page for the endpoint that refused, when Cloudflare names one. */
  documentationUrl?: string;
}

/**
 * How many of Cloudflare's error entries reach the refusal, and how long each sentence may be.
 *
 * Bounded because this text lands in `message`, and `message` is the one field that crosses to a
 * client (CLAUDE.md §Errors). An operator gets the whole body in `detail`; a refusal stays readable.
 *
 * Bounded is not the same as **shaped**, which is why {@link oneLine} exists beside these two. A `\n`
 * inside Cloudflare's sentence would put the remainder at column zero, indistinguishable from Pithy's
 * own action line, and would cross to a browser exactly as written. So upstream text is flattened to
 * one line before it is measured: sanitize, then slice, never the reverse.
 */
const MAX_API_ERRORS = 3;
const MAX_API_MESSAGE = 200;

/**
 * The most a composed refusal `message` may run to, and it is **derived, not chosen**.
 *
 * A refusal is raised inside Workflow steps as well as at a CLI — `classifiedSteps` wraps the store
 * calls in `@pithy-sh/secrets`' rotation, `@pithy-sh/media`'s Stream reads, `@pithy-sh/payments`'
 * reconcile — and across that durable boundary the step's text is the whole channel, measured against
 * core's `MAX_WORKFLOW_STEP_TEXT`. The encoder truncates past it rather than losing the field, so this
 * is not a guard against disaster; it is the reason the operator's terminal and the step record say the
 * same sentence. A refusal composed to a bound nobody else holds would be cut somewhere else.
 */
const MAX_REFUSAL_MESSAGE = MAX_WORKFLOW_STEP_TEXT;

/**
 * The most the **problem line** may run to before the answer is composed after it.
 *
 * **Truncating the composed sentence is not enough, because it cuts the wrong half.** A call site
 * interpolates caller data into the problem — `KV get for key '<key>'`, `R2 copy '<src>' to '<dst>'` —
 * and Cloudflare permits a 512-byte KV key and a 1024-byte R2 one, two per label. A head-preserving
 * slice at {@link MAX_REFUSAL_MESSAGE} therefore discards Pithy's *and* Cloudflare's words in that
 * order, so a long key silently ate the API answer this whole path exists to surface: at a 512-char
 * key the message kept neither the code nor the link, and ended in 59 characters of key.
 *
 * The problem line is bounded first, so the answer always has room. 200 is generous for every operation
 * label in the repository and still leaves the greater part of the budget to Cloudflare.
 */
const MAX_PROBLEM_LINE = 200;

/** `text`, or as much of it as `limit` allows with a trailing ellipsis standing for the rest. */
function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** Upstream text as one line: every whitespace run — newline, tab, CR — collapsed to a single space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Cloudflare's auth-class codes — the ones that mean "your credentials did not get you in", as
 * opposed to a missing resource (`12000`), a conflict (`12042`) or a rejected argument (`10202`).
 *
 * Status alone is not the discriminator, which is the trap #534 walked into: the reported Turnstile
 * refusal was `10000` under a **401**, while `isAuthorizationError` below keys on 403 and would not
 * have fired. Cloudflare returns `10000` under 400, 401 and 403 depending on the endpoint, so the
 * code is what identifies the class and the status is only a fallback for a body-less throw.
 */
const AUTH_CLASS_CODES = new Set([9103, 9106, 9107, 9109, 10000, 10001]);

/**
 * Cloudflare API resource segment → the account permission group whose absence explains a refusal.
 *
 * The product name comes from Cloudflare's own `documentation_url`
 * (`/api/resources/turnstile/subresources/widgets/methods/list` → `turnstile`), not from the
 * `operation` string a call site wrote: roughly a third of those never name the product, and the
 * manager that does know (`getServiceType()`) is a `this` no free function sees. Deriving it from the
 * failure itself is what lets all 134 call sites improve without one of them changing.
 *
 * A segment absent here yields no product name and the generic action — a wrong grant named
 * confidently is worse than none. Verify a new row against the dashboard's token editor before
 * adding it.
 */
const ACCOUNT_PERMISSIONS: Record<string, string> = {
  ai: "Workers AI",
  d1: "D1",
  images: "Cloudflare Images",
  kv: "Workers KV Storage",
  queues: "Queues",
  r2: "Workers R2 Storage",
  secrets_store: "Secrets Store",
  stream: "Stream",
  turnstile: "Turnstile",
  vectorize: "Vectorize",
  workers: "Workers Scripts",
};

/**
 * Run a Cloudflare SDK call and turn any failure into a `CloudflareRequestError`, preserving the
 * original error as `cause` and its message as internal `detail`. `operation` names the call for
 * the audit trail (`"KV get for key 'x'"`). A `PithyError` already in flight (e.g. a
 * not-configured guard) passes through untouched — only foreign throws get wrapped.
 *
 * The refusal carries Cloudflare's own `errors[]` — see {@link cloudflareRefusal}.
 *
 * **A call that ran out of time is `core/upstream_timeout` (504), not a 502.** CLAUDE.md §Errors
 * splits the upstream class in two for a reason a retry policy acts on: a 502 says Cloudflare
 * answered and refused, so the same call refuses again; a 504 says nobody answered, so the same call
 * may well succeed — **and may already have been applied**, which is the fact a caller needs before it
 * retries a create. Folding a connect timeout into `cloudflare/request_failed` told every reader the
 * first story about the second event.
 *
 * `permission` names the account permission group behind this endpoint for the refusal's action line,
 * for the endpoints whose docs link does not say. It is the same fact `cloudflareRefusal` takes, handed
 * in here so the *first* call of a command can carry it: `pithy token mint` refuses at
 * `findTokenByName` and `listPermissionGroups`, both of which run before the mint, so a hint attached
 * only to the mint is a hint the operator never reaches.
 */
export async function cloudflareRequest<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { permission?: string },
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PithyError) throw error;
    if (isTimeout(error)) {
      throw new UpstreamTimeoutError(
        {
          message: `Cloudflare did not answer in time: ${operation}.`,
          action:
            "Re-run the command. A create that timed out may already have been applied — check before retrying it.",
          detail: messageOf(error),
        },
        { cause: error },
      );
    }
    throw cloudflareRefusal({
      problem: `Cloudflare request failed: ${operation}.`,
      apiErrors: cloudflareApiErrors(error),
      status: statusOf(error),
      ...(options?.permission === undefined ? {} : { permission: options.permission }),
      detail: messageOf(error),
      cause: error,
    });
  }
}

/**
 * Compose the refusal every failed Cloudflare call renders: the problem line, then the API's own
 * answer, then — only for an auth-class code — what to do about it.
 *
 * One place, so a fix reaches every provisioner at once — and **one place is a claim a test has to
 * hold, because it was false the first time it was written.** Round one of #534 said
 * `CloudflareBuildsManager` was the only path composing a refusal by hand; `mintToken`, the Stream
 * direct upload and two integration helpers were composing their own, so `pithy token mint` — the
 * bootstrap command an under-scoped token meets first — still printed the operation and nothing else
 * on the identical 401 body. `refusalSites.test.ts` now fails any `new CloudflareRequestError(`
 * outside this file, so "the only place" is enforced rather than remembered.
 *
 * CLAUDE.md §Errors decides where each string lands. Cloudflare's sentence and its docs link are the
 * **caller's** information — what happened, in the words of whoever it happened to — so they go in
 * `message`, field by field off `errors[]` and never as `JSON.stringify(body)`: these managers are
 * imported into Worker paths too, so `message` can reach a browser through `clientError`. The
 * structured `code` and link ride along in `params`, which is client-facing by definition, so a
 * translating client can render them under the error code. "Add this grant, then re-run" names a
 * console the operator is sitting in front of, so it is an `action`. The raw body stays `detail`.
 *
 * The code stays `cloudflare/request_failed` at 502: a dedicated sibling of `core/upstream_failed`,
 * already the upstream class CLAUDE.md asks for, and pinned by `core`'s payload test.
 *
 * **The message is one line, and that is a kit-wide rule this had to learn the hard way.** Round one
 * of #534 made it a small document — problem line, `errors[]` indented beneath, action last — which
 * reads beautifully in a terminal and is unencodable everywhere else. A `PithyError` raised inside a
 * `classifiedSteps` step crosses a durable boundary as one string whose newline separates the sentence
 * from the remedy, so a multi-line `message` was declined whole at the reader and the operator got
 * `core/workflow_failed` 500 about durable execution instead of the API answer this issue exists to
 * show them. The same newline is what the CLI's action line is, so an upstream sentence containing one
 * forges a remedy Pithy never wrote. `Cloudflare said:` marks the boundary between our words and
 * theirs with a word instead of an indent, and a word survives a step record, a `--json` line and a
 * browser.
 */
export function cloudflareRefusal(args: {
  /** The problem line — what Pithy was doing when the API refused. */
  problem: string;
  /** Cloudflare's own error entries, from {@link cloudflareApiErrors}. */
  apiErrors: CloudflareApiError[];
  /** The HTTP status, when one is known. A fallback signal only; the code is the discriminator. */
  status?: number;
  /**
   * The account permission group behind this endpoint, when the call site knows it and Cloudflare's
   * docs link will not say. A **fact**, not wording: the sentence is still composed here, and a hint
   * that disagrees with the link loses to the link. `undefined` yields the generic action, which is
   * right — a wrong grant named confidently is worse than none.
   */
  permission?: string;
  /** The raw failure text, for logs and audit alone. */
  detail: string;
  /** The original throw. */
  cause?: unknown;
}): CloudflareRequestError {
  // Sliced here for `permissionAction`; `cloudflareSaid` bounds what it is given for itself, so a call
  // site reaching it directly cannot exceed the same limit by arriving from somewhere else.
  const shown = args.apiErrors.slice(0, MAX_API_ERRORS);
  const said = cloudflareSaid(args.problem, shown);
  return new CloudflareRequestError(
    {
      message: said.message,
      action: permissionAction(shown, args.status, args.permission),
      params: said.params,
      detail: args.detail,
    },
    { cause: args.cause },
  );
}

/**
 * Pithy's problem line with Cloudflare's own answer on the end of it, and the same answer as `params`.
 *
 * Exported because {@link cloudflareRefusal} is not the only refusal that must carry it. The 403 on
 * `accounts/tokens create` says something a generic refusal cannot — the token got in and may not
 * create tokens — so it keeps its own diagnosis and its own code, and *that* is what made it drop
 * Cloudflare's answer for two rounds: a call site with a better sentence had no way to keep the API's
 * words. Now it composes the sentence here like everything else, and the only thing it supplies is the
 * problem line.
 *
 * One line, always. Whitespace runs collapse and entries join with a semicolon. The problem line is
 * flattened along with the rest because a call site interpolates values into it (`KV get for key
 * '<key>'`), and a key holding a newline is an operator's refusal wearing a forged action line.
 *
 * **What gets cut when it does not fit is the part Pithy can afford to lose.** The problem line is
 * bounded to {@link MAX_PROBLEM_LINE} first, so a 512-byte KV key or a 1024-byte R2 one cannot crowd out
 * the answer; then whole entries are dropped from the end until the sentence fits
 * {@link MAX_REFUSAL_MESSAGE}, the bound of the durable step channel. Slicing the composed sentence
 * instead — which is what this did — discards the tail, and the tail is always Cloudflare's answer.
 */
export function cloudflareSaid(
  problem: string,
  apiErrors: CloudflareApiError[],
): { message: string; params: MessageParams } {
  const shown = apiErrors.slice(0, MAX_API_ERRORS);
  const primary = shown.find((entry) => entry.code !== undefined) ?? shown[0];
  const phrases = shown.map(apiErrorPhrase).filter((phrase) => phrase !== "");
  const head = bounded(oneLine(problem), MAX_PROBLEM_LINE);
  if (phrases.length === 0) return { message: head, params: apiErrorParams(primary) };

  // Whole entries are dropped from the end, never sliced. `toApiError` refuses a `documentation_url`
  // carrying whitespace on the ground that a printed link is one somebody clicks; cutting the same link
  // mid-URL a few lines later would take that back. Three ordinary zone errors with links compose to
  // roughly 810 characters against a 512 budget, so this is reached by Cloudflare's own body and not
  // only by a long key.
  // A dropped entry is still signaled, with the ellipsis after the last one that fits rather than in the
  // middle of a link. Silence would leave a reader believing Cloudflare said only what they can see.
  const kept = [...phrases];
  const compose = () =>
    oneLine(`${head} Cloudflare said: ${kept.join("; ")}${kept.length < phrases.length ? "; …" : ""}`);
  let composed = compose();
  while (kept.length > 1 && composed.length > MAX_REFUSAL_MESSAGE) {
    kept.pop();
    composed = compose();
  }
  return { message: bounded(composed, MAX_REFUSAL_MESSAGE), params: apiErrorParams(primary) };
}

/**
 * Cloudflare's `errors[]`, read off a thrown SDK error (`APIError.errors`) or handed the array
 * straight from an unwrapped envelope. Duck-typed rather than `instanceof APIError`, matching
 * {@link isNotFoundError}: the SDK is one producer of this shape and the raw-`fetch` path is another.
 *
 * Entries are read field by field and dropped when they carry neither a code nor a sentence, so a
 * malformed body degrades to today's refusal instead of rendering an empty line. A
 * `documentation_url` is kept only when it is `https:` — the link is printed, and a printed link is
 * one somebody clicks.
 */
export function cloudflareApiErrors(source: unknown): CloudflareApiError[] {
  const raw = Array.isArray(source)
    ? source
    : typeof source === "object" && source !== null
      ? (source as { errors?: unknown }).errors
      : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(toApiError);
}

/** One raw `errors[]` entry, narrowed — or nothing, when it says nothing. */
function toApiError(entry: unknown): CloudflareApiError[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { code, message, documentation_url: docs } = entry as Record<string, unknown>;
  const parsed: CloudflareApiError = {};
  if (typeof code === "number") parsed.code = code;
  if (typeof message === "string") {
    const flattened = oneLine(message).slice(0, MAX_API_MESSAGE);
    if (flattened.length > 0) parsed.message = flattened;
  }
  // A URL is one token by definition, so whitespace in it means the field is not one — and the link is
  // printed, so a "link" that wraps onto a second line is the same defect as a wrapped sentence.
  if (typeof docs === "string" && docs.startsWith("https://") && !/\s/.test(docs)) parsed.documentationUrl = docs;
  return parsed.code === undefined && parsed.message === undefined ? [] : [parsed];
}

/** One entry as the operator reads it, inline: `<code> <sentence> — <link>`. */
function apiErrorPhrase(entry: CloudflareApiError): string {
  const said = [entry.code, entry.message].filter((part) => part !== undefined).join(" ");
  if (said === "") return "";
  return entry.documentationUrl === undefined ? said : `${said} — ${entry.documentationUrl}`;
}

/**
 * The API's answer as a translating client receives it: one sentence a locale can write into its own
 * wording, plus the structured fields a client may render itself.
 *
 * **`apiAnswer` is supplied on every refusal, and that is the whole point of it.** A locale's sentence
 * is one string with no `if` in it, and `interpolate` leaves a placeholder nobody supplied written out
 * as `{apiAnswer}` — so a `{placeholder}` in a catalog is a claim that *every* throw of this code
 * passes that name, degraded paths included. A call that never reached Cloudflare has no answer, so
 * this one is `""` there, and the value carries its own leading separator (`": 10000 Authentication
 * error"`) so the one sentence closes correctly with the answer and without it. `core`'s
 * `GUARANTEED_ERROR_PARAMS` is where that promise is declared and where `@pithy-sh/i18n` reads it.
 *
 * The three structured fields stay optional, because Cloudflare's own body is: an entry may carry a
 * code with no sentence, a sentence with no code, and usually no link at all. They are for a client
 * reading `payload.params` directly, never for a catalog placeholder.
 */
function apiErrorParams(entry: CloudflareApiError | undefined): MessageParams {
  if (entry === undefined) return { apiAnswer: "" };
  const said = [entry.code, entry.message].filter((part) => part !== undefined).join(" ");
  return {
    apiAnswer: said.length === 0 ? "" : `: ${said}`,
    ...(entry.code === undefined ? {} : { apiCode: entry.code }),
    ...(entry.message === undefined ? {} : { apiMessage: entry.message }),
    ...(entry.documentationUrl === undefined ? {} : { apiDocumentationUrl: entry.documentationUrl }),
  };
}

/**
 * The action line for an auth-class refusal, and nothing at all for any other failure — a 500 that
 * grew an "add a permission" line would send every operator down the wrong path.
 *
 * **The API's code decides; the status is only consulted when there is no code.** Cloudflare returns
 * `10000` under 400, 401 and 403 depending on the endpoint, which is why the status cannot be the
 * discriminator — and the converse is the half that shipped wrong: a 403 is *also* how Cloudflare
 * answers `10021 Script startup exceeded CPU limit`, and "add Account → Workers Scripts to it" changes
 * nothing about a CPU limit. So when Cloudflare named any code at all, the codes are the whole of the
 * evidence and the status is not consulted; only a body-less throw (`401 status code (no body)`) falls
 * back to it.
 *
 * **What is known and what is concluded are kept apart, because the refusal cannot tell them apart.**
 * Cloudflare answered `10000` for this one call; that is all it said. A token missing this product's
 * grant, a revoked token and a token pointed at the wrong account all produce it, and this process can
 * separate none of the three. So the line names all three, in the order an operator can check them,
 * and asserts none. It named two for one round — "reaches other products" or "reaches none" — which
 * excluded the third by construction: a token in the *wrong* account reaches other products in that
 * account, so the operator was told to add a grant they already held.
 *
 * The **level** is deliberately absent too. The call that raised #534 was a *list* — Read would have
 * satisfied it — so "Turnstile → Edit" would have been a guess dressed as an instruction. Name the
 * group; the operator picks the level their calls need.
 */
function permissionAction(apiErrors: CloudflareApiError[], status?: number, hint?: string): string | undefined {
  if (!isAuthClassRefusal(apiErrors, status)) return undefined;
  const permission = accountPermissionOf(apiErrors) ?? hint;
  const grant =
    permission === undefined ? "the token's permission for this product" : `the token for Account → ${permission}`;
  return `A missing grant, a dead token and the wrong account all look the same here. Check ${grant}, then CLOUDFLARE_API_TOKEN, then CLOUDFLARE_ACCOUNT_ID.`;
}

/**
 * Whether the refusal is the credentials failing rather than the request — the one question the action
 * line above is allowed to answer. Codes win where there are codes; status is the body-less fallback.
 */
function isAuthClassRefusal(apiErrors: CloudflareApiError[], status?: number): boolean {
  const coded = apiErrors.filter((entry) => entry.code !== undefined);
  if (coded.length > 0) return coded.some((entry) => AUTH_CLASS_CODES.has(entry.code as number));
  return status === 401 || status === 403;
}

/** The account permission group behind the refused endpoint, per Cloudflare's own docs link. */
function accountPermissionOf(apiErrors: CloudflareApiError[]): string | undefined {
  for (const entry of apiErrors) {
    if (entry.documentationUrl === undefined) continue;
    const segments = entry.documentationUrl.split("/");
    const resource = segments[segments.indexOf("resources") + 1];
    // `Object.hasOwn`, never a bare index: a plain object answers `constructor` and `toString` for
    // segments nobody put in the table, and a native function is not a permission group — a docs link
    // reading `/api/resources/constructor/...` would otherwise render "add Account →
    // function Object() { [native code] }". `permissionAction.test` holds that exact string.
    if (resource === undefined || !Object.hasOwn(ACCOUNT_PERMISSIONS, resource)) continue;
    return ACCOUNT_PERMISSIONS[resource];
  }
  return undefined;
}

/**
 * The names a timed-out call throws under, **measured off the two producers rather than guessed**.
 *
 * Round two read `error.name` and `error.code`, which is what an SDK error and an undici error look
 * like in a fixture somebody types out. Driven against the real thing, neither producer sets what was
 * being read, and the 504 branch could not fire for either:
 *
 * - **The SDK never assigns `name`.** `APIConnectionTimeoutError extends APIConnectionError extends
 *   APIError extends CloudflareError extends Error`, and not one of them touches `this.name` — so
 *   `error.name` is `"Error"` and `error.code` is `undefined`. Driven with a real `Cloudflare` client
 *   (`maxRetries: 0`, `timeout: 150`) against a `node:net` server that accepts and never answers:
 *   `ctor=APIConnectionTimeoutError name="Error" code=undefined status=undefined msg="Request timed
 *   out."`. The class name is the only marker it carries, so the constructor is read as well as `name`.
 * - **`fetch` puts the timeout on `cause`, not on the throw.** A connect timeout rejects with
 *   `TypeError: fetch failed` — `name="TypeError"`, `code=undefined` — and undici's own
 *   `ConnectTimeoutError` (`code="UND_ERR_CONNECT_TIMEOUT"`) is one level down. Driven against
 *   TEST-NET-1 (`http://192.0.2.1`, 10.5s, undici's default connect timeout). So the chain is walked;
 *   reading only the top level made `TIMEOUT_CODES` dead for the raw-`fetch` escape hatch in
 *   `CloudflareBuildsManager` that it was written for.
 *
 * Both are pinned by `timeoutProducers.test.ts`, which builds its fixtures from those producers rather
 * than from this list — a fixture written by hand agrees with whoever wrote it.
 *
 * Duck-typed rather than `instanceof APIConnectionTimeoutError`, matching every other predicate here:
 * the SDK is one producer and `fetch` is another, and an `instanceof` across two copies of the SDK
 * answers false. `AbortSignal.timeout` is the third — a `DOMException` whose `name` really is
 * `"TimeoutError"` — and it is what a caller-imposed deadline raises.
 */
const TIMEOUT_NAMES = new Set([
  "APIConnectionTimeoutError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** How far down a `cause` chain the reason is looked for. Bounded, so a cyclic chain cannot spin. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether a throw is "nobody answered in time" rather than "Cloudflare answered and refused".
 *
 * **A throw carrying a status answered**, whatever is underneath it: an SDK `APIError` is Cloudflare's
 * own reply, so its cause chain is not consulted and the only statuses that mean time ran out are the
 * three below. `408` and `504` are here because a proxy in front of the API answers them for exactly
 * this event; `524` is Cloudflare's own "a timeout occurred", and it can reach a manager that fronts a
 * Worker. Every other throw is a transport failure, and the reason for one lives somewhere in its
 * `cause` chain — `TypeError: fetch failed` → `ConnectTimeoutError`, or the SDK's `APIConnectionError`
 * → `TypeError` → the socket error. A refused connection walks the same chain and states `ECONNREFUSED`
 * at the bottom of it, which is not in either set, so it stays the 502 it should be.
 */
function isTimeout(error: unknown): boolean {
  const answered = statusOf(error);
  if (answered !== undefined) return answered === 408 || answered === 504 || answered === 524;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    if (statesTimeout(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether one link of a `cause` chain says, in any of the three ways a producer says it, "out of time". */
function statesTimeout(error: object): boolean {
  const { name, code, constructor: ctor } = error as { name?: unknown; code?: unknown; constructor?: unknown };
  if (typeof name === "string" && TIMEOUT_NAMES.has(name)) return true;
  if (typeof code === "string" && TIMEOUT_CODES.has(code)) return true;
  const className = (ctor as { name?: unknown } | undefined)?.name;
  return typeof className === "string" && TIMEOUT_NAMES.has(className);
}

/**
 * The HTTP status of a thrown SDK error, when it carries one. Exported because a call site that
 * composes its own refusal through {@link cloudflareRefusal} has to hand it the same status this
 * module would have read — a hand-rolled `(error as { status?: number }).status` beside it is the
 * duplicate that drifts.
 */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** The raw message of an unknown throw, for use as a PithyError `detail`. One source of truth. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The most specific failure reason available, for a partial-failure report's `error` field: a
 * `PithyError`'s internal `detail` (the real cause `cloudflareRequest` captured), else its public
 * message, else the raw throw. Centralized so the detail-vs-message precedence lives in one place.
 */
export function reasonOf(error: unknown): string {
  if (error instanceof PithyError) return error.payload.detail ?? error.payload.message;
  return messageOf(error);
}

/** Whether a thrown SDK error is an HTTP 404 — the SDK throws on a missing resource, not null. */
export function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}

/**
 * Whether a thrown SDK error is an HTTP 403 — the token reached the API but lacks the permission for
 * the operation. The signal a caller uses to turn a raw "Unauthorized" into an actionable
 * "grant this permission group" message instead of a generic request failure.
 *
 * Strictly 403, and it stays that way: its callers branch on it to *swallow* a denial
 * (`getTokenName` answers `null`), so widening it to 401 would report a dead token as a permission
 * this project does not need. The broader "did the credentials get in" question is
 * {@link AUTH_CLASS_CODES}, which reads the API's own code rather than the status.
 */
export function isAuthorizationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 403;
}

/**
 * Decode a Cloudflare response against `schema`, throwing `cloudflare/invalid_response` on a shape
 * mismatch. The decode counterpart to `cloudflareRequest`'s error wrapping — one seam so every
 * manager validates the wire the same way instead of hand-rolling `safeParse` + throw.
 */
export function decodeResponse<T extends z.ZodType>(schema: T, raw: unknown, context: string): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CloudflareInvalidResponseError({
      message: `A Cloudflare response had an unexpected shape: ${context}.`,
      detail: parsed.error.message,
    });
  }
  return parsed.data;
}
