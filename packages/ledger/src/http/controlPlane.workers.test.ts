// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { LedgerConfig } from "../config/config";
import { openLedger } from "../ledger";
import { ledger_0001_accounts } from "../migrations/0001_accounts";
import {
  LedgerAccountsResponse,
  LedgerAdjustmentResponse,
  LedgerTransactionsResponse,
  LedgerUserAccountsResponse,
} from "./responses";
import { registerLedgerRoutes } from "./routes";
import { LEDGER_ACCOUNTS_ADJUST_SCOPE, LEDGER_ACCOUNTS_READ_SCOPE, LEDGER_TRANSACTIONS_READ_SCOPE } from "./scopes";

/**
 * The management handlers, actually executed.
 *
 * `routeContract.test.ts` calls each of these with no credential and asserts 403, which proves the guard
 * runs and nothing else — every handler body is unreached there. What survives only here: the keyset
 * pagination (an offset would pass every test that never fetches a second page), the response
 * projections, the 404 on an unconfigured currency filter, the audit event on a read, and every
 * guarantee a write makes — the replay, the reason, the shortfall, the reversal's unique ref with two in
 * flight, the account a ref must be on, and exactly one audit event per write that moved money. A guard
 * nothing exercises is a comment.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONFIG = LedgerConfig.parse({
  currencies: [
    { code: "chips", name: "Chips" },
    { code: "gold", name: "Gold" },
  ],
});
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

/** The app, with a live control-plane verifier and a capturing audit seam. */
function makeApp(scopes: readonly ControlPlaneScope[]) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerLedgerRoutes({ config: CONFIG })(app);
  return app;
}

/** A GET carrying a freshly minted control-plane token. */
async function call(app: Hono<PithyHonoEnv>, path: string, scope: ControlPlaneScope): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    {
      ...env,
      ENVIRONMENT,
    },
  );
}

/** A POST carrying a freshly minted control-plane token, bound to the exact body it sends. */
async function post(app: Hono<PithyHonoEnv>, path: string, scope: ControlPlaneScope, body: unknown): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    body: new TextEncoder().encode(raw),
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method: "POST", headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token }, body: raw },
    { ...env, ENVIRONMENT },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

interface AccountsBody {
  accounts: { userId: string; currency: string; balance: number; held: number; available: number }[];
  nextCursor: string | null;
}

interface TransactionsBody {
  userId: string;
  currency: string;
  transactions: { ref: string; kind: string; amount: number; memo: string | null }[];
  nextCursor: string | null;
}

beforeEach(async () => {
  for (const table of ["pithy_ledger_holds", "pithy_ledger_transactions", "pithy_ledger_accounts"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await ledger_0001_accounts.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  emitted = [];
});

describe("GET /ledger/admin/accounts", () => {
  test("lists every account and projects a deliberate view", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 40, "h1");

    const response = await call(
      makeApp([LEDGER_ACCOUNTS_READ_SCOPE]),
      "/ledger/admin/accounts",
      LEDGER_ACCOUNTS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = await response.json<AccountsBody>();
    expect(body.accounts).toEqual([
      {
        userId: "alice",
        currency: "chips",
        balance: 100,
        held: 40,
        // Computed by the view, so a client never has to know the rule.
        available: 60,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    // The surrogate primary key is internal and must not reach a client — an account is addressed by
    // `(userId, currency)`, which is also what the schema says the id is not for.
    expect(Object.keys(body.accounts[0] ?? {})).not.toContain("id");
  });

  test("pages by keyset, so a row inserted mid-read neither repeats nor disappears", async () => {
    // The bug an offset would have: `OFFSET 2` after a new account opens shifts the whole window, so
    // page 2 repeats a row page 1 already showed. Only a second page can catch it.
    for (const user of ["u1", "u2", "u3", "u4"]) await openLedger(env.DB).credit(user, "chips", 10, `c-${user}`);
    const app = makeApp([LEDGER_ACCOUNTS_READ_SCOPE]);

    const first = await (
      await call(app, "/ledger/admin/accounts?limit=2", LEDGER_ACCOUNTS_READ_SCOPE)
    ).json<AccountsBody>();
    expect(first.accounts.map((a) => a.userId)).toEqual(["u4", "u3"]);
    expect(first.nextCursor).toBeTypeOf("string");

    // A fifth account opens between the two requests, at the head of the ordering.
    await openLedger(env.DB).credit("u5", "chips", 10, "c-u5");

    const second = await (
      await call(
        app,
        `/ledger/admin/accounts?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        LEDGER_ACCOUNTS_READ_SCOPE,
      )
    ).json<AccountsBody>();
    expect(second.accounts.map((a) => a.userId)).toEqual(["u2", "u1"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a malformed cursor is a first page, not a 500", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    const response = await call(
      makeApp([LEDGER_ACCOUNTS_READ_SCOPE]),
      "/ledger/admin/accounts?cursor=not-a-cursor",
      LEDGER_ACCOUNTS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    expect((await response.json<AccountsBody>()).accounts).toHaveLength(1);
  });

  test("filters to one currency", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).credit("alice", "gold", 5, "c2");
    const body = await (
      await call(
        makeApp([LEDGER_ACCOUNTS_READ_SCOPE]),
        "/ledger/admin/accounts?currency=gold",
        LEDGER_ACCOUNTS_READ_SCOPE,
      )
    ).json<AccountsBody>();
    expect(body.accounts.map((a) => a.currency)).toEqual(["gold"]);
  });

  test("an unconfigured currency filter is a 404, not an empty pane", async () => {
    // An empty list reads to an operator as "nobody holds any", which is a different and wrong answer
    // to a mistyped code.
    const response = await call(
      makeApp([LEDGER_ACCOUNTS_READ_SCOPE]),
      "/ledger/admin/accounts?currency=doubloons",
      LEDGER_ACCOUNTS_READ_SCOPE,
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("ledger/currency_not_found");
  });

  test("the read is audited, with the caller and the connection recorded", async () => {
    // A credential quietly paging every player's balances changes nothing and would otherwise leave no
    // trace at all. That is the whole reason reads are audited here.
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await call(makeApp([LEDGER_ACCOUNTS_READ_SCOPE]), "/ledger/admin/accounts", LEDGER_ACCOUNTS_READ_SCOPE);
    const event = emitted.find((e) => e.action === "ledger/accounts_listed");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    expect((event?.metadata as { connectionId?: string } | undefined)?.connectionId).toBe(CONNECTION_ID);
    expect((event?.metadata as { returned?: number } | undefined)?.returned).toBe(1);
  });
});

describe("GET /ledger/admin/accounts/:userId", () => {
  test("returns what one player holds, in every currency", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).credit("alice", "gold", 5, "c2");
    await openLedger(env.DB).credit("bob", "chips", 7, "c3");

    const body = await (
      await call(makeApp([LEDGER_ACCOUNTS_READ_SCOPE]), "/ledger/admin/accounts/alice", LEDGER_ACCOUNTS_READ_SCOPE)
    ).json<{ userId: string; accounts: { currency: string; balance: number }[] }>();
    expect(body.userId).toBe("alice");
    expect(body.accounts).toEqual([
      expect.objectContaining({ currency: "chips", balance: 100 }),
      expect.objectContaining({ currency: "gold", balance: 5 }),
    ]);
  });

  test("a player with no account is an empty list, not a 404", async () => {
    // An account is opened by its first credit, so its absence is not a missing player — and a 404 here
    // would turn the route into an existence oracle for user ids.
    const response = await call(
      makeApp([LEDGER_ACCOUNTS_READ_SCOPE]),
      "/ledger/admin/accounts/nobody",
      LEDGER_ACCOUNTS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    expect((await response.json<{ accounts: unknown[] }>()).accounts).toEqual([]);
  });

  test("the read is audited against the player it named", async () => {
    await call(makeApp([LEDGER_ACCOUNTS_READ_SCOPE]), "/ledger/admin/accounts/alice", LEDGER_ACCOUNTS_READ_SCOPE);
    const event = emitted.find((e) => e.action === "ledger/account_read");
    expect(event?.resourceId).toBe("alice");
  });
});

describe("GET /ledger/admin/accounts/:userId/:currency/transactions", () => {
  test("returns the entry log newest first, with what an operator actually needs", async () => {
    const led = openLedger(env.DB);
    await led.credit("alice", "chips", 100, "c1", { memo: "daily bonus" });
    await led.debit("alice", "chips", 30, "d1", { memo: "blackjack" });

    const body = await (
      await call(
        makeApp([LEDGER_TRANSACTIONS_READ_SCOPE]),
        "/ledger/admin/accounts/alice/chips/transactions",
        LEDGER_TRANSACTIONS_READ_SCOPE,
      )
    ).json<TransactionsBody>();
    expect(body.transactions.map((t) => t.ref)).toEqual(["d1", "c1"]);
    expect(body.transactions[0]).toEqual({
      ref: "d1",
      kind: "debit",
      currency: "chips",
      amount: 30,
      relatedRef: null,
      memo: "blackjack",
      createdAt: expect.any(String),
    });
  });

  test("pages by keyset and stops at the end", async () => {
    const led = openLedger(env.DB);
    for (const n of [1, 2, 3]) await led.credit("alice", "chips", 10, `c${n}`);
    const app = makeApp([LEDGER_TRANSACTIONS_READ_SCOPE]);

    const first = await (
      await call(app, "/ledger/admin/accounts/alice/chips/transactions?limit=2", LEDGER_TRANSACTIONS_READ_SCOPE)
    ).json<TransactionsBody>();
    expect(first.transactions.map((t) => t.ref)).toEqual(["c3", "c2"]);

    const second = await (
      await call(
        app,
        `/ledger/admin/accounts/alice/chips/transactions?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        LEDGER_TRANSACTIONS_READ_SCOPE,
      )
    ).json<TransactionsBody>();
    expect(second.transactions.map((t) => t.ref)).toEqual(["c1"]);
    expect(second.nextCursor).toBeNull();
  });

  test("never returns another player's entries", async () => {
    const led = openLedger(env.DB);
    await led.credit("alice", "chips", 100, "alice-1");
    await led.credit("bob", "chips", 100, "bob-1");
    const body = await (
      await call(
        makeApp([LEDGER_TRANSACTIONS_READ_SCOPE]),
        "/ledger/admin/accounts/alice/chips/transactions",
        LEDGER_TRANSACTIONS_READ_SCOPE,
      )
    ).json<TransactionsBody>();
    expect(body.transactions.map((t) => t.ref)).toEqual(["alice-1"]);
  });

  test("an unconfigured currency is a 404", async () => {
    const response = await call(
      makeApp([LEDGER_TRANSACTIONS_READ_SCOPE]),
      "/ledger/admin/accounts/alice/doubloons/transactions",
      LEDGER_TRANSACTIONS_READ_SCOPE,
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("ledger/currency_not_found");
  });

  test("the read is audited against the account it opened", async () => {
    await call(
      makeApp([LEDGER_TRANSACTIONS_READ_SCOPE]),
      "/ledger/admin/accounts/alice/chips/transactions",
      LEDGER_TRANSACTIONS_READ_SCOPE,
    );
    const event = emitted.find((e) => e.action === "ledger/transactions_read");
    expect(event?.resourceId).toBe("alice:chips");
    expect(event?.actorType).toBe("control-plane");
  });
});

describe("the two scopes are not interchangeable", () => {
  test("a balances credential cannot open the entry log", async () => {
    // A balance is a number; the entry log is every wager, payout and purchase in order. The split only
    // means anything if holding one genuinely denies the other.
    const response = await call(
      makeApp([LEDGER_ACCOUNTS_READ_SCOPE]),
      "/ledger/admin/accounts/alice/chips/transactions",
      LEDGER_ACCOUNTS_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("a history credential cannot list the accounts", async () => {
    const response = await call(
      makeApp([LEDGER_TRANSACTIONS_READ_SCOPE]),
      "/ledger/admin/accounts",
      LEDGER_TRANSACTIONS_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("a granted scope presented for a different operation is still denied", async () => {
    // The connection holds both; the token names only one. `scopeCovers` checks the presented scope as
    // well as the granted set, so one call exercises one operation whatever the grant allows.
    const app = makeApp([LEDGER_ACCOUNTS_READ_SCOPE, LEDGER_TRANSACTIONS_READ_SCOPE]);
    expect((await call(app, "/ledger/admin/accounts", LEDGER_TRANSACTIONS_READ_SCOPE)).status).toBe(403);
    expect((await call(app, "/ledger/admin/accounts", LEDGER_ACCOUNTS_READ_SCOPE)).status).toBe(200);
  });
});

describe("the management surface moves a balance only through its four writes", () => {
  test("no verb but GET answers on the account listing", async () => {
    // The writes are per account, under `:userId/:currency/`. Nothing mutates the listing itself — there is
    // no bulk adjustment — so every other verb on it is a 404.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await makeApp([LEDGER_ACCOUNTS_READ_SCOPE]).request(
        "http://x/ledger/admin/accounts",
        { method },
        { ...env, ENVIRONMENT },
      );
      expect(response.status, method).toBe(404);
    }
  });

  test("a control-plane credential never satisfies the player admin gate", async () => {
    // The seam leaves `c.var.auth` null by design, so `requireAdmin` can never pass for a management
    // client. Confirmed rather than assumed: the credit route must refuse a perfectly valid token.
    const token = await mintControlPlaneToken({
      privateKey: keys.privateKey,
      keyId: CONTROL_PLANE_KEY_ID,
      issuer: CONTROL_PLANE_ISSUER,
      connectionId: CONNECTION_ID,
      subject: "operator-1",
      scope: LEDGER_ACCOUNTS_READ_SCOPE,
      now: () => NOW,
    });
    const response = await makeApp([LEDGER_ACCOUNTS_READ_SCOPE]).request(
      "http://x/ledger/chips/credit",
      {
        method: "POST",
        headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token },
        body: JSON.stringify({ userId: "alice", amount: 1000, ref: "escalation" }),
      },
      { ...env, ENVIRONMENT },
    );
    expect(response.status).toBe(401);
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 0, held: 0, available: 0 });
  });
});

describe("the exported response schemas against the live routes", () => {
  /**
   * The binding between what a route returns and what a management client is told it returns.
   *
   * Parsing alone would not do it: a Zod object strips unknown keys, so a handler that grew a field
   * would still parse. Comparing the parsed value with the raw body fails in both directions, which is
   * what stops the schema and the handler from drifting apart silently.
   */
  async function contract<T>(schema: z.ZodType<T>, scope: ControlPlaneScope, path: string): Promise<T> {
    const response = await call(makeApp([scope]), path, scope);
    expect(response.status, path).toBe(200);
    const raw = await response.json();
    expect(schema.parse(raw), path).toEqual(raw);
    return schema.parse(raw);
  }

  test("every management route returns exactly its declared envelope", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1", { memo: "welcome bonus" });
    await openLedger(env.DB).hold("alice", "chips", 40, "h1");
    await openLedger(env.DB).credit("bob", "chips", 20, "c2");

    // A limit of one, so the paged branch is under test — a schema proven only on the last page says
    // nothing about the cursor a client actually pages with.
    const accounts = await contract(
      LedgerAccountsResponse,
      LEDGER_ACCOUNTS_READ_SCOPE,
      "/ledger/admin/accounts?limit=1",
    );
    expect(accounts.nextCursor).not.toBeNull();

    await contract(LedgerUserAccountsResponse, LEDGER_ACCOUNTS_READ_SCOPE, "/ledger/admin/accounts/alice");
    // A player who holds nothing is an empty list, not a 404, and the schema has to accept that too.
    const none = await contract(
      LedgerUserAccountsResponse,
      LEDGER_ACCOUNTS_READ_SCOPE,
      "/ledger/admin/accounts/nobody",
    );
    expect(none.accounts).toEqual([]);

    await contract(
      LedgerTransactionsResponse,
      LEDGER_TRANSACTIONS_READ_SCOPE,
      "/ledger/admin/accounts/alice/chips/transactions",
    );
  });
});

/** The adjust routes' paths, for one account. */
const ADMIN = "/ledger/admin/accounts/alice/chips";

interface AdjustmentBody {
  userId: string;
  currency: string;
  ref: string;
  applied: boolean;
  balance: number;
  held: number;
  available: number;
}

/** Every entry on one account, oldest first. */
async function entries(userId = "alice", currency = "chips") {
  return (await openLedger(env.DB).transactions(userId, currency, 100)).reverse();
}

/** The events the ledger's writes emit — the guard's own denial events are not these. */
const WRITE_ACTIONS: readonly string[] = [
  "ledger/account_credited",
  "ledger/account_debited",
  "ledger/entry_reversed",
  "ledger/hold_released",
];
const writeEvents = () => emitted.filter((event) => WRITE_ACTIONS.includes(event.action));

describe("POST /ledger/admin/accounts/:userId/:currency/credit and /debit", () => {
  const app = () => makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);

  test("a credit adds funds, stores the reason as the memo, and answers with the account it left", async () => {
    const response = await post(app(), `${ADMIN}/credit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 250,
      ref: "refund-81",
      reason: "Refund: ticket 81",
    });
    expect(response.status).toBe(200);
    expect(await response.json<AdjustmentBody>()).toEqual({
      userId: "alice",
      currency: "chips",
      ref: "refund-81",
      applied: true,
      balance: 250,
      held: 0,
      available: 250,
    });
    expect((await entries()).map((e) => ({ ref: e.ref, kind: e.kind, amount: e.amount, memo: e.memo }))).toEqual([
      { ref: "refund-81", kind: "credit", amount: 250, memo: "Refund: ticket 81" },
    ]);
  });

  test("a debit removes funds", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    const response = await post(app(), `${ADMIN}/debit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 40,
      ref: "payout-misfire",
      reason: "Payout paid twice",
    });
    expect(response.status).toBe(200);
    expect(await response.json<AdjustmentBody>()).toMatchObject({ applied: true, balance: 60, available: 60 });
  });

  test("a debit below available is refused, naming the shortfall, and writes nothing", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 70, "h1");
    const response = await post(app(), `${ADMIN}/debit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 50,
      ref: "d1",
      reason: "Clawback",
    });
    expect(response.status).toBe(409);
    const body = await response.json<{ error: { code: string; params?: Record<string, number> } }>();
    expect(body.error.code).toBe("ledger/insufficient_funds");
    expect(body.error.params).toEqual({ amount: 50, available: 30, shortfall: 20 });
    expect((await entries()).map((e) => e.ref)).toEqual(["c1", "h1"]);
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 70, available: 30 });
    expect(writeEvents()).toEqual([]);
  });

  test("an unconfigured currency is a 404, and nothing is written", async () => {
    const response = await post(app(), "/ledger/admin/accounts/alice/doubloons/credit", LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 5,
      ref: "c1",
      reason: "x",
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("ledger/currency_not_found");
    expect(await entries("alice", "doubloons")).toEqual([]);
    expect(writeEvents()).toEqual([]);
  });

  test("a body naming a player of its own is refused — the path is the account", async () => {
    const response = await post(app(), `${ADMIN}/credit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 5,
      ref: "c1",
      reason: "x",
      userId: "mallory",
    });
    expect(response.status).toBe(400);
    expect(await entries("mallory")).toEqual([]);
  });
});

describe("every write refuses a missing or empty reason before anything is written", () => {
  const app = () => makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);

  test.each([
    ["credit", { amount: 5, ref: "w1" }],
    ["credit", { amount: 5, ref: "w1", reason: "" }],
    ["credit", { amount: 5, ref: "w1", reason: "   " }],
    ["debit", { amount: 5, ref: "w1" }],
    ["debit", { amount: 5, ref: "w1", reason: "" }],
    ["reverse", { ref: "c1" }],
    ["reverse", { ref: "c1", reason: " " }],
    ["release", { ref: "h1" }],
    ["release", { ref: "h1", reason: "" }],
  ])("%s %j", async (act, body) => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 10, "h1");
    const before = await entries();
    const response = await post(app(), `${ADMIN}/${act}`, LEDGER_ACCOUNTS_ADJUST_SCOPE, body);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
    expect(await entries()).toEqual(before);
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 10, available: 90 });
    expect(writeEvents()).toEqual([]);
  });
});

describe("every write is idempotent: the same request twice moves the balance once", () => {
  const app = () => makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);
  const cases: [string, Record<string, unknown>, { balance: number; held: number; available: number }][] = [
    ["credit", { amount: 25, ref: "w1", reason: "Goodwill" }, { balance: 125, held: 10, available: 115 }],
    ["debit", { amount: 25, ref: "w1", reason: "Clawback" }, { balance: 75, held: 10, available: 65 }],
    ["reverse", { ref: "c1", reason: "Granted in error" }, { balance: 0, held: 0, available: 0 }],
    ["release", { ref: "h1", reason: "Table crashed" }, { balance: 100, held: 0, available: 100 }],
  ];

  test.each(cases)("%s", async (act, body, settled) => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    if (act !== "reverse") await openLedger(env.DB).hold("alice", "chips", 10, "h1");
    const first = await post(app(), `${ADMIN}/${act}`, LEDGER_ACCOUNTS_ADJUST_SCOPE, body);
    const second = await post(app(), `${ADMIN}/${act}`, LEDGER_ACCOUNTS_ADJUST_SCOPE, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const one = await first.json<AdjustmentBody>();
    const two = await second.json<AdjustmentBody>();
    expect(one).toMatchObject({ applied: true, ...settled });
    // The replay answers with the balance as it stands — the same one — and says it moved nothing.
    expect(two).toEqual({ ...one, applied: false });
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual(settled);
    // One event for the write that moved money; none for the replay.
    expect(writeEvents()).toHaveLength(1);
  });
});

describe("an idempotency key is one write's: the same key on another write is a conflict, never a replay", () => {
  const app = () => makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);

  test("one key sent to two accounts credits the first and refuses the second", async () => {
    const first = await post(app(), `${ADMIN}/credit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 100,
      ref: "refund-7",
      reason: "Refund: ticket 7",
    });
    expect(first.status).toBe(200);
    const second = await post(app(), "/ledger/admin/accounts/bob/chips/credit", LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 50,
      ref: "refund-7",
      reason: "Refund: ticket 7, reused",
    });
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("ledger/ref_conflict");
    expect(await openLedger(env.DB).balance("bob", "chips")).toEqual({ balance: 0, held: 0, available: 0 });
    expect(await entries("bob")).toEqual([]);
    expect(writeEvents()).toHaveLength(1);
  });

  test("a credit's key sent to /debit is refused, and nothing moves", async () => {
    await post(app(), `${ADMIN}/credit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 100,
      ref: "refund-7",
      reason: "Refund: ticket 7",
    });
    const response = await post(app(), `${ADMIN}/debit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 100,
      ref: "refund-7",
      reason: "Clawback",
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("ledger/ref_conflict");
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    expect((await entries()).map((e) => e.ref)).toEqual(["refund-7"]);
    expect(writeEvents()).toHaveLength(1);
  });

  test("a key sent again for another amount, or naming a hold, is refused", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 10, "h1");
    for (const body of [
      { amount: 99, ref: "c1", reason: "Goodwill" },
      { amount: 10, ref: "h1", reason: "Goodwill" },
    ]) {
      const response = await post(app(), `${ADMIN}/credit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, body);
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("ledger/ref_conflict");
    }
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 10, available: 90 });
    expect(writeEvents()).toEqual([]);
  });
});

describe("POST /ledger/admin/accounts/:userId/:currency/reverse", () => {
  const app = () => makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);

  test("posts the opposite movement against the original, which stays as it was", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1", { memo: "daily bonus" });
    await openLedger(env.DB).debit("alice", "chips", 30, "d1", { memo: "blackjack" });
    const response = await post(app(), `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      ref: "d1",
      reason: "Hand voided",
    });
    expect(response.status).toBe(200);
    expect(await response.json<AdjustmentBody>()).toMatchObject({ ref: "d1:reverse", applied: true, balance: 100 });
    expect(
      (await entries()).map((e) => ({
        ref: e.ref,
        kind: e.kind,
        amount: e.amount,
        relatedRef: e.relatedRef,
        memo: e.memo,
      })),
    ).toEqual([
      { ref: "c1", kind: "credit", amount: 100, relatedRef: null, memo: "daily bonus" },
      { ref: "d1", kind: "debit", amount: 30, relatedRef: null, memo: "blackjack" },
      { ref: "d1:reverse", kind: "credit", amount: 30, relatedRef: "d1", memo: "Hand voided" },
    ]);
  });

  test("two reversals of one entry in flight at once post one, and audit one", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).debit("alice", "chips", 30, "d1");
    const shared = app();
    const [a, b] = await Promise.all([
      post(shared, `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, { ref: "d1", reason: "First tab" }),
      post(shared, `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, { ref: "d1", reason: "Second tab" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const applied = [(await a.json<AdjustmentBody>()).applied, (await b.json<AdjustmentBody>()).applied].sort();
    expect(applied).toEqual([false, true]);
    expect((await entries()).filter((e) => e.ref === "d1:reverse")).toHaveLength(1);
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    expect(writeEvents()).toHaveLength(1);
  });

  test("a reversal of a reversal is refused, naming the kind", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).debit("alice", "chips", 30, "d1");
    await openLedger(env.DB).reverse("d1");
    const response = await post(app(), `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      ref: "d1:reverse",
      reason: "Undo the undo",
    });
    expect(response.status).toBe(409);
    const body = await response.json<{ error: { code: string; params?: Record<string, string> } }>();
    expect(body.error).toMatchObject({
      code: "ledger/entry_not_reversible",
      params: { kind: "credit", reverses: "d1" },
    });
    expect(writeEvents()).toEqual([]);
  });

  test.each([
    ["h1", "hold"],
    ["h2:resolve", "release"],
    ["h3:resolve", "capture"],
    ["t1:out", "transfer_out"],
  ])("a reversal of %s is refused as a %s", async (ref, kind) => {
    const led = openLedger(env.DB);
    await led.credit("alice", "chips", 100, "c1");
    await led.hold("alice", "chips", 10, "h1");
    await led.hold("alice", "chips", 10, "h2");
    await led.release("h2");
    await led.hold("alice", "chips", 10, "h3");
    await led.capture("h3");
    await led.transfer("alice", "bob", "chips", 5, "t1");
    const before = await entries();
    const response = await post(app(), `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, { ref, reason: "x" });
    expect(response.status).toBe(409);
    const body = await response.json<{ error: { code: string; params?: Record<string, string> } }>();
    expect(body.error).toMatchObject({ code: "ledger/entry_not_reversible", params: { kind } });
    expect(await entries()).toEqual(before);
    expect(writeEvents()).toEqual([]);
  });

  test("reversing a credit below available is refused, naming the shortfall, and writes nothing", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).debit("alice", "chips", 60, "d1");
    const response = await post(app(), `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      ref: "c1",
      reason: "Granted in error",
    });
    expect(response.status).toBe(409);
    const body = await response.json<{ error: { code: string; params?: Record<string, number> } }>();
    expect(body.error).toMatchObject({
      code: "ledger/insufficient_funds",
      params: { amount: 100, available: 40, shortfall: 60 },
    });
    expect((await entries()).map((e) => e.ref)).toEqual(["c1", "d1"]);
    expect(writeEvents()).toEqual([]);
  });

  test("an entry on another account, or none at all, is not found", async () => {
    await openLedger(env.DB).credit("bob", "chips", 100, "bob-1");
    await openLedger(env.DB).credit("alice", "gold", 100, "gold-1");
    for (const ref of ["bob-1", "gold-1", "nothing"]) {
      const response = await post(app(), `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, { ref, reason: "x" });
      expect(response.status, ref).toBe(404);
      expect(await errorCode(response), ref).toBe("ledger/entry_not_found");
    }
    expect(await openLedger(env.DB).balance("bob", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    expect(writeEvents()).toEqual([]);
  });
});

describe("a ref the ledger derives is never a client's, and never a false replay", () => {
  const app = () => makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);

  /** An entry written straight into the log, as a release before reserved refs were refused could have. */
  async function legacyEntry(ref: string, userId: string) {
    await env.DB.prepare(
      "INSERT INTO pithy_ledger_transactions (ref, user_id, currency, kind, amount, related_ref, memo, created_at) VALUES (?, ?, 'chips', 'credit', 10, NULL, NULL, 0)",
    )
      .bind(ref, userId)
      .run();
  }

  test.each([
    ["credit", ":reverse"],
    ["credit", ":resolve"],
    ["debit", ":out"],
    ["debit", ":in"],
  ])("a %s whose ref ends in %s is refused before anything is written", async (act, suffix) => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    const response = await post(app(), `${ADMIN}/${act}`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 10,
      ref: `refund-7${suffix}`,
      reason: "Refund",
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
    expect((await entries()).map((e) => e.ref)).toEqual(["c1"]);
    expect(writeEvents()).toEqual([]);
  });

  test("a reversal whose ref an unrelated entry holds is a conflict, not 'already reversed'", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "refund-7");
    await legacyEntry("refund-7:reverse", "bob");
    const response = await post(app(), `${ADMIN}/reverse`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      ref: "refund-7",
      reason: "Granted in error",
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("ledger/ref_conflict");
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    expect(writeEvents()).toEqual([]);
  });

  test("a release whose ref an unrelated entry holds is a conflict, not 'already released'", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 40, "H");
    await legacyEntry("H:resolve", "bob");
    const response = await post(app(), `${ADMIN}/release`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      ref: "H",
      reason: "Table crashed",
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("ledger/ref_conflict");
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 40, available: 60 });
    expect(writeEvents()).toEqual([]);
  });
});

describe("POST /ledger/admin/accounts/:userId/:currency/release", () => {
  const app = () => makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);

  test("releases an open hold, with the reason on the release entry", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 40, "bet-1");
    const response = await post(app(), `${ADMIN}/release`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      ref: "bet-1",
      reason: "Table crashed mid-hand",
    });
    expect(response.status).toBe(200);
    expect(await response.json<AdjustmentBody>()).toMatchObject({
      ref: "bet-1:resolve",
      applied: true,
      held: 0,
      available: 100,
    });
    expect((await entries()).at(-1)).toMatchObject({
      ref: "bet-1:resolve",
      kind: "release",
      memo: "Table crashed mid-hand",
    });
  });

  test("a hold on another user or another currency is not found, and is never released", async () => {
    await openLedger(env.DB).credit("bob", "chips", 100, "c1");
    await openLedger(env.DB).hold("bob", "chips", 40, "bob-bet");
    await openLedger(env.DB).credit("alice", "gold", 100, "c2");
    await openLedger(env.DB).hold("alice", "gold", 40, "gold-bet");
    for (const ref of ["bob-bet", "gold-bet"]) {
      const response = await post(app(), `${ADMIN}/release`, LEDGER_ACCOUNTS_ADJUST_SCOPE, { ref, reason: "x" });
      expect(response.status, ref).toBe(404);
      expect(await errorCode(response), ref).toBe("ledger/hold_not_found");
    }
    expect((await openLedger(env.DB).balance("bob", "chips")).held).toBe(40);
    expect((await openLedger(env.DB).balance("alice", "gold")).held).toBe(40);
    expect(writeEvents()).toEqual([]);
  });

  test("a ref that is not an open hold is refused", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 40, "lost-bet");
    await openLedger(env.DB).capture("lost-bet");
    const notAHold = await post(app(), `${ADMIN}/release`, LEDGER_ACCOUNTS_ADJUST_SCOPE, { ref: "c1", reason: "x" });
    expect(notAHold.status).toBe(404);
    expect(await errorCode(notAHold)).toBe("ledger/hold_not_found");
    const captured = await post(app(), `${ADMIN}/release`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      ref: "lost-bet",
      reason: "x",
    });
    expect(captured.status).toBe(409);
    expect(await errorCode(captured)).toBe("ledger/hold_not_open");
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 60, held: 0, available: 60 });
    expect(writeEvents()).toEqual([]);
  });
});

describe("the audit event on a management write", () => {
  test("names the connection, the account, the act, the amount, the reason and the balance either side", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 30, "h1");
    await post(makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]), `${ADMIN}/debit`, LEDGER_ACCOUNTS_ADJUST_SCOPE, {
      amount: 20,
      ref: "fix-1",
      reason: "Payout paid twice",
    });
    expect(writeEvents()).toEqual([
      expect.objectContaining({
        action: "ledger/account_debited",
        outcome: "success",
        severity: "warning",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceType: "ledger_account",
        resourceId: "alice:chips",
        metadata: {
          connectionId: CONNECTION_ID,
          userId: "alice",
          currency: "chips",
          act: "debit",
          ref: "fix-1",
          entryRef: "fix-1",
          amount: 20,
          reason: "Payout paid twice",
          before: { balance: 100, held: 30, available: 70 },
          after: { balance: 80, held: 30, available: 50 },
        },
      }),
    ]);
  });

  test.each([
    ["credit", "ledger/account_credited", { amount: 5, ref: "w1", reason: "r" }, 5],
    ["reverse", "ledger/entry_reversed", { ref: "c1", reason: "r" }, 100],
    ["release", "ledger/hold_released", { ref: "h1", reason: "r" }, 30],
  ])("%s emits %s", async (act, action, body, amount) => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    if (act === "release") await openLedger(env.DB).hold("alice", "chips", 30, "h1");
    const response = await post(
      makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]),
      `${ADMIN}/${act}`,
      LEDGER_ACCOUNTS_ADJUST_SCOPE,
      body,
    );
    expect(response.status).toBe(200);
    const events = writeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action, severity: "warning", actorType: "control-plane" });
    expect(events[0]?.metadata).toMatchObject({ act, amount, reason: "r", connectionId: CONNECTION_ID });
  });
});

describe("the adjust scope is the only one that moves a balance", () => {
  test.each(["credit", "debit", "reverse", "release"])("%s refuses a connection without it", async (act) => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 10, "h1");
    const body =
      act === "reverse"
        ? { ref: "c1", reason: "x" }
        : act === "release"
          ? { ref: "h1", reason: "x" }
          : { amount: 5, ref: "w1", reason: "x" };
    // Every read the ledger has, granted and presented — and none of them confers a write.
    for (const scope of [LEDGER_ACCOUNTS_READ_SCOPE, LEDGER_TRANSACTIONS_READ_SCOPE]) {
      const app = makeApp([LEDGER_ACCOUNTS_READ_SCOPE, LEDGER_TRANSACTIONS_READ_SCOPE]);
      const response = await post(app, `${ADMIN}/${act}`, scope, body);
      expect(response.status, scope).toBe(403);
    }
    // A token naming the adjust scope against a connection never granted it.
    const ungranted = await post(
      makeApp([LEDGER_ACCOUNTS_READ_SCOPE]),
      `${ADMIN}/${act}`,
      LEDGER_ACCOUNTS_ADJUST_SCOPE,
      body,
    );
    expect(ungranted.status).toBe(403);
    expect(await openLedger(env.DB).balance("alice", "chips")).toEqual({ balance: 100, held: 10, available: 90 });
    expect(writeEvents()).toEqual([]);
  });

  test("the adjust scope reads nothing", async () => {
    const response = await call(
      makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]),
      "/ledger/admin/accounts",
      LEDGER_ACCOUNTS_ADJUST_SCOPE,
    );
    expect(response.status).toBe(403);
  });
});

describe("the write response schema against the live routes", () => {
  test("every write returns exactly its declared envelope", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "c1");
    await openLedger(env.DB).hold("alice", "chips", 10, "h1");
    const app = makeApp([LEDGER_ACCOUNTS_ADJUST_SCOPE]);
    for (const [act, body] of [
      ["credit", { amount: 5, ref: "w1", reason: "r" }],
      ["debit", { amount: 5, ref: "w2", reason: "r" }],
      ["reverse", { ref: "w2", reason: "r" }],
      ["release", { ref: "h1", reason: "r" }],
    ] as const) {
      const response = await post(app, `${ADMIN}/${act}`, LEDGER_ACCOUNTS_ADJUST_SCOPE, body);
      expect(response.status, act).toBe(200);
      const raw = await response.json();
      expect(LedgerAdjustmentResponse.parse(raw), act).toEqual(raw);
    }
  });
});
