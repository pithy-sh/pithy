// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HOME_SCREEN, TEMPLATE_DIR, TEMPLATE_GROUPS } from "./templates";

/**
 * **The ledger for `docs/CONVENTIONS.md` § *Seeded files*: every file this library seeds is held by a
 * gate that travels with it, or is ungated for a reason written down (#391).**
 *
 * `pithy ui add react --auth --payments` writes a whole front end into a repository Pithy will never see
 * again — eighteen files when #391 counted them, and **no test at all**. All ten gates over those files
 * lived in `src/` here, each stated over the *pristine* template text, so every one of them went silent
 * at the exact moment the files became the adopter's, which is the same moment they stopped being
 * fixable from here.
 *
 * ## What this can check, and what it cannot
 *
 * It **cannot** tell whether a file has an invariant. An invariant is two things agreeing, and whether
 * an agreement is meaningful or coincidental is semantic — no sweep over text decides it. It cannot
 * tell whether a named gate really gates its subject; `{ gate: … }` is a claim, and a file can assert
 * `true`. It cannot tell whether an `ungated` reason is *true*. And it cannot check the third property
 * at all: whether a gate was proven able to fail **in a scaffolded project** is an act someone
 * performs, and no runner here can perform it.
 *
 * What it **can** do is make the decision due at the only moment it can be made well — when the file is
 * added — and refuse to let the answer rot afterwards. A path added to `TEMPLATE_GROUPS` is red here
 * until this ledger says which gate holds it or why none does. A ledger entry naming a file that has
 * left the tree is red. A gate named by no entry is red. And the one property that *is* mechanisable,
 * #383's second, is checked on its own below.
 *
 * That is the honest shape: **a forcing function, not a detector.** The alternative — inferring an
 * invariant from source — would be a gate that guesses, and a gate that guesses is one people learn to
 * silence.
 *
 * ## The rule, in one line
 *
 * Every seeded file whose invariant an **adopter** can break silently ships with the gate that notices.
 * Remove the invariant first if you can, then gate the removal. The gate stays in the kit when the party
 * who can break the invariant is the kit — or when the gate simply cannot run where it would be seeded,
 * which is a thing you find out by trying, and `src/styles.css` is the entry that records it.
 */

/** How a seeded file is held. Exactly one of these, and the sentence is the point of either. */
type Held =
  /**
   * A seeded gate whose expectation is a canary invented in the test file. #383's second property:
   * asserting the real value would pass against the very drift the gate exists to catch.
   */
  | { readonly gate: string; readonly expectation: "canary" }
  /**
   * Held by a gate the kit **keeps**, named by its path from the repository root, with the reason it
   * cannot travel. Two reasons have turned up so far and both are walls rather than judgments: the
   * party who can break the invariant is the kit rather than the adopter, or the gate cannot run where
   * it would be seeded. Either way the ledger says so, rather than looking complete.
   *
   * The second wall has two shapes now. #391 found the first — the runner an adopter has cannot read
   * the subject, since Vitest stubs CSS modules to `""`. #399 found the other: the invariant is a fact
   * about *where the Worker sits in a scaffolded project*, so the gate needs a whole scaffolded project
   * and a spawned compiler to resolve against, and a test inside one such project is the wrong altitude
   * to check it from. Both end in the same place — the gate is kept, and what it cannot see is written
   * down beside it.
   */
  | { readonly keptGate: string; readonly why: string }
  /** No seeded gate, and why. A decline with an argument is an answer; a shrug is not. */
  | { readonly ungated: string };

/**
 * Every file this library seeds, and what holds it.
 *
 * Test files are not keys here — they are the gates, and they are checked against this table rather
 * than by it. Adding a template without adding a line below fails `the ledger names every seeded file`.
 */
const LEDGER: Record<string, Held> = {
  // ── base ────────────────────────────────────────────────────────────────────────────────────────
  "index.html": {
    ungated:
      "Nothing reads anything it declares. Since #394 the mount node is created in src/client.tsx; the id set on it is a styling hook that no code looks up, and there is no second string left to disagree with.",
  },
  "vite.config.ts": {
    keptGate: "packages/cli/src/project/scaffoldGates.test.ts",
    why: '#391 item H, closed by #399, and the second clause in its other shape. `persistState: "../../.wrangler/state"` is a depth: right relative to `apps/<worker>/` and wrong anywhere else, and a wrong one silently gives two Workers separate copies of one database. A unit test over the template can only assert the string reads as written, which a rename of the layout sails through. So the gate resolves it — from a scaffolded project\'s real `apps/<worker>/` against the store `pithy seed` uses — and that needs a scaffolded project, which is not something a seeded `vitest run` has.',
  },
  "tsconfig.client.json": {
    keptGate: "packages/cli/src/project/scaffoldGates.test.ts",
    why: "#391 item H, closed by #399, and the worst of the three. Narrowing `include` past the screens makes `tsc -b` exit 0 over a program holding none of them while the project's solution file still references it — the client's whole typecheck, lost, with no change in output. The gate plants a type error in a scaffolded screen and requires the client build to fail, which needs a spawned compiler and a real layout: neither is available where this file is seeded.",
  },
  "tsconfig.node.json": {
    keptGate: "packages/cli/src/project/scaffoldGates.test.ts",
    why: "#391 item H, closed by #399, and the mild one — it costs time and never correctness, which is why nobody would find it. Two composite programs pointing at one `tsBuildInfoFile` overwrite each other's build state every run. The gate resolves all three programs' declared paths from a scaffolded `apps/<worker>/` and requires them distinct and under the project's `dist/`, which is again a fact about a layout rather than about this file's text.",
  },
  "client-env.d.ts": {
    keptGate: "packages/vite/src/clientEnvDeclaration.test.ts",
    why: "#392, and the first clause it earned; #398 did better than the clause. The declaration is generated from the four declared client projections now, so the shape has one statement and there is no second one for an adopter's copy to disagree with — the invariant was removed rather than gated. What is kept is smaller and different in kind: that the committed artifact is the current emit. It needs the kit's projection sources, which a scaffolded project has not got, and the party who could break it is still the kit.",
  },
  "src/client.tsx": { gate: "src/client.test.tsx", expectation: "canary" },
  "src/pithy-config.tsx": {
    ungated:
      '#391 item C, declined. Its disabled branch restates four capability defaults, "cf-turnstile-response" among them. Every consumer narrows on `enabled` first, so the restated values are unreachable — there is no wrong runtime for a gate to notice, which is the first property failing, not a gate missing. The available fix imports kit constants into a file that is the adopter\'s, trading a dead literal for a live coupling.',
  },
  "src/router.tsx": { gate: "src/router.test.tsx", expectation: "canary" },
  "src/styles.css": {
    keptGate: "packages/ui-react/src/palette.test.ts",
    why: '#391 item I, and the second clause. By the rule this one should travel — `styles.css` is the adopter\'s and editing it is the point of the file. It cannot: the invariant is CSS text, a seeded gate would have to read it from the client program, and Vitest stubs CSS modules to the empty string — `?raw` and a raw glob both answer `""` under the plain `vitest run` an adopter has. Every case would sweep an empty set and pass, and a gate that passes over nothing is worse than no gate.',
  },
  "src/pithy-screens.css": {
    keptGate: "packages/ui-react/src/palette.test.ts",
    why: "The other half of the same palette, held by the same kept gate for the same wall. What is lost is real: it catches the kit shipping a half-set, which is what happened to `--danger`, and it cannot catch an adopter's later edit. One narrow slice of that edit is covered from outside since #401 — `pithy ui sync --check` re-reads the stylesheets on disk and fails on a class a Pithy screen renders that none of them defines — but that is class definedness, not the palette being declared as a set, which is the part no fallback can detect.",
  },

  // ── auth ────────────────────────────────────────────────────────────────────────────────────────
  "src/session.tsx": {
    ungated:
      "It restates nothing. Every path it navigates to comes from `screenPath` over the route table, and every string it sends comes from `pithy-config.tsx` — so an edit that breaks it breaks the type or the render, which is the first property failing.",
  },
  "src/turnstile.tsx": { gate: "src/turnstile.test.tsx", expectation: "canary" },
  "src/routes/pithy/sign-in.tsx": { gate: "src/routes/pithy/sign-in.test.tsx", expectation: "canary" },
  "src/routes/pithy/otp.tsx": {
    ungated:
      "Its own `path` is the single statement of where it is, and it navigates through `navigate` rather than to a literal. Nothing outside it holds a copy of anything in it.",
  },
  "src/routes/pithy/callback.tsx": {
    ungated:
      "Held from the other end. Its `path` is the one statement of where a magic link returns, and sign-in.test.tsx is the gate that keeps sign-in.tsx reading it rather than restating it (#393). A second gate here would assert the file agrees with itself.",
  },

  // ── payments ────────────────────────────────────────────────────────────────────────────────────
  "src/payments.tsx": {
    ungated:
      "A bridge, not a contract: it binds one base path from `pithy-config.tsx` and re-exports the checkout frame class the two selling screens share. templates.test.ts already holds the frame class to being rendered wherever it is named.",
  },
  "src/routes/pithy/paywall.tsx": {
    ungated:
      "Its sibling paths come from `useScreenPath` over declared roles, and its rail set from PAYMENTS_HOSTED_RAILS. templates.test.ts holds the checkout half — a screen that starts a checkout opens the handoff and renders the frame it named — and that gate reads the template text, so it survives the file being copied.",
  },
  "src/routes/pithy/pricing.tsx": {
    ungated:
      "The paywall's shape, held by the same two sweeps in templates.test.ts: it may write no price down, and it must open the handoff and render the frame it named. Its sibling paths come from useScreenPath and its rail from PAYMENTS_HOSTED_RAILS, so there is nothing left in it that is a copy of anything.",
  },
  "src/routes/pithy/subscription.tsx": {
    ungated:
      "The paywall's shape again, and held by the same sweeps. It reaches the paywall through useScreenPath over a declared role rather than a path it writes down, which is the statement #393 made one — so an adopter renaming either screen moves one string and the other follows.",
  },

  // ── the home screen, in both variants ────────────────────────────────────────────────────────────
  "src/routes/app/home.tsx": {
    ungated:
      "It is yours from the moment it is written — src/routes/app/ is the one directory Pithy writes once and never inspects again. #391 item G asked for the unstyled report to reach into it, and #401 declined that half outright: a report auditing an adopter's own application after scaffold is the kit inspecting somebody's code, and the classes it renders are defined by a stylesheet client.tsx imports for the whole app. The other half of #401 shipped — the report re-runs at pithy ui sync --check and fails on a finding — and it still stops at src/routes/pithy/.",
  },
  "src/routes/app/home.bare.tsx": {
    keptGate: "packages/cli/src/ui/react.test.ts",
    why: '#391 item D, closed by #400 — and closed by removal rather than by watching. The path was written in three places: @pithy-sh/core mounted "/health", the CLI\'s route allowlist seeded it, this screen fetched it, and a rename in the first renders "The worker says: unknown." with a 200 and nothing in a log. All three now read HEALTH_PATH from @pithy-sh/core/src/worker/health, so a rename moves the screen with it. What is left to hold is the reversal — someone retyping a literal here — and the party who would do that is the kit, editing the template, which is where the gate is.',
  },
};

/** The repository root. `TEMPLATE_DIR` is `packages/ui-react/templates`, so it is three levels up. */
const REPO_ROOT: string = join(TEMPLATE_DIR, "..", "..", "..");

/** The group each declared path belongs to. `home` is its own: one of the two variants always ships. */
function groupOf(path: string): string {
  for (const [group, paths] of Object.entries(TEMPLATE_GROUPS)) {
    if ((paths as readonly string[]).includes(path)) return group;
  }
  if (path === HOME_SCREEN.auth || path === HOME_SCREEN.bare) return "home";
  return "";
}

/** Every path any group or the home screen declares. */
const DECLARED: string[] = [...Object.values(TEMPLATE_GROUPS).flat(), HOME_SCREEN.auth, HOME_SCREEN.bare];

/** Is this a test file — a gate, rather than a subject to be held? */
const isGate = (path: string): boolean => /\.(test|spec)\.[jt]sx?$/.test(path);

/** The subjects: every seeded file that is not itself a gate. */
const SUBJECTS: string[] = DECLARED.filter((path) => !isGate(path));

/** The gates: every seeded test file. */
const GATES: string[] = DECLARED.filter(isGate);

describe("the ledger and the tree agree", () => {
  test("the ledger names every seeded file, and names nothing else", () => {
    const keys = Object.keys(LEDGER).sort();
    // Both directions. Missing keys are a template that slipped in with no decision taken; extra keys
    // are a decision kept alive for a file that left, which is how a table like this rots.
    expect(keys).toEqual([...SUBJECTS].sort());
  });

  test("every gate the ledger names is a file this library actually seeds", () => {
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("gate" in held)) continue;
      expect(DECLARED, `${subject} names ${held.gate}, which no group writes`).toContain(held.gate);
      expect(isGate(held.gate), `${held.gate} is named as a gate and is not a test file`).toBe(true);
    }
  });

  test("every gate is claimed by something it holds — none ships gating nothing", () => {
    const claimed = new Set(Object.values(LEDGER).flatMap((held) => ("gate" in held ? [held.gate] : [])));
    for (const gate of GATES) {
      expect(claimed.has(gate), `${gate} is seeded and the ledger says it holds nothing`).toBe(true);
    }
  });

  test("a gate ships in the same group as the file it holds", () => {
    // Either direction is a hole. A gate in `base` over an `auth` subject is a test importing a file a
    // --no-auth project has not got; a subject in `base` gated from `auth` leaves a payments-only
    // scaffold with the file and nothing watching it — and that one is silent, which is the whole point.
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("gate" in held)) continue;
      expect(groupOf(held.gate), `${held.gate} does not travel with ${subject}`).toBe(groupOf(subject));
    }
  });

  test("a decline is an argument, not a shrug", () => {
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("ungated" in held)) continue;
      expect(held.ungated.length, `${subject} is ungated and says almost nothing about why`).toBeGreaterThan(80);
    }
  });
});

describe("a seeded gate does not write down the value it is checking", () => {
  // #383's second property, mechanised as far as it goes: the expectation is either a canary this file
  // invented, or a comparison of two subjects. It is NOT the real value restated — that passes against
  // the exact drift the gate exists to catch, and it is the failure mode that leaves a green suite.

  /** Does the text declare a canary and refuse at least one of them having drifted onto a real value? */
  function refusesDrift(text: string): boolean {
    const canaries = [...text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*CANARY[A-Z0-9_]*|CANARY[A-Z0-9_]*)\s*=/g)].map(
      (match) => match[1] ?? "",
    );
    if (canaries.length === 0) return false;
    return canaries.some((name) => new RegExp(`expect\\(\\s*${name}\\s*\\)\\s*\\.not\\.toBe\\(`).test(text));
  }

  test("the canary reading is calibrated before it is trusted", () => {
    // A gate over its own instrument. Without this the sweep below passes on a pattern that matches
    // nothing and says the same thing as a tree with no defect in it.
    expect(refusesDrift('const CANARY_ACTION = "x";\nexpect(CANARY_ACTION).not.toBe("login");')).toBe(true);
    // The bug it exists to catch: someone copies a seeded gate and replaces the canary with the real
    // value. Nothing else about the file changes and it passes forever.
    expect(refusesDrift('const ACTION = "login";\nexpect(rendered?.action).toBe(ACTION);')).toBe(false);
    // A canary declared and never refused. It may have drifted onto a real value and nothing would say.
    expect(refusesDrift('const CANARY_ID = "root";\nexpect(document.body.textContent).toContain(CANARY_ID);')).toBe(
      false,
    );
    // The refusal must be of the canary itself, not of some other value beside it.
    expect(refusesDrift('const CANARY_ID = "x";\nexpect(other).not.toBe("root");')).toBe(false);
  });

  test("every canary gate invents its expectation and refuses it having drifted", async () => {
    let checked = 0;
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("gate" in held) || !("expectation" in held)) continue;
      const text = await readFile(join(TEMPLATE_DIR, held.gate), "utf8");
      expect(
        refusesDrift(text),
        `${held.gate} holds ${subject} by a canary and either declares none or never refuses one — an expectation that has drifted onto the real value passes against the bug`,
      ).toBe(true);
      checked += 1;
    }
    // Near-exact, not a comfortable floor. Four canary gates were seeded, by #383, #393 and #394. A
    // sweep that found three has stopped reading one, and a sweep that found none passes over nothing.
    expect(checked, "the canary sweep no longer reads every canary gate the ledger names").toBeGreaterThanOrEqual(4);
  });

  test("every kept gate is a file that exists, outside the tree, with the reason it stayed", async () => {
    // A ledger entry claiming a gate elsewhere is a claim that rots the moment that file is renamed —
    // and it rots into a subject that reads as held. So the path is resolved, and the reason is required
    // to be one: whichever wall it names, the next reader has to be able to check it.
    let checked = 0;
    for (const [subject, held] of Object.entries(LEDGER)) {
      if (!("keptGate" in held)) continue;
      expect(DECLARED, `${subject} names ${held.keptGate} as a kept gate, and it is a seeded file`).not.toContain(
        held.keptGate,
      );
      const text = await readFile(join(REPO_ROOT, held.keptGate), "utf8").catch(() => null);
      expect(text, `${subject} is held by ${held.keptGate}, which is not there`).not.toBeNull();
      expect(
        held.why.length,
        `${subject} is kept and says almost nothing about why it could not travel`,
      ).toBeGreaterThan(80);
      checked += 1;
    }
    // Seven: the ambient declarations, both halves of the palette, the three build contracts #399
    // moved to the scaffolder's suite, and the bare home screen #400 made one statement.
    expect(checked, "the kept-gate sweep no longer reads every such gate the ledger names").toBeGreaterThanOrEqual(7);
  });
});

describe("the floors", () => {
  test("the tree is the size the ledger was written about", () => {
    // Near-exact rather than comfortable: twenty-one subjects across three groups and two home
    // variants, held by four seeded gates and seven kept ones. A manifest that collapsed under either
    // sweep above would make it vacuous, and a floor set well below the real population is the shape of
    // a guard rather than one.
    expect(SUBJECTS.length).toBeGreaterThanOrEqual(21);
    expect(GATES.length).toBeGreaterThanOrEqual(4);
  });
});
