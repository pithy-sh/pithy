import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ForbiddenError, fromZodError, InternalError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { resolveCurrency, type WalletConfig } from "../config/config";
import { WalletCurrencyNotFoundError } from "../error/errors";
import { ledger } from "../ledger/ledger";

/**
 * The wallet routes and their declared verification strategies. A player can always read their *own*
 * balance and history; **moving funds over HTTP is server-authoritative** and requires the admin scope,
 * because a wallet a client could credit itself is not a wallet:
 *
 *   GET  /wallet/:currency               → your balance                (bearer | session)
 *   GET  /wallet/:currency/transactions  → your recent ledger entries  (bearer | session)
 *   POST /wallet/:currency/credit        → add funds to a player       (bearer | session + admin scope)
 *   POST /wallet/:currency/debit         → remove funds from a player  (bearer | session + admin scope)
 *
 * Most balance movement happens in-process (a game model calling the {@link ledger} directly), not over
 * HTTP; these routes are the read surface players need plus a trusted-server admin surface. The user id
 * comes from the core `AuthContext` seam, never a request body — a read is always scoped to the caller.
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

const AdminWrite = z
  .object({
    userId: z.string().min(1).describe("The player whose balance moves."),
    amount: z.number().int().positive().describe("A positive integer in the currency's minor unit."),
    ref: z.string().min(1).describe("A unique idempotency key — a replay with the same ref is a no-op."),
    memo: z.string().optional().describe("An optional human-readable note."),
  })
  .describe("An admin credit/debit request.");

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

  const body = async <S extends z.ZodType>(c: Context<PithyHonoEnv>, schema: S): Promise<z.output<S>> => {
    const result = schema.safeParse(await c.req.json().catch(() => undefined));
    if (!result.success) throw fromZodError(result.error);
    return result.data;
  };

  return (app) => {
    app.get(`${base}/:currency/transactions`, requireAuth(), async (c) => {
      const code = currency(config, c.req.param("currency"));
      const rows = await ledger(db(c)).transactions(callerId(c), code, 50);
      return c.json({ transactions: rows }, 200);
    });

    app.get(`${base}/:currency`, requireAuth(), async (c) => {
      const code = currency(config, c.req.param("currency"));
      return c.json(await ledger(db(c)).balance(callerId(c), code), 200);
    });

    app.post(`${base}/:currency/credit`, requireAuth(), requireAdmin(config.adminScope), async (c) => {
      const code = currency(config, c.req.param("currency"));
      const input = await body(c, AdminWrite);
      const balance = await ledger(db(c)).credit(input.userId, code, input.amount, input.ref, { memo: input.memo });
      return c.json(balance, 200);
    });

    app.post(`${base}/:currency/debit`, requireAuth(), requireAdmin(config.adminScope), async (c) => {
      const code = currency(config, c.req.param("currency"));
      const input = await body(c, AdminWrite);
      const balance = await ledger(db(c)).debit(input.userId, code, input.amount, input.ref, { memo: input.memo });
      return c.json(balance, 200);
    });
  };
}
