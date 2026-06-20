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
 * Better Auth's handler runs with `onAPIError.throw`, so its errors bubble to the Hono boundary as
 * `APIError` (`{ statusCode, status, message, body: { message, code } }`). We re-home them in the one
 * `PithyError` family so the HTTP codec owns the response shape and strips `detail`. For 4xx the
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
