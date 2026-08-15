// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { loadIntegrationEnv } from "./harness";

/**
 * The live test fixture estate: which real-world things a live suite needs, whether this run has them,
 * and what a run says when it does not.
 *
 * ## Absent means skip, never fail
 *
 * A contributor with no Cloudflare account, no Turnstile widget and no zone must be able to run the
 * whole suite and get green. That is the rule, and both ways of getting it subtly wrong are worse than
 * having no helper at all. A gate that **throws** on a missing fixture turns "you have no credentials"
 * into "the kit is broken", and every one of those costs somebody an afternoon proving it is not. A gate
 * that **silently passes** turns "nothing ran" into "everything is fine", which is how a release gate
 * comes to certify a suite that has never executed.
 *
 * So the skip is loud. {@link reportFixtureEstate} runs from `globalSetup` — once per run, before a
 * single suite is collected — and prints a line per fixture naming what is missing, what will therefore
 * skip, and the document that creates it. The `describe.skipIf` in a suite is only the mechanism; this
 * report is the sentence a human reads.
 *
 * **From `globalSetup` for the same reason the debris sweep is** (see `integrationSetup.ts`): Vitest runs
 * no hooks inside a `describe.skipIf(true)`, so anything living in a suite hook is gated on exactly the
 * condition it exists to report. A report that goes quiet precisely when there is something to say is
 * not a report.
 *
 * ## A value never appears
 *
 * These names resolve API tokens, OAuth client secrets and Turnstile secret keys. A line here names the
 * **variable** and never its contents, in every outcome — including the malformed ones, where the
 * temptation to print what was found is strongest. `fixtures.test.ts` plants a distinctive value and
 * asserts no report line contains it.
 */

/**
 * How a fixture's value is judged.
 *
 * `credential` — any usable text is the fixture. An account id, a token, a zone id, a sitekey.
 *
 * `switch` — a deliberate opt-in, where the *word* is the whole meaning. `PITHY_LIVE_DEPLOY` is the one
 * that matters: it arms a suite that deploys real Workers and deletes them again, so `0` has to mean no
 * rather than "a non-empty string, therefore yes". Judging it as a credential is not a style choice —
 * it is the difference between an opt-out and a deploy.
 */
export type FixtureShape = "credential" | "switch";

/** One live fixture: what it is, where its value comes from, what skips without it, and how to make it. */
export interface LiveFixture {
  /** The fixture's name — what a skip line says, and the anchor its documentation lives under. */
  name: string;
  /** Every environment variable that must resolve before the fixture is usable. All of them, not any. */
  keys: readonly string[];
  /** How the value is judged. See {@link FixtureShape}. */
  shape: FixtureShape;
  /**
   * What a run loses without it, as a whole sentence — "Turnstile sign-in gating (#84) skips."
   *
   * A sentence rather than a noun phrase, because the report is read by somebody deciding whether the
   * green they just got means anything, and "the Custom Hostnames lifecycle" does not answer that.
   */
  consequence: string;
  /** The document section that creates it. Must exist; `fixtures.test.ts` proves every one of them does. */
  doc: string;
}

/**
 * What this run has, per fixture.
 *
 * Four outcomes rather than a boolean, because three different things skip a suite and only one of them
 * is fine. **`absent`** is the contributor with no credentials, and is the normal case. **`declined`** is
 * a switch deliberately turned off. **`malformed`** is somebody who tried to set the fixture and failed —
 * a CI export of an unset secret, a shell interpolation that produced the literal text `undefined`.
 *
 * All three skip. Only the reporting differs, and that is the whole point: #323 landed the same
 * distinction one layer down — *"'not recorded' is a claim about the file, and it is now made only when
 * the file makes no claim"* — after two investigations died inside a "missing" that meant "malformed".
 * A fixture blanked by a broken export must not read as a fixture nobody configured.
 */
export type FixtureOutcome = "present" | "absent" | "malformed" | "declined";

/** One key's own verdict, and why — the grain the fixture's sentence is assembled from. */
interface KeyVerdict {
  /** The variable name. Never accompanied by its value. */
  key: string;
  /** This key's outcome, before the fixture's keys are folded together. */
  outcome: FixtureOutcome;
  /** Why, in a fragment that reads after the key name: "is not set", "is set to an empty value". */
  note: string;
}

/** A fixture, resolved against one environment. */
export interface FixtureResolution {
  /** The fixture that was resolved. */
  fixture: LiveFixture;
  /** The fixture's outcome — the worst of its keys'. */
  outcome: FixtureOutcome;
  /** True only for `present`. The boolean a `describe.skipIf` negates. */
  ready: boolean;
  /** One sentence naming the offending variables and their state. Never a value. */
  reason: string;
}

/** Words a switch reads as on. Case-insensitive. */
const SWITCH_ON: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/** Words a switch reads as off — a deliberate decline, not a misconfiguration. */
const SWITCH_OFF: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/**
 * Text a value must never be, whatever its shape.
 *
 * These are not values. They are what a templating layer writes when it had nothing: `export
 * KEY=$MISSING` under some shells, a JSON `null` stringified, a GitHub Actions expression that resolved
 * to nothing and got quoted anyway. Each is a non-empty string, so every `Boolean(value)` check in the
 * world reads it as present and hands it to Cloudflare, which answers 401 three frames later.
 */
const PLACEHOLDER_TEXT: ReadonlySet<string> = new Set(["undefined", "null"]);

/** Worst-first, so folding a fixture's keys is a `Math.min` over this order. */
const OUTCOME_RANK: Readonly<Record<FixtureOutcome, number>> = {
  malformed: 0,
  absent: 1,
  declined: 2,
  present: 3,
};

/**
 * The estate, declared once.
 *
 * Every live fixture the repository knows about, whether or not a suite reads it yet — a fixture that
 * exists only in the head of whoever wrote the suite is a fixture nobody can be told to create. The
 * `consequence` line names the issue, so the report is a to-do list for anyone who wants a red X to become
 * a run.
 *
 * Alphabetical, as the reap plan is, so the set reads as a list rather than as an accident of the order
 * somebody happened to add things in.
 */
export const LIVE_FIXTURES = {
  "cloudflare-account": {
    name: "cloudflare-account",
    keys: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    shape: "credential",
    consequence: "Every live suite skips, and the run sweeps no debris.",
    doc: "docs/FIXTURES.md#cloudflare-account",
  },
  "custom-hostname-zones": {
    name: "custom-hostname-zones",
    keys: ["CUSTOM_HOSTNAME_ZONE_ID", "CUSTOM_HOSTNAME_CUSTOMER_ZONE_ID"],
    shape: "credential",
    consequence: "The Custom Hostnames lifecycle (#41) skips.",
    doc: "docs/FIXTURES.md#custom-hostname-zones",
  },
  "email-routing": {
    name: "email-routing",
    keys: ["EMAIL_ROUTING_ZONE_ID", "EMAIL_ROUTING_ADDRESS"],
    shape: "credential",
    consequence: "The inbound Email Routing rule (#47) skips.",
    doc: "docs/FIXTURES.md#email-routing",
  },
  "email-sending": {
    name: "email-sending",
    keys: ["EMAIL_SENDING_FROM"],
    shape: "credential",
    consequence: "The inbound delivery round trip (#47) skips: nothing can post a message to the routed address.",
    doc: "docs/FIXTURES.md#email-sending",
  },
  "google-oauth": {
    name: "google-oauth",
    keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    shape: "credential",
    consequence: "The Google provider suite, on localhost (#84), skips.",
    doc: "docs/FIXTURES.md#google-oauth",
  },
  "live-deploy": {
    name: "live-deploy",
    keys: ["PITHY_LIVE_DEPLOY"],
    shape: "switch",
    consequence: "The secrets provision, write, rotate and teardown round trip skips.",
    doc: "docs/FIXTURES.md#live-deploy",
  },
  "r2-s3-keys": {
    name: "r2-s3-keys",
    keys: ["R2_CREDENTIALS"],
    shape: "credential",
    consequence: "The R2 presigned-URL suite skips, and stale buckets are not reclaimed.",
    doc: "docs/FIXTURES.md#r2-s3-keys",
  },
  "secrets-store": {
    name: "secrets-store",
    keys: ["SECRETS_STORE_ID"],
    shape: "credential",
    consequence: "The Secrets Store suites skip, and stale entries are not reclaimed.",
    doc: "docs/FIXTURES.md#secrets-store",
  },
  "turnstile-widget": {
    name: "turnstile-widget",
    keys: ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"],
    shape: "credential",
    consequence: "Turnstile sign-in gating on a workers.dev hostname (#84) skips.",
    doc: "docs/FIXTURES.md#turnstile-widget",
  },
} as const satisfies Record<string, LiveFixture>;

/** Every declared fixture name. A typo is a type error rather than a silently skipped suite. */
export type FixtureName = keyof typeof LIVE_FIXTURES;

/** How a fixture is resolved: from an injected environment, or from the run's own. */
export interface FixtureOptions {
  /**
   * The environment to read. Defaults to {@link fixtureEnv}.
   *
   * A test passes its own, so a maintainer's real `.dev.vars` can never decide whether a unit test
   * passes — the failure mode `vitest.setup.ts` exists to prevent, one level up.
   */
  env?: Record<string, string | undefined>;
}

/**
 * The environment a fixture resolves against: `packages/cloudflare/.dev.vars` first, then `process.env`.
 *
 * The same pair {@link loadIntegrationEnv} already reads for credentials, so a fixture and a credential
 * cannot disagree about which file they came from. `.dev.vars` wins where both state a key, because a
 * file somebody wrote on purpose beats a variable their shell exported hours ago.
 */
export function fixtureEnv(): Record<string, string | undefined> {
  return { ...process.env, ...loadIntegrationEnv() };
}

/** Judge one variable, with no knowledge of the fixture it belongs to. */
function verdictFor(key: string, shape: FixtureShape, raw: string | undefined): KeyVerdict {
  if (raw === undefined) return { key, outcome: "absent", note: "is not set" };
  if (raw === "") return { key, outcome: "malformed", note: "is set to an empty value" };

  const value = raw.trim();
  if (value === "") return { key, outcome: "malformed", note: "is set to whitespace" };
  if (PLACEHOLDER_TEXT.has(value.toLowerCase())) {
    return { key, outcome: "malformed", note: "is set to placeholder text, not a value" };
  }

  if (shape === "switch") {
    const word = value.toLowerCase();
    if (SWITCH_ON.has(word)) return { key, outcome: "present", note: "is on" };
    if (SWITCH_OFF.has(word)) return { key, outcome: "declined", note: "is off" };
    return { key, outcome: "malformed", note: "is set to a word that is neither on nor off" };
  }

  return { key, outcome: "present", note: "is set" };
}

/** Fold a fixture's keys into one outcome: the worst wins, so one broken key is never averaged away. */
function foldOutcome(verdicts: readonly KeyVerdict[]): FixtureOutcome {
  let worst: FixtureOutcome = "present";
  for (const verdict of verdicts) {
    if (OUTCOME_RANK[verdict.outcome] < OUTCOME_RANK[worst]) worst = verdict.outcome;
  }
  return worst;
}

/** The sentence for a fixture's outcome: every key in the offending state, and what state that is. */
function reasonFor(outcome: FixtureOutcome, verdicts: readonly KeyVerdict[]): string {
  if (outcome === "present") return "Ready.";
  const offenders = verdicts.filter((verdict) => verdict.outcome === outcome);
  const note = offenders[0]?.note ?? "is not set";
  const keys = offenders.map((verdict) => verdict.key).join(", ");
  return `${keys} ${offenders.length === 1 ? note : note.replace(/^is /, "are ")}.`;
}

/**
 * Resolve one fixture against an environment.
 *
 * Never throws and never reaches the network. It answers what this run has; deciding what to do about it
 * is {@link fixtureReady}'s job, and saying so out loud is {@link reportFixtureEstate}'s.
 */
export function resolveFixture(name: FixtureName, options: FixtureOptions = {}): FixtureResolution {
  const fixture: LiveFixture = LIVE_FIXTURES[name];
  const env = options.env ?? fixtureEnv();
  const verdicts = fixture.keys.map((key) => verdictFor(key, fixture.shape, env[key]));
  const outcome = foldOutcome(verdicts);
  return { fixture, outcome, ready: outcome === "present", reason: reasonFor(outcome, verdicts) };
}

/**
 * Whether a suite gated on this fixture can run — the boolean a `describe.skipIf` negates:
 *
 * ```ts
 * describe.skipIf(!fixtureReady("turnstile-widget"))("turnstile — LIVE", () => { … });
 * ```
 *
 * False for every outcome that is not `present`, malformed included. The distinction between a fixture
 * nobody configured and one somebody configured wrongly belongs in the report, not in whether the suite
 * runs: neither can be tested against, and a run that failed on the second would fail a contributor
 * whose CI template exports blanks — the same "the kit is broken" this file exists to prevent.
 */
export function fixtureReady(name: FixtureName, options: FixtureOptions = {}): boolean {
  return resolveFixture(name, options).ready;
}

/**
 * One of a ready fixture's values.
 *
 * Throws when the fixture is not ready, and that is not a contradiction of the rule above: reaching here
 * means a suite read a value it never gated on, which is a defect in the suite rather than a missing
 * credential. The error names the key and never carries a value — `detail` reaches a log.
 */
export function fixtureValue(name: FixtureName, key: string, options: FixtureOptions = {}): string {
  const fixture: LiveFixture = LIVE_FIXTURES[name];
  if (!fixture.keys.includes(key)) {
    throw new ValidationError({
      message: `Fixture ${name} declares no ${key}.`,
      action: `Read one of: ${fixture.keys.join(", ")}.`,
      detail: `fixtureValue was asked for ${key}, which is not in the ${name} fixture's keys.`,
    });
  }
  const resolution = resolveFixture(name, options);
  if (!resolution.ready) {
    throw new ValidationError({
      message: `Fixture ${name} is ${resolution.outcome}.`,
      action: `Gate the suite with fixtureReady("${name}"), or create the fixture: ${fixture.doc}.`,
      detail: `${resolution.reason} A suite read a fixture value it had not gated on.`,
    });
  }
  const env = options.env ?? fixtureEnv();
  return (env[key] ?? "").trim();
}

/**
 * The lines a run prints about its fixtures — pure, so a test reads exactly what a human would.
 *
 * One line per fixture, then a count. A present fixture still gets a line: a report that only speaks when
 * something is wrong cannot tell "the estate is complete" from "the report never ran", and that is the
 * same indistinguishability this whole file is about.
 */
export function fixtureReportLines(resolutions: readonly FixtureResolution[]): string[] {
  const lines = resolutions.map((resolution) => {
    if (resolution.ready) return `fixture present: ${resolution.fixture.name}.`;
    return [
      `fixture ${resolution.outcome}: ${resolution.fixture.name}.`,
      resolution.reason,
      resolution.fixture.consequence,
      `See ${resolution.fixture.doc}.`,
    ].join(" ");
  });

  const counted = (outcome: FixtureOutcome) => resolutions.filter((entry) => entry.outcome === outcome).length;
  lines.push(
    `fixtures: ${counted("present")} present, ${counted("absent")} absent, ` +
      `${counted("malformed")} malformed, ${counted("declined")} declined. ` +
      "A skipped suite is not a passing one.",
  );
  return lines;
}

/**
 * Resolve every fixture, say what the run has, and hand back the resolutions.
 *
 * The `globalSetup` entry point. Never throws — a report that fails the run it was meant to explain is
 * worse than no report, exactly as the debris sweep beside it is.
 */
export function reportFixtureEstate(options: FixtureOptions = {}): FixtureResolution[] {
  let resolutions: FixtureResolution[] = [];
  try {
    const env = options.env ?? fixtureEnv();
    resolutions = (Object.keys(LIVE_FIXTURES) as FixtureName[]).map((name) => resolveFixture(name, { env }));
    for (const line of fixtureReportLines(resolutions)) console.warn(line);
  } catch (error) {
    console.warn(`the fixture estate could not be reported: ${error instanceof Error ? error.message : String(error)}`);
  }
  return resolutions;
}
