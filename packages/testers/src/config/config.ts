// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { TestersNotConfiguredError } from "../error/errors";

/**
 * Configuration for the testers capability — the roster policy, the clock's shape, and every constant
 * behind the forecast.
 *
 * **The load-bearing decision is that all of it is configurable and none of it is hidden.** The survival
 * table below turns a tester's health score into "how likely are they to still be opted in on day
 * fourteen", and those numbers are priors we chose, not parameters fitted to anybody's data. A model
 * that cannot be audited or adjusted by the developer relying on it is a model asking to be trusted on
 * authority — and this capability's whole position is that Google owns the authoritative number and we
 * do not. So every constant is a described config field, and `modelVersion` is stamped on every daily
 * snapshot so a chart can annotate exactly where a developer's change took effect.
 *
 * Cohorts themselves are rows, not config: a cohort has a lifecycle, a roster, and an event history, and
 * none of that belongs in a file that is redeployed. What lives here is the policy every new cohort
 * inherits.
 */

/** The longest a cohort or member display name may be. Long enough for a real name, short enough to render. */
const MAX_NAME_LENGTH = 120;

/**
 * Google Play's floor: twelve testers, opted in continuously for fourteen days, before a new personal
 * developer account gets production access.
 */
const PLAY_TARGET_SIZE = 12;

/** Google Play's continuous window, in days. */
const PLAY_WINDOW_DAYS = 14;

/**
 * The roster cap a cohort defaults to.
 *
 * **This is a management default, not a store limit, and the difference matters.** Play's *internal*
 * testing track caps at 100 testers per app; *closed* testing — the track the 12-for-14 requirement
 * actually runs on — allows up to 2,000 emails per list and 50 lists per track. So 100 is not a ceiling
 * Google imposes here. It is the size of roster one person can still chase by hand, which is the real
 * constraint on a solo developer, and it is why over-provisioning advice is capped near it rather than
 * telling someone to invite four hundred people they will never follow up with.
 */
const DEFAULT_MAX_ROSTER_SIZE = 100;

/** The hard ceiling on a roster: Play's closed-testing per-list limit. Beyond this you need a second list. */
const PLAY_CLOSED_TEST_LIST_LIMIT = 2000;

/**
 * The hosts a cohort's opt-in URL may point at.
 *
 * The opt-in route renders a link to this URL, so an unconstrained value would be an
 * open redirect from the adopter's own domain — the one place a phishing link is most likely to be
 * trusted, since the tester arrived there from an email the adopter signed. An allowlist of the two
 * stores' own hosts is the whole legitimate surface.
 */
export const STORE_OPT_IN_HOSTS: readonly string[] = ["play.google.com", "testflight.apple.com"];

/**
 * Whether a URL is a store opt-in page we are willing to put in front of a tester.
 *
 * Exact host match over HTTPS. A subdomain check would accept `play.google.com.evil.test`, which is the
 * classic way this validation is got wrong.
 */
export function isStoreOptInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && STORE_OPT_IN_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/** The platform a cohort's test targets, which decides what "has a usable device" means for its testers. */
export const TesterPlatform = z
  .enum(["android", "ios"])
  .describe(
    "Which store's beta program this cohort serves. `android` is the default because the 12-for-14 requirement that motivates this capability is Google Play's; `ios` covers a TestFlight cohort, which has no equivalent minimum.",
  );
export type TesterPlatform = z.output<typeof TesterPlatform>;

/**
 * What Pithy assumes happens to the continuous-day counter when a cohort dips below its target.
 *
 * Google does not document this and no API exposes it, so it is genuinely an assumption — named as one,
 * on the wire and in config, rather than buried in the arithmetic.
 */
export const ResetPolicy = z
  .enum(["reset", "pause"])
  .describe(
    "Pithy's ASSUMPTION about a dip below target: `reset` restarts the streak from zero, `pause` holds it and resumes. Google's actual behavior is undocumented. `reset` is the default deliberately — an estimate that errs toward 'you are not finished yet' fails safe, and being told day fourteen while actually on day three is the expensive mistake.",
  );
export type ResetPolicy = z.output<typeof ResetPolicy>;

/**
 * Per-day survival probabilities by health band — the priors behind the whole forecast.
 *
 * Read each as "the chance this tester is still opted in tomorrow". Raised to the power of the days
 * remaining, that becomes their chance of lasting the window, and the exact Poisson-binomial over every
 * tester becomes the cohort's. They are declared, not fitted, and `GET /testers/cohorts` says so in a
 * `calibration` field so nobody mistakes 0.998 for a measurement.
 */
export const SurvivalPriors = z
  .object({
    healthy: z
      .number()
      .gt(0)
      .lte(1)
      .default(0.998)
      .describe("Daily survival for a tester scoring 80–100. About a 1-in-500 chance of dropping on any given day."),
    watch: z
      .number()
      .gt(0)
      .lte(1)
      .default(0.99)
      .describe(
        "Daily survival for a tester scoring 60–79. Roughly 1-in-100 a day — usually fine over a week, dicey over two.",
      ),
    atRisk: z
      .number()
      .gt(0)
      .lte(1)
      .default(0.97)
      .describe("Daily survival for a tester scoring 30–59. A coin-flip-and-a-half over a full fourteen-day window."),
    critical: z
      .number()
      .gt(0)
      .lte(1)
      .default(0.93)
      .describe("Daily survival for a tester scoring 0–29. More likely than not to be gone before the window closes."),
    unknown: z
      .number()
      .gt(0)
      .lte(1)
      .default(0.985)
      .describe(
        "Daily survival for a tester we cannot observe at all — one who opted in but never signed in, so there is no activity signal. A blanket assumption, deliberately mild: absence of evidence is not evidence of risk.",
      ),
    unreachable: z
      .number()
      .gt(0)
      .lte(1)
      .default(0.95)
      .describe(
        "Daily survival for a tester whose address hard-bounced or was suppressed. Lower than `unknown` because we cannot even nudge them — this is a replace-this-person signal.",
      ),
  })
  .describe(
    "Per-day survival probability by health band. Pithy's declared priors, not values fitted to your data — change them if you disagree, and bump `modelVersion` so your charts annotate the change.",
  );
export type SurvivalPriors = z.output<typeof SurvivalPriors>;

/**
 * Points deducted from a tester's health, by observed condition.
 *
 * Every term is surfaced individually on the API as a `factors[]` entry, so a score is auditable line by
 * line rather than asserted. The dark-day bands are exclusive — exactly one fires.
 */
export const HealthPenalties = z
  .object({
    darkThreeToFour: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe("Quiet for 3–4 days. Three days is noise rather than signal — a nudge-worthy shrug."),
    darkFiveToSeven: z
      .number()
      .int()
      .min(0)
      .default(25)
      .describe("Quiet for 5–7 days. A week without opening the app is the first real sign of drift."),
    darkEightToTen: z
      .number()
      .int()
      .min(0)
      .default(45)
      .describe("Quiet for 8–10 days. The strongest single predictor of a silent uninstall."),
    darkElevenToThirteen: z
      .number()
      .int()
      .min(0)
      .default(60)
      .describe("Quiet for 11–13 days. Nearly the whole window with no sign of life."),
    darkFourteenPlus: z
      .number()
      .int()
      .min(0)
      .default(75)
      .describe("Quiet for 14 days or more. Gone longer than the test you are asking them to complete."),
    noTargetPlatformDevice: z
      .number()
      .int()
      .min(0)
      .default(15)
      .describe(
        "No registered device on the cohort's target platform. An Android test needs an Android device, and a tester with only a web session may not be testing the build at all.",
      ),
    unansweredNudge: z
      .number()
      .int()
      .min(0)
      .default(8)
      .describe(
        "Per nudge sent since they last answered. Each nudge is a probe, and the counter clears when they answer one — accepting the invitation or confirming the opt-in. Opening the app does not clear it: activity is a separate signal with its own penalties, and folding the two together would let a tester who never replies look responsive because they installed the app once.",
      ),
    unansweredNudgeCap: z
      .number()
      .int()
      .min(0)
      .default(24)
      .describe(
        "The most `unansweredNudge` may deduct in total. Three unanswered probes is already an answer; a fourth tells you nothing new.",
      ),
    noSessionSinceOptIn: z
      .number()
      .int()
      .min(0)
      .default(20)
      .describe(
        "Confirmed the opt-in link but has not opened the app since. They are counted, but they are not testing.",
      ),
  })
  .describe(
    "Health-score deductions by observed condition. Each is reported as its own factor so the score can be audited.",
  );
export type HealthPenalties = z.output<typeof HealthPenalties>;

/** Points added back to a tester's health, by observed condition. */
export const HealthCredits = z
  .object({
    engaged: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe("At least `engagedSessionThreshold` sessions inside the window. A tester who is actually testing."),
    engagedSessionThreshold: z
      .number()
      .int()
      .positive()
      .default(5)
      .describe("How many sessions inside the window count as engaged. Five is a tester opening the app most days."),
    multiDevice: z
      .number()
      .int()
      .min(0)
      .default(5)
      .describe("Two or more registered devices. Someone invested enough to install twice."),
    freshOptIn: z
      .number()
      .int()
      .min(0)
      .default(5)
      .describe(
        "Opted in within the last `freshOptInDays` days, so decay has had no time to apply. Without this a tester who joined this morning reads as neglected.",
      ),
    freshOptInDays: z.number().int().positive().default(3).describe("How recently an opt-in counts as fresh, in days."),
  })
  .describe("Health-score credits by observed condition, and the thresholds that decide when each applies.");
export type HealthCredits = z.output<typeof HealthCredits>;

/** How and when this capability may mail a tester, and what a caller may put in the message. */
export const NudgePolicy = z
  .object({
    cooldownHours: z
      .number()
      .int()
      .positive()
      .default(72)
      .describe(
        "The minimum hours between two nudges to one tester, enforced server-side on every path. A nudge trigger with no guard is a button that mails the same twelve people repeatedly, and the fastest way to lose a cohort is to become the reason they muted you.",
      ),
    allowCopyOverride: z
      .boolean()
      .default(true)
      .describe(
        "Whether a control-plane caller may supply its own subject and plain-text body. Set false to pin the shipped defaults, which is the right choice if the dashboard credential is shared more widely than the sending domain's reputation can afford.",
      ),
    maxSubjectLength: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(120)
      .describe(
        "The longest overridden subject accepted. A subject longer than this is truncated by every mail client anyway.",
      ),
    maxBodyLength: z
      .number()
      .int()
      .positive()
      .max(20_000)
      .default(4000)
      .describe(
        "The longest overridden body accepted, in characters. Generous for a nudge and small enough that a flood of them cannot be a rendering denial of service.",
      ),
  })
  .describe(
    "Nudge policy: the per-tester cooldown, and whether a caller may supply copy. A caller may author words; this capability always owns the envelope, the rendering, and the delivery.",
  );
export type NudgePolicy = z.output<typeof NudgePolicy>;

/** The defaults every new cohort inherits, and the bounds a cohort may be created within. */
export const CohortDefaults = z
  .object({
    targetSize: z
      .number()
      .int()
      .positive()
      .default(PLAY_TARGET_SIZE)
      .describe(
        "How many testers must be opted in simultaneously. Twelve, because that is Google Play's requirement for a new personal developer account. TestFlight has no equivalent minimum, so an `ios` cohort may set whatever number the team actually wants.",
      ),
    windowDays: z
      .number()
      .int()
      .positive()
      .max(365)
      .default(PLAY_WINDOW_DAYS)
      .describe(
        "How many continuous days the target must hold. Fourteen, matching Play's rule that the days be consecutive — a tester who opts in, tests for nine days, opts out and opts back in has not banked those nine days.",
      ),
    maxRosterSize: z
      .number()
      .int()
      .positive()
      .max(PLAY_CLOSED_TEST_LIST_LIMIT)
      .default(DEFAULT_MAX_ROSTER_SIZE)
      .describe(
        "The roster cap for a new cohort. A hundred by default — not a store limit, but the size of roster one person can still chase by hand. Play's closed-testing ceiling is 2,000 per email list; the widely-repeated 100 figure is the *internal* track's cap and does not apply here.",
      ),
    targetPlatform: TesterPlatform.default("android").describe(
      "Which store's program new cohorts serve by default. Decides which registered device counts as usable, and nothing else.",
    ),
    storeOptInUrl: z
      .string()
      .nullable()
      .default(null)
      .refine((value) => value === null || isStoreOptInUrl(value), {
        message:
          "storeOptInUrl must be an https URL on play.google.com or testflight.apple.com — the opt-in route renders it as a link on a page served from your own domain, so anything else would put your domain behind a link you did not choose.",
      })
      .describe(
        "The store's own opt-in page every new cohort inherits — `https://play.google.com/apps/testing/<package>` for Play, or a TestFlight public link. Copy it from the console; Google documents no format for it, so Pithy will not guess one. THIS is where a tester actually enrolls: Pithy's confirmation link records that they went and then sends them here.",
      ),
    resetPolicy: ResetPolicy.default("reset").describe(
      "What a dip below target does to the streak, for new cohorts. Pithy's assumption, not Google's documented behavior.",
    ),
  })
  .describe(
    "What a cohort inherits when it is created without explicit values. A cohort stores its own copy, so changing this never rewrites history.",
  );
export type CohortDefaults = z.output<typeof CohortDefaults>;

/** The whole testers configuration. */
export const TestersConfig = z
  .object({
    basePath: z
      .string()
      .startsWith("/")
      .default("/testers")
      .describe(
        "Where the testers routes mount, the public opt-in link included. Change it and the confirmation links in already-sent invitations break, so pick it before you invite anybody.",
      ),
    baseUrl: z
      .url()
      .optional()
      .describe(
        "The absolute origin the opt-in link is built from, e.g. `https://api.example.com`. Required for invitations, because an email cannot carry a relative URL. Omit it only if you never send one.",
      ),
    cohortDefaults: CohortDefaults.default(CohortDefaults.parse({})).describe("The policy every new cohort inherits."),
    activeWithinDays: z
      .number()
      .int()
      .positive()
      .default(3)
      .describe(
        "How recently a tester must have authenticated to count as `active`. Three days, so a weekend of silence is not an alarm.",
      ),
    optInLinkTtlDays: z
      .number()
      .int()
      .positive()
      .max(365)
      .default(30)
      .describe(
        "How long an opt-in link stays valid. Long enough to survive an inbox nobody checks for a fortnight, short enough that a forwarded link does not stay live for a year.",
      ),
    nudges: NudgePolicy.default(NudgePolicy.parse({})).describe("The nudge cooldown and the copy-override policy."),
    survival: SurvivalPriors.default(SurvivalPriors.parse({})).describe(
      "The per-day survival priors behind the forecast.",
    ),
    healthPenalties: HealthPenalties.default(HealthPenalties.parse({})).describe("The health-score deductions."),
    healthCredits: HealthCredits.default(HealthCredits.parse({})).describe("The health-score credits."),
    snapshotHourUtc: z
      .number()
      .int()
      .min(0)
      .max(23)
      .default(5)
      .describe(
        "The UTC hour the daily pass runs. Five, offset from storage's 03:00 sweep and payments' 04:00 reconciliation so three hosts in one account do not contend for the same minute.",
      ),
    snapshotRetentionDays: z
      .number()
      .int()
      .positive()
      .default(400)
      .describe(
        "How many daily snapshots a cohort keeps. Four hundred days is a year of chart with room either side; a fourteen-day cohort writes fourteen rows and never approaches it.",
      ),
    modelVersion: z
      .string()
      .min(1)
      .max(32)
      .default("1")
      .describe(
        "The label stamped on every snapshot identifying which set of survival and health constants produced it. Bump it whenever you change one: a trend line that silently spans two models is a lie, and the dashboard uses this to annotate where your change took effect.",
      ),
    maxNameLength: z
      .number()
      .int()
      .positive()
      .max(MAX_NAME_LENGTH)
      .default(MAX_NAME_LENGTH)
      .describe("The longest cohort or tester name accepted. Bounded so a roster stays renderable."),
  })
  .describe(
    "Configuration for the testers capability: where it mounts, what a cohort defaults to, and every constant behind the forecast. Pithy's opt-in count is an estimate from your own invite records; Google's count is authoritative and no API exposes it.",
  )
  .check((ctx) => {
    const config = ctx.value;
    // A target larger than the roster cap is a cohort that can never succeed, and the failure would
    // only show up as a forecast that never reaches 1.0 — worth catching at deploy instead.
    if (config.cohortDefaults.targetSize > config.cohortDefaults.maxRosterSize) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["cohortDefaults", "targetSize"],
        message: `targetSize (${config.cohortDefaults.targetSize}) exceeds maxRosterSize (${config.cohortDefaults.maxRosterSize}). A cohort whose target is larger than its roster cap can never reach target.`,
      });
    }
    // A link that expires before the window closes strands testers mid-cohort, and the symptom — an
    // opt-in route that 400s for exactly the people you most need — is miserable to diagnose live.
    if (config.optInLinkTtlDays < config.cohortDefaults.windowDays) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["optInLinkTtlDays"],
        message: `optInLinkTtlDays (${config.optInLinkTtlDays}) is shorter than windowDays (${config.cohortDefaults.windowDays}). An invitation would expire before the test window it belongs to closes.`,
      });
    }
    // Activity is the early-warning signal; a window wider than the test window would report a tester
    // as active on the strength of a session from before the cohort existed.
    if (config.activeWithinDays >= config.cohortDefaults.windowDays) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["activeWithinDays"],
        message: `activeWithinDays (${config.activeWithinDays}) must be shorter than windowDays (${config.cohortDefaults.windowDays}), or every tester reads as active for the whole window and the early-warning signal is dead.`,
      });
    }
    // Retention shorter than the window means the chart loses the beginning of the very cohort it is
    // drawing — the only period where a reset is still explicable.
    if (config.snapshotRetentionDays < config.cohortDefaults.windowDays) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["snapshotRetentionDays"],
        message: `snapshotRetentionDays (${config.snapshotRetentionDays}) is shorter than windowDays (${config.cohortDefaults.windowDays}). The trend would be pruned out from under the window it describes.`,
      });
    }
  });
export type TestersConfig = z.output<typeof TestersConfig>;
export type TestersConfigInput = z.input<typeof TestersConfig>;

/**
 * The absolute base URL, or a stated failure. Invitations cannot be built without it, so the check
 * lives here rather than at each send site.
 */
export function requireBaseUrl(config: TestersConfig): string {
  if (!config.baseUrl) {
    throw new TestersNotConfiguredError({
      message: "Invitations cannot be sent yet.",
      action: "Set `baseUrl` on the testers block in pithy.config.ts — an email cannot carry a relative link.",
      detail: "testers.baseUrl is unset, so an absolute opt-in URL cannot be built",
    });
  }
  return config.baseUrl.replace(/\/+$/, "");
}

/**
 * The link in the first email: "yes, I will test."
 *
 * Records their consent and tells the developer to add the address to the store's tester list. No store
 * link is shown here, because it would not work yet.
 */
export function confirmUrl(config: TestersConfig, token: string): string {
  return `${requireBaseUrl(config)}${config.basePath}/confirm/${token}`;
}

/**
 * The link in the second email: through to the store's own opt-in page.
 *
 * Sent only once the developer has added the address to the tester list. It records the strongest
 * enrollment signal Pithy can observe and then hands the tester the store's link.
 */
export function optInUrl(config: TestersConfig, token: string): string {
  return `${requireBaseUrl(config)}${config.basePath}/opt-in/${token}`;
}

/** The link a tester follows to withdraw. */
export function optOutUrl(config: TestersConfig, token: string): string {
  return `${requireBaseUrl(config)}${config.basePath}/opt-out/${token}`;
}
