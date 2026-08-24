// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

/**
 * **No screen this kit seeds writes a sentence a translator cannot reach.**
 *
 * Every template renders through `t.t(key)` now, and every one of those keys is answered by a baked
 * `satisfies MessageCatalog` block that travels with the file. The hard part is keeping it that way: a
 * screen gains a button, the button gains a label, and one bare string ships into every adopter's
 * repository as the one sentence their Spanish readers meet in English. Nothing else notices, because a
 * bare string renders perfectly.
 *
 * ## Why this is a sweep and not a GritQL plugin
 *
 * The obvious tool is a Biome plugin — `plugins/no-raw-request-input.grit` is the same shape one level
 * over. It does not work here, and the reason is specific rather than general: **GritQL's `JsxText()`
 * matches the text between tags and nothing else.** It never sees
 *
 * - `aria-label="Continue with Google"` — the accessible name, which is copy by definition,
 * - `placeholder="Your email address"`,
 * - `title="…"` or `alt="…"`,
 * - `{"Check your inbox."}`, an expression container holding a literal,
 * - `const TITLE = "Welcome back.";` above the return.
 *
 * `sign-in.tsx` carries translatable copy in **all five** of those positions today — its provider
 * buttons' accessible names are the entire subject of WCAG 2.5.3 for that screen — so a `JsxText()`
 * rule would have passed the file it exists for. Two further facts settle it: a `.grit` edit does not
 * trigger a CI full run, since `GLOBAL_PATHS` names `biome.jsonc` and not `plugins/`; and a plugin
 * scoped to a `templates/` tree would have to be excluded from the license-header rule that forbids
 * those trees a header, which is one more special case for one more file.
 *
 * ## What counts as copy
 *
 * A string is copy when it reads as **prose**: two or more alphabetic words with whitespace between
 * them. That is the line, and it is drawn where it is because the alternative — any string with letters
 * in it — flags `pithy.config.ts` and `paddle` inside a `<code>`, the `secondary auth__provider` in a
 * class list, and `https://challenges.cloudflare.com/…` in a const. Those are identifiers, and an
 * identifier rendered in Spanish names something that does not exist.
 *
 * The cost is honest: **a one-word sentence is invisible to this.** `Or`, standing alone between the
 * providers and the form, would pass. It is a real hole and it is the narrow one — a single word cannot
 * be told from a class name or a brand by any rule over text — and it is covered from the other side,
 * because `ci/catalogCoverage.test.ts` reads the catalog that word would have to be missing from.
 *
 * ## Comments are blanked, not deleted
 *
 * With the shared stripper, and not one written here — `packages/cli/src/ci/commentStripping.test.ts`
 * fails any gate that rolls its own, because a pattern has no notion of a string and a URL's `//`
 * silently switches the scan off for the rest of its line. It matters more here than almost anywhere:
 * these templates are the most heavily commented files in the repository, every docblock is prose, and
 * prose is exactly what this looks for.
 */

/** Every template file this sweep reads: source that renders, never a test and never a declaration. */
function templateSources(directory: string = TEMPLATE_DIR, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") templateSources(path, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    if (path.endsWith(".d.ts") || path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    found.push(path);
  }
  return found.sort();
}

/** Prose: two alphabetic words with whitespace between them. See the docblock for where this line sits. */
const PROSE = /[A-Za-z][A-Za-z'’]*\s+[A-Za-z]/;

/**
 * The attributes whose value a reader hears or reads.
 *
 * `aria-label` first, because it is the one a screen reader announces and the one WCAG 2.5.3 is about.
 * `title` and `alt` and `placeholder` are the rest of the set an adopter reaches for without thinking
 * of it as copy — which is exactly why they are named.
 */
const LABEL_ATTRIBUTE = /\b(aria-label|placeholder|title|alt)\s*=\s*(["'])((?:\\.|(?!\2).)*)\2/g;

/** A JSX expression container holding nothing but a literal: `{"Check your inbox."}`. */
const LITERAL_CONTAINER = /\{\s*(["'])((?:\\.|(?!\1).)*)\1\s*\}/g;

/** A string hoisted into a `const` — the sentence written above the return rather than inside it. */
const CONST_STRING = /\bconst\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]*)?=\s*(["'])((?:\\.|(?!\1).)*)\1/g;

/**
 * Text between a tag's `>` and the next `<` that opens a closing tag or a lowercase element.
 *
 * The narrowing is against TypeScript's own angle brackets: `Promise<void>` and `ReadonlyMap<K, V>` end
 * in a `>` with code after it, and there is no way to tell that `>` from a tag's by looking at it. Two
 * facts separate them and both are cheap — a generic's close is followed by more code rather than by a
 * tag, and the code that follows it holds a semicolon, an assignment, a quote or a call. Measured over
 * this tree: seven false positives before the narrowing, none after.
 */
const JSX_TEXT = />([^<>{}]+)<(?=\/|[a-z])/g;

/** The shapes that make a run of characters code rather than a sentence. A call needs its callee. */
const CODE_IN_TEXT = /[;=`"|]|[A-Za-z_$\])]\(/;

/** One string a template says out loud, with the position it says it from. */
interface Copy {
  /** Which of the five positions it was written in. */
  readonly position: "attribute" | "container" | "const" | "text";
  /** The words themselves, trimmed. */
  readonly text: string;
}

/**
 * Every bare sentence in one template's source.
 *
 * **A sweep proven only against the real tree is proven against a tree that passes** — it reports
 * nothing whether the detector works or not, and "reports nothing" is what passing looks like. So the
 * fixtures below drive this directly, one case per position, and each of the five is a shape
 * `JsxText()` would have missed.
 */
function bareCopy(source: string): Copy[] {
  const code = blankComments(source);
  const found: Copy[] = [];
  const take = (position: Copy["position"], text: string): void => {
    if (PROSE.test(text)) found.push({ position, text: text.trim() });
  };
  for (const match of code.matchAll(LABEL_ATTRIBUTE)) take("attribute", match[3] as string);
  for (const match of code.matchAll(LITERAL_CONTAINER)) take("container", match[2] as string);
  for (const match of code.matchAll(CONST_STRING)) take("const", match[2] as string);
  for (const match of code.matchAll(JSX_TEXT)) {
    const text = match[1] as string;
    if (!CODE_IN_TEXT.test(text)) take("text", text);
  }
  return found;
}

/** Repo-relative and POSIX-separated, so a failure reads the same on every machine. */
function named(path: string): string {
  return relative(join(TEMPLATE_DIR, "..", "..", ".."), path)
    .split(sep)
    .join("/");
}

describe("no screen ships a sentence the catalog cannot reach", () => {
  test("the sweep reads the whole template tree, so an empty report means something", () => {
    // The anti-vacuity guard. Fifteen `.tsx` screens and shell modules plus one `.ts` — `vite.config.ts`,
    // the only one in the tree, since the `tsconfig.*.json` files are JSON and `client-env.d.ts` is
    // excluded above. A walk returning three would report nothing and look identical to a clean tree.
    const files = templateSources();
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.map(named)).toContain("packages/ui-react/templates/src/routes/pithy/sign-in.tsx");
  });

  test("every template renders through the translator and never around it", () => {
    const findings = templateSources().flatMap((path) =>
      bareCopy(readFileSync(path, "utf8")).map((copy) => `${named(path)} [${copy.position}] ${copy.text}`),
    );
    expect(
      findings,
      "A template writes copy a translator cannot reach. Move it into that file's `satisfies MessageCatalog` block and render it with `t.t(key)`, then add the key to `packages/i18n/src/catalogs/<locale>/`.",
    ).toEqual([]);
  });

  test("the one HTML file says nothing a reader reads", () => {
    // Out of the sweep above and checked on its own, because its comment grammar is not JavaScript's
    // and the shared stripper does not speak it — reading it with the sweep would mean a second comment
    // stripper, which `packages/cli/src/ci/commentStripping.test.ts` refuses on principle. There is one
    // text node in the file and it is a substitution token `pithy ui add` fills with the worker's name.
    const html = readFileSync(join(TEMPLATE_DIR, "index.html"), "utf8");
    expect(html).toContain("<title>__PITHY_WORKER__</title>");
    expect(html.match(/<title>([^<]*)<\/title>/)?.[1]).toBe("__PITHY_WORKER__");
  });
});

describe("the detector can fail, in each position GritQL would have missed", () => {
  const positions = (source: string): string[] => bareCopy(source).map((copy) => `${copy.position}:${copy.text}`);

  test("text between tags, on one line and across several", () => {
    expect(positions("<h1>Welcome back.</h1>")).toEqual(["text:Welcome back."]);
    expect(positions('<p className="muted">\n  A link is on its way.\n</p>')).toEqual(["text:A link is on its way."]);
    // The half before a nested element. `JsxText()` does see this one; it is here so the narrowing that
    // keeps generics out is not quietly also keeping this out.
    expect(positions("<p>Read the <a>terms</a></p>")).toEqual(["text:Read the"]);
  });

  test("the four attributes a reader hears", () => {
    expect(positions('<button aria-label="Continue with Google" />')).toEqual(["attribute:Continue with Google"]);
    expect(positions('<input placeholder="Your email address" />')).toEqual(["attribute:Your email address"]);
    expect(positions('<abbr title="One time password" />')).toEqual(["attribute:One time password"]);
    expect(positions('<img alt="A friendly robot" src="/r.png" />')).toEqual(["attribute:A friendly robot"]);
  });

  test("a literal in an expression container", () => {
    expect(positions('<p>{"Check your inbox."}</p>')).toEqual(["container:Check your inbox."]);
  });

  test("a sentence hoisted above the return", () => {
    expect(positions('const TITLE = "Welcome back.";')).toEqual(["const:Welcome back."]);
    expect(positions("const TITLE: string = 'Welcome back.';")).toEqual(["const:Welcome back."]);
  });
});

describe("the detector does not fail on what a screen is allowed to say", () => {
  test("an identifier is not copy, wherever it is rendered", () => {
    // `pithy.config.ts` and `paddle` are rendered inside `<code>` on the two empty-state screens, and a
    // translation of either names a file or a rail that does not exist.
    expect(bareCopy("<code>pithy.config.ts</code>")).toEqual([]);
    expect(
      bareCopy('const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";'),
    ).toEqual([]);
  });

  test("a translated string is not a bare one", () => {
    expect(bareCopy('<h1>{t.t("auth/sign_in.title")}</h1>')).toEqual([]);
    expect(bareCopy('<button aria-label={t.t("auth/sign_in.provider.label", { provider })} />')).toEqual([]);
  });

  test("the baked catalog is the catalog, not a finding", () => {
    // Every screen holds one, every value in it is prose, and every one of them is the point.
    expect(bareCopy('const EN = {\n  "auth/sign_in.title": "Welcome.",\n} satisfies MessageCatalog;')).toEqual([]);
  });

  test("TypeScript's angle brackets are not tags", () => {
    expect(bareCopy("function loadScript(): Promise<void> {\n  return script;\n}")).toEqual([]);
    expect(bareCopy("const byRole = new Map<string, Screen>();\nconst table = await routeTable();")).toEqual([]);
  });

  test("prose in a comment is prose", () => {
    // The templates are the most heavily commented files in this repository. Without the stripper this
    // sweep would report a hundred findings and be deleted within the week.
    expect(bareCopy('// A heading that says Welcome back to the reader.\n<h1>{t.t("a/b")}</h1>')).toEqual([]);
  });
});

/**
 * **A server's refusal is copy too, and it is the copy a reader meets at the worst moment.**
 *
 * The sweep above catches a sentence a screen *writes*. This one catches a sentence a screen *relays*.
 * Every selling screen rendered `failure.message` — the public message off a `PaymentsFailure`, which
 * is English and is permanently English, because `message` is written at the throw site and the server
 * never localizes one (`docs/I18N.md` § *Errors*). So a page that was Spanish in every other respect
 * turned English the moment a purchase failed, a price could not be quoted, or the store could not be
 * reached.
 *
 * Neither of the two gates that exist could see it. `templateCopy`'s prose detector finds bare
 * *literals*, and `failure.message` is an expression. `ci/catalogCoverage.test.ts` reads the key sets
 * and finds `payments/product_not_found` present on both sides — **the kit ships the Spanish, and the
 * screen never looks it up**, which is a hole no comparison of catalogs can have an opinion about.
 *
 * ## The rule, and why it is spelled as a ban
 *
 * A failure carries a namespaced `code`, and for an error the code *is* the catalog key. So the lookup
 * is `t.maybe(failure.code, failure.params) ?? failure.message`, and it lives in one place — `failureText` in
 * `src/payments.tsx`, beside `CHECKOUT_FRAME` and for its reason: three screens render a failure, and
 * three copies of one lookup is two screens still speaking English the day somebody fixes the third.
 *
 * Which makes the check a ban rather than a pattern match. **No template but that one may read
 * `.message` at all.** Nothing else in the tree has a `.message` to read — a `PaymentsFailure` is the
 * only thing carrying one — so the ban costs nothing, and unlike a rule that tries to recognize the
 * *correct* shape it cannot be satisfied by a lookup that is subtly not the documented one.
 */

/** The one template that may read a failure's `message`: where `failureText` is defined. */
const FAILURE_HELPER = "src/payments.tsx";

/** How a screen reaches the helper. Every failure a screen renders goes through this call. */
const HELPER_CALL = "failureText(";

/** Every line that reads a `.message`, numbered, with comments blanked first. */
function rawMessages(source: string): string[] {
  return blankComments(source)
    .split("\n")
    .flatMap((line, index) => (/\.message\b/.test(line) ? [`${index + 1}: ${line.trim()}`] : []));
}

/** The template's path relative to the seeded tree — `src/payments.tsx`, as the ledger writes it. */
function seeded(path: string): string {
  return relative(TEMPLATE_DIR, path).split(sep).join("/");
}

describe("no screen relays the server's English to a reader who asked for another language", () => {
  /** The screens that render a `PaymentsFailure`. Named, so deleting the render is not a way to pass. */
  const SELLING = ["src/routes/pithy/paywall.tsx", "src/routes/pithy/pricing.tsx", "src/routes/pithy/subscription.tsx"];

  test("the three screens that render a failure still render one, through the helper", () => {
    // The anti-vacuity guard, and it is the one that matters here: the ban below is satisfied perfectly
    // by a tree that renders no failure at all, which is a worse page than an English one.
    for (const screen of SELLING) {
      const source = readFileSync(join(TEMPLATE_DIR, screen), "utf8");
      expect(source, `${screen} renders no failure — the sweep below would pass over nothing`).toContain(HELPER_CALL);
    }
  });

  test("the helper is the documented lookup, and it is the only reader of a message", () => {
    const helper = blankComments(readFileSync(join(TEMPLATE_DIR, FAILURE_HELPER), "utf8"));
    // `maybe`, not `t`: `t` is total, so a code no catalog covers would render as the code itself.
    expect(helper).toContain("t.maybe(failure.code, failure.params) ?? failure.message");
  });

  test("no other template reads a failure's message", () => {
    const findings = templateSources().flatMap((path) => {
      const at = seeded(path);
      if (at === FAILURE_HELPER) return [];
      return rawMessages(readFileSync(path, "utf8")).map((line) => `${named(path)} ${line}`);
    });
    expect(
      findings,
      "A screen renders a server's `message` directly. That sentence is English permanently. Render `failureText(t, failure)` from `src/payments.tsx` instead, which is `t.maybe(failure.code, failure.params) ?? failure.message`.",
    ).toEqual([]);
  });
});

describe("the failure detector can fail", () => {
  test("a message rendered straight is a finding, wherever it is reached from", () => {
    expect(rawMessages('<p className="muted">{failure.message}</p>')).toEqual([
      '1: <p className="muted">{failure.message}</p>',
    ]);
    expect(rawMessages("{checkout.failure && <p>{checkout.failure.message}</p>}")).toHaveLength(1);
    expect(rawMessages("const words = readFailure.message;")).toHaveLength(1);
  });

  test("the helper call is not a finding, and neither is prose about one", () => {
    expect(rawMessages("<p>{failureText(t, failure)}</p>")).toEqual([]);
    // The templates are the most heavily commented files here, and this rule's own argument names the
    // field it bans in half a dozen docblocks. Without the stripper it would report every one of them.
    expect(rawMessages("// Rendering failure.message straight is the defect this exists to stop.")).toEqual([]);
  });
});
