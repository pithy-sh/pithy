import { env, runInDurableObject } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { ledger } from "@pithy-sh/wallet/src/ledger/ledger";
import { wallet_0001_ledger } from "@pithy-sh/wallet/src/migrations/0001_ledger";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MULTIPLAYER_MIGRATION_ORDER } from "../../capability";
import { multiplayer_0001_results } from "../../migrations/0001_results";
import type { MultiplayerSession } from "../../session/durableObject";
import type { GameSnapshot } from "../../session/state";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "multiplayer",
      order: MULTIPLAYER_MIGRATION_ORDER,
      migrations: { "0001_results": multiplayer_0001_results },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

beforeEach(async () => {
  for (const t of [
    "pithy_multiplayer_results",
    "pithy_wallet_accounts",
    "pithy_wallet_transactions",
    "pithy_wallet_holds",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  await wallet_0001_ledger.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
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

describe("craps — real table through the DO, RNG, and wallet", () => {
  test("a field bet holds the stake, then a real roll settles it consistently with the wallet", async () => {
    const w = ledger(env.DB);
    await w.credit("alice", "chips", 100, "seed");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(craps, "alice"));

    await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("alice", { kind: "bet", bet: { type: "field", amount: 10 } }),
    );
    expect(await w.balance("alice", "chips")).toEqual({ balance: 100, held: 10, available: 90 });

    const rolled = await runInDurableObject(stub, (s: MultiplayerSession) => s.action("alice", { kind: "event" }));
    const view = rolled.state as CrapsView;
    expect(view.round.lastRoll).not.toBeNull();
    const decision = view.lastDecisions[0];
    expect(decision).toBeDefined();
    const balance = await w.balance("alice", "chips");
    expect(balance.held).toBe(0); // a field bet is a one-roll bet — always resolved
    if (decision?.result === "win") expect(balance.balance).toBe(100 + (decision.payout ?? 0));
    else expect(balance.balance).toBe(90);
  });

  test("fairness: the seed hash is committed up front and the seed is revealed at close", async () => {
    await ledger(env.DB).credit("alice", "chips", 100, "seed");
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    const created = await runInDurableObject(stub, (s: MultiplayerSession) => s.create(craps, "alice"));
    expect(created.fairness.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.fairness.seed).toBeNull();
    const closed = await runInDurableObject(stub, (s: MultiplayerSession) => s.close("alice"));
    expect(closed.fairness.seed).toMatch(/^[0-9a-f]{32}$/);
  });
});
