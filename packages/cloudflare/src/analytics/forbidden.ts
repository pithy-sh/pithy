// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName, remedy } from "@pithy-sh/core/src/cli/command";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import { isAuthClassFailure } from "../client/errors";
import { RUNTIME_PROFILE } from "../tokens/runtime";

/**
 * **An analytics read the Worker's own token may not make, as each caller's own code.**
 *
 * Every capability that reads Cloudflare's GraphQL Analytics does it on the one `runtime` token, which needs
 * {@link ANALYTICS_PERMISSION}. A refusal for want of it is `cloudflare/request_failed` like any other, and
 * that code names no permission a client can read. So a caller wraps its read in {@link guardForbidden},
 * which hands a missing grant to the caller's own error class with the permission in `params` and the
 * remedy in `message`, and lets every other failure through unchanged. No SDK is imported here, so a
 * caller that loads the manager lazily keeps doing so.
 */

/** The account permission group every analytics read needs, as Cloudflare's token editor names it. */
export const ANALYTICS_PERMISSION = "Account Analytics Read";

/** The GraphQL `extensions.code` that means the token may not read the account it asked about. */
export const GRAPHQL_AUTH_CODES: ReadonlySet<string> = new Set(["authz"]);

/** A missing grant, in the fields a caller's error class takes. */
export interface ForbiddenRefusal {
  /** The sentence the caller reads: the permission, and the rotate that adds it. */
  message: string;
  /** `permission`, for a client that translates. */
  params: MessageParams;
  /** The operator's line from the Cloudflare refusal, kept for the terminal and the log. */
  action?: string;
  /** The Cloudflare refusal's detail, kept for the log. */
  detail?: string;
}

/** Builds the caller's own error for a missing grant. */
export type RefuseForbidden = (refusal: ForbiddenRefusal, options: { cause: unknown }) => Error;

/** Where the read ran and what to call it, for the sentence. */
export interface ForbiddenContext {
  /** The environment this Worker serves, or null when it names none. */
  environment: string | null;
  /** The read as the sentence names it: "the delivery analytics read". */
  read: string;
}

/** Whether a GraphQL `errors` array, kept as a refusal's cause, says the token may not read the account. */
function isGraphQLAuthRefusal(cause: unknown): boolean {
  if (!Array.isArray(cause)) return false;
  return cause.some((entry: unknown) => {
    const code = (entry as { extensions?: { code?: unknown } } | null)?.extensions?.code;
    return typeof code === "string" && GRAPHQL_AUTH_CODES.has(code);
  });
}

/**
 * Whether a failure is an analytics query refused because the credentials did not get in: a 401 or 403, or
 * Cloudflare's auth-class code, or GraphQL's `authz`. A spent rate budget, a 5xx and a rejected query are not.
 */
export function isAnalyticsForbidden(error: unknown): boolean {
  if (!(error instanceof PithyError) || error.payload.code !== "cloudflare/request_failed") return false;
  return isAuthClassFailure(error.cause) || isGraphQLAuthRefusal(error.cause);
}

/** The remedy a caller reads: rotate re-scopes the runtime token, where a mint only rolls its value. */
function rotateSentence(environment: string | null): string {
  const tail = "to re-scope it; a mint only rolls the value.";
  if (environment === null) return `Rotate it with \`${commandName("token rotate")}\` ${tail}`;
  return remedy("token rotate", { args: [RUNTIME_PROFILE], flags: { "--env": environment } }, { runtime: true }).say(
    (command) => `Run \`${command}\` ${tail}`,
  );
}

/** A missing grant on `error`, as the fields of the caller's own error. */
export function forbiddenRefusal(error: PithyError, context: ForbiddenContext): ForbiddenRefusal {
  return {
    message: `Cloudflare refused ${context.read}: this Worker's ${RUNTIME_PROFILE} token lacks ${ANALYTICS_PERMISSION}. ${rotateSentence(context.environment)}`,
    params: { permission: ANALYTICS_PERMISSION },
    ...(error.payload.action === undefined ? {} : { action: error.payload.action }),
    ...(error.payload.detail === undefined ? {} : { detail: error.payload.detail }),
  };
}

/** Run an analytics read, refusing a missing grant with the caller's own error and passing every other failure on. */
export async function guardForbidden<T>(
  read: () => Promise<T>,
  context: ForbiddenContext,
  refuse: RefuseForbidden,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof PithyError) || !isAnalyticsForbidden(error)) throw error;
    throw refuse(forbiddenRefusal(error, context), { cause: error });
  }
}
