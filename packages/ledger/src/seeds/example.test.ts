import { composeSeeds } from "@pithy-sh/core/src/seed/compose";
import { describe, expect, it } from "vitest";
import { ledger } from "../capability";
import { LEDGER_ACCOUNTS_TABLE } from "../data/tables";
import { ledgerExampleSeed } from "./example";

const currencies = [{ code: "coins", name: "Coins" }];

describe("ledgerExampleSeed", () => {
  it("is flagged as an example", () => {
    expect(ledgerExampleSeed.example).toBe(true);
  });

  it("never lists production — an example fixture is dev/staging only", () => {
    expect(ledgerExampleSeed.environments).not.toContain("production");
    expect(ledgerExampleSeed.environments).toEqual(["dev", "staging"]);
  });

  it("seeds a demo balance for each canonical user into the app database", () => {
    expect(ledgerExampleSeed.d1).toHaveLength(1);
    const [group] = ledgerExampleSeed.d1 ?? [];
    expect(group?.database).toBe("app");
    expect(group?.table).toBe(LEDGER_ACCOUNTS_TABLE);
    expect(group?.rows).toHaveLength(3);
    const userIds = group?.rows.map((row) => (row as { userId: string }).userId) ?? [];
    expect(userIds).toEqual(["example-ada", "example-grace", "example-alan"]);
  });
});

describe("ledger() with seed.includeExamples", () => {
  it("composes the example set only when includeExamples is on", () => {
    const capability = ledger({ currencies });

    const withoutExamples = composeSeeds([capability], { env: "dev", includeExamples: false });
    expect(withoutExamples.sets).toHaveLength(0);

    const withExamples = composeSeeds([capability], { env: "dev", includeExamples: true });
    expect(withExamples.sets).toHaveLength(1);
    expect(withExamples.sets[0]?.key).toContain("ledger");
  });

  it("never composes the example set for production, even with includeExamples on", () => {
    const capability = ledger({ currencies });

    const result = composeSeeds([capability], { env: "production", includeExamples: true });
    expect(result.sets).toHaveLength(0);
    expect(result.skippedByEnv.length).toBeGreaterThan(0);
  });
});
