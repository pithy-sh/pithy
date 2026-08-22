// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workerIdentity } from "@pithy-sh/core/src/worker/identity";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { DEFAULT_TOKEN_FIELD, type TurnstileMode } from "../config/config";
import { TurnstileConfigError, TurnstileFailedError, TurnstileMissingTokenError } from "../error/errors";
import { isTestKeyEnvironment, TEST_KEY_ENVIRONMENTS } from "../provision/testKeys";
import { selectTurnstileSecret, TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "../secret/registry";

/** Cloudflare's server-side endpoint a Turnstile token is validated against. */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * The siteverify error codes that name the **secret** rather than the token.
 *
 * The distinction is the whole point: every other code is a verdict about the caller, and these two are
 * a verdict about the deployment. Cloudflare answers HTTP 400 for a secret it does not recognize, which
 * the fail-closed branch used to render as `turnstile/failed` — a 403 telling an operator that a user
 * failed a challenge, when the truth was that nobody could ever pass one here.
 */
const SECRET_FAULT_CODES = ["invalid-input-secret", "missing-input-secret"];

/**
 * The siteverify response, narrowed to what the gate checks. Cloudflare may add fields; Zod strips the
 * rest. Validating the body is itself part of the security boundary — an unexpected shape is treated as
 * a failure, never as a pass.
 */
export const SiteverifyResult = z
  .object({
    success: z.boolean().describe("Whether the token passed the humanity challenge."),
    "error-codes": z.array(z.string()).default([]).describe("Machine-readable failure reasons; empty on success."),
    action: z
      .string()
      .optional()
      .describe("The action label baked into the token at widget render — compared against the expected action."),
    metadata: z
      .object({
        result_with_testing_key: z
          .boolean()
          .optional()
          .describe("Cloudflare's own flag: this verdict came from a documented test key, not a real widget."),
      })
      .optional()
      .describe("Cloudflare's metadata about how the verdict was reached."),
  })
  .describe(
    "The server-side Turnstile siteverify response, narrowed to the success flag, error codes, action, and test-key metadata.",
  );
export type SiteverifyResult = z.output<typeof SiteverifyResult>;

/** Whether a verdict was produced by one of Cloudflare's documented test keys, by Cloudflare's own flag. */
function fromTestingKey(result: SiteverifyResult): boolean {
  return result.metadata?.result_with_testing_key === true;
}

/**
 * A secret Cloudflare does not recognize is a deployment fault, and is reported as one.
 *
 * `turnstile/config` (500) rather than `turnstile/failed` (403), because the two go to different people:
 * a 403 sends the operator looking at the user who was refused, and every such request is refused, so
 * the search never converges. The `action` line names the command that fixes it.
 */
function assertSecretRecognized(codes: string[], status: number): void {
  const fault = codes.find((code) => SECRET_FAULT_CODES.includes(code));
  if (fault === undefined) return;
  throw new TurnstileConfigError({
    message: "The humanity check is not configured.",
    action:
      "Cloudflare does not recognize this widget's secret key. Run `pithy turnstile provision` for this environment.",
    detail: `siteverify answered ${status} with "${fault}" — the secret, not the token, was refused.`,
  });
}

/**
 * The one exception to the action binding, and the only thing that made dev and staging sign-in
 * possible: **a documented test key returns no action at all** (#374).
 *
 * Cloudflare's always-pass secret answers `success: true` with no `action` field, verified live against
 * siteverify. `createAuthRoutes` stacks the gate as `turnstile({ action: "login" })`, so the binding
 * compared `"login"` against nothing and denied every sign-in in the two environments provisioning
 * wires that key into — a token that *was* valid, refused by a field the key never populates.
 *
 * Three conditions, and the exception needs all of them:
 *
 * 1. **Cloudflare says it is a test key** — `metadata.result_with_testing_key`, its own flag on its own
 *    answer, not a comparison against a list of key strings we keep. A real widget's answer never
 *    carries it, so no real deployment can reach this branch however its secret is spelled.
 * 2. **No action came back at all.** An action that came back and *differs* is a token minted for
 *    another action, which is exactly what the binding exists to refuse, and it is refused here too.
 * 3. **The Worker says it is dev or staging** — {@link isTestKeyEnvironment}, off the stamped
 *    `ENVIRONMENT` var, which nothing in a request can influence. `prod` is not in that list and an
 *    unstamped Worker is not either, so production keeps the binding exactly as it was.
 *
 * The alternative was to relax the binding itself, which would have traded a real protection — a token
 * solved for one action must not be replayable against another — for a developer's convenience.
 */
function testKeyCarriesNoAction(result: SiteverifyResult, environment: string | null): boolean {
  return fromTestingKey(result) && result.action === undefined && isTestKeyEnvironment(environment);
}

/** The `error-codes` of a body we are not otherwise going to parse. Absent or unreadable reads as none. */
async function errorCodesOf(response: Response): Promise<string[]> {
  const raw: unknown = await response.json().catch(() => null);
  const codes = (raw as { "error-codes"?: unknown } | null)?.["error-codes"];
  return Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string") : [];
}

/** Options the `turnstile()` middleware accepts when a route stacks it. */
export interface TurnstileOptions {
  /**
   * Which widget this route gates. Required only when the app runs both a `visible` and an `invisible`
   * widget; with a single widget it is inferred. Selects the entry from the resolved turnstile secret.
   */
  mode?: TurnstileMode;
  /** Body field carrying the token (form or JSON). Defaults to `cf-turnstile-response`. */
  field?: string;
  /** If set, read the token from this request header instead of the body field. */
  header?: string;
  /**
   * The expected action label. Turnstile bakes the action into the token at widget render and returns it
   * from siteverify; when set, the middleware asserts the returned action matches and denies on mismatch —
   * binding a token to the route it was solved for (no cross-action reuse on a shared widget).
   */
  action?: string;
}

/**
 * Verify a Turnstile token server-side against `/siteverify`. **Fails closed:** a transport error, a
 * non-OK status, a non-JSON body, or an unexpected shape all raise `turnstile/failed` rather than
 * letting the request through — a bot gate must never silently open. A well-formed response (whether the
 * token passed or not) is returned for the caller to act on.
 *
 * The one failure that does **not** come back as `turnstile/failed` is a secret Cloudflare does not
 * recognize: that is `turnstile/config`, because it is a verdict about the deployment rather than about
 * the caller. See {@link assertSecretRecognized}. Both directions still deny.
 */
export async function siteverify(
  secret: string,
  token: string,
  options?: { remoteIp?: string },
): Promise<SiteverifyResult> {
  // Note: Turnstile siteverify takes no `action` request param — the action is a *response* field the
  // caller compares (done by the middleware). Only secret, response, and remoteip are sent.
  const body = new URLSearchParams({ secret, response: token });
  if (options?.remoteIp) body.set("remoteip", options.remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (cause) {
    throw new TurnstileFailedError(
      { detail: `siteverify request failed: ${cause instanceof Error ? cause.message : String(cause)}` },
      { cause },
    );
  }

  if (!response.ok) {
    assertSecretRecognized(await errorCodesOf(response), response.status);
    throw new TurnstileFailedError({ detail: `siteverify responded ${response.status} ${response.statusText}.` });
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new TurnstileFailedError({ detail: "siteverify returned a non-JSON body." }, { cause });
  }

  const parsed = SiteverifyResult.safeParse(raw);
  if (!parsed.success) {
    throw new TurnstileFailedError({ detail: `siteverify response had an unexpected shape: ${parsed.error.message}` });
  }
  // A 200 carrying a secret-side code is not what Cloudflare answers today (it uses 400), but the
  // classification belongs to the code rather than to the status, so both routes reach the same verdict.
  assertSecretRecognized(parsed.data["error-codes"], response.status);
  return parsed.data;
}

/**
 * Read the response token from the configured header, or the body field. Form posts (the widget's own
 * submit) parse as form data; everything else — JSON, a `+json` media type, or a request with no/odd
 * content-type (some mobile/`fetch` clients) — is read as JSON. Any parse failure yields `null`, which the
 * caller turns into a missing-token denial, so this stays fail-closed.
 *
 * **The body is read off a clone, never off the request itself.** This gate is stacked on top of a route
 * it does not own — `@pithy-sh/auth` mounts it on the magic-link and OTP paths, which are Better Auth's,
 * and the handler there forwards `c.req.raw` untouched. Reading through `c.req.json()`/`c.req.parseBody()`
 * consumes that stream (Hono's body cache calls `raw.json()`), so a request that PASSED the humanity check
 * would then fail downstream with "Body has already been read" — the gate would work only when it denied.
 * Cloning costs one buffer copy of a token-sized body and keeps the original readable by whoever follows.
 */
async function readToken(c: Context, field: string, header?: string): Promise<string | null> {
  if (header) {
    return c.req.header(header) ?? null;
  }
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
  const probe = c.req.raw.clone();
  const body = isForm
    ? await probe
        .formData()
        .then((form) => Object.fromEntries(form.entries()) as Record<string, unknown>)
        .catch(() => null)
    : ((await probe.json().catch(() => null)) as Record<string, unknown> | null);
  const value = body?.[field];
  return typeof value === "string" ? value : null;
}

/**
 * The Turnstile humanity-check middleware. Stack it on **any** route, on top of that route's real
 * verification strategy (`public`, `bearer`, `session`, …) — it answers "is this a human?", never
 * "who is this?", so it is never an identity strategy of its own (CLAUDE.md §HTTP).
 *
 * It resolves the widget secret through the one `secretsStore` reader (CLAUDE.md §secrets: every secret is
 * declared in a registry and read through the reader; the registry — `turnstileSecretsRegistry` — decides
 * where it lives), reads the response token from the request, verifies it against Cloudflare siteverify,
 * and on success lets the request continue to its real strategy. The app must have the `secrets`
 * capability (it provides whatever the read needs); the secret is the encrypted row in its `SECRETS` D1,
 * in local dev exactly as deployed, which is what `pithy turnstile provision` writes. It
 * **fails closed** — every failure throws a `PithyError` subclass (all carrying a `turnstile/*` code), so
 * a bot gate never silently opens. Register `pithyErrorHandler` on the app to map these to HTTP responses.
 *
 * **Two failures are the deployment's, not the caller's, and say so.** A secret Cloudflare does not
 * recognize, and a documented test key outside dev/staging, both raise `turnstile/config` — see
 * {@link assertSecretRecognized} and {@link testKeyCarriesNoAction} for why blaming the caller for
 * either one costs an operator an hour.
 *
 * @throws {@link TurnstileMissingTokenError} (`turnstile/missing_token`, 400) — no token in the request.
 * @throws {@link TurnstileFailedError} (`turnstile/failed`, 403) — the token did not pass siteverify, its
 *   action did not match a configured `action`, or the check could not complete (an unreachable/malformed
 *   siteverify response also lands here, fail-closed).
 * @throws {@link TurnstileConfigError} (`turnstile/config`, 500) — the secret is missing, malformed, has
 *   no entry for the route's widget mode, is one Cloudflare does not recognize, or is a test key in an
 *   environment that has no business holding one (the `secretsStore` read is rewrapped to this too, so
 *   the gate's contract stays `turnstile/*`).
 */
export function turnstile(options: TurnstileOptions = {}): MiddlewareHandler {
  const field = options.field ?? DEFAULT_TOKEN_FIELD;
  return async (c, next) => {
    let secret: string;
    try {
      const store = await sharedSecretsStore(c.env as unknown as SecretsStoreEnv, turnstileSecretsRegistry);
      secret = selectTurnstileSecret(store.get(TURNSTILE_SECRET_NAME), options.mode);
    } catch (cause) {
      // selectTurnstileSecret already throws turnstile/config; the reader throws secrets/* — rewrap those
      // so the gate fails closed under its own contract (a missing secret is a misconfig, not a 404 route).
      if (cause instanceof TurnstileConfigError) throw cause;
      throw new TurnstileConfigError(
        { detail: `Could not resolve the turnstile secret: ${cause instanceof Error ? cause.message : String(cause)}` },
        { cause },
      );
    }

    const token = await readToken(c, field, options.header);
    if (!token) {
      throw new TurnstileMissingTokenError({
        detail: options.header
          ? `No token in the ${options.header} header.`
          : `No "${field}" field in the request body.`,
      });
    }

    const environment = workerIdentity(c.env).environment;
    const result = await siteverify(secret, token, { remoteIp: c.req.header("CF-Connecting-IP") });

    // A documented test key answers for everybody who asks, so where it is wired is the whole of what
    // makes it acceptable. Outside the two environments provisioning writes one into, its presence is a
    // misconfiguration and is reported as one — an always-pass secret on a production login page is a
    // door, and it should be the loudest thing in the log rather than a quiet 200.
    if (fromTestingKey(result) && !isTestKeyEnvironment(environment)) {
      throw new TurnstileConfigError({
        message: "The humanity check is not configured.",
        action: `This widget secret is a Cloudflare Turnstile test key, which passes every caller. Run \`pithy turnstile provision\` for the real widget, or stamp ENVIRONMENT as ${TEST_KEY_ENVIRONMENTS.join(" or ")} in this Worker's wrangler.jsonc if that is what this deployment is.`,
        detail: `siteverify set metadata.result_with_testing_key on environment "${environment ?? "unstamped"}".`,
      });
    }

    if (!result.success) {
      throw new TurnstileFailedError({
        detail: `siteverify rejected the token: ${result["error-codes"].join(", ") || "no error codes"}.`,
      });
    }
    // Bind the token to the expected action when one is configured — fail closed on mismatch so a token
    // solved for another action on the same widget can't be replayed here.
    if (
      options.action !== undefined &&
      result.action !== options.action &&
      !testKeyCarriesNoAction(result, environment)
    ) {
      throw new TurnstileFailedError({
        detail: `Turnstile action mismatch: expected "${options.action}", got "${result.action ?? "none"}".`,
      });
    }

    await next();
  };
}
