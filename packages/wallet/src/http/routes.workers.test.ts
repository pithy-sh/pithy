import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { WalletConfig, type WalletConfigInput } from "../config/config";
import { ledger } from "../ledger/ledger";
import { wallet_0001_ledger } from "../migrations/0001_ledger";
import { registerWalletRoutes } from "./routes";

beforeEach(async () => {
  for (const t of ["pithy_wallet_accounts", "pithy_wallet_transactions", "pithy_wallet_holds"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await wallet_0001_ledger.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

function makeApp(input: WalletConfigInput = { currencies: [{ code: "chips", name: "Chips" }] }) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    const scopes = c.req.header("x-scopes")?.split(",").filter(Boolean) ?? [];
    if (user) c.set("auth", { userId: user, sessionId: "s1", scopes });
    else c.set("auth", null);
    await next();
  });
  registerWalletRoutes({ config: WalletConfig.parse(input) })(app);
  return app;
}

const req = (
  app: Hono<PithyHonoEnv>,
  method: string,
  path: string,
  o: { user?: string; scopes?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.user) headers["x-user"] = o.user;
  if (o.scopes) headers["x-scopes"] = o.scopes;
  const sendsBody = method !== "GET" && o.body !== undefined;
  return app.request(`http://x${path}`, { method, headers, body: sendsBody ? JSON.stringify(o.body) : undefined }, env);
};

const ADMIN = "wallet:admin";

describe("wallet routes", () => {
  test("reading a balance requires auth and is scoped to the caller", async () => {
    const app = makeApp();
    expect((await req(app, "GET", "/wallet/chips")).status).toBe(401);
    await ledger(env.DB).credit("alice", "chips", 100, "c1");
    const res = await req(app, "GET", "/wallet/chips", { user: "alice" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 100, held: 0, available: 100 });
    // Bob reads his own (empty) balance, never alice's.
    expect(await (await req(app, "GET", "/wallet/chips", { user: "bob" })).json()).toEqual({
      balance: 0,
      held: 0,
      available: 0,
    });
  });

  test("an unknown currency is a 404", async () => {
    const res = await req(makeApp(), "GET", "/wallet/doubloons", { user: "alice" });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("wallet/currency_not_found");
  });

  test("crediting another player requires the admin scope", async () => {
    const app = makeApp();
    // No scope → forbidden.
    const forbidden = await req(app, "POST", "/wallet/chips/credit", {
      user: "server",
      body: { userId: "alice", amount: 100, ref: "c1" },
    });
    expect(forbidden.status).toBe(403);
    // With the scope → works.
    const ok = await req(app, "POST", "/wallet/chips/credit", {
      user: "server",
      scopes: ADMIN,
      body: { userId: "alice", amount: 100, ref: "c1" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ balance: 100, held: 0, available: 100 });
  });

  test("an admin debit past the balance is a 409 insufficient_funds", async () => {
    const app = makeApp();
    await req(app, "POST", "/wallet/chips/credit", {
      user: "server",
      scopes: ADMIN,
      body: { userId: "alice", amount: 50, ref: "c1" },
    });
    const res = await req(app, "POST", "/wallet/chips/debit", {
      user: "server",
      scopes: ADMIN,
      body: { userId: "alice", amount: 80, ref: "d1" },
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("wallet/insufficient_funds");
  });

  test("a credit with a bad amount is a 400", async () => {
    const app = makeApp();
    const res = await req(app, "POST", "/wallet/chips/credit", {
      user: "server",
      scopes: ADMIN,
      body: { userId: "alice", amount: -5, ref: "c1" },
    });
    expect(res.status).toBe(400);
  });

  test("a malformed :currency is a 400 before any currency lookup", async () => {
    // The `:currency` validator is shape-only, so `CHIPS` never reaches `resolveCurrency`.
    const res = await req(makeApp(), "GET", "/wallet/CHIPS", { user: "alice" });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("a malformed admin body is a 400", async () => {
    const res = await req(makeApp(), "POST", "/wallet/chips/credit", {
      user: "server",
      scopes: ADMIN,
      body: { userId: "alice", amount: 100 },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("an unparseable JSON body is a 400", async () => {
    const app = makeApp();
    const res = await app.request(
      "http://x/wallet/chips/credit",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": "server", "x-scopes": ADMIN },
        body: "{not json",
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("the guards still win over the validators", async () => {
    const app = makeApp();
    // A request that is both unauthenticated and malformed is a 401 — validators sit after the guards.
    const unauthenticated = await req(app, "POST", "/wallet/chips/credit", { body: { amount: -5 } });
    expect(unauthenticated.status).toBe(401);
    // Authenticated but unscoped, still malformed → 403, not 400.
    const unscoped = await req(app, "POST", "/wallet/chips/credit", { user: "server", body: { amount: -5 } });
    expect(unscoped.status).toBe(403);
  });

  test("a malformed body on an unconfigured currency is a 400, not the currency 404", async () => {
    // Pins a deliberate order change: the body validator now runs on the route line, before the handler
    // resolves the currency. This used to be `wallet/currency_not_found` (404).
    const res = await req(makeApp(), "POST", "/wallet/doubloons/credit", {
      user: "server",
      scopes: ADMIN,
      body: { userId: "alice", amount: -5, ref: "c1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("a well-formed body on an unconfigured currency is still the currency 404", async () => {
    const res = await req(makeApp(), "POST", "/wallet/doubloons/credit", {
      user: "server",
      scopes: ADMIN,
      body: { userId: "alice", amount: 100, ref: "c1" },
    });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("wallet/currency_not_found");
  });

  test("transactions lists the caller's own history", async () => {
    const app = makeApp();
    await ledger(env.DB).credit("alice", "chips", 100, "c1", { memo: "welcome bonus" });
    const res = await req(app, "GET", "/wallet/chips/transactions", { user: "alice" });
    expect(res.status).toBe(200);
    const { transactions } = await res.json<{ transactions: { ref: string; memo: string }[] }>();
    expect(transactions[0]?.ref).toBe("c1");
    expect(transactions[0]?.memo).toBe("welcome bonus");
  });
});
