// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { HOME_SCREEN, TEMPLATE_DIR, TEMPLATE_GROUPS, WORKER_TOKEN } from "./templates";

/**
 * The library is text, so its meta-test is about the manifest telling the truth: every path a group
 * names exists, and every file in the tree is named by some group. Either half failing is the same
 * class of bug — a template that silently never ships, or a group that points at nothing — and
 * neither is visible to `tsc` or to the CLI's own tests.
 */

/** Every file in the template tree, as paths relative to it, POSIX-separated. */
async function treeFiles(dir: string = TEMPLATE_DIR): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await treeFiles(path)));
    else found.push(relative(TEMPLATE_DIR, path).split(sep).join("/"));
  }
  return found.sort();
}

/** Every path any group or the home screen declares. */
function declaredPaths(): string[] {
  return [...Object.values(TEMPLATE_GROUPS).flat(), HOME_SCREEN.auth, HOME_SCREEN.bare].sort();
}

describe("the React template library", () => {
  test("every declared path exists on disk", async () => {
    for (const path of declaredPaths()) {
      const info = await stat(join(TEMPLATE_DIR, path)).catch(() => null);
      expect(info?.isFile(), `${path} is declared but missing`).toBe(true);
    }
  });

  test("every file in the tree is declared — no template ships by accident, and none is orphaned", async () => {
    const declared = new Set(declaredPaths());
    const orphans = (await treeFiles()).filter((path) => !declared.has(path));
    expect(orphans, "files present in templates/ but named by no group").toEqual([]);
  });

  test("the tree is not empty — a broken TEMPLATE_DIR must fail loudly, not vacuously pass", async () => {
    const files = await treeFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(declaredPaths().length).toBe(files.length);
  });

  test("base is what every template gets; every other group is additive on top of it", () => {
    expect(TEMPLATE_GROUPS.base).toContain("src/router.tsx");
    expect(TEMPLATE_GROUPS.base).toContain("client-env.d.ts");
    // The one module that imports the virtual modules and narrows them belongs to every capability, not
    // to auth — a payments-only scaffold needs it too. docs/UI.md states the rule.
    expect(TEMPLATE_GROUPS.base).toContain("src/pithy-config.tsx");

    // A capability's screens ride on that capability being composed, so none of them may sit in base.
    const capabilityOwned: Record<string, readonly string[]> = {
      // `src/turnstile.test.tsx` is a helper of the same kind: it is the gate over `turnstile.tsx`, and
      // it rides on auth being composed for exactly the reason the widget does — there is no widget to
      // hold to its contract otherwise (#383).
      auth: ["src/session.tsx", "src/turnstile.tsx", "src/turnstile.test.tsx"],
      payments: ["src/payments.tsx"],
    };
    for (const [group, helpers] of Object.entries(capabilityOwned)) {
      for (const path of TEMPLATE_GROUPS[group as "auth" | "payments"]) {
        expect(TEMPLATE_GROUPS.base as readonly string[], path).not.toContain(path);
        expect(path.startsWith("src/routes/pithy/") || helpers.includes(path), path).toBe(true);
      }
    }
  });

  test("no file is claimed by two groups — a scaffold writes each path once", () => {
    const declared = Object.values(TEMPLATE_GROUPS).flat();
    expect(new Set(declared).size).toBe(declared.length);
  });

  test("the payments group is the three screens and the bridge, and nothing from auth", () => {
    expect([...TEMPLATE_GROUPS.payments]).toEqual([
      "src/payments.tsx",
      "src/routes/pithy/paywall.tsx",
      "src/routes/pithy/pricing.tsx",
      "src/routes/pithy/subscription.tsx",
    ]);
  });

  /**
   * A currency symbol against a digit. No false positive is possible, so it runs over every template.
   */
  const CURRENCY = /[$£€¥]\s?\d/;

  /**
   * A bare two-decimal figure. Runs over the payments screens only — `d="M12 .297c-6.63…"` in an SVG
   * icon is full of them, and an auth screen has no money to quote. Scoping it is what lets the pattern
   * stay strict enough to catch `5.00` written without a symbol at all.
   */
  const BARE_AMOUNT = /\b\d+\.\d{2}\b/;

  /** Every line of a template that could render, with comment text removed. Prose is not a price. */
  async function renderableLines(path: string): Promise<{ line: number; code: string; source: string }[]> {
    const text = await readFile(join(TEMPLATE_DIR, path), "utf8");
    return text.split("\n").map((source, index) => ({
      line: index + 1,
      code: source.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""),
      source,
    }));
  }

  test("no screen this library ships writes a price down", async () => {
    // The acceptance criterion for localized pricing, as a gate on the text rather than a rule in a
    // docblock. A figure in a template is wrong in every country whose tax convention differs from the
    // one it was written in, and a scaffolded file is one Pithy cannot fix afterwards. Every price a
    // Pithy screen renders comes from Paddle, for that visitor.
    const payments: readonly string[] = TEMPLATE_GROUPS.payments;
    const offences: string[] = [];
    for (const path of declaredPaths()) {
      for (const { line, code, source } of await renderableLines(path)) {
        const hit = CURRENCY.test(code) || (payments.includes(path) && BARE_AMOUNT.test(code));
        if (hit) offences.push(`${path}:${line} ${source.trim()}`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("the price sweep finds one when there is one to find", () => {
    // Otherwise the test above passes on patterns that match nothing at all, over a list that may be
    // empty, and says the same thing either way.
    expect(CURRENCY.test("<strong>$5.00</strong>")).toBe(true);
    expect(CURRENCY.test("<strong>¥725</strong>")).toBe(true);
    expect(BARE_AMOUNT.test("const price = 5.00;")).toBe(true);
    expect(CURRENCY.test("<strong>{summary.headline}</strong>")).toBe(false);
    expect(TEMPLATE_GROUPS.payments.length).toBeGreaterThan(3);
  });

  test("the home screen has both variants, and they land at the same target", () => {
    expect(HOME_SCREEN.auth).not.toBe(HOME_SCREEN.bare);
    expect(HOME_SCREEN.target).toBe("src/routes/app/home.tsx");
  });

  test("the worker token appears only where a name belongs, and every use is substitutable", async () => {
    const users: string[] = [];
    for (const path of declaredPaths()) {
      const text = await readFile(join(TEMPLATE_DIR, path), "utf8");
      if (text.includes(WORKER_TOKEN)) users.push(path);
    }
    // Three templates need the worker's name: the document title, and each tsconfig's `tsBuildInfoFile`.
    // The build-state files sit together under the project's `dist/`, so they are named after the Worker
    // they belong to — two composite programs pointing at one file overwrite each other's state.
    expect(users).toEqual(["index.html", "tsconfig.client.json", "tsconfig.node.json"]);
  });

  test("no template reaches for a token that nothing substitutes", async () => {
    for (const path of declaredPaths()) {
      const text = await readFile(join(TEMPLATE_DIR, path), "utf8");
      const tokens = (text.match(/__PITHY_[A-Z_]+__/g) ?? []).filter((token) => token !== WORKER_TOKEN);
      expect(tokens, `${path} uses an unsubstituted token`).toEqual([]);
    }
  });

  /**
   * No screen writes out the set of hosted rails.
   *
   * #336 three times over: a screen that gates on "any rail that sells in a browser" and answers it by
   * naming the rails it remembers. Each copy was correct the day it was written and one rail short a
   * release later, and the third was added directly beneath a comment describing the second.
   *
   * The rule is narrow because the defect is: **naming one hosted rail is a screen about that rail**
   * — `pricing.tsx` is Paddle's, because PricePreview is Paddle's API — and naming two is a set someone
   * typed from memory. Sets come from `PAYMENTS_HOSTED_RAILS`, which the package exports and a copied
   * template keeps importing. Apple and Google are exempt by not being on this list at all: they are
   * named one at a time on purpose, each with its own sentence, and neither is ever part of a set.
   */
  test("no scaffolded screen writes out the set of hosted rails", async () => {
    // The names, in this file rather than imported. Importing them from the package would make this a
    // sweep for whatever the package currently says, and the thing being checked is that a screen does
    // not repeat the package — a rule that read its own subject would go quiet exactly when a rail is
    // added, which is the one moment it exists for.
    const HOSTED = ["stripe", "lemonSqueezy", "paddle"];
    const screens = declaredPaths().filter((path) => path.startsWith("src/routes/pithy/"));
    let named = 0;

    for (const path of screens) {
      const text = await readFile(join(TEMPLATE_DIR, path), "utf8");
      // `rails.paddle`, `paymentsConfig.rails.stripe` — a rail read by name. `rails[rail]` is not a
      // name, which is the whole point: it is a lookup against a list somebody else maintains.
      const byName = new Set([...text.matchAll(/\brails\.([A-Za-z]+)\b/g)].map((match) => match[1] ?? ""));
      const hosted = HOSTED.filter((rail) => byName.has(rail));
      if (hosted.length > 0) named += 1;
      expect(
        hosted.length,
        `${path} names ${hosted.join(" and ")} by hand — a set of hosted rails is PAYMENTS_HOSTED_RAILS`,
      ).toBeLessThan(2);
    }

    // A floor under both halves. Without it a broken glob sweeps nothing and passes, and a regex that
    // matched nothing would say the same thing as a tree with no defect in it.
    expect(screens.length).toBeGreaterThanOrEqual(5);
    expect(named, "no screen reads a rail by name at all — the pattern has stopped matching").toBeGreaterThan(0);
  });

  /**
   * A screen that starts a checkout finishes it.
   *
   * #335, as a rule rather than as two remembered edits. `useCheckout` returns a `handoff` on the one
   * rail with nowhere to navigate to, and a screen that ignores it renders a Buy button that creates a
   * transaction, charges nobody, and does nothing visible — the failure mode hardest to notice, because
   * every other rail on the same button works. Both screens that sell had exactly that shape until this
   * issue, and the third screen someone adds would inherit it by copying either of them.
   *
   * A sweep over every screen that calls `useCheckout`, not a list of the two that do today.
   */
  test("every screen that starts a checkout also opens the one that does not navigate away", async () => {
    const screens = declaredPaths().filter((path) => path.startsWith("src/routes/pithy/"));
    const selling: string[] = [];

    for (const path of screens) {
      const text = await readFile(join(TEMPLATE_DIR, path), "utf8");
      if (!text.includes("useCheckout(")) continue;
      selling.push(path);
      expect(text, `${path} starts a checkout and never opens the Paddle handoff`).toContain("usePaddleCheckout(");
      // Inline checkout renders into an element found by class name. A screen that passes a frameTarget
      // and never renders one is a checkout drawn into nothing — silently, and only on the projects
      // configured for inline, which is the last place a defect gets found.
      const frameTarget = /frameTarget:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
      expect(frameTarget, `${path} opens a checkout without naming a container`).not.toBeNull();
      const container = frameTarget?.[1] ?? "";
      expect(text, `${path} names ${container} as its frame target and never renders it`).toContain(
        `className={${container}}`,
      );
    }

    // Floors. A glob that swept nothing, or a screen set where nothing sells, would assert nothing here.
    expect(screens.length).toBeGreaterThanOrEqual(5);
    expect(selling.length, "no scaffolded screen starts a checkout — the marker has stopped matching").toBeGreaterThan(
      1,
    );
  });
});
