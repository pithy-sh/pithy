// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { LedgerConfig, resolveCurrency } from "./config";

describe("LedgerConfig", () => {
  test("parses currencies, defaults decimals to 0 and the admin scope", () => {
    const config = LedgerConfig.parse({ currencies: [{ code: "chips", name: "Casino Chips" }] });
    expect(config.currencies[0]).toMatchObject({ code: "chips", name: "Casino Chips", decimals: 0 });
    expect(config.adminScope).toBe("ledger:admin");
  });

  test("rejects an empty currency set", () => {
    expect(LedgerConfig.safeParse({ currencies: [] }).success).toBe(false);
  });

  test("rejects duplicate currency codes", () => {
    const result = LedgerConfig.safeParse({
      currencies: [
        { code: "chips", name: "A" },
        { code: "chips", name: "B" },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes("Duplicate currency codes"))).toBe(true);
  });

  test("rejects a non-kebab currency code", () => {
    expect(LedgerConfig.safeParse({ currencies: [{ code: "US Dollars", name: "USD" }] }).success).toBe(false);
  });

  test("resolveCurrency finds a configured code and misses an unknown one", () => {
    const config = LedgerConfig.parse({ currencies: [{ code: "gold", name: "Gold", decimals: 2 }] });
    expect(resolveCurrency(config, "gold")?.decimals).toBe(2);
    expect(resolveCurrency(config, "silver")).toBeUndefined();
  });
});
