// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InputRequiredError, InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { RailChoice } from "@pithy-sh/ui-react-native/src/generatedConfig";
import { declaresConstant } from "../capabilities/configConstants";
import { type RunAddOptions, runAdd } from "../capabilities/flow";
import { kitAddFacts } from "../capabilities/kitAddFacts";
import { locateRegistration } from "../capabilities/reconcile";
import { canceled } from "../terminal/exitClass";
import type { BackendRails } from "../ui/rails";
import { parseRail, RAIL_PLATFORMS, type RailPlatform, railFlag } from "../ui/rails";
import { writeFileAtomic } from "./atomic";
import { composeFor } from "./composeFor";
import type { WorkerConfig } from "./config";
import { type InstallRunner, installPackage, type PackageManager } from "./packageManager";

/**
 * `pithy init` with a rail named: the new Worker composes payments, through the same `runAdd` `pithy add payments
 * --with-prerequisites` runs, and then turns on exactly the rails the flags named.
 */

/** A rail that sells something: any rail but `none`. */
export type SoldRail = Exclude<RailChoice, "none">;

/** Every rail payments knows, in the order its config lists them. */
const PAYMENTS_RAILS: readonly SoldRail[] = ["apple", "google", "stripe", "lemonSqueezy", "paddle"];

/** The flag that answers payments' `billingSubject` on `pithy init`. */
export const BILLING_SUBJECT_FLAG = "--billing-subject";

/** What a person reads beside each billing subject. */
const SUBJECT_LABELS: Readonly<Record<string, string>> = {
  user: "user. One person buys, one person is entitled.",
  organization:
    "organization. A company buys, and everyone in it is entitled. Leaves you a subject resolver to finish.",
};

/** The value the billing-subject question opens on: no answer, so enter alone is refused. */
const UNANSWERED = "";

/** The billing subjects payments takes, from the kit's own manifest. */
function billingSubjects(): readonly string[] {
  const option = kitAddFacts("payments")?.requiredOptions.find((one) => one.key === "billingSubject");
  return option?.choices ?? ["user", "organization"];
}

/** `a or b`, for a refusal's action line. */
function either(values: readonly string[]): string {
  return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

/**
 * Parse `--ios-rail`, `--android-rail` and `--web-rail`. A rail the platform cannot sell through is refused by
 * {@link parseRail}, and `paddle` is refused everywhere: its `paddle` block needs a client token only the adopter's
 * Paddle account holds, so init has nothing true to write.
 */
export function parseInitRails(
  flags: Partial<Record<RailPlatform, string>>,
): Partial<Record<RailPlatform, RailChoice>> {
  const parsed: Partial<Record<RailPlatform, RailChoice>> = {};
  for (const platform of RAIL_PLATFORMS) {
    const raw = flags[platform];
    if (raw === undefined) continue;
    const rail = parseRail(platform, raw);
    if (rail === "paddle") {
      throw new ValidationError({
        message: "init can't turn on the paddle rail. It needs your Paddle client token.",
        action: `Pass ${railFlag(platform)} with another rail, then turn on rails.paddle with its paddle block in the Worker's pithy.config.ts after init.`,
      });
    }
    parsed[platform] = rail;
  }
  return parsed;
}

/** The rails a set of platform rails sells through, each once, in payments' order. */
export function soldRails(rails: Partial<Record<RailPlatform, RailChoice>>): SoldRail[] {
  const chosen = new Set(Object.values(rails));
  return PAYMENTS_RAILS.filter((rail) => chosen.has(rail));
}

/** The Worker init is about to write, as the rail check reads it: payments composed with exactly `sold` on. */
export function initBackendRails(sold: readonly SoldRail[]): BackendRails {
  const on = (rail: SoldRail) => sold.includes(rail);
  return {
    composed: sold.length > 0,
    enabled: {
      apple: on("apple"),
      google: on("google"),
      stripe: on("stripe"),
      lemonSqueezy: on("lemonSqueezy"),
      paddle: on("paddle"),
    },
  };
}

/** Parse `--billing-subject`, refusing anything payments does not take. */
export function parseBillingSubject(raw: string): string {
  const subjects = billingSubjects();
  if (subjects.includes(raw)) return raw;
  throw new ValidationError({
    message: `"${raw}" is not a billing subject.`,
    action: `Pass ${BILLING_SUBJECT_FLAG} ${either(subjects)}.`,
  });
}

/** The refusal a run gets when it sells through a rail and nobody chose a billing subject. */
function billingSubjectRequired(): InputRequiredError {
  const subjects = billingSubjects();
  return new InputRequiredError({
    flag: BILLING_SUBJECT_FLAG,
    choices: subjects,
    message: "A rail sells through payments, and payments needs a billing subject. Nothing in this run names one.",
    action: `Pass ${subjects.map((subject) => `${BILLING_SUBJECT_FLAG} ${subject}`).join(" or ")}.`,
    detail:
      "billingSubject keys the entitlement column and its UNIQUE index, so payments states no default and init picks none.",
  });
}

/** The one question {@link askBillingSubject} asks, as a seam. */
export interface BillingSubjectPrompt {
  select(options: { message: string; options: { value: string; label: string }[] }): Promise<string | symbol>;
  isCancel(value: unknown): boolean;
}

/**
 * Who holds a subscription, when a rail sells something. A flag decides outright. Without one a human is asked,
 * opening on no answer, and anyone else is refused, naming the flag. A flag with no rail sold is refused: it would
 * answer a question this run never asks. `prompt` is handed over only when a human is attached.
 */
export async function askBillingSubject(options: {
  /** `--billing-subject`, already parsed. */
  flag?: string;
  sold: readonly SoldRail[];
  prompt?: BillingSubjectPrompt;
}): Promise<{ value: string | null; prompted: boolean }> {
  if (options.sold.length === 0) {
    if (options.flag === undefined) return { value: null, prompted: false };
    throw new ValidationError({
      message: `${BILLING_SUBJECT_FLAG} only applies with a rail, and no rail flag names one.`,
      action: `Pass --ios-rail, --android-rail or --web-rail with a rail other than none, or leave out ${BILLING_SUBJECT_FLAG}.`,
    });
  }
  if (options.flag !== undefined) return { value: options.flag, prompted: false };
  const prompt = options.prompt;
  if (prompt === undefined) throw billingSubjectRequired();
  const answer = await prompt.select({
    message: "Who holds a subscription? Changing it once anyone has subscribed is a migration.",
    options: [
      { value: UNANSWERED, label: "Choose one" },
      ...billingSubjects().map((subject) => ({ value: subject, label: SUBJECT_LABELS[subject] ?? subject })),
    ],
  });
  if (prompt.isCancel(answer)) canceled();
  if (answer === UNANSWERED || typeof answer !== "string") throw billingSubjectRequired();
  return { value: answer, prompted: true };
}

/** One rail's settings block, as the lines init writes into the payments registration. */
function hostedSettings(rail: SoldRail, indent: string): string[] {
  const inner = `${indent}  `;
  if (rail === "stripe") {
    return [
      `${indent}// Where Stripe's hosted pages send a browser back to. Built on PUBLIC_ORIGIN, so each environment returns to itself.`,
      `${indent}stripe: {`,
      `${inner}successUrl: \`\${PUBLIC_ORIGIN}/thanks?session={CHECKOUT_SESSION_ID}\`,`,
      `${inner}cancelUrl: \`\${PUBLIC_ORIGIN}/pricing\`,`,
      `${inner}portalReturnUrl: \`\${PUBLIC_ORIGIN}/account\`,`,
      `${indent}},`,
    ];
  }
  if (rail === "lemonSqueezy") {
    return [
      `${indent}// Where Lemon Squeezy's hosted checkout sends a buyer back to. Built on PUBLIC_ORIGIN.`,
      `${indent}lemonSqueezy: { successUrl: \`\${PUBLIC_ORIGIN}/thanks\` },`,
    ];
  }
  return [];
}

/**
 * A Worker's `pithy.config.ts` with the payments registration selling through `sold`: a `rails` line turning each
 * on, and the settings block each hosted rail refuses to boot without. Nothing outside the registration moves.
 */
export function withRailSettings(source: string, sold: readonly SoldRail[]): string {
  const location = locateRegistration(source, "payments");
  if (location?.form !== "block") {
    throw new InternalError({
      message: "The Worker's pithy.config.ts has no payments({ … }) block to turn rails on in.",
      action: "Restore the payments registration, then set its rails by hand.",
    });
  }
  const hosted = sold.filter((rail) => rail === "stripe" || rail === "lemonSqueezy");
  if (hosted.length > 0 && !declaresConstant(source, "publicOrigin")) {
    throw new InternalError({
      message: "The Worker's pithy.config.ts declares no PUBLIC_ORIGIN to build the return URLs on.",
      action: `Declare PUBLIC_ORIGIN, then add the ${hosted.join(" and ")} block by hand.`,
    });
  }
  const indent = `${location.indent}  `;
  const lines = [
    `${indent}// Which stores this project sells through. Every rail is off until named.`,
    `${indent}rails: { ${sold.map((rail) => `${rail}: true`).join(", ")} },`,
    ...sold.flatMap((rail) => hostedSettings(rail, indent)),
  ];
  const lineStart = source.lastIndexOf("\n", location.closeIndex) + 1;
  return `${source.slice(0, lineStart)}${lines.join("\n")}\n${source.slice(lineStart)}`;
}

/** The steps {@link composeInitPayments} runs, each the real one unless a test hands its own. */
export interface InitPaymentsSteps
  extends Pick<RunAddOptions, "install" | "declare" | "migrate" | "sync" | "bootstrap"> {
  /** Read the Worker's config as it now stands (default: composed for `dev`, fresh). */
  load?: (workerDir: string) => Promise<WorkerConfig>;
  /** The spawner the default install runs its package manager through (default: the real install). */
  run?: InstallRunner;
}

/** What composing payments on init produced. */
export interface InitPayments {
  /** The capabilities composed on the way, deepest first. */
  prerequisites: string[];
  /** What the add finished off-config, and what only a provision command can supply. */
  notes: string[];
  /** The Worker's config with payments composed, for the front ends init writes next. */
  config: WorkerConfig;
}

const loadFresh = (workerDir: string): Promise<WorkerConfig> =>
  composeFor(LOCAL_ENVIRONMENT, (load) => load(workerDir, { fresh: true }));

/**
 * Compose payments on the new Worker the way `pithy add payments --with-prerequisites --set billingSubject=<subject>`
 * does, then turn on exactly `rails`. Returns the Worker's config as it stands after both.
 */
export async function composeInitPayments(options: {
  projectDir: string;
  workerDir: string;
  worker: string;
  project: string;
  account: RunAddOptions["account"];
  billingSubject: string;
  rails: readonly SoldRail[];
  /**
   * The manager every install runs through. A new project has no lockfile yet, so without it the first install
   * would run npm and write `package-lock.json` into a project its runner chose otherwise. Defaults to the detected one.
   */
  packageManager?: PackageManager;
  json?: boolean;
  steps?: InitPaymentsSteps;
}): Promise<InitPayments> {
  const { load = loadFresh, run, ...steps } = options.steps ?? {};
  const { packageManager } = options;
  const install: RunAddOptions["install"] =
    steps.install ??
    ((input) =>
      installPackage({
        ...input,
        ...(packageManager === undefined ? {} : { packageManager }),
        ...(run === undefined ? {} : { run }),
      }));
  const added = await runAdd({
    projectDir: options.projectDir,
    workerDir: options.workerDir,
    worker: options.worker,
    project: options.project,
    account: options.account,
    capability: "payments",
    setFlags: [`billingSubject=${options.billingSubject}`],
    withPrerequisites: true,
    ...(options.json === undefined ? {} : { json: options.json }),
    ...steps,
    install,
  });
  const path = join(options.workerDir, "pithy.config.ts");
  await writeFileAtomic(path, withRailSettings(await readFile(path, "utf8"), options.rails));
  return { prerequisites: added.prerequisites, notes: added.notes, config: await load(options.workerDir) };
}
