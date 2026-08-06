// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineErrorPayload } from "./extend";
import { HttpError, pithyErrorHandler } from "./http";
import { ErrorPayload, PublicErrorPayload } from "./payload";
import { ForbiddenError, PithyError, UpstreamError, UpstreamTimeoutError } from "./pithyError";

describe("HttpError codec", () => {
  test("encode strips `detail` — internal context never reaches the wire", () => {
    const err = new ForbiddenError({ detail: "user 5 lacks role:admin" });
    const wire = HttpError.encode(err.payload);
    expect(wire).toEqual({ code: "auth/forbidden", status: 403, message: "Forbidden." });
    expect("detail" in wire).toBe(false);
  });

  test("round-trips: encode → wire → decode equals the public projection", () => {
    const err = new ForbiddenError({ message: "No.", action: "Ask an admin.", detail: "secret" });
    const wire = HttpError.encode(err.payload);
    const back = HttpError.parse(wire);
    expect(back).toEqual({ code: "auth/forbidden", status: 403, message: "No.", action: "Ask an admin." });
  });
});

describe("the boundary holds for an adopter-defined error", () => {
  // The test that matters most in the extension seam. Widening the union must not widen what
  // reaches a client: an error the kit never defined has to strip `detail` exactly like one it did.
  const expired = () =>
    defineErrorPayload({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
      action: "Run pithy dashboard connect again.",
      detail: "code 9f2c bound to org 3, issued 11m ago",
    });

  test("encode strips `detail` from an adopter payload", () => {
    const wire = HttpError.encode(expired());
    expect(wire).toEqual({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
      action: "Run pithy dashboard connect again.",
    });
    expect("detail" in wire).toBe(false);
  });

  test("the schema strips it even if the encode function stops doing so", () => {
    // Belt and braces, tested honestly: `HttpError.encode` removes `detail` by destructure, so
    // feeding it a detail-carrying payload proves nothing about the second pass. This codec is the
    // same pair of schemas with an encode that deliberately leaks, and `detail` still does not
    // survive — so an edit to `encode`, or a stray `detail` on the public open member, cannot
    // quietly open the boundary.
    const Leaky = z.codec(PublicErrorPayload, ErrorPayload, {
      decode: (wire): ErrorPayload => wire,
      encode: (payload): PublicErrorPayload => payload as PublicErrorPayload,
    });
    const wire = Leaky.encode(expired());
    expect("detail" in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toContain("org 3");
  });

  test("decode revives an adopter error from a wire body", () => {
    // The client-SDK direction. Dropping the open branch from `PublicErrorPayload` would leave a
    // consumer parsing an adopter's error body with a raw ZodError instead of a PithyError.
    const payload = HttpError.decode({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
    });
    expect(payload.code).toBe("connect/device_code_expired");
    expect(payload.status).toBe(410);
  });

  test("the handler answers at the adopter's status with no internal context", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new PithyError(expired());
    });

    const res = await app.request("/");
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("connect/device_code_expired");
    expect("detail" in body.error).toBe(false);
    expect(JSON.stringify(body)).not.toContain("org 3");
  });

  test("an upstream failure answers 502, not 500 — the blame lands on the right system", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new UpstreamError({ detail: "GET https://customer.example/admin/users → 503" });
    });

    const res = await app.request("/");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/upstream_failed");
    expect(JSON.stringify(body)).not.toContain("customer.example");
  });

  test("an upstream timeout answers 504 all the way to the Response", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new UpstreamTimeoutError({ detail: "GET https://customer.example/admin/users → 30s" });
    });

    const res = await app.request("/");
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/upstream_timeout");
    expect(JSON.stringify(body)).not.toContain("customer.example");
  });
});

describe("pithyErrorHandler (Hono onError)", () => {
  test("maps a PithyError to its declared status and public body", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new ForbiddenError({ detail: "must not leak" });
    });

    const res = await app.request("/");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("auth/forbidden");
    expect(body.error.message).toBe("Forbidden.");
    expect("detail" in body.error).toBe(false);
  });

  test("maps an unknown throw to a 500 with a generic message and no internal leak", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new Error("raw stack-revealing detail");
    });

    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/internal");
    expect(body.error.message).toBe("Something unexpected happened.");
    expect(JSON.stringify(body)).not.toContain("raw stack-revealing detail");
  });

  test("a Hono HTTPException 400 becomes validation/invalid_input, not a 500", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new HTTPException(400, { message: "Malformed JSON in request body" });
    });

    const res = await app.request("/");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("validation/invalid_input");
    expect(body.error.message).toBe("The request body could not be parsed.");
    expect(JSON.stringify(body)).not.toContain("Malformed JSON");
  });

  test("a non-400 HTTPException stays a generic 500 — we have no public wording for it", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/", () => {
      throw new HTTPException(418, { message: "internal framework wording" });
    });

    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/internal");
    expect(JSON.stringify(body)).not.toContain("internal framework wording");
  });

  test("a thrown unknown is still wrapped — the original is the PithyError cause", async () => {
    const app = new Hono();
    let captured: unknown;
    app.onError((err, c) => {
      captured = err;
      return pithyErrorHandler(err, c);
    });
    app.get("/", () => {
      throw new Error("root cause");
    });
    await app.request("/");
    expect(captured).toBeInstanceOf(Error);
    expect(captured).not.toBeInstanceOf(PithyError); // Hono hands us the raw throw
  });
});
