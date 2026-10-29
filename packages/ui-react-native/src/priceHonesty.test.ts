// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

/**
 * No React Native screen writes a price down, and no screen decides for itself where a visitor lives. Every figure
 * comes from the App Store, Google Play or Paddle, rendered for the reader. Held over the whole tree, enumerated
 * from disk, so a screen added later is enrolled by existing.
 */

/** Every source file in the template tree, POSIX-separated relative paths. */
async function templateSources(dir: string = TEMPLATE_DIR): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await templateSources(path)));
    else found.push(relative(TEMPLATE_DIR, path).split(sep).join("/"));
  }
  return found.sort();
}

/** Every money-shaped literal in one file's text: a symbol against a digit, a two-decimal number, an ISO code. */
function moneyLiterals(source: string): string[] {
  const patterns = [
    /[$€£¥₹₩₪₫฿]\s?\d/g,
    /\b\d+[.,]\d{2}\b/g,
    /\b\d+(?:[.,]\d+)?\s?(?:USD|EUR|GBP|JPY|KRW|CLP|VND|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|PLN|ZAR)\b/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[0]));
}

describe("no scaffolded React Native screen writes a price down", () => {
  test("the detector reports a price, so a green sweep means something", () => {
    expect(moneyLiterals("<Text>Pro is $5.00 a month.</Text>")).toEqual(["$5", "5.00"]);
    expect(moneyLiterals("<Text>¥725 a month.</Text>")).toEqual(["¥7"]);
    expect(moneyLiterals("<Text>Pay 5 USD.</Text>")).toEqual(["5 USD"]);
  });

  test("the sweep reads the real tree, the screens that sell included", async () => {
    const sources = await templateSources();
    expect(sources).toEqual(
      expect.arrayContaining([
        "src/payments.tsx",
        "src/routes/pithy/pricing.tsx",
        "src/routes/pithy/paywall.tsx",
        "src/routes/pithy/subscription.tsx",
      ]),
    );
  });

  test("every template is free of money-shaped literals", async () => {
    const offenses: string[] = [];
    for (const path of await templateSources()) {
      const found = moneyLiterals(await readFile(join(TEMPLATE_DIR, path), "utf8"));
      if (found.length > 0) offenses.push(`${path}: ${[...new Set(found)].join(", ")}`);
    }
    expect(offenses, "A scaffolded screen writes a figure down. Every price comes from the store.").toEqual([]);
  });
});

describe("no scaffolded React Native screen decides for itself where a visitor lives", () => {
  test("a screen that asks Paddle for a quote builds it through the one resolver, and labels an estimate", async () => {
    const quoting: string[] = [];
    const offenses: string[] = [];
    for (const path of await templateSources()) {
      const source = await readFile(join(TEMPLATE_DIR, path), "utf8");
      if (!source.includes("usePricePreview")) continue;
      quoting.push(path);
      const routed =
        source.includes("@pithy-sh/payments/src/pricing/location") &&
        source.includes("priceQueryFor") &&
        source.includes("quoteIsEstimated");
      if (!routed) offenses.push(path);
    }
    expect(quoting).toContain("src/routes/pithy/pricing.tsx");
    expect(offenses).toEqual([]);
  });
});
