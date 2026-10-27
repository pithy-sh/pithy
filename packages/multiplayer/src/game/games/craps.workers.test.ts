// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import { isRetained, purgeSteps } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { ledger } from "@pithy-sh/ledger/src/capability";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MULTIPLAYER_MIGRATION_ORDER, multiplayer } from "../../capability";
import { sessionIndex } from "../../data/sessionStore";
import { multiplayerDatabase } from "../../data/tables";
import { MULTIPLAYER_MIGRATIONS } from "../../migrations/chain";
import type { MultiplayerSession } from "../../session/durableObject";
import type { GameSnapshot } from "../../session/state";

// The composition an adopter's `createEntrypoint` performs at load (#645): every capability's `compose` hook over
// the whole set. It is what hands the session its ledger and its leaderboard, which the session never imports;
// the Durable Object runs in this isolate, so it reads what this composed.
const composed = [
  ledger({ currencies: [{ code: "chips", name: "Chips" }] }),
  leaderboard({ boards: [{ key: "wins", direction: "desc", aggregation: "sum" }] }),
  multiplayer({ games: [{ key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }] }),
];
for (const capability of composed) capability.compose?.({ capabilities: composed });

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "multiplayer",
      order: MULTIPLAYER_MIGRATION_ORDER,
      migrations: MULTIPLAYER_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

beforeEach(async () => {
  for (const t of [
    "pithy_multiplayer_results",
    "pithy_multiplayer_sessions",
    "pithy_multiplayer_void_keys",
    "pithy_ledger_accounts",
    "pithy_ledger_transactions",
    "pithy_ledger_holds",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  await ledger_0001_accounts.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const craps: GameSnapshot = {
  key: "table-1",
  kind: "craps",
  mode: "table",
  players: 8,
  turnTimeoutMs: null,
  leaderboard: null,
  rules: { currency: "chips", minBet: 5, maxBet: 100 },
};
type CrapsView = {
  round: { phase: string; point: number | null; lastRoll: [number, number] | null };
  lastDecisions: { ref: string; result: string; payout: number }[];
};

describe("craps — real table through the DO, RNG, and ledger", () => {
  test("a field bet holds the stake, then a real roll settles it consistently with the ledger", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("alice", "chips", 100, "seed");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(craps, "alice"));

    await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("alice", { kind: "bet", bet: { type: "field", amount: 10 } }),
    );
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 100, held: 10, available: 90 });

    const rolled = await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", { kind: "event" }));
    const view = rolled.state as CrapsView;
    expect(view.round.lastRoll).not.toBeNull();
    const decision = view.lastDecisions[0];
    expect(decision).toBeDefined();
    const balance = await ledger.balance("alice", "chips");
    expect(balance.held).toBe(0); // a field bet is a one-roll bet — always resolved
    if (decision?.result === "win") expect(balance.balance).toBe(100 + (decision.payout ?? 0));
    else expect(balance.balance).toBe(90);
  });

  test("fairness: the seed hash is committed up front and the seed is revealed at close", async () => {
    await openLedger(env.DB).credit("alice", "chips", 100, "seed");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    const created = await runInDurableObject(stub, (s: MultiplayerSession) => s.create(craps, "alice"));
    expect(created.fairness.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.fairness.seed).toBeNull();
    const closed = await runInDurableObject(stub, (s: MultiplayerSession) => s.close("alice"));
    expect(closed.fairness.seed).toMatch(/^[0-9a-f]{32}$/);
  });

  test("closing the table releases every open bet, whoever closes it (#820)", async () => {
    const ledger = openLedger(env.DB);
    for (const closer of ["player", "operator"] as const) {
      await ledger.credit(`ada-${closer}`, "chips", 100, `seed-ada-${closer}`);
      await ledger.credit(`bo-${closer}`, "chips", 100, `seed-bo-${closer}`);
      const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
      await runInDurableObject(stub, (s: MultiplayerSession) => s.create(craps, `ada-${closer}`));
      await runInDurableObject(stub, (s: MultiplayerSession) => s.join(`bo-${closer}`));
      // A pass-line bet stays open across rolls until the point resolves: nothing but a close would settle it.
      for (const player of [`ada-${closer}`, `bo-${closer}`]) {
        await runInDurableObject(stub, (s: MultiplayerSession) =>
          s.action(player, { kind: "bet", bet: { type: "pass", amount: 20 } }),
        );
        expect((await ledger.balance(player, "chips")).held).toBe(20);
      }
      if (closer === "player") await runInDurableObject(stub, (s: MultiplayerSession) => s.close(`ada-${closer}`));
      else await runInDurableObject(stub, (s: MultiplayerSession) => s.closeByOperator("k1", "Closing the room."));
      for (const player of [`ada-${closer}`, `bo-${closer}`]) {
        expect(await ledger.balance(player, "chips"), `${closer} close, ${player}`).toEqual({
          balance: 100,
          held: 0,
          available: 100,
        });
      }
    }
  });

  test("erasing a player with a bet open: the ledger's step goes first, and the table still closes (#820)", async () => {
    const ledger = openLedger(env.DB);
    await ledger.credit("ada", "chips", 100, "seed-ada");
    await ledger.credit("bo", "chips", 100, "seed-bo");
    const id = env.SESSIONS.newUniqueId();
    const stub = env.SESSIONS.get(id);
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(craps, "ada"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bo"));
    for (const player of ["ada", "bo"]) {
      await runInDurableObject(stub, (s: MultiplayerSession) =>
        s.action(player, { kind: "bet", bet: { type: "pass", amount: 20 } }),
      );
    }

    // The steps in composition order, as a purge runs them: ledger() is composed before multiplayer(), so ada's
    // hold is gone by the time multiplayer closes the table and settles her seat out.
    const steps = purgeSteps(composed, "user").filter(({ step }) => step === "ledger" || step === "multiplayer");
    expect(steps.map(({ step }) => step)).toEqual(["ledger", "multiplayer"]);
    const context = { subject: { type: "user" as const, id: "ada" }, env: { DB: env.DB, SESSIONS: env.SESSIONS } };
    for (const { contribution } of steps) {
      if (isRetained(contribution)) throw new Error(`${contribution.summary} retains`);
      await contribution.erase(context);
    }

    const inspected = await runInDurableObject(stub, (s: MultiplayerSession) => s.inspect());
    expect(inspected.phase).toBe("abandoned");
    expect(await sessionIndex(multiplayerDatabase(env.DB)).get(id.toString())).toBeUndefined();
    // The other seat's bet is released, not left held behind the erased one.
    expect(await ledger.balance("bo", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    // And a second run, as a retried purge makes, finds nothing to do.
    for (const { contribution } of steps) if (!isRetained(contribution)) await contribution.erase(context);
  });
});
