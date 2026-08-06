// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { Context, Hono } from "hono";
import { listAccounts, listTransactions, readAccounts } from "../admin/read";
import { type LedgerAuditAction, LedgerAuditActions } from "../audit/actions";
import { type LedgerConfig, resolveCurrency } from "../config/config";
import { LedgerCurrencyNotFoundError } from "../error/errors";
import { openLedger } from "../ledger";
import { LEDGER_ACCOUNTS_READ_SCOPE, LEDGER_TRANSACTIONS_READ_SCOPE, requireAdmin, requireAuth } from "./guards";
import type { LedgerAccountsResponse, LedgerTransactionsResponse, LedgerUserAccountsResponse } from "./responses";
import {
  AdminAccountParam,
  AdminAccountsQuery,
  AdminTransactionsQuery,
  AdminUserParam,
  AdminWrite,
  CurrencyParam,
} from "./schemas";
import { accountView, transactionView } from "./view";

/**
 * The ledger routes, their declared verification strategies, and what each accepts. A player can always
 * read their *own* balance and history; **moving funds over HTTP is server-authoritative** and requires
 * the admin scope, because a ledger a client could credit itself is not a ledger; and a management
 * client reads across every player through the control-plane seam:
 *
 *   GET  /ledger/:currency                                     → your balance                (bearer | session)                param: CurrencyParam
 *   GET  /ledger/:currency/transactions                        → your recent ledger entries  (bearer | session)                param: CurrencyParam
 *   POST /ledger/:currency/credit                              → add funds to a player       (bearer | session + admin scope)  param: CurrencyParam, json: AdminWrite
 *   POST /ledger/:currency/debit                               → remove funds from a player  (bearer | session + admin scope)  param: CurrencyParam, json: AdminWrite
 *   GET  /ledger/admin/accounts                                → every account, paged        (control-plane: ledger:accounts:read)      query: AdminAccountsQuery
 *   GET  /ledger/admin/accounts/:userId                        → one player's balances       (control-plane: ledger:accounts:read)      param: AdminUserParam
 *   GET  /ledger/admin/accounts/:userId/:currency/transactions → one account's entry log     (control-plane: ledger:transactions:read)  param: AdminAccountParam, query: AdminTransactionsQuery
 *
 * Most balance movement happens in-process (a game model calling {@link openLedger} directly), not over
 * HTTP; these routes are the read surface players need, a trusted-server admin surface, and a read-only
 * management surface. The user id on a player route comes from the core `AuthContext` seam, never a
 * request body — a player's read is always scoped to the caller.
 *
 * ## The management surface is read-only, deliberately
 *
 * There is no `POST /admin/adjust`. Writing to a balance ledger from an admin console needs everything
 * every other movement gets — an idempotency key so a double-click does not pay twice, a recorded
 * reason, a reversal path — and a console route with none of those would be the one place the ledger's
 * guarantees do not hold. So the seam reads and nothing else: balances, and the entries that explain
 * them.
 *
 * ## Why the management routes sit under `admin/`
 *
 * `${base}/:currency` claims the entire one-segment space beneath the mount point, so a management route
 * at `${base}/accounts` would be ambiguous with a currency called `accounts` and would sit behind
 * whichever of the two Hono matched first — a route's gate decided by registration order. The extra
 * static segment makes the two sets disjoint by construction: `${base}/admin/accounts` cannot collide
 * with `${base}/:currency` (two segments against three) nor with `${base}/:currency/transactions` (the
 * last segment differs), and the deeper ones are longer than anything the player surface mounts.
 *
 * ## `requireAuth()` is never on a management route
 *
 * The seam deliberately leaves `c.var.auth` null, so an auth gate on a control-plane route would deny
 * every legitimate management call permanently and no credential could fix it. `requireControlPlane`
 * **replaces** `requireAuth()` and `requireAdmin()` on those lines; it does not stack with them. See
 * `guards.ts` for the whole argument.
 *
 * Validators sit **after** the guards on every route line: an unauthenticated, unscoped, or unverified
 * caller is turned away before its payload is read, so a bad request can never downgrade a 401/403 to a
 * 400 and tell a caller with no credential which requests were well-formed. They sit **before** the
 * handler, which is why a malformed request on an *unconfigured* currency answers 400 rather than 404 —
 * the request is rejected as unparseable before the currency is ever resolved.
 */

/**
 * Where the ledger mounts when an adopter names nothing.
 *
 * Exported because two places must agree on it: the router below, and `ledgerAdminRoutes` in
 * `capability.ts`. A default living only in the registrar would let the manifest advertise `/ledger/...`
 * while the routes mounted somewhere else, and a management client composing its calls from the
 * manifest would 404 with nothing to diagnose.
 */
export const LEDGER_DEFAULT_BASE_PATH = "/ledger";

/**
 * What every route this capability mounts declares: its path, its verification strategy, and the
 * control-plane scope it checks when it has one.
 *
 * **Exported so a test can assert against the declaration rather than against a middleware count.**
 * Counting middleware proves that *something* runs before the handler; it cannot prove *what*, and a
 * bare `zValidator` satisfies a count. `routeContract.test.ts` checks this list against the routes Hono
 * actually registered in both directions, so a route added without an entry and an entry naming a route
 * nobody mounts both fail.
 */
export interface LedgerRouteDeclaration {
  readonly method: "GET" | "POST";
  /** The path relative to the configured `basePath`, e.g. `/admin/accounts`. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The control-plane scope this route checks, for a `control-plane` route. */
  readonly scope?: ControlPlaneScope;
}

/** Every route, and how it is gated. */
export const LEDGER_ROUTES: readonly LedgerRouteDeclaration[] = [
  { method: "GET", path: "/:currency", strategy: "bearer" },
  { method: "GET", path: "/:currency/transactions", strategy: "bearer" },
  { method: "POST", path: "/:currency/credit", strategy: "bearer" },
  { method: "POST", path: "/:currency/debit", strategy: "bearer" },
  { method: "GET", path: "/admin/accounts", strategy: "control-plane", scope: LEDGER_ACCOUNTS_READ_SCOPE },
  { method: "GET", path: "/admin/accounts/:userId", strategy: "control-plane", scope: LEDGER_ACCOUNTS_READ_SCOPE },
  {
    method: "GET",
    path: "/admin/accounts/:userId/:currency/transactions",
    strategy: "control-plane",
    scope: LEDGER_TRANSACTIONS_READ_SCOPE,
  },
];

export interface LedgerRoutesOptions {
  config: LedgerConfig;
  basePath?: string;
}

function db(c: Context<PithyHonoEnv>): D1Database {
  const binding = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!binding) {
    throw new InternalError({
      message: "The ledger is not configured.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "Ledger requires a `DB` D1 binding; none was present on env.",
    });
  }
  return binding;
}

/** Reject a request whose currency is not configured. */
function currency(config: LedgerConfig, code: string): string {
  if (!resolveCurrency(config, code))
    throw new LedgerCurrencyNotFoundError({ detail: `No currency "${code}" is configured.` });
  return code;
}

/**
 * The verified management client behind a control-plane call.
 *
 * `requireControlPlane()` has run on every route that calls this, so `c.var.controlPlane` is populated
 * by the time a handler reads it. The throw is a programming-error guard rather than a runtime path:
 * reaching it would mean a management route was mounted without its gate, which is the one mistake this
 * file is arranged to make impossible.
 */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({
      message: "The ledger could not identify the management caller.",
      detail: "requireControlPlane() must run before a ledger management handler reads the caller.",
    });
  }
  return context;
}

/**
 * Record a management read.
 *
 * **Every read, not only writes.** There are no writes on this surface, so an unaudited one would leave
 * the capability's whole management history blank — and a credential quietly paging every player's
 * balance history is exactly the thing that leaves no other trace. Counts and identifiers only: no
 * balance, no `ref`, no memo. Copying the ledger into the audit trail would make a second ledger with
 * weaker access rules than the first.
 */
async function record(
  c: Context<PithyHonoEnv>,
  action: LedgerAuditAction,
  resourceId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  const who = caller(c);
  await c.var.emit({
    action,
    outcome: "success",
    actorType: "control-plane",
    actorId: who.subject,
    resourceType: "ledger_account",
    resourceId,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: { connectionId: who.connectionId, ...metadata },
  });
}

export function registerLedgerRoutes(options: LedgerRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? LEDGER_DEFAULT_BASE_PATH;
  const { config } = options;

  /**
   * The caller's own id. `requireAuth()` has already run on every route that calls this, so a null
   * `auth` is a wiring mistake rather than an unauthenticated request — hence `InternalError`, not a
   * 401. Narrowing here rather than asserting non-null keeps the impossible case impossible to ignore.
   */
  const callerId = (c: Context<PithyHonoEnv>): string => {
    const auth = c.var.auth;
    if (!auth) {
      throw new InternalError({ detail: "requireAuth() must run before a ledger handler reads the caller." });
    }
    return auth.userId;
  };

  return (app) => {
    // The management surface: control-plane, read-only. Its paths are disjoint from the player routes
    // by construction, so registering it first is presentation rather than semantics.

    app.get(
      `${base}/admin/accounts`,
      requireControlPlane(LEDGER_ACCOUNTS_READ_SCOPE),
      zValidator("query", AdminAccountsQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        // A currency filter is still config-backed resolution: an operator who mistypes one gets the
        // capability's own 404 rather than an empty pane they would read as "nobody holds any".
        const code = query.currency === undefined ? undefined : currency(config, query.currency);
        const page = await listAccounts(db(c), { ...query, currency: code });
        await record(c, LedgerAuditActions.accountsListed, null, {
          currency: code ?? null,
          returned: page.items.length,
          resumed: query.cursor !== undefined,
        });
        return c.json(
          { accounts: page.items.map(accountView), nextCursor: page.nextCursor } satisfies LedgerAccountsResponse,
          200,
        );
      },
    );

    app.get(
      `${base}/admin/accounts/:userId`,
      requireControlPlane(LEDGER_ACCOUNTS_READ_SCOPE),
      zValidator("param", AdminUserParam, validationHook),
      async (c) => {
        const { userId } = c.req.valid("param");
        const accounts = await readAccounts(db(c), userId);
        await record(c, LedgerAuditActions.accountRead, userId, { userId, returned: accounts.length });
        // A player with no account is an empty list, not a 404 — the honest answer, since an account is
        // opened by its first credit and its absence is not a missing player. It also keeps this surface
        // from being an existence oracle for user ids.
        return c.json({ userId, accounts: accounts.map(accountView) } satisfies LedgerUserAccountsResponse, 200);
      },
    );

    app.get(
      `${base}/admin/accounts/:userId/:currency/transactions`,
      requireControlPlane(LEDGER_TRANSACTIONS_READ_SCOPE),
      zValidator("param", AdminAccountParam, validationHook),
      zValidator("query", AdminTransactionsQuery, validationHook),
      async (c) => {
        const { userId, currency: requested } = c.req.valid("param");
        const code = currency(config, requested);
        const query = c.req.valid("query");
        const page = await listTransactions(db(c), userId, code, query);
        await record(c, LedgerAuditActions.transactionsRead, `${userId}:${code}`, {
          userId,
          currency: code,
          returned: page.items.length,
          resumed: query.cursor !== undefined,
        });
        return c.json(
          {
            userId,
            currency: code,
            transactions: page.items.map(transactionView),
            nextCursor: page.nextCursor,
          } satisfies LedgerTransactionsResponse,
          200,
        );
      },
    );

    // The player surface: bearer or session, always scoped to the caller.

    app.get(
      `${base}/:currency/transactions`,
      requireAuth(),
      zValidator("param", CurrencyParam, validationHook),
      async (c) => {
        const code = currency(config, c.req.valid("param").currency);
        const rows = await openLedger(db(c)).transactions(callerId(c), code, 50);
        return c.json({ transactions: rows }, 200);
      },
    );

    app.get(`${base}/:currency`, requireAuth(), zValidator("param", CurrencyParam, validationHook), async (c) => {
      const code = currency(config, c.req.valid("param").currency);
      return c.json(await openLedger(db(c)).balance(callerId(c), code), 200);
    });

    app.post(
      `${base}/:currency/credit`,
      requireAuth(),
      requireAdmin(config.adminScope),
      zValidator("param", CurrencyParam, validationHook),
      zValidator("json", AdminWrite, validationHook),
      async (c) => {
        const code = currency(config, c.req.valid("param").currency);
        const input = c.req.valid("json");
        const balance = await openLedger(db(c)).credit(input.userId, code, input.amount, input.ref, {
          memo: input.memo,
        });
        return c.json(balance, 200);
      },
    );

    app.post(
      `${base}/:currency/debit`,
      requireAuth(),
      requireAdmin(config.adminScope),
      zValidator("param", CurrencyParam, validationHook),
      zValidator("json", AdminWrite, validationHook),
      async (c) => {
        const code = currency(config, c.req.valid("param").currency);
        const input = c.req.valid("json");
        const balance = await openLedger(db(c)).debit(input.userId, code, input.amount, input.ref, {
          memo: input.memo,
        });
        return c.json(balance, 200);
      },
    );
  };
}
