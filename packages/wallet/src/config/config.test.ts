import { describe, expect, test } from "vitest";
import { resolveCurrency, WalletConfig } from "./config";

describe("WalletConfig", () => {
  test("parses currencies, defaults decimals to 0 and the admin scope", () => {
    const config = WalletConfig.parse({ currencies: [{ code: "chips", name: "Casino Chips" }] });
    expect(config.currencies[0]).toMatchObject({ code: "chips", name: "Casino Chips", decimals: 0 });
    expect(config.adminScope).toBe("wallet:admin");
  });

  test("rejects an empty currency set", () => {
    expect(WalletConfig.safeParse({ currencies: [] }).success).toBe(false);
  });

  test("rejects duplicate currency codes", () => {
    const result = WalletConfig.safeParse({
      currencies: [
        { code: "chips", name: "A" },
        { code: "chips", name: "B" },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes("Duplicate currency codes"))).toBe(true);
  });

  test("rejects a non-kebab currency code", () => {
    expect(WalletConfig.safeParse({ currencies: [{ code: "US Dollars", name: "USD" }] }).success).toBe(false);
  });

  test("resolveCurrency finds a configured code and misses an unknown one", () => {
    const config = WalletConfig.parse({ currencies: [{ code: "gold", name: "Gold", decimals: 2 }] });
    expect(resolveCurrency(config, "gold")?.decimals).toBe(2);
    expect(resolveCurrency(config, "silver")).toBeUndefined();
  });
});
