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
