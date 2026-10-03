// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { isPaddleSubscriptionId, isPaddleTransactionId } from "./paddleIds";

/** A real sandbox transaction, and the subscription it belongs to. Verbatim, 26 characters after the prefix. */
const TXN = "txn_01m02kntv7bhw3sxdy5kyj93k1";
const SUB = "sub_01m02kntv7bhw3sxdy5kyj93kt";

describe("isPaddleTransactionId", () => {
  test("a real transaction id is one, and a subscription is not", () => {
    expect(isPaddleTransactionId(TXN)).toBe(true);
    expect(isPaddleTransactionId(SUB)).toBe(false);
  });

  test("the prefix alone is not an id, and neither is Paddle's alphabet shouted", () => {
    // The two values `startsWith("txn_")` accepted and this refuses. The bare prefix names no
    // transaction, and Paddle issues lowercase base32 — an uppercase id is somebody else's string.
    expect(isPaddleTransactionId("txn_")).toBe(false);
    expect(isPaddleTransactionId(TXN.toUpperCase())).toBe(false);
  });

  test("anything that is not a string is not an id", () => {
    for (const value of [undefined, null, 42, {}, [TXN]]) expect(isPaddleTransactionId(value)).toBe(false);
  });
});

describe("isPaddleSubscriptionId", () => {
  test("a real subscription id is one, and a transaction is not", () => {
    expect(isPaddleSubscriptionId(SUB)).toBe(true);
    expect(isPaddleSubscriptionId(TXN)).toBe(false);
  });

  test("the prefix alone is not an id, and neither is Paddle's alphabet shouted", () => {
    expect(isPaddleSubscriptionId("sub_")).toBe(false);
    expect(isPaddleSubscriptionId(SUB.toUpperCase())).toBe(false);
  });

  test("anything that is not a string is not an id", () => {
    for (const value of [undefined, null, 42, {}, [SUB]]) expect(isPaddleSubscriptionId(value)).toBe(false);
  });
});

/**
 * **The sweep: this module is the only one that decides what a Paddle id is.**
 *
 * Five producers answered that question across the Paddle rail and no two agreed (#681). `verify.ts` held a
 * regex, `refund.ts` and `refresh.ts` asked `startsWith` for a transaction, `refresh.ts` and
 * `subscription.ts` asked it for a subscription, and `objects.test.ts` asked it again to route a fixture to
 * a schema. The loose ones accepted the bare prefix and an alphabet Paddle does not issue, so one string
 * was a transaction in `refund.ts` and not one in `verify.ts`. Four of this kit's recurring defects are
 * that exact shape: a rule at a call site rather than at the thing being called.
 *
 * ## The invariant, and why it is not a list of banned calls
 *
 * #681 asks for the invariant rather than a list of banned verbs, and it is right to: banning `startsWith`
 * by name would miss a regex, an `indexOf`, a slice comparison and the next spelling. So the rule is about
 * the **prefix**, which no spelling can avoid writing down:
 *
 * > A Paddle id prefix may be written anywhere as a *value*. It may be **interrogated** only in the
 * > modules {@link PREFIX_READERS} names.
 *
 * That distinction is the whole design, and it is the easy half to get wrong. A bare prefix is also a
 * perfectly good test input — `client/paddleLink.test.ts` and `http/routes.workers.test.ts` both list one
 * beside `"javascript:alert(1)"` as something a URL must not be read as — and every red test #681 required
 * had to write one too. A gate that flagged the literal wherever it appeared would have been red on day
 * one for the tests proving it works. So {@link INTERROGATIONS} matches the literal only where
 * it is being *measured against*: as the sole argument of a member call, as an operand of an equality, or
 * anchored inside a pattern. A value in an array, an object field or a plain function call is not a rule.
 *
 * **Three forms, and between them any spelling of the question.** A prefix test has to compare the prefix
 * to the front of a string, and there are only three ways to write that: hand it to a method on the string,
 * compare it to a slice of the string, or anchor it in a regular expression. `^` is the whole of the third
 * form, because an unanchored `/txn_/` is a containment test rather than a prefix test — a different and
 * worse bug, and not one this rule is about.
 *
 * **Run over the raw text, not with comments stripped**, which is the choice `sameOrigin.test.ts` makes for
 * its own rule 1: a doc comment must not be able to hide a call site. The price is that prose spelling a
 * prefix test out in full trips the gate as well, and that is the right price — the prose explaining this
 * rule belongs in `paddleIds.ts`, which is where the first exemption is.
 *
 * ## The second net
 *
 * The text rules catch the question written down. The last test below catches it written in a spelling they
 * cannot see, by asserting from the other side: every module in the Paddle rail that reads a purchase row's
 * own id calls one of these two predicates. A call site moved back inline character by character still
 * fails that one.
 *
 * ## Both halves are held open
 *
 * An allowlist computed from today's callers is green by construction, so {@link PREFIX_READERS} is a
 * frozen literal and each entry carries the sentence somebody has to disagree with to add another. And a
 * sweep that matched nothing would pass in silence, so the walk has a floor, the exemptions are asserted
 * still to match, and the detector itself is exercised against a fixture rather than trusted. The
 * primitives' own exemption is held open *behaviorally* rather than by counting hits in their text: the
 * doc comment above them quotes the two patterns Paddle documents, so a text count stays at two even if
 * both regexes are loosened to a bare prefix.
 */

/** This package's root, so every path below reads as it does in the issue and in a `grep`. */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * This file, which the walk skips.
 *
 * A gate has to be able to write down the form it forbids — in its fixture, in the unit tests above, and in
 * the failure message it prints when it fires. Scanning itself would make it permanently red for saying
 * what it is for. The exclusion is one file, and it is asserted to be a file that exists and to be this
 * one, so it cannot quietly become a directory somebody hides a producer in.
 */
const THIS_GATE = "src/data/paddleIds.test.ts";

/** One source file, and the text it held when the walk read it. */
interface Source {
  /** Package-relative, `/`-separated — `src/rails/paddle/refund.ts`. */
  readonly path: string;
  /** Its contents, exactly as they are on disk. */
  readonly text: string;
}

/**
 * Every `.ts` file under `src/`, tests included.
 *
 * Tests included on purpose: `objects.test.ts` was the fifth producer, and a rule written into a test
 * helper is still a rule at a call site.
 *
 * **The whole package rather than `rails/paddle/` alone.** The issue asks for the rail, but a prefix test
 * is just as wrong in `http/`, in a workflow or in the browser half, and scanning wider is what turned up
 * `rails/stripe/pricing.ts` and made its exemption something a reader can see rather than something the
 * scope happened to miss.
 */
function sources(): Source[] {
  return readdirSync(`${PACKAGE_ROOT}src`, { recursive: true, encoding: "utf8" })
    .map((entry) => `src/${entry.split(sep).join("/")}`)
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        path !== THIS_GATE &&
        !path.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules"),
    )
    .map((path) => ({ path, text: readFileSync(`${PACKAGE_ROOT}${path}`, "utf8") }));
}

/**
 * The three ways a line can interrogate a Paddle id prefix.
 *
 * Each is the prefix next to the thing doing the measuring, which is what separates a rule from a value.
 * `MEMBER_TEST` names no method, so a spelling nobody has reached for yet is caught by the same line.
 */
const INTERROGATIONS: readonly RegExp[] = [
  /** `id.startsWith("txn_")`, `id.indexOf("sub_")`, and every other method on a string. */
  /\.[A-Za-z_$][\w$]*\(\s*(["'`])(?:txn|sub)_\1\s*\)/,
  /** `id.slice(0, 4) === "txn_"`, in either order. */
  /(?:===|!==|==|!=)\s*(["'`])(?:txn|sub)_\1|(["'`])(?:txn|sub)_\2\s*(?:===|!==|==|!=)/,
  /** `/^txn_[a-z0-9]+$/`, or the same string handed to `new RegExp`. */
  /\^(?:txn|sub)_/,
];

/**
 * The modules that may interrogate a Paddle id prefix, and why each one may.
 *
 * **A frozen literal, and it has two entries.** Not the files that happen to contain one today — the files
 * that are *allowed* to. A third entry is a claim that some module needs its own answer to "what is a
 * Paddle id"; write the claim down, and let a reviewer disagree with it.
 */
const PREFIX_READERS: Readonly<Record<string, string>> = {
  "src/data/paddleIds.ts":
    "The primitives themselves. This is the module the rule lives in, and the sweep exists to keep it the only one.",
  "src/rails/stripe/pricing.ts":
    "Stripe's own subscription ids, a different namespace that happens to share a prefix with Paddle's. Reading them through a Paddle predicate would fuse two stores' id spaces, which #681 calls the real bug and declines to introduce.",
};

/** Every line of `source` that interrogates a prefix, as `path:line: trimmed source`. */
function interrogations(source: Source): string[] {
  return source.text
    .split("\n")
    .map((line, number) =>
      INTERROGATIONS.some((pattern) => pattern.test(line)) ? `${source.path}:${number + 1}: ${line.trim()}` : null,
    )
    .filter((hit): hit is string => hit !== null);
}

describe("the detector the sweep depends on", () => {
  test("finds the prefix where it is measured against, and leaves it alone where it is a value", () => {
    // A bug here would silently disarm the gate, or make it red for the tests that prove it works. Both
    // halves are fixtures rather than assumptions.
    const rules = [
      'if (id.startsWith("txn_")) return id;',
      'if (!subscriptionId.startsWith("sub_")) return undefined;',
      'if (id.indexOf("sub_") === 0) return id;',
      'if (id.slice(0, 4) === "txn_") return id;',
      "const TRANSACTION_ID = /^txn_[a-z0-9]+$/;",
      'const pattern = new RegExp("^sub_[a-z0-9]+$");',
    ];
    const values = [
      'for (const value of ["", "txn_", "javascript:alert(1)"]) {',
      'const row = purchase({ providerTransactionId: "sub_" });',
      'expect(isPaddleTransactionId("txn_")).toBe(false);',
      `const bulk = \`txn_bulk_\${index}\`;`,
      `const url = \`/transactions/\${id}\`;`,
    ];
    for (const line of rules) {
      expect(interrogations({ path: "src/fixture.ts", text: line }), line).toHaveLength(1);
    }
    for (const line of values) {
      expect(interrogations({ path: "src/fixture.ts", text: line }), line).toEqual([]);
    }
  });
});

describe("one producer of what a Paddle id is", () => {
  const scanned = sources();

  test("the walk is reading this package, not an empty tree", () => {
    // Anti-vacuous. A walk that found nothing would make every assertion below pass in silence.
    expect(scanned.length).toBeGreaterThan(100);
    for (const path of Object.keys(PREFIX_READERS)) expect(scanned.map((source) => source.path)).toContain(path);
    // The one file the walk skips is a file, and it is this one.
    expect(readFileSync(`${PACKAGE_ROOT}${THIS_GATE}`, "utf8")).toContain("PREFIX_READERS");
    expect(scanned.map((source) => source.path)).not.toContain(THIS_GATE);
  });

  test("a Paddle id prefix is interrogated only where the frozen list says it may be", () => {
    const elsewhere = scanned
      .filter((source) => PREFIX_READERS[source.path] === undefined)
      .flatMap((source) => interrogations(source));
    expect(
      elsewhere,
      `A second answer to "what is a Paddle id". The prefix may be written as a value anywhere, but deciding whether a string is an id belongs to \`isPaddleTransactionId\` and \`isPaddleSubscriptionId\` in src/data/paddleIds.ts — a prefix test at a call site accepts the bare prefix and an alphabet Paddle does not issue, which is how the same string became a transaction in one module and not one in another (#681). Call a primitive — or, if this module genuinely answers a different question, add it to PREFIX_READERS in this file with the sentence that says so:\n${elsewhere.map((hit) => `  ${hit}`).join("\n")}`,
    ).toEqual([]);
  });

  test("every exemption still names a module that interrogates a prefix", () => {
    // An allowlist whose entries have quietly stopped matching anything reads as permission nobody
    // granted, and the next reader inherits it as precedent.
    const stale = Object.keys(PREFIX_READERS).filter((path) => {
      const source = scanned.find((candidate) => candidate.path === path);
      return source === undefined || interrogations(source).length === 0;
    });
    expect(
      stale,
      `These PREFIX_READERS entries no longer describe anything. Delete them:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  test("and the module it exempts still holds the tight rule, not just the prose about it", () => {
    // The other half of anti-vacuous: a rule permitting one module is worthless if that module stopped
    // being the one. Counting interrogations in its text does not establish that, and the first draft of
    // this test made exactly that mistake — `paddleIds.ts`'s own doc comment quotes the two patterns
    // Paddle documents, so loosening both regexes to a bare prefix left the count at two and the test
    // green. The exemption is asked instead to still buy what it was granted for.
    const primitives = scanned.find((source) => source.path === "src/data/paddleIds.ts") as Source;
    expect(primitives).toBeDefined();
    expect(primitives.text).toContain("export function isPaddleTransactionId");
    expect(primitives.text).toContain("export function isPaddleSubscriptionId");
    expect(isPaddleTransactionId("txn_"), "the transaction rule has been loosened back to a prefix").toBe(false);
    expect(isPaddleSubscriptionId("sub_"), "the subscription rule has been loosened back to a prefix").toBe(false);
  });

  test("every module in the Paddle rail that reads a purchase's own id asks a primitive what it is", () => {
    // The second net, and the one that does not depend on how the question is spelled. A call site moved
    // back inline — by a regex the rules above do not match, or character by character — still fails here,
    // because the module would be reading the column without asking either predicate about it.
    //
    // The Paddle rail alone: `lemonSqueezy/pricing.ts` reads the same column and must *not* ask a Paddle
    // predicate about it, because `subscription:<id>` is Lemon Squeezy's namespace and not Paddle's.
    const readers = scanned.filter(
      (source) =>
        source.path.startsWith("src/rails/paddle/") && /\bpurchase\.providerTransactionId\b/.test(source.text),
    );
    // Anti-vacuous: the three modules #681 routed are the readers, so a rename that empties this set is
    // visible rather than quietly permissive.
    expect(readers.map((source) => source.path).sort()).toEqual([
      "src/rails/paddle/refresh.ts",
      "src/rails/paddle/refund.ts",
      "src/rails/paddle/subscription.ts",
    ]);
    const unasked = readers
      .filter((source) => !/isPaddle(?:Transaction|Subscription)Id/.test(source.text))
      .map((source) => source.path);
    expect(
      unasked,
      `These modules read a purchase row's Paddle id and decide what it is without asking src/data/paddleIds.ts (#681):\n${unasked.map((path) => `  ${path}`).join("\n")}`,
    ).toEqual([]);
  });
});
