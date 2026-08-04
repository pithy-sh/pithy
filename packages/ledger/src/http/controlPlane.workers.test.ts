// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/http/verify";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { LedgerConfig } from "../config/config";
import { openLedger } from "../ledger";
import { ledger_0001_accounts } from "../migrations/0001_accounts";
import { LEDGER_ACCOUNTS_READ_SCOPE, LEDGER_TRANSACTIONS_READ_SCOPE } from "./guards";
import { registerLedgerRoutes } from "./routes";

/**
 * The management handlers, actually executed.
 *
 * `routeContract.test.ts` calls each of these with no credential and asserts 403, which proves the guard
 * runs and nothing else — every handler body is unreached there. What survives only here: the keyset
 * pagination (an offset would pass every test that never fetches a second page), the response
 * projections, the 404 on an unconfigured currency filter, and the audit event on a read. A guard
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

describe("the management surface cannot move a balance", () => {
  test("no verb but GET answers under admin/", async () => {
    // There is no adjustment route, on purpose. If one is ever added it must arrive with an idempotency
    // key, a recorded reason, and a reversal path — this fails the moment one arrives without them.
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
