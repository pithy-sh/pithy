// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { renderPithyError, toPithyError } from "../error/http";
import type { Logger } from "./logger";
import { createWorkerLogger } from "./worker";

/**
 * The `onError` handler that **writes the fault down** before it renders it.
 *
 * ## The defect this closes
 *
 * A misconfigured knob — a webhook tolerance, a lock horizon, a batch size — now refuses instead of
 * silently deleting the check it was part of (#521), and every one of those refusals carries an
 * `action` naming the variable an operator must fix. In a deployed Worker that `action` reached
 * nothing. `clientError` strips it on the way to the wire, which is correct and is the point; the
 * terminal renderer is a CLI surface no Worker runs; and the request produced exactly one record — the
 * access log line, `{"msg":"request","status":500}`. So the remedy existed and nobody could read it,
 * which is the unfollowable-action defect one layer out: not an action that does not help, an action
 * that does not arrive.
 *
 * ## Why it is here and not in the encoder
 *
 * `error/http.ts` is on the client side of the logger boundary and `logger/boundary.test.ts` gates
 * that: the three client/operator-facing error surfaces (`http.ts`, `terminal.ts`, `payload.ts`) must
 * not import the logger, so a record carrying `detail` cannot reach a response through them. That is a
 * deliberate decision, not an oversight, and the fix respects its direction rather than working around
 * it — the log is written on the internal side, and the encoder is imported *by* it. Nothing here can
 * put a log record into a response: {@link renderPithyError} takes the payload and this module never
 * touches the body.
 *
 * ## What lands
 *
 * One record, with the whole payload — `code`, `status`, `message`, `action`, `detail`. The logger
 * engine lifts a reserved `error` field into {@link import("./record").LogRecord.error}, so nothing
 * here formats or flattens anything; the fields the request logger already binds (`request`, `method`,
 * `path`, `env`, `version`) ride along, which is what makes the line correlatable with the access log
 * line beside it.
 *
 * **The client boundary does not move.** The response is byte-identical to what
 * `pithyErrorHandler` produced: `HttpError.encode` still runs through `clientError`, `action` and
 * `detail` are still stripped, and a forger still learns a status and a bland sentence. Both halves are
 * pinned in `errorHandler.test.ts` — the log carries the action, the wire body does not.
 */

/**
 * Level by status, and it is one branch on purpose.
 *
 * **5xx is ours.** `core/internal`, `core/upstream_failed`, `core/upstream_timeout`: the code means
 * *read our logs*, so the log is where it goes, at the level an operator's alerting already watches.
 *
 * **4xx is the caller's**, and it is already visible — the access log line beside this one carries its
 * status. Logging it at `error` would put an unauthenticated caller in charge of how much this Worker
 * writes, which is a bill and a haystack rather than a signal. It is still recorded, at `debug`, with
 * the identical payload: an operator chasing a 403 nobody can explain turns the level down and gets
 * every field, including the `action`, without a second code path existing to drift.
 */
function levelFor(status: number): "debug" | "error" {
  return status >= 500 ? "error" : "debug";
}

/**
 * The fallback logger, built once, for an app that registers this handler without
 * `createBackend`'s base middleware — the email host's dev dispatch door, a hand-assembled Hono app.
 *
 * `noopLogger` would be the tidier default and it is the wrong one here: this handler exists so a
 * fault reaches a surface, and a fallback that reaches none is the defect with a new spelling. This is
 * the same CF-native adapter `createBackend` defaults to, minus the per-request correlation there is
 * nothing to derive it from.
 */
let fallback: Logger | null = null;

/** The request's logger if one was bound, else the shared fallback. */
function loggerFor(c: Context): Logger {
  const bound: unknown = (c as Context<{ Variables: { log?: Logger } }>).get("log");
  if (bound) return bound as Logger;
  fallback ??= createWorkerLogger();
  return fallback;
}

/**
 * Hono `onError` handler: log the fault with its full payload, then render the public response.
 *
 * Register it once on the root app — `createBackend` already does. `pithyErrorHandler` remains the
 * bare encoder for an app that has no logger seam at all.
 */
export function loggingErrorHandler(err: Error, c: Context): Response {
  const pithy = toPithyError(err);
  // The same object the response is rendered from, so the record and the body can never describe two
  // different faults. `error` is the reserved field the engine lifts — `action` and `detail` included.
  loggerFor(c)[levelFor(pithy.payload.status)]("request failed", { error: pithy });
  return renderPithyError(pithy, c);
}
