// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type CompiledQuery, sql } from "kysely";
import type { Balance } from "./data/account";
import { LEDGER_ACCOUNTS_TABLE, LEDGER_HOLDS_TABLE, LEDGER_TRANSACTIONS_TABLE, ledgerDatabase } from "./data/tables";
import { LedgerTransaction, type TransactionKind } from "./data/transaction";
import {
  LedgerEntryNotFoundError,
  LedgerEntryNotReversibleError,
  LedgerHoldNotFoundError,
  LedgerHoldNotOpenError,
  LedgerInsufficientFundsError,
  LedgerInvalidAmountError,
  LedgerRefConflictError,
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
 * **Nothing is ever updated or deleted in the entry log, a correction included.** A reversal is a new
 * entry: the opposite movement, carrying the original's ref as its `relatedRef`, under the ref
 * `${ref}:reverse`. That ref is unique the way a hold's `${holdRef}:resolve` is, so a second reversal of
 * one entry fails at the database rather than at a read two callers could both pass.
 *
 * This runs in-process (a game model, a trusted server handler) against the `DB` binding — the ledger is a
 * server-authoritative primitive, not a client-facing API.
 */
export interface Ledger {
  /** A player's position in a currency. Zero across the board when they have no account yet. */
  balance(userId: string, currency: string): Promise<Balance>;
  /** Add funds (a grant, a reward, a buy-in, a payout). Opens the account if needed. */
  credit(userId: string, currency: string, amount: number, ref: string, options?: { memo?: string }): Promise<Balance>;
  /** Remove funds. Fails `insufficient_funds`, naming the shortfall, if the available balance cannot cover it. */
  debit(userId: string, currency: string, amount: number, ref: string, options?: { memo?: string }): Promise<Balance>;
  /**
   * Post the opposite of a credit or a debit, as a new entry `${ref}:reverse` whose `relatedRef` is `ref`.
   * The original stays. Idempotent: a second reversal of one entry moves nothing. Refuses any other kind,
   * and a reversal of a reversal, with `ledger/entry_not_reversible`; refuses reversing a credit the
   * account can no longer cover with `ledger/insufficient_funds`, naming the shortfall; refuses with
   * `ledger/ref_conflict` when an unrelated entry already holds `${ref}:reverse`, rather than calling it a replay.
   */
  reverse(ref: string, options?: { memo?: string }): Promise<Balance>;
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
  release(holdRef: string, options?: { memo?: string }): Promise<Balance>;
  /** Finalize a hold: spend `amount` of it (default: all), returning any remainder. Idempotent. */
  capture(holdRef: string, options?: { amount?: number; memo?: string }): Promise<Balance>;
  /** A player's recent ledger entries in a currency, newest first. */
  transactions(userId: string, currency: string, limit: number): Promise<LedgerTransaction[]>;
}

/** One account, by the key the accounts table is on. */
export interface LedgerAccountKey {
  userId: string;
  currency: string;
}

/**
 * What one write did: whether it moved anything, and the account on either side of it.
 *
 * `after` is read **inside the write's own transaction**, so it is exactly the state the write left, and
 * `before` is that minus the write's own movement — a pair that differs by this write and nothing else,
 * however many other movements land around it. On a replay nothing moved, `applied` is false, and both
 * are the balance as it stands.
 */
export interface LedgerWriteOutcome {
  /** False when this write already happened under its ref — a replay, or a race another call of it won. Nothing moved. */
  applied: boolean;
  /** The account just before this write's movement. */
  before: Balance;
  /** The account just after it. */
  after: Balance;
}

/** A reversal's outcome, with the entry it reversed. */
export interface LedgerReversalOutcome extends LedgerWriteOutcome {
  /** The original entry — what was reversed, on whose account, by how much. */
  entry: { ref: string; userId: string; currency: string; kind: "credit" | "debit"; amount: number };
}

/** A release's outcome, with the hold it released. */
export interface LedgerReleaseOutcome extends LedgerWriteOutcome {
  /** The hold — whose funds it reserved, and how much went back to `available`. */
  hold: { ref: string; userId: string; currency: string; amount: number };
}

/**
 * The writes a management surface makes, each answering with what it did rather than only where the
 * balance ended up. An audit event needs the difference between "moved" and "was already moved", and
 * the balance on both sides of the movement — and neither can be reconstructed from a balance read
 * after the fact without a race.
 *
 * Every invariant {@link Ledger} keeps holds here: these are the same statements in the same batches.
 * What is added is `account`, on the two writes that take a ref rather than an account: the entry or
 * hold must be on that account, or it is not found — so a route that names an account in its path can
 * never reach past it.
 *
 * `release` here treats an already-released hold as a replay, since its ref is the hold's own: the hold
 * is in the state asked for, and nothing moves. A captured hold is still refused, and so is a ref that is
 * no hold at all.
 */
export interface LedgerWrites {
  credit(
    userId: string,
    currency: string,
    amount: number,
    ref: string,
    options?: { memo?: string },
  ): Promise<LedgerWriteOutcome>;
  debit(
    userId: string,
    currency: string,
    amount: number,
    ref: string,
    options?: { memo?: string },
  ): Promise<LedgerWriteOutcome>;
  reverse(ref: string, options?: { memo?: string; account?: LedgerAccountKey }): Promise<LedgerReversalOutcome>;
  release(holdRef: string, options?: { memo?: string; account?: LedgerAccountKey }): Promise<LedgerReleaseOutcome>;
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

/** A balance from the two stored columns — `available` is always computed, never stored. */
function toBalance(row: { balance: number; held: number }): Balance {
  return { balance: row.balance, held: row.held, available: row.balance - row.held };
}

/** How a write moves an account: the signed change to each stored column. */
interface Movement {
  balance: number;
  held: number;
}

/**
 * The refusal for a movement the account cannot cover, naming the shortfall.
 *
 * Read after the abort, so the numbers are the account as the refusal found it. `params` carries them to
 * a client, which can render "30 short" in its own words; `detail` carries them to the log.
 */
function shortfall(
  act: string,
  account: LedgerAccountKey,
  amount: number,
  current: Balance,
  cause: unknown,
): LedgerInsufficientFundsError {
  const short = Math.max(amount - current.available, 0);
  return new LedgerInsufficientFundsError(
    {
      detail: `${act} of ${amount} ${account.currency} for ${account.userId} exceeds the ${current.available} available, ${short} short.`,
      params: { amount, available: current.available, shortfall: short },
    },
    { cause },
  );
}

/** The statements, readers and batch runner every ledger operation is built from. */
function ledgerCore(d1: D1Database, now: () => number) {
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
    kind: TransactionKind,
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

  const selectBalance = (account: LedgerAccountKey) =>
    db
      .selectFrom(LEDGER_ACCOUNTS_TABLE)
      .select(["balance", "held"])
      .where("userId", "=", account.userId)
      .where("currency", "=", account.currency);

  const readBalance = async (userId: string, currency: string): Promise<Balance> => {
    const row = await selectBalance({ userId, currency }).executeTakeFirst();
    return row ? toBalance(row) : { balance: 0, held: 0, available: 0 };
  };

  /**
   * Run one operation's batch, and report what it did.
   *
   * The account is read by a last statement **inside the batch**, so `after` is the state this transaction
   * committed and `before` is exactly that minus `movement`. A UNIQUE abort is a replay — nothing moved —
   * and a CHECK abort is insolvency, refused through `insufficient` when the operation can be short.
   */
  const run = async (
    statements: D1PreparedStatement[],
    account: LedgerAccountKey,
    movement: Movement,
    insufficient?: (current: Balance, cause: unknown) => Error,
  ): Promise<LedgerWriteOutcome> => {
    let results: Awaited<ReturnType<D1Database["batch"]>>;
    try {
      results = await d1.batch([...statements, prepared(selectBalance(account))]);
    } catch (error) {
      if (isViolation(error, "UNIQUE")) {
        const current = await readBalance(account.userId, account.currency); // replay → no-op
        return { applied: false, before: current, after: current };
      }
      if (isViolation(error, "CHECK") && insufficient) {
        throw insufficient(await readBalance(account.userId, account.currency), error);
      }
      throw error;
    }
    const row = results.at(-1)?.results[0] as { balance: number; held: number } | undefined;
    const after = row ? toBalance(row) : await readBalance(account.userId, account.currency);
    const before = toBalance({ balance: after.balance - movement.balance, held: after.held - movement.held });
    return { applied: true, before, after };
  };

  /**
   * After a derived write aborted on UNIQUE, prove the row under `derivedRef` is this write's own — written
   * for `ownerRef` on `account` — before the abort is answered as a replay.
   *
   * A row under that ref that answers something else is an entry nobody meant to collide with, and calling
   * it a replay would tell a console "already reversed" or "already released" while nothing moved.
   */
  const assertOwnDerived = async (derivedRef: string, ownerRef: string, account: LedgerAccountKey) => {
    const row = await db
      .selectFrom(LEDGER_TRANSACTIONS_TABLE)
      .select(["relatedRef", "userId", "currency"])
      .where("ref", "=", derivedRef)
      .executeTakeFirst();
    if (row?.relatedRef === ownerRef && row.userId === account.userId && row.currency === account.currency) return;
    throw new LedgerRefConflictError({
      detail: `Ref ${derivedRef} is held by an entry that is not ${ownerRef}'s, so nothing was written.`,
      params: { ref: derivedRef },
    });
  };

  /**
   * After a credit or a debit aborted on UNIQUE, prove the row under its client-chosen `ref` is this same
   * write — the account, the kind and the amount — before the abort is answered as a replay.
   *
   * Refs are unique across the whole log, so the same key sent for another account, for the other kind,
   * for another amount, or naming a hold, aborts exactly as a replay does. Answering that `applied: false`
   * would tell a console "already done" while the write it asked for never happened. The memo is not
   * compared: a retry whose reason was reworded is still the same movement.
   */
  const assertSameEntry = async (
    ref: string,
    write: { userId: string; currency: string; kind: "credit" | "debit"; amount: number },
  ) => {
    const row = await db
      .selectFrom(LEDGER_TRANSACTIONS_TABLE)
      .select(["userId", "currency", "kind", "amount"])
      .where("ref", "=", ref)
      .executeTakeFirst();
    if (
      row?.userId === write.userId &&
      row.currency === write.currency &&
      row.kind === write.kind &&
      row.amount === write.amount
    ) {
      return;
    }
    throw new LedgerRefConflictError({
      detail: `Ref ${ref} is held by an entry that is not this ${write.kind} of ${write.amount} ${write.currency} for ${write.userId}, so nothing was written.`,
      params: { ref },
    });
  };

  /** The hold with this ref, in whatever state it is in, or undefined. */
  const findHold = (ref: string) =>
    db
      .selectFrom(LEDGER_HOLDS_TABLE)
      .select(["userId", "currency", "amount", "status"])
      .where("ref", "=", ref)
      .executeTakeFirst();

  /** Release an open hold — the entry, the hold's state, and the funds back to `available`, in one batch. */
  const releaseHold = async (
    holdRef: string,
    hold: { userId: string; currency: string; amount: number },
    memo: string | null,
  ): Promise<LedgerWriteOutcome> => {
    const at = now();
    const statements = [
      // One resolution per hold, whichever wins the race — the `:resolve` ref is unique.
      prepared(entry(`${holdRef}:resolve`, hold.userId, hold.currency, "release", hold.amount, holdRef, memo, at)),
      prepared(
        db
          .updateTable(LEDGER_HOLDS_TABLE)
          .set({ status: "released", resolvedAt: at })
          .where("ref", "=", holdRef)
          .where("status", "=", "open"),
      ),
      prepared(adjust(hold.userId, hold.currency, { held: sql`held - ${hold.amount}` }, at)),
    ];
    const outcome = await run(statements, hold, { balance: 0, held: -hold.amount });
    if (!outcome.applied) await assertOwnDerived(`${holdRef}:resolve`, holdRef, hold);
    return outcome;
  };

  return {
    db,
    prepared,
    ensureAccount,
    entry,
    adjust,
    readBalance,
    run,
    assertOwnDerived,
    assertSameEntry,
    findHold,
    releaseHold,
  };
}

type LedgerCore = ReturnType<typeof ledgerCore>;

/** The writes, over one core — shared by {@link openLedger} and {@link openLedgerWrites}. */
function writesOver(core: LedgerCore, now: () => number): LedgerWrites {
  const { db, prepared, ensureAccount, entry, adjust, readBalance, run, assertOwnDerived, findHold, releaseHold } =
    core;
  const onAccount = (row: { userId: string; currency: string }, account: LedgerAccountKey | undefined) =>
    account === undefined || (row.userId === account.userId && row.currency === account.currency);

  return {
    async credit(userId, currency, amount, ref, options) {
      assertAmount(amount, "credit");
      const at = now();
      const statements = [
        prepared(ensureAccount(userId, currency, at)),
        prepared(entry(ref, userId, currency, "credit", amount, null, options?.memo ?? null, at)),
        prepared(adjust(userId, currency, { balance: sql`balance + ${amount}` }, at)),
      ];
      return run(statements, { userId, currency }, { balance: amount, held: 0 });
    },

    async debit(userId, currency, amount, ref, options) {
      assertAmount(amount, "debit");
      const at = now();
      const account = { userId, currency };
      const statements = [
        prepared(ensureAccount(userId, currency, at)),
        prepared(entry(ref, userId, currency, "debit", amount, null, options?.memo ?? null, at)),
        prepared(adjust(userId, currency, { balance: sql`balance - ${amount}` }, at)),
      ];
      return run(statements, account, { balance: -amount, held: 0 }, (current, cause) =>
        shortfall("debit", account, amount, current, cause),
      );
    },

    async reverse(ref, options) {
      const row = await db.selectFrom(LEDGER_TRANSACTIONS_TABLE).selectAll().where("ref", "=", ref).executeTakeFirst();
      if (!row || !onAccount(row, options?.account)) {
        throw new LedgerEntryNotFoundError({ detail: `No entry with ref ${ref} on that account.` });
      }
      const original = LedgerTransaction.parse(row);
      if (original.kind !== "credit" && original.kind !== "debit") {
        throw new LedgerEntryNotReversibleError({
          detail: `Entry ${ref} is a ${original.kind}; only a credit or a debit reverses.`,
          params: { kind: original.kind },
        });
      }
      // A credit or a debit carries a `relatedRef` only when it is a reversal — neither `credit` nor `debit`
      // takes one — so this is what a reversal of a reversal looks like.
      if (original.relatedRef !== null) {
        throw new LedgerEntryNotReversibleError({
          detail: `Entry ${ref} is itself the reversal of ${original.relatedRef}.`,
          params: { kind: original.kind, reverses: original.relatedRef },
        });
      }
      const { userId, currency, amount } = original;
      const account = { userId, currency };
      const opposite = original.kind === "credit" ? "debit" : "credit";
      const at = now();
      const statements = [
        prepared(entry(`${ref}:reverse`, userId, currency, opposite, amount, ref, options?.memo ?? null, at)),
        prepared(
          adjust(
            userId,
            currency,
            { balance: opposite === "credit" ? sql`balance + ${amount}` : sql`balance - ${amount}` },
            at,
          ),
        ),
      ];
      // Reversing a credit is a debit, and it obeys the debit's rule: refused below `available`.
      const outcome = await run(
        statements,
        account,
        { balance: opposite === "credit" ? amount : -amount, held: 0 },
        (current, cause) => shortfall("reversal", account, amount, current, cause),
      );
      // Lost a race to another reversal of this entry — or the ref was never this reversal's to take.
      if (!outcome.applied) await assertOwnDerived(`${ref}:reverse`, ref, account);
      return { ...outcome, entry: { ref, userId, currency, kind: original.kind, amount } };
    },

    async release(holdRef, options) {
      const found = await findHold(holdRef);
      if (!found || !onAccount(found, options?.account)) {
        throw new LedgerHoldNotFoundError({ detail: `No hold with ref ${holdRef} on that account.` });
      }
      const hold = { ref: holdRef, userId: found.userId, currency: found.currency, amount: found.amount };
      const notOpen = () => new LedgerHoldNotOpenError({ detail: `Hold ${holdRef} is captured.` });
      if (found.status === "captured") throw notOpen();
      if (found.status === "released") {
        // Its ref is the hold's own, so a second release is this one replayed: the state asked for, nothing moved.
        const current = await readBalance(hold.userId, hold.currency);
        return { applied: false, before: current, after: current, hold };
      }
      const outcome = await releaseHold(holdRef, hold, options?.memo ?? null);
      // Lost a race. To another release, that is a replay; to a capture, the hold was never released at all.
      if (!outcome.applied && (await findHold(holdRef))?.status === "captured") throw notOpen();
      return { ...outcome, hold };
    },
  };
}

/**
 * The management writes — {@link LedgerWrites} — over the `DB` binding.
 *
 * Deep path only, never in the package entrypoint: an in-process caller wants {@link openLedger}, and this
 * exists for the control-plane routes, which need to know whether a write moved anything and what the
 * account held either side of it.
 *
 * **`applied: false` here means only a replay.** A credit or a debit whose ref is already held by a
 * different write — another account, the other kind, another amount, a hold — is
 * `ledger/ref_conflict`, and nothing moves. {@link openLedger} keeps its contract unchanged: in process,
 * any duplicate ref is the silent no-op it always was.
 */
export function openLedgerWrites(d1: D1Database, now: () => number = () => Date.now()): LedgerWrites {
  const core = ledgerCore(d1, now);
  const writes = writesOver(core, now);
  return {
    ...writes,
    async credit(userId, currency, amount, ref, options) {
      const outcome = await writes.credit(userId, currency, amount, ref, options);
      if (!outcome.applied) await core.assertSameEntry(ref, { userId, currency, kind: "credit", amount });
      return outcome;
    },
    async debit(userId, currency, amount, ref, options) {
      const outcome = await writes.debit(userId, currency, amount, ref, options);
      if (!outcome.applied) await core.assertSameEntry(ref, { userId, currency, kind: "debit", amount });
      return outcome;
    },
  };
}

export function openLedger(d1: D1Database, now: () => number = () => Date.now()): Ledger {
  const core = ledgerCore(d1, now);
  const { db, prepared, ensureAccount, entry, adjust, readBalance, run, assertOwnDerived, releaseHold } = core;
  const writes = writesOver(core, now);

  return {
    balance: readBalance,

    async credit(userId, currency, amount, ref, options) {
      return (await writes.credit(userId, currency, amount, ref, options)).after;
    },

    async debit(userId, currency, amount, ref, options) {
      return (await writes.debit(userId, currency, amount, ref, options)).after;
    },

    async reverse(ref, options) {
      return (await writes.reverse(ref, options)).after;
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
      const outcome = await run(
        statements,
        { userId, currency },
        { balance: 0, held: amount },
        (_current, cause) =>
          new LedgerInsufficientFundsError(
            { detail: `hold of ${amount} ${currency} for ${userId} exceeds available balance` },
            { cause },
          ),
      );
      return outcome.after;
    },

    async release(holdRef, options) {
      const hold = await requireOpenHold(db, holdRef);
      return (await releaseHold(holdRef, hold, options?.memo ?? null)).after;
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
      // A UNIQUE abort means another resolution already won the race — a no-op — unless the ref was never
      // this hold's to take.
      const outcome = await run(statements, hold, { balance: -captured, held: -hold.amount });
      if (!outcome.applied) await assertOwnDerived(`${holdRef}:resolve`, holdRef, hold);
      return outcome.after;
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
