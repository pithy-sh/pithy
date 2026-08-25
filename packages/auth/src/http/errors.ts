// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PithyError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import { isAPIError } from "better-auth/api";

/**
 * Translate a thrown Better-Auth `APIError` into the matching `PithyError` subclass, by HTTP status.
 *
 * **What reaches here is a much smaller set than `onAPIError: { throw: true }` suggests.** That option
 * reads as though every endpoint's `APIError` bubbles to the Hono boundary, and none of them do:
 * better-auth's `onError` re-raises (`better-auth/dist/api/index.mjs:193`) straight into better-call's
 * own catch (`better-call@1.4.0`, `dist/router.mjs:83-89`), which renders an `APIError` as a Response
 * and returns it. An endpoint refusal is therefore an ordinary non-2xx answer, and `handleBetterAuth`
 * hands it back untouched (#449).
 *
 * What still arrives is what better-call declined to handle: a non-`APIError` throw from an endpoint
 * (`throw error` at `router.mjs:88` — a database failure, a genuine bug), and a throw from a plugin's
 * `onRequest` hook, which runs outside the router's try. The `isAPIError` branch is kept for those,
 * which can carry one, and because a caller other than the delegating route may hand this anything.
 *
 * The shape, when it is one: `{ statusCode, status, message, body: { message, code } }`. We re-home it
 * in the one `PithyError` family so the HTTP codec owns the response shape and strips `detail`. For 4xx the
 * Better-Auth message is user-actionable and safe to surface (it never reveals account existence —
 * sign-up is silently no-op'd for unknown users); 5xx gets a generic public message. The Better-Auth
 * status + error code stay in `detail` (logs/audit only, never the client).
 */
export function apiErrorToPithy(error: unknown): PithyError {
  if (error instanceof PithyError) return error;
  if (!isAPIError(error)) {
    return new InternalError({
      message: "Authentication failed.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const e = error as {
    statusCode?: number;
    status?: unknown;
    message?: string;
    body?: { message?: string; code?: string };
  };
  const status = typeof e.statusCode === "number" ? e.statusCode : 500;
  const publicMessage = e.body?.message ?? e.message ?? "Authentication failed.";
  const detail = `better-auth ${String(e.status)}${e.body?.code ? ` ${e.body.code}` : ""}: ${e.message ?? ""}`.trim();
  switch (status) {
    case 400:
      return new ValidationError({ message: publicMessage, detail });
    case 401:
      return new UnauthorizedError({ message: publicMessage, detail });
    case 403:
      return new ForbiddenError({ message: publicMessage, detail });
    case 404:
      return new NotFoundError({ message: publicMessage, detail });
    case 409:
      return new ConflictError({ message: publicMessage, detail });
    case 429:
      return new RateLimitError({ message: publicMessage, detail });
    default:
      return new InternalError({ message: "Authentication failed.", detail });
  }
}
