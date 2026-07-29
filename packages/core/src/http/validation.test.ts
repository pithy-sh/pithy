import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pithyErrorHandler } from "../error/http";
import { validationHook } from "./validation";

const Body = z.object({ score: z.number() }).describe("A score submission.");
const Query = z.object({ limit: z.coerce.number().int().min(1).max(10) }).describe("A page size.");
const Params = z.object({ id: z.string().min(1).max(8) }).describe("A record id.");

/** An app registering one route per validation target, each on the shared hook. */
function app() {
  const a = new Hono();
  a.onError(pithyErrorHandler);
  a.post("/body", zValidator("json", Body, validationHook), (c) => c.json(c.req.valid("json")));
  a.get("/query", zValidator("query", Query, validationHook), (c) => c.json(c.req.valid("query")));
  a.get("/params/:id", zValidator("param", Params, validationHook), (c) => c.json(c.req.valid("param")));
  return a;
}

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; status: number; message: string; issues?: unknown[] } };
  return body.error;
}

describe("validationHook", () => {
  test("a malformed body renders the PithyError payload, not zod-validator's own response", async () => {
    const res = await app().request("/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: "high" }),
    });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("validation/invalid_input");
    expect(error.status).toBe(400);
    expect(error.issues).toEqual([expect.objectContaining({ path: ["score"], code: "invalid_type" })]);
  });

  test("a malformed query is the same 400", async () => {
    const res = await app().request("/query?limit=99");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a malformed path param is the same 400", async () => {
    const res = await app().request("/params/far-too-long-for-this");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("unparseable JSON is a 400, not the 500 a bare c.req.json() produces", async () => {
    const res = await app().request("/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a valid request reaches the handler with the parsed value", async () => {
    const res = await app().request("/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: 12 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score: 12 });
  });

  test("query coercion and defaults reach the handler decoded", async () => {
    const res = await app().request("/query?limit=3");
    expect(await res.json()).toEqual({ limit: 3 });
  });

  test("a successful outcome throws nothing", () => {
    expect(() => validationHook({ success: true })).not.toThrow();
  });

  test("the detail a client must never see is absent from the wire payload", async () => {
    const res = await app().request("/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(await errorOf(res)).not.toHaveProperty("detail");
  });
});
