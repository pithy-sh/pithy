// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

/**
 * Two things a scaffolded screen must never do with money, held as invariants over the whole tree
 * rather than as assertions about the screens that exist today.
 *
 * **No screen writes a price down.** Not in a component, not in a fallback, not in prose. A figure
 * written here is wrong in every country whose tax convention differs from the one it was typed in, it
 * is wrong in every zero-decimal currency — ¥725 is `725`, not `72500` — and it is wrong *silently*,
 * because nothing recomputes it. Every figure comes from Paddle, rendered by Paddle for the visitor.
 *
 * **No screen decides for itself where a visitor lives.** A page quoting from the browser's IP and a
 * checkout charging from the billing address is the "the site said $5 and you charged me $5.44" failure
 * — up to 15% inside the United States alone. `@pithy-sh/payments/src/pricing/location` is the one
 * resolver, and a screen that quotes routes both the query and the estimate label through it.
 *
 * **Both are stated as what must be true, not as a list of what is forbidden.** The tree is enumerated
 * from disk and every file in it is held to the rule, so a screen added next year is enrolled by
 * existing rather than by somebody remembering to add it here. The defect classes in this kit that had
 * three producers each had a rule living at a call site; this is the same rule living at the tree.
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

/**
 * Vector geometry, removed before the money sweep reads a file.
 *
 * An SVG path is a list of coordinates and `12.297` in one is not a price in any currency. This is a
 * statement about what the characters *are*, not a file that has been excused: the geometry is dropped
 * wherever it appears, in a screen that exists and in one that does not yet.
 */
function withoutVectorGeometry(source: string): string {
  return source.replace(/\sd="[^"]*"/g, " ").replace(/\sviewBox="[^"]*"/g, " ");
}

/**
 * Every money-shaped literal in one file's text.
 *
 * Three shapes, because a price is written three ways and banning one leaves the other two. A symbol
 * against a digit catches `$5`, `€4,20` and `¥725` — the zero-decimal currencies have no decimal point
 * to catch them by, which is exactly why the symbol rule exists. A two-decimal number catches a bare
 * `5.00` somebody wrote without a symbol. An ISO code against a digit catches `5 USD`.
 */
function moneyLiterals(source: string): string[] {
  const text = withoutVectorGeometry(source);
  const patterns = [
    /[$€£¥₹₩₪₫฿]\s?\d/g,
    /\b\d+[.,]\d{2}\b/g,
    /\b\d+(?:[.,]\d+)?\s?(?:USD|EUR|GBP|JPY|KRW|CLP|VND|CAD|AUD|CHF|CNY|INR|BRL|MXN|SEK|NOK|DKK|PLN|ZAR)\b/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
}

describe("no scaffolded screen writes a price down", () => {
  test("the detector reports a price, so a green sweep means something", () => {
    // The gate's own gate. A regex that matched nothing would pass the sweep below on every file in the
    // tree and on every file added to it, forever, and would read exactly like a rule being kept.
    expect(moneyLiterals("<p>Pro is $5.00 a month.</p>")).toEqual(["$5", "5.00"]);
    expect(moneyLiterals("<p>¥725 a month.</p>")).toEqual(["¥7"]);
    expect(moneyLiterals("<p>Pay 5 USD.</p>")).toEqual(["5 USD"]);
    // And it does not report geometry, which is what would make the sweep unfixable rather than strict.
    expect(moneyLiterals('<path d="M12 .297c-6.63 0-12 5.373-12 12" />')).toEqual([]);
  });

  test("the sweep reads the real tree, not an empty directory", async () => {
    const sources = await templateSources();
    expect(sources.length).toBeGreaterThan(10);
    expect(sources).toContain("src/routes/pithy/pricing.tsx");
  });

  test("every template is free of money-shaped literals", async () => {
    const offences: string[] = [];
    for (const path of await templateSources()) {
      const found = moneyLiterals(await readFile(join(TEMPLATE_DIR, path), "utf8"));
      if (found.length > 0) offences.push(`${path} — ${[...new Set(found)].join(", ")}`);
    }
    expect(
      offences,
      `A scaffolded screen writes a figure down. Every price comes from the store, rendered by the store for the visitor — a literal here is wrong in every country whose tax convention differs from the one it was typed in, and wrong silently:\n${offences.map((offence) => `  ${offence}`).join("\n")}`,
    ).toEqual([]);
  });
});

describe("no scaffolded screen decides for itself where a visitor lives", () => {
  /** The module that owns the decision. One resolver, or the quote and the charge can disagree. */
  const RESOLVER = "@pithy-sh/payments/src/pricing/location";

  /** Every template that asks a store for a price. */
  async function quotingScreens(): Promise<{ path: string; source: string }[]> {
    const screens: { path: string; source: string }[] = [];
    for (const path of await templateSources()) {
      if (!path.endsWith(".tsx") && !path.endsWith(".ts")) continue;
      const source = await readFile(join(TEMPLATE_DIR, path), "utf8");
      if (source.includes("usePricePreview")) screens.push({ path, source });
    }
    return screens;
  }

  test("there is a screen that quotes — otherwise the two rules below hold vacuously", async () => {
    expect((await quotingScreens()).map((screen) => screen.path)).toContain("src/routes/pithy/pricing.tsx");
  });

  test("a screen that quotes builds its query through the one resolver", async () => {
    const offences = (await quotingScreens())
      .filter((screen) => !screen.source.includes("priceQueryFor") || !screen.source.includes(RESOLVER))
      .map((screen) => screen.path);
    expect(
      offences,
      `These screens ask a store for a price and build the request themselves. Where a visitor lives is one decision — \`resolvePriceLocation\` and \`priceQueryFor\` in ${RESOLVER} — and a screen that answers it its own way quotes from a location the checkout does not charge from:\n${offences.map((path) => `  ${path}`).join("\n")}`,
    ).toEqual([]);
  });

  test("a screen that quotes labels the figure through the one rule", async () => {
    // `priceSummary().estimated` is only half the answer: it says the tax is unresolved and says nothing
    // about the location being a guess from an IP. A screen rendering it raw presents an estimate as the
    // charge the moment Paddle starts filling in a postal code it does not fill in today.
    const offences = (await quotingScreens())
      .filter((screen) => !screen.source.includes("quoteIsEstimated"))
      .map((screen) => screen.path);
    expect(
      offences,
      `These screens render a quote without asking \`quoteIsEstimated\` whether it is one. A figure from an IP is an estimate whatever fields the store filled in, and one rendered as final is the failure this rule exists to stop:\n${offences.map((path) => `  ${path}`).join("\n")}`,
    ).toEqual([]);
  });
});
