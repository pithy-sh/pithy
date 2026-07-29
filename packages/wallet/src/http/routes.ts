import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError, InternalError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { resolveCurrency, type WalletConfig } from "../config/config";
import { WalletCurrencyNotFoundError } from "../error/errors";
import { ledger } from "../ledger/ledger";
import { AdminWrite, CurrencyParam } from "./schemas";

/**
 * The wallet routes, their declared verification strategies, and what each accepts. A player can always
 * read their *own* balance and history; **moving funds over HTTP is server-authoritative** and requires
 * the admin scope, because a wallet a client could credit itself is not a wallet:
 *
 *   GET  /wallet/:currency               → your balance                (bearer | session)                param: CurrencyParam
 *   GET  /wallet/:currency/transactions  → your recent ledger entries  (bearer | session)                param: CurrencyParam
 *   POST /wallet/:currency/credit        → add funds to a player       (bearer | session + admin scope)  param: CurrencyParam, json: AdminWrite
 *   POST /wallet/:currency/debit         → remove funds from a player  (bearer | session + admin scope)  param: CurrencyParam, json: AdminWrite
 *
 * Most balance movement happens in-process (a game model calling the {@link ledger} directly), not over
 * HTTP; these routes are the read surface players need plus a trusted-server admin surface. The user id
 * comes from the core `AuthContext` seam, never a request body — a read is always scoped to the caller.
 *
 * Validators sit **after** the guards on every route line: an unauthenticated or unscoped caller is
 * turned away before its payload is read, so a bad body can never downgrade a 401/403 to a 400. They sit
 * **before** the handler, which is why a malformed body on an *unconfigured* currency now answers 400
 * rather than 404 — the request is rejected as unparseable before the currency is ever resolved.
 */
export interface WalletRoutesOptions {
  config: WalletConfig;
  basePath?: string;
}

/** Require an authenticated caller (the core AuthContext seam). */
function requireAuth(): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth) {
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
      });
    }
    await next();
  };
}

/** Require the admin scope for a balance-moving write. */
function requireAdmin(scope: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    if (!c.var.auth?.scopes.includes(scope)) {
      throw new ForbiddenError({
        message: "This session may not move balances.",
        action: `Retry with a token carrying the ${scope} scope, minted for your trusted server.`,
        detail: `Wallet writes require the ${scope} scope; this session carries [${c.var.auth?.scopes.join(", ") ?? ""}].`,
      });
    }
    await next();
  };
}

function db(c: Context<PithyHonoEnv>): D1Database {
  const binding = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!binding) {
    throw new InternalError({
      message: "The wallet is not configured.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "Wallet requires a `DB` D1 binding; none was present on env.",
    });
  }
  return binding;
}

/** Reject a request whose `:currency` is not configured. */
function currency(config: WalletConfig, code: string): string {
  if (!resolveCurrency(config, code))
    throw new WalletCurrencyNotFoundError({ detail: `No currency "${code}" is configured.` });
  return code;
}

export function registerWalletRoutes(options: WalletRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/wallet";
  const { config } = options;

  /**
   * The caller's own id. `requireAuth()` has already run on every route that calls this, so a null
   * `auth` is a wiring mistake rather than an unauthenticated request — hence `InternalError`, not a
   * 401. Narrowing here rather than asserting non-null keeps the impossible case impossible to ignore.
   */
  const callerId = (c: Context<PithyHonoEnv>): string => {
    const auth = c.var.auth;
    if (!auth) {
      throw new InternalError({ detail: "requireAuth() must run before a wallet handler reads the caller." });
    }
    return auth.userId;
  };

  return (app) => {
    app.get(
      `${base}/:currency/transactions`,
      requireAuth(),
      zValidator("param", CurrencyParam, validationHook),
      async (c) => {
        const code = currency(config, c.req.valid("param").currency);
        const rows = await ledger(db(c)).transactions(callerId(c), code, 50);
        return c.json({ transactions: rows }, 200);
      },
    );

    app.get(`${base}/:currency`, requireAuth(), zValidator("param", CurrencyParam, validationHook), async (c) => {
      const code = currency(config, c.req.valid("param").currency);
      return c.json(await ledger(db(c)).balance(callerId(c), code), 200);
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
        const balance = await ledger(db(c)).credit(input.userId, code, input.amount, input.ref, { memo: input.memo });
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
        const balance = await ledger(db(c)).debit(input.userId, code, input.amount, input.ref, { memo: input.memo });
        return c.json(balance, 200);
      },
    );
  };
}
