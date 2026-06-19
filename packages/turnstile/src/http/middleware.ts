import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { secretsStore } from "@pithy-sh/secrets/src/secretsStore";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { DEFAULT_TOKEN_FIELD, type TurnstileMode } from "../config/config";
import { TurnstileConfigError, TurnstileFailedError, TurnstileMissingTokenError } from "../error/errors";
import { selectTurnstileSecret, TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "../secret/registry";

/** Cloudflare's server-side endpoint a Turnstile token is validated against. */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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
  })
  .describe("The server-side Turnstile siteverify response, narrowed to the success flag, error codes, and action.");
export type SiteverifyResult = z.output<typeof SiteverifyResult>;

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
  return parsed.data;
}

/**
 * Read the response token from the configured header, or the body field. Form posts (the widget's own
 * submit) parse as form data; everything else — JSON, a `+json` media type, or a request with no/odd
 * content-type (some mobile/`fetch` clients) — is read as JSON. Any parse failure yields `null`, which the
 * caller turns into a missing-token denial, so this stays fail-closed.
 */
async function readToken(c: Context, field: string, header?: string): Promise<string | null> {
  if (header) {
    return c.req.header(header) ?? null;
  }
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
  if (isForm) {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const value = body[field];
    return typeof value === "string" ? value : null;
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
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
 * capability (it provides whatever the read needs); in local dev the secret resolves from `.dev.vars`. It
 * **fails closed** — every failure throws a `PithyError` subclass (all carrying a `turnstile/*` code), so
 * a bot gate never silently opens. Register `pithyErrorHandler` on the app to map these to HTTP responses.
 *
 * @throws {@link TurnstileMissingTokenError} (`turnstile/missing_token`, 400) — no token in the request.
 * @throws {@link TurnstileFailedError} (`turnstile/failed`, 403) — the token did not pass siteverify, its
 *   action did not match a configured `action`, or the check could not complete (an unreachable/malformed
 *   siteverify response also lands here, fail-closed).
 * @throws {@link TurnstileConfigError} (`turnstile/config`, 500) — the secret is missing, malformed, or has
 *   no entry for the route's widget mode (the `secretsStore` read is rewrapped to this so the gate's
 *   contract stays `turnstile/*`).
 */
export function turnstile(options: TurnstileOptions = {}): MiddlewareHandler {
  const field = options.field ?? DEFAULT_TOKEN_FIELD;
  return async (c, next) => {
    let secret: string;
    try {
      const store = await secretsStore(c.env as unknown as SecretsStoreEnv, turnstileSecretsRegistry);
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

    const result = await siteverify(secret, token, { remoteIp: c.req.header("CF-Connecting-IP") });
    if (!result.success) {
      throw new TurnstileFailedError({
        detail: `siteverify rejected the token: ${result["error-codes"].join(", ") || "no error codes"}.`,
      });
    }
    // Bind the token to the expected action when one is configured — fail closed on mismatch so a token
    // solved for another action on the same widget can't be replayed here.
    if (options.action !== undefined && result.action !== options.action) {
      throw new TurnstileFailedError({
        detail: `Turnstile action mismatch: expected "${options.action}", got "${result.action ?? "none"}".`,
      });
    }

    await next();
  };
}
