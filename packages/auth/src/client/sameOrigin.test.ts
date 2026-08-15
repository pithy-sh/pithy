// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * One producer of the same-origin request, held by a gate rather than by a convention.
 *
 * `callAuth` in `./api.ts` is the only place that knows how a browser program asks this Worker an auth
 * question: the base-path join, `credentials: "include"`, the same-origin refusal, and the three ways
 * an answer can fail to be one. Before it existed, six scaffolded screens each wrote that transport out
 * by hand — and a scaffolded screen is copied into an adopter's repository, so a later fix to any of it
 * reaches none of them (#370).
 *
 * ## The rule that bites is the cookie mode, not `fetch(`
 *
 * This is the lesson `#346`'s gate paid for and it is not obvious. Its first rule scanned for the
 * literal `fetch(` — and **would not have caught the defect it was written for**, because the offending
 * module called an injected `fetcher` and the literal never appeared in it. `credentials: "include"` is
 * what makes a request carry the session, so a second producer cannot avoid writing it. That is rule 2,
 * and it is the one that fires. Rule 1 is what stops the next producer reaching for the global directly.
 *
 * ## Neither permitted set is derived from the code it polices
 *
 * **A gate whose allowlist is computed from today's callers is green by construction.** Both lists below
 * are frozen literals written by hand, each entry carrying the sentence somebody has to disagree with to
 * add another. Adding one is an edit to this file, in a diff, with a reason.
 *
 * The comment stripper rule 2 reads through is exercised against a fixture rather than trusted: a bug in
 * it would silently disarm the gate.
 */

/** This package's root, so every path below reads as it does in the issue and in a `grep`. */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * This file, which the walk skips.
 *
 * A gate has to be able to write down the pattern it forbids — in its fixtures, and in the failure
 * message it prints when it fires. Scanning itself would make it permanently red for saying what it is
 * for. The exclusion is one file and is asserted to be a file that exists, so it cannot quietly become a
 * directory somebody hides a producer in.
 */
const THIS_GATE = "src/client/sameOrigin.test.ts";

/** One source file, and the text it held when the walk read it. */
interface Source {
  /** Package-relative, `/`-separated — `src/client/api.ts`. */
  readonly path: string;
  /** Its contents. */
  readonly text: string;
}

/** Every `.ts` file under `src/`, tests included — a second producer in a test helper is still one. */
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
 * The same text with every comment blanked out, line structure intact.
 *
 * Character by character rather than by regular expression, because the thing that has to be right is
 * that a `//` inside a string — `"https://accounts.google.com"` — is not the start of a comment.
 * Comments become spaces rather than disappearing, so a reported line number is still the line in the
 * file.
 */
function withoutComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === "//") {
      while (index < text.length && text[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (two === "/*") {
      while (index < text.length && text.slice(index, index + 2) !== "*/") {
        out += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += "  ";
      index += 2;
      continue;
    }
    const quote = text[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      out += quote;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        // An escape consumes the character after it, so `"\\""` does not end here.
        if (text[index] === "\\") {
          out += text.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += text[index];
        index += 1;
      }
      out += text[index] ?? "";
      index += 1;
      continue;
    }
    out += quote;
    index += 1;
  }
  return out;
}

/** Every line of `text` matching `pattern`, as `path:line: trimmed source`. */
function hits(source: Source, text: string, pattern: RegExp): string[] {
  return text
    .split("\n")
    .map((line, number) => (pattern.test(line) ? `${source.path}:${number + 1}: ${line.trim()}` : null))
    .filter((hit): hit is string => hit !== null);
}

/**
 * Where a `fetch(` may appear in this package, and why each one is not the rule this file polices.
 *
 * **A frozen literal.** Not the files that happen to contain one today — the files that are *allowed*
 * to, each with the sentence that justifies it. A new entry is a claim that some module needs its own
 * transport. Write the claim down, and let a reviewer disagree with it.
 */
const FETCH_EXEMPTIONS: Readonly<Record<string, string>> = {
  "src/test-utils/liveApp.ts":
    "`app.fetch(...)` — dispatching into a Hono app under test, in a Worker. No network, no browser, no cookie mode of its own.",
  "src/instance/googleProvider.integration.test.ts":
    "A live integration test driving a real deployed Worker and Google's own endpoints from Node, by absolute URL. Not a browser program, and not this Worker's own origin.",
  "src/http/turnstileGate.integration.test.ts":
    "A live integration test driving a real deployed Worker and Cloudflare's siteverify endpoint from Node, by absolute URL. Not a browser program.",
  "src/http/clientRoundTrip.test.ts":
    "Node's `fetch` standing in for a browser against a real listening port, so the primitive can be driven over a real socket with a real cookie jar. It is the harness the primitive is tested through, not a second producer: it takes the relative path `callAuth` produced and resolves it, and nothing in the package calls it.",
};

/**
 * The modules that may write the cookie mode. **A frozen literal, and it has one entry.**
 *
 * One module knows that a request to this Worker carries the session cookie. That is the whole rule, and
 * a list of one is the strongest form it can take.
 */
const SAME_ORIGIN_PRODUCERS: readonly string[] = ["src/client/api.ts"];

/** `credentials: "include"` and its siblings — the cookie mode, in any quoting. */
const COOKIE_MODE = /credentials\s*:\s*["']/;

/** The issue's grep, verbatim. */
const FETCH_CALL = /fetch\(/;

describe("the comment stripper rule 2 depends on", () => {
  test("keeps code and blanks comments, and a `//` inside a string is not a comment", () => {
    const fixture = [
      'const url = "https://accounts.google.com";',
      '// credentials: "include"',
      '/* credentials: "include" */',
      'const init = { credentials: "include" };',
    ].join("\n");
    const stripped = withoutComments(fixture);
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped.split("\n")[0]).toBe('const url = "https://accounts.google.com";');
    expect(COOKIE_MODE.test(stripped.split("\n")[1] ?? "")).toBe(false);
    expect(COOKIE_MODE.test(stripped.split("\n")[2] ?? "")).toBe(false);
    expect(COOKIE_MODE.test(stripped.split("\n")[3] ?? "")).toBe(true);
  });
});

describe("one producer of the same-origin request", () => {
  const scanned = sources();

  test("the walk is reading this package, not an empty tree", () => {
    // Anti-vacuous. A walk that found nothing would make every assertion below pass in silence.
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.map((source) => source.path)).toContain("src/client/api.ts");
    for (const path of Object.keys(FETCH_EXEMPTIONS)) expect(scanned.map((source) => source.path)).toContain(path);
    // The one file the walk skips is a file, and it is this one.
    expect(readFileSync(`${PACKAGE_ROOT}${THIS_GATE}`, "utf8")).toContain("SAME_ORIGIN_PRODUCERS");
    expect(scanned.map((source) => source.path)).not.toContain(THIS_GATE);
  });

  test("`fetch(` appears only where the frozen exemption list says it may", () => {
    const unexplained = scanned
      .filter((source) => FETCH_EXEMPTIONS[source.path] === undefined)
      .flatMap((source) => hits(source, source.text, FETCH_CALL));
    expect(
      unexplained,
      `A \`fetch(\` outside the same-origin primitive. A browser program asks this Worker an auth question through \`callAuth\` in src/client/api.ts, and a second producer of that request is how the base path, the cookie mode and the failure directions drift apart (#370). Route it through the primitive — or, if it is genuinely not a browser program's request to this Worker, add it to FETCH_EXEMPTIONS in this file with the sentence that says so:\n${unexplained.map((hit) => `  ${hit}`).join("\n")}`,
    ).toEqual([]);
  });

  test("every exemption still names a file that calls `fetch(`", () => {
    // An allowlist whose entries have quietly stopped matching anything reads as permission nobody
    // granted, and the next reader inherits it as precedent.
    const stale = Object.keys(FETCH_EXEMPTIONS).filter((path) => {
      const source = scanned.find((candidate) => candidate.path === path);
      return source === undefined || !FETCH_CALL.test(source.text);
    });
    expect(
      stale,
      `These FETCH_EXEMPTIONS entries no longer describe anything. Delete them:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  test("no exemption is a same-origin call wearing an outbound coat", () => {
    // The failure mode of any allowlist: an entry granted for one reason, later used for another. None
    // of the exempt files is a browser program, so a cookie mode inside one is the exemption being
    // spent on the rule it was excused from.
    const widened = Object.keys(FETCH_EXEMPTIONS).flatMap((path) => {
      const source = scanned.find((candidate) => candidate.path === path);
      return source === undefined ? [] : hits(source, withoutComments(source.text), COOKIE_MODE);
    });
    expect(
      widened,
      `An exempt caller now sets the browser cookie mode. Its exemption does not cover that:\n${widened.join("\n")}`,
    ).toEqual([]);
  });

  test("the cookie mode is written in one module and nowhere else", () => {
    const elsewhere = scanned
      .filter((source) => !SAME_ORIGIN_PRODUCERS.includes(source.path))
      .flatMap((source) => hits(source, withoutComments(source.text), COOKIE_MODE));
    expect(
      elsewhere,
      `A second producer of the same-origin request. \`credentials: "include"\` is what makes a request to this Worker carry the session, and exactly one module may write it — ${SAME_ORIGIN_PRODUCERS.join(", ")}. Call \`callAuth\` instead (#370):\n${elsewhere.map((hit) => `  ${hit}`).join("\n")}`,
    ).toEqual([]);
  });

  test("and the producer it names actually writes it", () => {
    // The other half of anti-vacuous: a rule permitting one module is worthless if that module stopped
    // being the one, because then the permitted set is empty and the gate polices nothing.
    const primitive = scanned.find((source) => source.path === "src/client/api.ts");
    expect(primitive).toBeDefined();
    expect(hits(primitive as Source, withoutComments((primitive as Source).text), COOKIE_MODE)).not.toEqual([]);
  });
});

/**
 * Every module that compiles into an adopter's browser bundle, and everything each may import.
 *
 * **A frozen literal, and the whole of the no-Zod rule.** The primitive stays free of Zod not because
 * nobody has added it but because its import list is empty and this says so. Zod is not banned by name —
 * naming it would be a rule about one package rather than about the graph — every specifier is refused
 * unless it is written here, so `../http/responses` and `@pithy-sh/core` are refused too, and each of
 * those would drag the Worker's schema graph into an adopter's build exactly as `zod` would.
 */
const BROWSER_MODULES: Readonly<Record<string, readonly string[]>> = {
  // The primitive. No imports at all, which is the strongest form the rule can take — and the reason
  // nothing here throws a `PithyError`: the class is not in reach, and a bare `Error` is forbidden.
  "src/client/api.ts": [],
};

describe("the browser half carries no schema library", () => {
  /** Every module specifier a file imports — type-only and bare side-effect imports included. */
  function specifiers(text: string): string[] {
    const code = withoutComments(text);
    return [
      ...code.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gms),
      ...code.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ].map((match) => match[1] ?? "");
  }

  test("the frozen list still names files that exist", () => {
    const paths = sources().map((source) => source.path);
    for (const path of Object.keys(BROWSER_MODULES)) expect(paths).toContain(path);
  });

  test("no browser module imports anything outside its frozen allowlist", () => {
    const scanned = sources();
    for (const [path, allowed] of Object.entries(BROWSER_MODULES)) {
      const source = scanned.find((candidate) => candidate.path === path) as Source;
      const forbidden = specifiers(source.text).filter((specifier) => !allowed.includes(specifier));
      expect(
        forbidden,
        `${path} compiles into an adopter's browser bundle. These imports are not on its allowlist, and a schema graph reached from here breaks their build rather than ours:\n${forbidden.map((specifier) => `  ${specifier}`).join("\n")}`,
      ).toEqual([]);
    }
  });

  test("the scan reads real imports, so the allowlist is not vacuous", () => {
    // A specifier reader that matched nothing would report every module as importing nothing at all,
    // and the rule above would be green over a file full of imports.
    const scanned = sources();
    const consumer = scanned.find((source) => source.path === "src/client/api.test.ts") as Source;
    expect(specifiers(consumer.text)).toEqual(["vitest", "./api"]);
  });
});
