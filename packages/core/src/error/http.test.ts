import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import { HttpError, pithyErrorHandler } from "./http";
import { ForbiddenError, PithyError } from "./pithyError";

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
