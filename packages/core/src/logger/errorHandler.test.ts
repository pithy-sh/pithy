// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createBackend } from "../createBackend";
import { ForbiddenError, InternalError } from "../error/pithyError";
import { loggingErrorHandler } from "./errorHandler";
import { createLogger, type Logger } from "./logger";
import type { LogRecord } from "./record";

/**
 * **Both halves, pinned together.** A misconfigured knob refuses with an `action` naming the variable
 * an operator must fix (#521); `clientError` strips that `action` on the way to the wire, and must
 * keep stripping it. So every test here asserts the pair: the record carries the remedy, the body does
 * not. Asserting either alone is how one of them moves.
 */

/** The fault the whole of #521 produces: a knob that is not a number, refused by name. */
const misconfigured = () =>
  new InternalError({
    message: "This webhook endpoint is not configured.",
    action: "Give the x-signature guard a tolerance between 0 and 3600 seconds.",
    detail: "The signed-webhook guard on x-signature was given a tolerance of NaN seconds.",
  });

/** An app whose one route throws `error`, with a capturing logger bound the way `createBackend` binds one. */
function appThrowing(
  error: Error,
  level: "debug" | "error" = "debug",
): { app: Hono<{ Variables: { log: Logger } }>; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const log = createLogger({ level, sink: (record) => records.push(record) });
  const app = new Hono<{ Variables: { log: Logger } }>();
  app.onError(loggingErrorHandler);
  app.use("*", async (c, next) => {
    c.set("log", log);
    await next();
  });
  app.get("/boom", () => {
    throw error;
  });
  return { app, records };
}

describe("loggingErrorHandler", () => {
  test("the operator's remedy lands in the log, and not on the wire", async () => {
    const { app, records } = appThrowing(misconfigured());
    const response = await app.request("/boom");

    expect(response.status).toBe(500);

    // The log half. One record, carrying the whole payload.
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.level).toBe("error");
    expect(record?.error?.code).toBe("core/internal");
    expect(record?.error?.action).toContain("tolerance between 0 and 3600 seconds");
    expect(record?.error?.detail).toContain("NaN");

    // The wire half. Unchanged, and it is the security boundary: neither field crosses.
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/internal");
    expect(body.error.message).toBe("This webhook endpoint is not configured.");
    expect("action" in body.error).toBe(false);
    expect("detail" in body.error).toBe(false);
  });

  test("a caller's 4xx is recorded at debug — the access log already carries its status", async () => {
    const { app, records } = appThrowing(new ForbiddenError({ message: "Nope.", action: "Grant the scope." }));
    const response = await app.request("/boom");

    expect(response.status).toBe(403);
    expect(records[0]?.level).toBe("debug");
    // Same payload, lower volume: an unauthenticated caller must not decide how much this Worker writes,
    // and an operator turning the level down still gets every field rather than a second, thinner path.
    expect(records[0]?.error?.action).toBe("Grant the scope.");
    expect("action" in ((await response.json()) as { error: object }).error).toBe(false);
  });

  test("a 4xx is dropped entirely by a default-level logger, and a 5xx is not", async () => {
    const { app, records } = appThrowing(new ForbiddenError({ message: "Nope." }), "error");
    await app.request("/boom");
    expect(records).toHaveLength(0);

    const fault = appThrowing(misconfigured(), "error");
    await fault.app.request("/boom");
    expect(fault.records).toHaveLength(1);
  });

  test("a throw that is not a PithyError is wrapped, logged, and says nothing to the caller", async () => {
    const { app, records } = appThrowing(new Error("SQLITE_BUSY: database is locked"));
    const response = await app.request("/boom");

    expect(response.status).toBe(500);
    // The original message is internal context, so it rides on `detail` and nowhere else.
    expect(records[0]?.error?.detail).toBe("SQLITE_BUSY: database is locked");
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain("SQLITE_BUSY");
    expect("detail" in body.error).toBe(false);
  });

  test("the record and the response describe one fault, not two", async () => {
    const { app, records } = appThrowing(misconfigured());
    const response = await app.request("/boom");
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(records[0]?.error?.code).toBe(body.error.code);
    expect(records[0]?.error?.message).toBe(body.error.message);
    expect(records[0]?.error?.status).toBe(response.status);
  });
});

/**
 * The wiring, asserted where it is. The handler above can be perfect and reach nobody if the app every
 * adopter composes registers the bare encoder instead — which is exactly the state #521 measured.
 */
describe("createBackend wires it", () => {
  test("a fault from a composed app reaches the log with its action, and the wire without it", async () => {
    const records: LogRecord[] = [];
    const app = createBackend({
      capabilities: [],
      logger: createLogger({ level: "debug", sink: (record) => records.push(record) }),
    });
    app.get("/boom", () => {
      throw misconfigured();
    });

    const response = await app.request("/boom", {}, { ENVIRONMENT: "dev" });

    expect(response.status).toBe(500);
    const fault = records.find((record) => record.msg === "request failed");
    expect(fault?.error?.action).toContain("tolerance between 0 and 3600 seconds");
    // The access log line is still there beside it — the one record this used to be the whole of.
    expect(records.some((record) => record.msg === "request")).toBe(true);
    expect("action" in ((await response.json()) as { error: object }).error).toBe(false);
  });
});
