// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HOME_SCREEN, TEMPLATE_DIR, TEMPLATE_GROUPS } from "./templates";

/**
 * No scaffolded screen writes a same-origin, cookie-bearing request of its own.
 *
 * **This is the gate that matters most in the repository, because these files are the ones Pithy can
 * never fix.** A template is copied into an adopter's repository and becomes the adopter's file; a
 * request written into one is frozen there at the moment they ran `pithy init`, and a later correction
 * to the base path, the cookie mode or the failure directions reaches none of them. Six such requests
 * were frozen into every app scaffolded so far — `/get-session`, `/sign-out`, both OTP routes, the magic
 * link, and the social handoff. They call `@pithy-sh/auth/src/client/api` now (#370).
 *
 * ## The rule that bites is the cookie mode
 *
 * `#346`'s gate paid for this lesson: its `fetch(` rule **would not have caught the defect it was
 * written for**, because the offending module called an injected `fetcher` and the literal never
 * appeared in it. `credentials: "include"` is what makes a request carry the session, so a second
 * producer cannot avoid writing it. Rule 2 is the one that fires; rule 1 stops the next producer
 * reaching for the global.
 *
 * ## The permitted sets are frozen, and neither is derived from what the templates say today
 *
 * A gate whose allowlist is computed from its own subject is green by construction — it goes quiet at
 * exactly the moment it exists for. Both lists here are hand-written literals, each entry carrying the
 * sentence somebody has to disagree with to add another.
 */

/** Every template that ships, by path within the tree. */
function scaffoldedPaths(): string[] {
  return [...Object.values(TEMPLATE_GROUPS).flat(), HOME_SCREEN.auth, HOME_SCREEN.bare].sort();
}

/** One template, and the text it held when the sweep read it. */
interface Template {
  /** Tree-relative, `/`-separated — `src/routes/pithy/sign-in.tsx`. */
  readonly path: string;
  /** Its contents. */
  readonly text: string;
}

/** Every shipped template, read. */
function templates(): Template[] {
  return scaffoldedPaths().map((path) => ({ path, text: readFileSync(join(TEMPLATE_DIR, path), "utf8") }));
}

/**
 * The same text with comments blanked out, line structure intact.
 *
 * Character by character rather than by regular expression, because the thing that has to be right is
 * that a `//` inside a string — `"https://challenges.cloudflare.com/…"` — is not the start of a comment.
 * The prose explaining the rule is not a breach of it, and a gate satisfiable by rewording a comment
 * would be measuring the wrong thing.
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
function hits(template: Template, text: string, pattern: RegExp): string[] {
  return text
    .split("\n")
    .map((line, number) => (pattern.test(line) ? `${template.path}:${number + 1}: ${line.trim()}` : null))
    .filter((hit): hit is string => hit !== null);
}

/**
 * Where a `fetch(` may appear in a shipped template, and why it is not the rule this file polices.
 *
 * **A frozen literal, and it has one entry.** `src/routes/app/home.bare.tsx` is the home screen a
 * project scaffolded *without* auth gets — it is the only screen that ships to a repository with no
 * `@pithy-sh/auth` in its `package.json`, so it cannot import the primitive and must not pretend to.
 * What makes that safe is that its request carries **no ambient credential at all**: `/health` is a
 * public liveness route that reads nothing about the caller, and the `credentials: "include"` it used
 * to write was deleted rather than routed. A request with no session on it is not the rule `callAuth`
 * owns, and adding a second primitive somewhere both templates could reach would be inventing a seam
 * for one unauthenticated GET.
 *
 * The cookie-mode rule below still covers this file, which is what keeps that argument honest: put the
 * credential back and rule 2 fires, exemption or not.
 */
const FETCH_EXEMPTIONS: Readonly<Record<string, string>> = {
  "src/routes/app/home.bare.tsx":
    "The no-auth home screen. `@pithy-sh/auth` is not a dependency of the project this ships to, and its one request is an uncredentialed GET to the public `/health` route.",
};

/**
 * The templates that may write the cookie mode. **A frozen literal, and it is empty.**
 *
 * There is no correct reason for a scaffolded screen to name the cookie mode. It is the transport, and
 * the transport belongs to `@pithy-sh/auth` where it can still be corrected after the file is somebody
 * else's. An empty permitted set is the strongest form this rule can take, so it is the form it takes.
 */
const SAME_ORIGIN_PRODUCERS: readonly string[] = [];

/** `credentials: "include"` and its siblings — the cookie mode, in any quoting. */
const COOKIE_MODE = /credentials\s*:\s*["']/;

/** The issue's grep, verbatim. */
const FETCH_CALL = /fetch\(/;

/** The primitive every credentialed request goes through. */
const PRIMITIVE = "@pithy-sh/auth/src/client/api";

describe("the comment stripper the cookie-mode rule depends on", () => {
  test("keeps code and blanks comments, and a `//` inside a string is not a comment", () => {
    const fixture = [
      'const src = "https://challenges.cloudflare.com/turnstile/v0/api.js";',
      '// credentials: "include"',
      '/* credentials: "include" */',
      'const init = { credentials: "include" };',
    ].join("\n");
    const stripped = withoutComments(fixture);
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped.split("\n")[0]).toBe('const src = "https://challenges.cloudflare.com/turnstile/v0/api.js";');
    expect(COOKIE_MODE.test(stripped.split("\n")[1] ?? "")).toBe(false);
    expect(COOKIE_MODE.test(stripped.split("\n")[2] ?? "")).toBe(false);
    expect(COOKIE_MODE.test(stripped.split("\n")[3] ?? "")).toBe(true);
  });
});

describe("no scaffolded screen produces the same-origin request", () => {
  const scanned = templates();

  test("the sweep is reading the template tree, not an empty one", () => {
    // Anti-vacuous. A sweep that found nothing would make every assertion below pass in silence.
    expect(scanned.length).toBeGreaterThan(10);
    expect(scanned.map((template) => template.path)).toContain("src/routes/pithy/sign-in.tsx");
    expect(scanned.map((template) => template.path)).toContain("src/session.tsx");
    for (const path of Object.keys(FETCH_EXEMPTIONS)) expect(scanned.map((t) => t.path)).toContain(path);
  });

  test("the cookie mode appears in no template at all", () => {
    const elsewhere = scanned
      .filter((template) => !SAME_ORIGIN_PRODUCERS.includes(template.path))
      .flatMap((template) => hits(template, withoutComments(template.text), COOKIE_MODE));
    expect(
      elsewhere,
      `A scaffolded screen writes the cookie mode. \`credentials: "include"\` is what makes a request carry the session, and a screen copied into an adopter's repository is the one place Pithy can never correct it. Call ${PRIMITIVE} instead (#370):\n${elsewhere.map((hit) => `  ${hit}`).join("\n")}`,
    ).toEqual([]);
  });

  test("`fetch(` appears only where the frozen exemption list says it may", () => {
    const unexplained = scanned
      .filter((template) => FETCH_EXEMPTIONS[template.path] === undefined)
      .flatMap((template) => hits(template, template.text, FETCH_CALL));
    expect(
      unexplained,
      `A \`fetch(\` in a scaffolded screen. A screen names an intent; the transport belongs to ${PRIMITIVE}, which upgrades with a minor release after this file is the adopter's (#370). Route it through the primitive — or, if it genuinely carries no ambient credential and cannot reach the primitive, add it to FETCH_EXEMPTIONS in this file with the sentence that says so:\n${unexplained.map((hit) => `  ${hit}`).join("\n")}`,
    ).toEqual([]);
  });

  test("every exemption still names a template that calls `fetch(`", () => {
    // An allowlist whose entries have quietly stopped matching anything reads as permission nobody
    // granted, and the next reader inherits it as precedent.
    const stale = Object.keys(FETCH_EXEMPTIONS).filter((path) => {
      const template = scanned.find((candidate) => candidate.path === path);
      return template === undefined || !FETCH_CALL.test(template.text);
    });
    expect(
      stale,
      `These FETCH_EXEMPTIONS entries no longer describe anything. Delete them:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  test("the exempt screen is exempt from `fetch(` and not from the credential", () => {
    // The failure mode of any allowlist: an entry granted for one reason, later used for another. The
    // exemption is for an *uncredentialed* request, so this is the sentence it was granted on.
    const widened = Object.keys(FETCH_EXEMPTIONS).flatMap((path) => {
      const template = scanned.find((candidate) => candidate.path === path);
      return template === undefined ? [] : hits(template, withoutComments(template.text), COOKIE_MODE);
    });
    expect(
      widened,
      `An exempt screen now sets the cookie mode. Its exemption does not cover that:\n${widened.join("\n")}`,
    ).toEqual([]);
  });

  test("the screens that ask this worker an auth question call the primitive", () => {
    // The positive half. Rules 1 and 2 both go quiet if the calls simply disappear — a screen that
    // stopped signing anybody in would satisfy them perfectly. These are the three files that held
    // five of the six requests, named here rather than discovered, so deleting a call is a red test.
    // The sixth lived in `home.bare.tsx` and is the exemption above, for the reason written there.
    const callers = ["src/session.tsx", "src/routes/pithy/otp.tsx", "src/routes/pithy/sign-in.tsx"];
    for (const path of callers) {
      const template = scanned.find((candidate) => candidate.path === path);
      expect(template, `${path} no longer ships`).toBeDefined();
      expect(template?.text, `${path} stopped calling the primitive`).toContain(PRIMITIVE);
    }
  });
});
