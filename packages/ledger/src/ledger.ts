import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type CompiledQuery, sql } from "kysely";
import type { Balance } from "./data/account";
import { LEDGER_ACCOUNTS_TABLE, LEDGER_HOLDS_TABLE, LEDGER_TRANSACTIONS_TABLE, ledgerDatabase } from "./data/tables";
import { LedgerTransaction } from "./data/transaction";
import {
  LedgerHoldNotFoundError,
  LedgerHoldNotOpenError,
  LedgerInsufficientFundsError,
  LedgerInvalidAmountError,
} from "./error/errors";

/**
 * The ledger — every balance movement, made correct by the database rather than by hope.
 *
 * Three invariants hold no matter how operations interleave or how many times they are delivered:
 *
 * - **Atomic.** Each operation is a single `DB.batch`, which D1 runs as one transaction: the ledger entry
 *   and the balance change commit together or not at all. The statements are built with Kysely (so
 *   `CamelCasePlugin` owns the snake_case columns — no hand-written SQL identifiers) and compiled to D1
 *   prepared statements; only the `batch()` call itself is D1-native, because Kysely has no equivalent for
 *   D1's transaction primitive.
 * - **Idempotent.** Every operation carries a caller-supplied `ref`, written as a `UNIQUE` ledger row. A
 *   replay inserts a duplicate `ref`, which aborts the batch; the operation catches that and returns the
 *   current balance unchanged. A payout delivered twice pays once.
 * - **Overdraft-safe.** A debit or hold is applied by an `UPDATE` guarded by the account's `CHECK (balance
 *   >= 0 AND held >= 0 AND held <= balance)`. If the movement would break solvency — even against a balance
 *   another concurrent operation just lowered — the `CHECK` aborts the batch, and the operation surfaces
 *   `ledger/insufficient_funds`. The guard is in SQLite, so no race can slip past it.
 *
 * This runs in-process (a game model, a trusted server handler) against the `DB` binding — the ledger is a
 * server-authoritative primitive, not a client-facing API.
 */
export interface Ledger {
  /** A player's position in a currency. Zero across the board when they have no account yet. */
  balance(userId: string, currency: string): Promise<Balance>;
  /** Add funds (a grant, a reward, a buy-in, a payout). Opens the account if needed. */
  credit(userId: string, currency: string, amount: number, ref: string, options?: { memo?: string }): Promise<Balance>;
  /** Remove funds. Fails `insufficient_funds` if the available balance cannot cover it. */
  debit(userId: string, currency: string, amount: number, ref: string, options?: { memo?: string }): Promise<Balance>;
  /** Move funds between two players atomically (a pot payout, a table settle-up). */
  transfer(
    from: string,
    to: string,
    currency: string,
    amount: number,
    ref: string,
    options?: { memo?: string },
  ): Promise<void>;
  /** Reserve funds for a pending wager. `ref` identifies the hold, for later release or capture. */
  hold(userId: string, currency: string, amount: number, ref: string): Promise<Balance>;
  /** Cancel a hold, returning the reserved funds to the player. Idempotent; refuses a resolved hold. */
  release(holdRef: string): Promise<Balance>;
  /** Finalize a hold: spend `amount` of it (default: all), returning any remainder. Idempotent. */
  capture(holdRef: string, options?: { amount?: number; memo?: string }): Promise<Balance>;
  /** A player's recent ledger entries in a currency, newest first. */
  transactions(userId: string, currency: string, limit: number): Promise<LedgerTransaction[]>;
}

/** A positive integer in a currency's minor unit — the only kind of amount the ledger accepts. */
function assertAmount(amount: number, context: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new LedgerInvalidAmountError({ detail: `${context}: amount ${amount} is not a positive integer.` });
  }
}

/** Whether a D1 error is a specific constraint violation — how the batch's abort is classified. */
function isViolation(error: unknown, constraint: "UNIQUE" | "CHECK"): boolean {
  return new RegExp(`${constraint} constraint failed`, "i").test(
    String((error as { message?: unknown })?.message ?? ""),
  );
}

export function openLedger(d1: D1Database, now: () => number = () => Date.now()): Ledger {
  const db = ledgerDatabase(d1);
  /** Compile a Kysely query to a D1 prepared statement, so it can join a `DB.batch` transaction. */
  const prepared = (query: { compile(): CompiledQuery }): D1PreparedStatement => {
    const compiled = query.compile();
    return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
  };

  const ensureAccount = (userId: string, currency: string, at: number) =>
    db
      .insertInto(LEDGER_ACCOUNTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
      .values({ userId, currency, balance: 0, held: 0, createdAt: at, updatedAt: at } as any)
      .onConflict((oc) => oc.columns(["userId", "currency"]).doNothing());

  const entry = (
    ref: string,
    userId: string,
    currency: string,
    kind: string,
    amount: number,
    relatedRef: string | null,
    memo: string | null,
    at: number,
  ) =>
    db
      .insertInto(LEDGER_TRANSACTIONS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: as above — the encoded row is the z.input side.
      .values({ ref, userId, currency, kind, amount, relatedRef, memo, createdAt: at } as any);

  const adjust = (userId: string, currency: string, set: Record<string, unknown>, at: number) =>
    db
      .updateTable(LEDGER_ACCOUNTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: `set` mixes column values and `sql` fragments (balance ± amount).
      .set({ ...set, updatedAt: at } as any)
      .where("userId", "=", userId)
      .where("currency", "=", currency);

  const readBalance = async (userId: string, currency: string): Promise<Balance> => {
    const row = await db
      .selectFrom(LEDGER_ACCOUNTS_TABLE)
      .select(["balance", "held"])
      .where("userId", "=", userId)
      .where("currency", "=", currency)
      .executeTakeFirst();
    if (!row) return { balance: 0, held: 0, available: 0 };
    return { balance: row.balance, held: row.held, available: row.balance - row.held };
  };

  /** Run a funding batch; a UNIQUE abort is an idempotent replay, a CHECK abort is insolvency. */
  const applyFunding = async (
    statements: D1PreparedStatement[],
    userId: string,
    currency: string,
    insufficientDetail: string,
  ): Promise<Balance> => {
    try {
      await d1.batch(statements);
    } catch (error) {
      if (isViolation(error, "UNIQUE")) return readBalance(userId, currency); // replay → no-op
      if (isViolation(error, "CHECK"))
        throw new LedgerInsufficientFundsError({ detail: insufficientDetail }, { cause: error });
      throw error;
    }
    return readBalance(userId, currency);
  };

  return {
    balance: readBalance,

    async credit(userId, currency, amount, ref, options) {
      assertAmount(amount, "credit");
      const at = now();
      const statements = [
        prepared(ensureAccount(userId, currency, at)),
        prepared(entry(ref, userId, currency, "credit", amount, null, options?.memo ?? null, at)),
        prepared(adjust(userId, currency, { balance: sql`balance + ${amount}` }, at)),
      ];
      return applyFunding(statements, userId, currency, "");
    },

    async debit(userId, currency, amount, ref, options) {
      assertAmount(amount, "debit");
      const at = now();
      const statements = [
        prepared(ensureAccount(userId, currency, at)),
        prepared(entry(ref, userId, currency, "debit", amount, null, options?.memo ?? null, at)),
        prepared(adjust(userId, currency, { balance: sql`balance - ${amount}` }, at)),
      ];
      return applyFunding(
        statements,
        userId,
        currency,
        `debit of ${amount} ${currency} for ${userId} exceeds available balance`,
      );
    },

    async transfer(from, to, currency, amount, ref, options) {
      assertAmount(amount, "transfer");
      const at = now();
      const statements = [
        prepared(ensureAccount(from, currency, at)),
        prepared(ensureAccount(to, currency, at)),
        prepared(entry(`${ref}:out`, from, currency, "transfer_out", amount, `${ref}:in`, options?.memo ?? null, at)),
        prepared(entry(`${ref}:in`, to, currency, "transfer_in", amount, `${ref}:out`, options?.memo ?? null, at)),
        prepared(adjust(from, currency, { balance: sql`balance - ${amount}` }, at)),
        prepared(adjust(to, currency, { balance: sql`balance + ${amount}` }, at)),
      ];
      try {
        await d1.batch(statements);
      } catch (error) {
        if (isViolation(error, "UNIQUE")) return; // replay → no-op
        if (isViolation(error, "CHECK"))
          throw new LedgerInsufficientFundsError(
            { detail: `transfer of ${amount} ${currency} from ${from} exceeds available balance` },
            { cause: error },
          );
        throw error;
      }
    },

    async hold(userId, currency, amount, ref) {
      assertAmount(amount, "hold");
      const at = now();
      const statements = [
        prepared(ensureAccount(userId, currency, at)),
        prepared(entry(ref, userId, currency, "hold", amount, null, null, at)),
        prepared(
          db
            .insertInto(LEDGER_HOLDS_TABLE)
            // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
            .values({ ref, userId, currency, amount, status: "open", createdAt: at, resolvedAt: null } as any),
        ),
        prepared(adjust(userId, currency, { held: sql`held + ${amount}` }, at)),
      ];
      return applyFunding(
        statements,
        userId,
        currency,
        `hold of ${amount} ${currency} for ${userId} exceeds available balance`,
      );
    },

    async release(holdRef) {
      const hold = await requireOpenHold(db, holdRef);
      const at = now();
      const statements = [
        // One resolution per hold, whichever wins the race — the `:resolve` ref is unique.
        prepared(entry(`${holdRef}:resolve`, hold.userId, hold.currency, "release", hold.amount, holdRef, null, at)),
        prepared(
          db
            .updateTable(LEDGER_HOLDS_TABLE)
            .set({ status: "released", resolvedAt: at })
            .where("ref", "=", holdRef)
            .where("status", "=", "open"),
        ),
        prepared(adjust(hold.userId, hold.currency, { held: sql`held - ${hold.amount}` }, at)),
      ];
      return resolveHold(d1, statements, hold.userId, hold.currency, readBalance);
    },

    async capture(holdRef, options) {
      const hold = await requireOpenHold(db, holdRef);
      const captured = options?.amount ?? hold.amount;
      if (!Number.isInteger(captured) || captured < 0 || captured > hold.amount) {
        throw new LedgerInvalidAmountError({
          detail: `capture of ${captured} exceeds the ${hold.amount} held on ${holdRef}`,
        });
      }
      const at = now();
      const statements = [
        prepared(
          entry(
            `${holdRef}:resolve`,
            hold.userId,
            hold.currency,
            "capture",
            captured,
            holdRef,
            options?.memo ?? null,
            at,
          ),
        ),
        prepared(
          db
            .updateTable(LEDGER_HOLDS_TABLE)
            .set({ status: "captured", resolvedAt: at })
            .where("ref", "=", holdRef)
            .where("status", "=", "open"),
        ),
        // Release the whole reservation from `held`, and spend the captured part from `balance`.
        prepared(
          adjust(
            hold.userId,
            hold.currency,
            { held: sql`held - ${hold.amount}`, balance: sql`balance - ${captured}` },
            at,
          ),
        ),
      ];
      return resolveHold(d1, statements, hold.userId, hold.currency, readBalance);
    },

    async transactions(userId, currency, limit) {
      const rows = await db
        .selectFrom(LEDGER_TRANSACTIONS_TABLE)
        .selectAll()
        .where("userId", "=", userId)
        .where("currency", "=", currency)
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map((row) => LedgerTransaction.parse(row));
    },
  };
}

/** The open hold with this ref, or a typed error — the pre-check that turns a bad-state resolution into a clean 404/409. */
async function requireOpenHold(
  db: ReturnType<typeof ledgerDatabase>,
  ref: string,
): Promise<{ userId: string; currency: string; amount: number }> {
  const row = await db
    .selectFrom(LEDGER_HOLDS_TABLE)
    .select(["userId", "currency", "amount", "status"])
    .where("ref", "=", ref)
    .executeTakeFirst();
  if (!row) throw new LedgerHoldNotFoundError({ detail: `No hold with ref ${ref}.` });
  if (row.status !== "open") throw new LedgerHoldNotOpenError({ detail: `Hold ${ref} is ${row.status}.` });
  return { userId: row.userId, currency: row.currency, amount: row.amount };
}

/** Run a hold-resolution batch; a UNIQUE abort means another resolution already won the race — a no-op. */
async function resolveHold(
  d1: D1Database,
  statements: D1PreparedStatement[],
  userId: string,
  currency: string,
  readBalance: (u: string, c: string) => Promise<Balance>,
): Promise<Balance> {
  try {
    await d1.batch(statements);
  } catch (error) {
    if (isViolation(error, "UNIQUE")) return readBalance(userId, currency); // already resolved → no-op
    throw error;
  }
  return readBalance(userId, currency);
}
