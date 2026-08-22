// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENVIRONMENTS, MAX_ENVIRONMENT_NAME } from "@pithy-sh/core/src/naming/environment";
import { featureResourceName } from "@pithy-sh/core/src/naming/feature";
import {
  FEATURE_DERIVED_PROJECT_NAME,
  MAX_CAPABILITY_JOB,
  MAX_FEATURE_KIND,
  MAX_ISSUE_DIGITS,
  MAX_PITHY_NAME,
  NAMESPACE_LIMITS,
  type Namespace,
  WORKFLOW_DERIVED_PROJECT_NAME,
} from "@pithy-sh/core/src/naming/limits";
import { fitSegment, MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { describe, expect, it } from "vitest";

/**
 * `docs/NAMING.md` is the adopter-facing statement of every limit in `@pithy-sh/core/src/naming`, and an adopter cannot
 * check it — they hit a refusal and read the doc to find out why. A number that has drifted is therefore
 * worse than no number at all: it sends someone to shorten a name that was already legal, or reassures
 * them about one that is not.
 *
 * It lives here rather than beside the constants because reading a file needs `node:fs`, and `core` is
 * bundled into the adopter's Worker — it carries no `node:` types on purpose, and adding them to typecheck
 * a test would let a real `node:` import into `core` unnoticed.
 *
 * So the doc is tested like code. Each table below is parsed out of the markdown and compared against the
 * constants and the composer itself — not against a second copy of the arithmetic, which would drift in
 * lockstep. Change a limit and this fails until the doc is changed with it.
 *
 * {@link RESTATEMENTS} extends the same treatment to the two other docs that quote one of these numbers.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const NAMING = readFileSync(join(REPO_ROOT, "docs", "NAMING.md"), "utf8");

/**
 * The other docs that restate one of these numbers, whitespace-collapsed so a hard-wrapped sentence reads
 * as one line — `docs/CLI.md` wraps at 110 columns, and `name` stops \n at 25 characters is one claim.
 *
 * `docs/NAMING.md` states the rule; every other doc links there. But "links there" has never meant "quotes
 * no number", and the two that do both drifted: the README and `docs/CLI.md` each said a project name stops
 * at 25 when the derived cap is 26, and `docs/CLI.md`'s feature budget reserved 7 digits for an issue that
 * reserves 6 — then spent the same 7 twice, once as the issue and once as the fixed literals, and published
 * a slug budget one character short of what the composer keeps. NAMING.md did not drift, for the one reason
 * the tests below extend to these two: it is pinned to the constants.
 */
const RESTATEMENTS: Record<string, string> = {
  "README.md": readFileSync(join(REPO_ROOT, "README.md"), "utf8").replace(/\s+/g, " "),
  "docs/CLI.md": readFileSync(join(REPO_ROOT, "docs", "CLI.md"), "utf8").replace(/\s+/g, " "),
  // The feature-name budget moved here with `pithy dev` when #223 split the reference one page per
  // command. The numbers did not move, and neither did the reason they are pinned.
  "docs/commands/dev.md": readFileSync(join(REPO_ROOT, "docs", "commands", "dev.md"), "utf8").replace(/\s+/g, " "),
};

/**
 * The docs that quote the project-name cap, as a set rather than a loop over every restatement: two of
 * these three state it, and a doc that starts quoting it has to join the check rather than slip past.
 */
const QUOTES_THE_CAP = ["README.md", "docs/CLI.md"];

/**
 * The numbers one sentence of a doc states, or a failure naming the sentence that has gone missing.
 *
 * A pin that quietly passes when its regex stops matching is worse than no pin: the sentence it guards can
 * be reworded into a fresh wrong number and nothing notices. So a miss throws, and rewording a pinned
 * sentence is a deliberate act that updates the pattern with it.
 */
function stated(doc: keyof typeof RESTATEMENTS, pattern: RegExp, claim: string): number[] {
  const found = RESTATEMENTS[doc]?.match(pattern);
  if (!found) throw new Error(`${doc} no longer states ${claim} — nothing matched ${pattern}. Repin or restate.`);
  return found.slice(1).map(Number);
}

/** The first-column label the doc's limits table gives each namespace. The join between doc and code. */
const ROW_LABEL: Record<Namespace, string> = {
  workflow: "Workflow",
  worker: "Worker script",
  r2: "R2 bucket",
  vectorizeIndex: "Vectorize index",
  kv: "KV namespace title",
  d1: "D1 database",
  secretEntry: "Secrets Store entry",
  apiToken: "Cloudflare API token",
};

/**
 * The doc's limits section alone. Scoped, because the shape table earlier on the page has rows keyed on
 * the same words — `| Workflow |` appears in both, and the first match is the wrong one.
 */
const LIMITS_SECTION = NAMING.slice(NAMING.indexOf("## Every limit, per namespace")).split("\n## ")[0] ?? "";

/** The row of the limits table whose first cell is exactly `label`. */
function row(label: string): string {
  const found = LIMITS_SECTION.split("\n").find((line) => line.startsWith(`| ${label} |`));
  if (!found) throw new Error(`docs/NAMING.md's limits table has no row for "${label}".`);
  return found;
}

/** The cells of a markdown table row, trimmed. */
function cells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/**
 * The longest slug `featureResourceName` keeps verbatim — asked of the composer rather than recomputed,
 * so the doc's budget table is checked against the code that actually names the bucket.
 */
function verbatimSlug(projectLength: number, binding: string, issueDigits: number): number {
  const project = `p${"a".repeat(projectLength - 1)}`;
  const issue = "1".repeat(issueDigits);
  for (let length = 60; length >= 1; length -= 1) {
    const slug = "s".repeat(length);
    if (featureResourceName({ project, issue, slug }, binding, "r2").includes(`-${slug}-`)) return length;
  }
  return 0;
}

describe("the limits table", () => {
  it("states every namespace Pithy composes into", () => {
    for (const namespace of Object.keys(NAMESPACE_LIMITS) as Namespace[]) {
      expect(() => row(ROW_LABEL[namespace])).not.toThrow();
    }
  });

  it("quotes each namespace's real cap", () => {
    for (const [namespace, limit] of Object.entries(NAMESPACE_LIMITS) as [
      Namespace,
      (typeof NAMESPACE_LIMITS)[Namespace],
    ][]) {
      // The second cell is the limit. Read as a number so `128` never passes as `1,280`.
      const stated = cells(row(ROW_LABEL[namespace]))[1] ?? "";
      const numbers = stated.match(/\d+/g) ?? [];
      expect(numbers, `${ROW_LABEL[namespace]} limit cell: ${stated}`).toContain(String(limit.maxLength));
    }
  });

  it("attributes each cap to Cloudflare or to Pithy, matching the code", () => {
    for (const [namespace, limit] of Object.entries(NAMESPACE_LIMITS) as [
      Namespace,
      (typeof NAMESPACE_LIMITS)[Namespace],
    ][]) {
      const cell = cells(row(ROW_LABEL[namespace])).at(-1) ?? "";
      const claimed = /pithy/i.test(cell) ? "pithy" : "cloudflare";
      expect(claimed, `${ROW_LABEL[namespace]} source cell: ${cell}`).toBe(limit.source);
    }
  });

  it("says refused or truncated, matching each namespace's policy", () => {
    for (const [namespace, limit] of Object.entries(NAMESPACE_LIMITS) as [
      Namespace,
      (typeof NAMESPACE_LIMITS)[Namespace],
    ][]) {
      const line = row(ROW_LABEL[namespace]);
      const claimed = /refus/i.test(line) ? "refuse" : "truncate";
      expect(claimed, line).toBe(limit.policy);
    }
  });

  it("names Pithy's own ceiling where Cloudflare publishes none", () => {
    // Anchored on a word boundary. `toContain("128 characters")` would also be satisfied by `2128
    // characters`, and the same pin for a smaller constant is satisfied by any number ending in it —
    // `7 characters` matches inside `127 characters`, which is exactly the drift these guard against.
    expect(NAMING).toMatch(new RegExp(`\\b${MAX_PITHY_NAME} characters\\b`));
  });

  it("quotes the room each namespace really leaves at a 12-character project", () => {
    const scope = resourceNames("a".repeat(12)).env("staging");
    const ask: Partial<Record<Namespace, (thing: string) => string>> = {
      worker: (thing) => scope.worker(thing),
      r2: (thing) => scope.r2(thing),
      vectorizeIndex: (thing) => scope.vectorizeIndex(thing),
      kv: (thing) => scope.kv(thing),
      d1: (thing) => scope.d1(thing),
      secretEntry: (thing) => scope.secretEntry(thing),
      apiToken: (thing) => scope.apiToken(thing),
    };
    for (const [namespace, compose] of Object.entries(ask) as [Namespace, (thing: string) => string][]) {
      // The longest `<thing>` that survives verbatim — asked of the composer, not recomputed.
      let room = 0;
      for (let length = 1; length <= 520; length += 1) {
        const thing = `t${"x".repeat(length - 1)}`;
        try {
          if (!compose(thing).endsWith(`-${thing}`)) break;
        } catch {
          break;
        }
        room = length;
      }
      const stated = Number((cells(row(ROW_LABEL[namespace]))[3] ?? "").match(/\d+/)?.[0]);
      expect(stated, `${ROW_LABEL[namespace]} room cell`).toBe(room);
    }
  });

  it("quotes both numbers the Workflow row turns on, and the composer honors the tighter one", () => {
    // Separate from the loop above because a Workflow's `<thing>` is two segments, `<capability>-<job>`,
    // so it cannot be asked for with a single string. It was simply left out of that map, and being a
    // `Partial` record the omission cost nothing and skipped the row in silence — the one cap in the table
    // with no assertion behind it, in a namespace whose overflow policy is `refuse`.
    //
    // The cell carries two numbers because two rules apply: the namespace leaves 43 characters at a
    // 12-character project in `staging`, but a `<capability>-<job>` stops at `MAX_CAPABILITY_JOB` well
    // before that. Both are pinned, because either drifting misleads — and the second is pinned to the
    // composer too, so the doc cannot agree with a constant the code has stopped enforcing.
    const [wide, tight] = (cells(row(ROW_LABEL.workflow))[3] ?? "").match(/\d+/g)?.map(Number) ?? [];
    const project = 12;
    expect(wide, "Workflow row's namespace arithmetic").toBe(
      NAMESPACE_LIMITS.workflow.maxLength - project - MAX_ENVIRONMENT_NAME - 2,
    );
    expect(tight, "Workflow row's <capability>-<job> cap").toBe(MAX_CAPABILITY_JOB);

    const scope = resourceNames("a".repeat(project)).env("staging");
    let room = 0;
    for (let length = 3; length <= 80; length += 1) {
      const capability = `t${"x".repeat(length - 3)}`;
      try {
        if (!scope.workflow(capability, "j").endsWith(`-${capability}-j`)) break;
      } catch {
        break;
      }
      room = length;
    }
    expect(room, "the longest <capability>-<job> the composer keeps").toBe(MAX_CAPABILITY_JOB);
  });
});

describe("the worked examples", () => {
  it("shows the truncation the composer actually produces", () => {
    // Both of these are hashes. A hash nobody re-derived is a hash that has drifted.
    expect(NAMING).toContain(fitSegment("media-bucket", 8));
    expect(NAMING).toContain(fitSegment("secrets-encryption-keys", 21));
  });

  it("shows feature names the composer actually produces", () => {
    expect(NAMING).toContain(
      featureResourceName({ project: "acme", issue: "95", slug: "project-scope-resources" }, "DB", "r2"),
    );
    expect(NAMING).toContain(
      featureResourceName(
        { project: "acme-backend-platform", issue: "999999", slug: "project-scope-resources" },
        "EMAIL_SUPPRESSIONS",
        "r2",
      ),
    );
  });
});

describe("the project-name cap", () => {
  it("states the cap and both derivations", () => {
    expect(NAMING).toContain(`stops at ${MAX_PROJECT_NAME} characters`);
    expect(NAMING).toContain(`= ${WORKFLOW_DERIVED_PROJECT_NAME}`);
    expect(NAMING).toContain(`= ${FEATURE_DERIVED_PROJECT_NAME}`);
  });

  it("states the longest `<capability>-<job>` the Workflow derivation reserves", () => {
    // `toContain(String(MAX_CAPABILITY_JOB))` was `toContain("22")`, which any year, port, or other
    // constant on the page satisfies — it could not fail for the drift it is named after. Anchored to the
    // sentence, and to the example whose length *is* the constant.
    expect(NAMING).toMatch(new RegExp(`\\b${MAX_CAPABILITY_JOB}\\b[^\\n]*\`?media-audio-transcribe`));
    expect("media-audio-transcribe".length).toBe(MAX_CAPABILITY_JOB);
  });
});

describe("the environments", () => {
  it("names all three, and the enforced maximum", () => {
    for (const environment of ENVIRONMENTS) expect(NAMING).toContain(`\`${environment}\``);
    // `toContain("7 characters")` matches inside `127 characters` and `17 characters`, so it survived the
    // constant changing to anything ending in 7. Word-anchored, and tied to the environment it is the
    // length of — the number means nothing on its own.
    expect(NAMING).toMatch(new RegExp(`\\b${MAX_ENVIRONMENT_NAME} characters\\b`));
    expect(Math.max(...ENVIRONMENTS.map((e) => e.length))).toBe(MAX_ENVIRONMENT_NAME);
  });

  it("never composes an example name under the old `production` spelling", () => {
    expect(NAMING).not.toMatch(/-production-/);
  });
});

describe("the feature budget table", () => {
  /** `| <project chars> | <slug> | <slug> | <slug> | <slug> |`, one row per project length. */
  const BINDINGS = ["DB", "SESSIONS", "MEDIA_BUCKET", "EMAIL_SUPPRESSIONS"];
  const rows = NAMING.split("\n")
    .filter((line) => /^\| \d+ \| \d+ \| \d+ \| \d+ \| \d+ \|$/.test(line))
    .map((line) => cells(line).map(Number));

  it("has a row per project length", () => {
    // Exact, not `>= 5` against six rows — that tolerance let a deleted row pass, in the one table an
    // adopter reads to size a project name. The count is asserted first so every pin below is known to
    // have had something to match: a regex that silently matches nothing makes the rest of this vacuous.
    expect(rows.length).toBe(6);
    expect(rows.every((cells) => cells.length === BINDINGS.length + 1)).toBe(true);
  });

  it("matches what `featureResourceName` actually keeps, at the longest reserved issue", () => {
    for (const [projectLength, ...budgets] of rows) {
      expect(budgets).toEqual(
        BINDINGS.map((binding) => verbatimSlug(projectLength as number, binding, MAX_ISSUE_DIGITS)),
      );
    }
  });

  it("states the arithmetic the table is a projection of", () => {
    // `const fixed = 63 - 7` was a second copy of the arithmetic this file says it never keeps: both
    // numbers were literals, so a change to the R2 cap or to the fixed separators would have left the doc
    // right and this test wrong. Derived from the constants instead.
    //
    // `<project>-f<issue>-<slug>-<binding>-<kind>`: four separators, the `f`, and `<kind>` (`-r2` is the
    // longest) are what a feature name spends before any of the four variable parts.
    const fixed = NAMESPACE_LIMITS.r2.maxLength - (4 + 1 + MAX_FEATURE_KIND);
    expect(NAMING).toMatch(new RegExp(`= ${fixed}\\b`));
    expect(NAMING).toMatch(new RegExp(`\\b${MAX_ISSUE_DIGITS} digits\\b`));
  });

  it("covers the worst legal project, where the derivation bottoms out", () => {
    expect(rows.some(([projectLength]) => projectLength === MAX_PROJECT_NAME)).toBe(true);
  });
});

describe("the numbers the other docs restate", () => {
  it("states the real project-name cap wherever it is quoted", () => {
    const quoting = Object.keys(RESTATEMENTS).filter((doc) => /stops at \d+ characters/.test(RESTATEMENTS[doc] ?? ""));
    expect(quoting).toEqual(QUOTES_THE_CAP);
    for (const doc of QUOTES_THE_CAP) {
      const [cap] = stated(doc, /stops at (\d+) characters/, "the project-name cap");
      expect(cap, `${doc}: the project-name cap`).toBe(MAX_PROJECT_NAME);
    }
  });

  it("states the environment maximum every project budget is derived against", () => {
    const [max] = stated("docs/CLI.md", /hard maximum of (\d+) characters/, "the environment maximum");
    expect(max).toBe(MAX_ENVIRONMENT_NAME);
  });

  it("holds the feature shape to the same R2 cap the code does", () => {
    const [cap] = stated("docs/commands/dev.md", /Held to R2's (\d+) characters/, "R2's cap");
    expect(cap).toBe(NAMESPACE_LIMITS.r2.maxLength);
  });

  it("counts the fixed literals as literals, and divides what is left", () => {
    // `<project>-f<issue>-<slug>-<binding>-<kind>`: `-f`, three more hyphens, and the kind. Seven, and it
    // is not the issue reserve — the two were the same number while `MAX_ISSUE_DIGITS` was 7, which is how
    // the budget came to spend it twice.
    const fixed = 2 + 3 + MAX_FEATURE_KIND;
    const [literals] = stated("docs/commands/dev.md", /with (\d+) taken by the fixed literals/, "the fixed literals");
    expect(literals).toBe(fixed);

    const divided = NAMESPACE_LIMITS.r2.maxLength - fixed;
    expect(stated("docs/commands/dev.md", /divide (\d+) between them/, "what the variable segments divide")).toEqual([
      divided,
    ]);
    expect(
      stated("docs/commands/dev.md", /project \+ issue \+ slug \+ binding = (\d+)/, "the feature-budget arithmetic"),
    ).toEqual([divided]);
  });

  it("reserves the issue the same digits the composer does", () => {
    const [digits] = stated("docs/commands/dev.md", /issue number is reserved (\d+) digits/, "the issue reserve");
    expect(digits).toBe(MAX_ISSUE_DIGITS);
  });

  it("quotes a slug budget `featureResourceName` actually keeps, at both issue lengths", () => {
    // Every number in the sentence is read out of it and recomputed — the project length, both issue
    // lengths, and both budgets — so the doc may pick its own example and still cannot pick its own answer.
    const [projectLength, atReserve, reserveDigits, atReal, realDigits] = stated(
      "docs/commands/dev.md",
      /a (\d+)-character project with a `DB` binding leaves (\d+) characters of slug at a (\d+)-digit issue, and (\d+) at a real (\d+)-digit one/,
      "the worked slug budget",
    ) as [number, number, number, number, number];
    expect(reserveDigits).toBe(MAX_ISSUE_DIGITS);
    expect(atReserve).toBe(verbatimSlug(projectLength, "DB", reserveDigits));
    expect(atReal).toBe(verbatimSlug(projectLength, "DB", realDigits));
  });
});
