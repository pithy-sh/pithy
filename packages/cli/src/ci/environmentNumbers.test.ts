// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **A number an operator typed is not a number until something says so.**
 *
 * #521 is one defect wearing five faces: a value that is not finite reaching a comparison does not
 * widen the comparison, it *deletes* it. `skew > NaN` is false, so a decade-old webhook verified.
 * `at < notBefore` and `at > notAfter` are both false, so an expired certificate passed the check that
 * says a certificate is in date. `now >= NaN` is false, so at-rest master-key rotation never came due,
 * on every cron tick, forever. `acquiredAt < <a date in the future>` is true of every row, so a
 * leaderboard's advisory lock stopped excluding anything and two rank refreshes interleaved their
 * writes. Every one of them is silent, and four of the five arrived the same way: `Number(env.X)` on a
 * variable that was unset, misspelled, or typed in the wrong unit, which TypeScript types `number` and
 * every `??` below passes on untouched.
 *
 * **Two hand sweeps missed two instances.** The first pass fixed three and declared the class closed;
 * a later reader found `payments/src/rails/apple/x509.ts`, and a reader after that found
 * `packages/leaderboard`. A pattern that survives two deliberate sweeps is not going to be caught by a
 * third. So it is a gate.
 *
 * ## The rule
 *
 * In shipped source, a numeric coercion over an environment value — `Number(env.X)`,
 * `Number(this.env.X)`, `Number(process.env.X)`, and the `parseInt`/`parseFloat` spellings — must be
 * **the whole of one argument to a call**, and that call must name a function {@link DECLARED} here as
 * one that refuses a value it cannot compare. It may not be assigned to a binding, wrapped in
 * arithmetic, or handed to anything else.
 *
 * That is deliberately a syntactic rule about *one* shape, because that shape is where four of the
 * five instances lived and it is the one a reader can check by eye. See **what this cannot catch**,
 * below, which is most of the space and is stated rather than implied.
 *
 * ## What this cannot catch
 *
 * A gate that overstates its reach is worse than a narrow one that is honest, because the next reader
 * stops looking. This one does not see:
 *
 * 1. **A value that is already a number when it arrives.** A Zod-parsed config field, a `JSON.parse`d
 *    var, a D1 column, an RPC argument, a function parameter. `secretsCacheTtlSeconds` came through a
 *    plain TypeScript interface and `verifyCertificateChain`'s `now` was a caller's `Date`; neither
 *    would appear here. Nothing textual separates a number that was validated from one that was not.
 * 2. **A comparison built from two unvalidated numbers.** The check belongs to whoever compares, and
 *    this only looks at where a number is born. `signedWebhook.ts` checks *both* operands — the
 *    tolerance and the clock — for exactly that reason.
 * 3. **Anything computed.** `Number(env.A) * 60_000` is not one argument and fails here, which is the
 *    intended answer; but `0 / 0`, an overflow to `Infinity`, and a subtraction of two valid dates that
 *    yields `NaN` are all born far from an `env`.
 * 4. **`env` under another name.** A destructure (`const { X } = env`), an alias, a `getVar("X")`
 *    helper, or a var read through a schema. The needle is the literal `env.`/`env[`.
 * 5. **Other coercions.** Unary `+env.X`, `env.X * 1`, or a template read. `+` is not scanned because
 *    string concatenation makes it unreadable without a parser, and a gate with false positives gets
 *    muted.
 * 6. **Test files and generated code.** The walk is {@link sourcePaths}'s shipped-source filter.
 * 7. **Whether the declared validator is still a validator for *this* value.** Each row's function is
 *    proved to contain a finiteness or integer check and a `throw` ({@link DECLARED} below asserts it),
 *    which stops the check being quietly deleted. It does not prove the bound covers the range the
 *    caller cares about — that is what the capability's own tests are for.
 *
 * What it does catch is the exact shape that shipped five times.
 */

/** The repository root — `packages/cli/src/ci` is four levels down. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/**
 * The coercions scanned for. `Number.parseInt` is listed ahead of `Number` so the longer spelling wins,
 * and the lookbehind keeps `parseInt` inside `Number.parseInt` from matching a second time — and keeps
 * a method named `.parseFloat(` on somebody's object out of the scan entirely.
 */
const COERCION = /(?<![.\w$])(Number\.parseInt|Number\.parseFloat|Number|parseInt|parseFloat)\s*\(/g;

/**
 * An environment read, inside a coercion's argument. Matches `env.X`, `this.env.X`, `process.env.X`
 * and `env[key]`; does not match `hostEnv.X` or `myenv.X`, because the character before `env` must not
 * be part of an identifier.
 */
const ENV_READ = /(?:^|[^A-Za-z0-9_$])env\s*[.[]/;

/** Words that can precede a `(` without it being a call. `if (Number(env.X) > 5)` is not a handoff. */
const NOT_A_CALL = new Set(["if", "while", "for", "switch", "catch", "return", "typeof", "await", "function"]);

/**
 * A function a raw coercion over an environment value may be handed to.
 *
 * **A row is a claim that this function refuses a value it cannot compare**, and the claim is checked:
 * the test below reads each function's own source and fails if it has lost its finiteness/integer check
 * or its `throw`. So this is an allowlist that cannot rot into a rubber stamp — deleting the guard
 * inside `requireLockStaleMs` fails here, not only in `@pithy-sh/leaderboard`'s suite.
 */
interface DeclaredValidator {
  /** The function named at the call site. */
  readonly fn: string;
  /** Where it lives, relative to the repository root. */
  readonly module: string;
  /** What it refuses, and what disappears when it does not. */
  readonly reason: string;
}

const DECLARED: readonly DeclaredValidator[] = [
  {
    fn: "requireLockStaleMs",
    module: "packages/leaderboard/src/rank/lock.ts",
    reason:
      "LEADERBOARD_LOCK_STALE_MS. At or below zero the rank-refresh lock's takeover clause is true of every row, so each cron fire steals a live holder's lock and two refreshes interleave their chunked rank writes; NaN or Infinity makes the horizon an Invalid Date and kills the run with a ZodError naming nothing. Refused as `core/internal` with the var in the action line.",
  },
  {
    fn: "isRotationDue",
    module: "packages/secrets/src/rotation/keyRotation.ts",
    reason:
      "ROTATION_INTERVAL_DAYS. `now >= NaN` is false, so at-rest rotation of the master key never comes due — silently, on every tick, forever. Zero or negative is refused for the mirror reason: it starts a rotation Workflow against the store's key every minute.",
  },
];

/** One coercion over an environment value, found in the tree. */
interface Site {
  /** Repo-relative path. */
  readonly file: string;
  /** 1-indexed line, measured on the real file — {@link blankComments} preserves offsets. */
  readonly line: number;
  /** The coercion's text, e.g. `Number(env.ROTATION_INTERVAL_DAYS ?? 30)`. */
  readonly code: string;
  /** The function it is handed to whole, or null when it is handed to nothing. */
  readonly handedTo: string | null;
}

/** The index just past the `)` closing the call whose `(` is at `open`, or -1 if it never closes. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The call this expression is an argument of, walking backwards over balanced brackets.
 *
 * Returns the callee's last identifier and the offset where this argument began — the character after
 * the nearest top-level `,`, or after the `(` for a first argument. `argStart` is what lets the caller
 * insist the coercion is the *whole* argument rather than one term of an expression.
 */
function enclosingCall(text: string, start: number): { callee: string; argStart: number } | null {
  let depth = 0;
  let argStart = -1;
  for (let i = start - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "[" || ch === "{") return null;
    else if (ch === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const callee = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, i));
      if (!callee?.[1] || NOT_A_CALL.has(callee[1])) return null;
      return { callee: callee[1], argStart: argStart === -1 ? i + 1 : argStart };
    } else if (ch === "," && depth === 0 && argStart === -1) argStart = i + 1;
    else if ((ch === ";" || ch === "\n") && depth === 0 && argStart === -1) {
      // A statement boundary at depth zero means there is no enclosing call to find.
      if (ch === ";") return null;
    }
  }
  return null;
}

/** Every coercion over an environment value in `source`, with what it is handed to. */
function environmentCoercions(file: string, source: string): Site[] {
  const text = blankComments(source);
  const found: Site[] = [];
  for (const match of text.matchAll(COERCION)) {
    const start = match.index;
    const open = start + match[0].length - 1;
    const end = closingParen(text, open);
    if (end === -1) continue;
    if (!ENV_READ.test(text.slice(open + 1, end - 1))) continue;

    const enclosing = enclosingCall(text, start);
    // Handed to a call *and* the whole of that argument: nothing before it since the last separator,
    // and nothing after it before the next one. `f(a + Number(env.X))` is not a handoff.
    const whole =
      enclosing !== null && text.slice(enclosing.argStart, start).trim() === "" && /^\s*[,)]/.test(text.slice(end));
    found.push({
      file,
      line: source.slice(0, start).split("\n").length,
      code: source.slice(start, end),
      handedTo: whole ? enclosing.callee : null,
    });
  }
  return found;
}

/** Every site in the tree's shipped source. */
function allSites(): Site[] {
  const sites: Site[] = [];
  for (const path of sourcePaths(REPO_ROOT)) {
    const source = readSource(path);
    if (source === null) continue;
    sites.push(...environmentCoercions(relative(REPO_ROOT, path), source));
  }
  return sites;
}

/** A declared validator's own body, comments blanked — for the "is it still a validator" check. */
function bodyOf(row: DeclaredValidator): string {
  const source = readSource(join(REPO_ROOT, row.module));
  if (source === null) return "";
  const text = blankComments(source);
  const start = text.indexOf(`export function ${row.fn}(`);
  if (start === -1) return "";
  const end = text.indexOf("\n}", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

describe("a number from the environment is checked before it is compared", () => {
  test("every coercion over an environment value is handed whole to a declared validator", () => {
    const names = new Set(DECLARED.map((row) => row.fn));
    const unchecked = allSites()
      .filter((site) => site.handedTo === null || !names.has(site.handedTo))
      .map((site) => `${site.file}:${site.line}  ${site.code}${site.handedTo ? ` → ${site.handedTo}()` : ""}`);

    // A new one lands here. Give it a named check that refuses a non-finite, out-of-range value with a
    // `PithyError` whose `action` names the variable, then add the function to DECLARED above — the
    // shape `requireLockStaleMs` and `assertBatchSize` already have. Widening the comparison is not the
    // fix; there is no safe number to clamp a typo to.
    expect(unchecked).toEqual([]);
  });

  test("each declared validator still refuses — the allowlist cannot rot into a rubber stamp", () => {
    for (const row of DECLARED) {
      const body = bodyOf(row);
      expect(body, `${row.module} no longer exports ${row.fn}`).not.toBe("");
      expect(body, `${row.fn} has lost its finiteness check`).toMatch(/Number\.is(Finite|Integer)\(/);
      expect(body, `${row.fn} no longer throws`).toMatch(/throw new \w*Error\(/);
    }
  });

  test("every declared validator is actually used — no stale rows", () => {
    const used = new Set(allSites().map((site) => site.handedTo));
    expect(DECLARED.filter((row) => !used.has(row.fn)).map((row) => row.fn)).toEqual([]);
  });
});

/**
 * The control. A `toEqual([])` over a scan that finds nothing is the most comfortable green in the
 * repository — shape 8 of the taxonomy in `sweepPopulation.test.ts` — so the scanner is driven over
 * source with a known answer, in both directions, and the real tree is asserted to contain the sites
 * this gate was built for.
 */
describe("the scanner can fail", () => {
  const drive = (code: string) => environmentCoercions("planted.ts", code);

  test("a bare coercion assigned to a binding is a finding", () => {
    const [site] = drive("const staleMs = Number(this.env.LEADERBOARD_LOCK_STALE_MS);");
    expect(site?.handedTo).toBe(null);
  });

  test("a coercion handed whole to a call is not", () => {
    expect(drive("if (isRotationDue(at, Number(env.ROTATION_INTERVAL_DAYS ?? 30))) {")[0]?.handedTo).toBe(
      "isRotationDue",
    );
    expect(drive("const ms = requireLockStaleMs(Number(this.env.LOCK_MS));")[0]?.handedTo).toBe("requireLockStaleMs");
  });

  test("a coercion buried in an expression inside a call is still a finding", () => {
    expect(drive("check(60_000 * Number(env.MINUTES));")[0]?.handedTo).toBe(null);
    expect(drive("check(Number(env.MINUTES) * 60_000);")[0]?.handedTo).toBe(null);
  });

  test("a bare comparison is a finding, and `if` is not a call", () => {
    expect(drive("if (Number(env.SKEW) > 5) return;")[0]?.handedTo).toBe(null);
  });

  test("a coercion over something that is not the environment is not scanned at all", () => {
    expect(drive("const count = Number(row.count);")).toEqual([]);
    expect(drive("const dedent = Number(hostEnv.indent);")).toEqual([]);
    expect(drive("const port = Number.parseInt(config.port, 10);")).toEqual([]);
  });

  test("the parseInt spellings are scanned, and only once each", () => {
    expect(drive("const n = Number.parseInt(env.PORT, 10);")).toHaveLength(1);
    expect(drive("const n = parseFloat(process.env.RATIO);")).toHaveLength(1);
  });

  test("a coercion inside a comment is invisible", () => {
    expect(drive("// `Number(env.SCHEDULER_BATCH_SIZE)` yields NaN for a typo.")).toEqual([]);
  });

  test("the real tree still holds the sites this gate was built for", () => {
    const sites = allSites();
    // Not a floor far below the population: these two are the population, named, so a walk that stopped
    // reaching `packages/` fails here rather than passing over nothing.
    expect(sites.map((site) => site.file).sort()).toEqual([
      join("packages", "leaderboard", "src", "rank", "worker.entry.ts"),
      join("packages", "secrets", "src", "manager", "worker.ts"),
    ]);
    expect(sourcePaths(REPO_ROOT).length).toBeGreaterThan(1000);
  });
});
