// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareAnalyticsManager } from "@pithy-sh/cloudflare/src/analytics/analyticsManager";
import { TURNSTILE_EVENTS } from "@pithy-sh/cloudflare/src/analytics/datasets";
import {
  checkAnalyticsWindow,
  resolveAnalyticsWindow,
  type WindowRefusal,
} from "@pithy-sh/cloudflare/src/analytics/window";
import { pithyCommandOf } from "@pithy-sh/core/src/cli/command";
import type { TurnstileConfig, TurnstileMode } from "../config/config";
import { TurnstileAnalyticsUnavailableError, TurnstileAnalyticsWindowError } from "../error/errors";
import type { TurnstileTestKeyVerdict, TurnstileWidgetReport, TurnstileWidgetsResponse } from "../http/responses";
import { isTestKeyEnvironment, resolveSitekey, TEST_KEY_ENVIRONMENTS, testKeyVerdict } from "../provision/testKeys";
import { summarizeOutcomes } from "./outcomes";

/**
 * **Which widget guards this environment, and how its challenges went (#731).**
 *
 * A control-plane read is per environment: this Worker reports the environment it serves, and a client
 * asking about three asks three Workers. Turnstile stays stateless. It has counted nothing, so the outcomes
 * come from Cloudflare's Turnstile analytics, which are account-wide — the sitekey filter is what narrows
 * them to this environment's widget.
 *
 * A test key makes no query. Its outcome is fixed by Cloudflare, so the read says what the key does. In dev,
 * staging and a feature build that is deliberate, never zero challenges and never broken. Anywhere else the
 * gate refuses a test key's verdict as `turnstile/config`, so the read says it is misconfigured, the same
 * fact the middleware states, and never calls a broken production gate deliberate.
 */

/** The slice of {@link CloudflareAnalyticsManager} this read uses — what a test hands in instead. */
export type WidgetSource = Pick<CloudflareAnalyticsManager, "datasetLimits" | "turnstileEvents">;

/** What the read needs. */
export interface WidgetDeps {
  /** The resolved turnstile config — which widgets exist, and their sitekeys per environment. */
  config: TurnstileConfig;
  /** The environment this Worker serves, from its stamped `ENVIRONMENT` var. Null when it names none. */
  environment: string | null;
  /**
   * The analytics reader, built only when a real widget is in force. Lazy, so a test-key environment never
   * reads the account or the token.
   */
  source: () => Promise<WidgetSource>;
  /** The clock. */
  now: () => Date;
}

/** The dataset, as an operator would say it. */
const MEASURED = { dataset: TURNSTILE_EVENTS, label: "Turnstile events" };

/** The widget modes, in the order a report lists them. */
const MODES: readonly TurnstileMode[] = ["visible", "invisible"];

/** A refused window, as turnstile's own code. */
const refuseWindow = (refusal: WindowRefusal) => new TurnstileAnalyticsWindowError(refusal);

/** The remedy for a test key where it is not accepted — the line the middleware names too. */
const PROVISION = pithyCommandOf("turnstile provision", {}, { runtime: true });

/** What each test key is, said once. */
const TEST_KEY_NAMES: Readonly<Record<TurnstileTestKeyVerdict, string>> = {
  passes: "always-pass",
  blocks: "always-fail",
  challenges: "forced-challenge",
};

/** What each test key does, said once. */
const TEST_KEY_SENTENCES: Readonly<Record<TurnstileTestKeyVerdict, string>> = {
  passes:
    "This is Cloudflare's always-pass test key, so every challenge here passes. That is deliberate: a test runner cannot solve a live widget.",
  blocks: "This is Cloudflare's always-fail test key, so every challenge here fails. That is deliberate.",
  challenges:
    "This is Cloudflare's forced-challenge test key, so every visitor here is challenged. That is deliberate.",
};

/** A test key where the gate refuses it, said the way the middleware's refusal says it. */
function misconfiguredSentence(verdict: TurnstileTestKeyVerdict, environment: string): string {
  return `This is Cloudflare's ${TEST_KEY_NAMES[verdict]} test key, and a test key is accepted only where ENVIRONMENT is ${TEST_KEY_ENVIRONMENTS.join(", ")}. Here it is "${environment}", so no challenge gets through. Run \`${PROVISION}\` so this environment renders its own widget.`;
}

/** A widget before any outcome is read: unconfigured, a test key, or a real sitekey still to count. */
type Planned = TurnstileWidgetReport | { state: "real"; mode: TurnstileMode; sitekey: string };

/** Where one configured widget stands in this environment, before anything is asked of Cloudflare. */
function plan(mode: TurnstileMode, config: TurnstileConfig, environment: string | null): Planned {
  if (environment === null) {
    return { state: "unconfigured", mode, message: "This Worker names no environment, so no sitekey is in force." };
  }
  const widget = config.widgets[mode];
  const sitekey = widget ? resolveSitekey(widget.sitekeys, environment, mode) : undefined;
  if (!sitekey) {
    return {
      state: "unconfigured",
      mode,
      message: `No sitekey is stated for ${environment}, so this widget renders nowhere here.`,
    };
  }
  const verdict = testKeyVerdict(sitekey);
  if (verdict !== null) {
    if (!isTestKeyEnvironment(environment)) {
      const message = misconfiguredSentence(verdict, environment);
      return { state: "misconfigured", mode, sitekey, testKey: true, verdict, message };
    }
    return { state: "test-key", mode, sitekey, testKey: true, verdict, message: TEST_KEY_SENTENCES[verdict] };
  }
  return { state: "real", mode, sitekey };
}

/**
 * Read every configured widget for this environment, in the window asked for — the last 30 days by default.
 *
 * Only a real widget reaches Cloudflare, and all of them in one query. The dataset's limits are read from the
 * account's own settings first: one Cloudflare does not serve is a refusal, not an empty answer, and a window
 * past its retention or span is a refusal naming the cap.
 */
export async function readWidgets(
  deps: WidgetDeps,
  input: { since?: Date; until?: Date },
): Promise<TurnstileWidgetsResponse> {
  const now = deps.now();
  const window = resolveAnalyticsWindow(input, now, refuseWindow);
  const planned = MODES.filter((mode) => deps.config.widgets[mode] !== undefined).map((mode) =>
    plan(mode, deps.config, deps.environment),
  );
  const real = planned.filter((widget) => widget.state === "real");

  let events = new Map<string, Map<string, number>>();
  if (real.length > 0) {
    const source = await deps.source();
    const limits = (await source.datasetLimits([TURNSTILE_EVENTS]))[TURNSTILE_EVENTS];
    if (!limits?.enabled) {
      throw new TurnstileAnalyticsUnavailableError({
        message: "Cloudflare does not serve Turnstile analytics to this account, so no outcome can be read.",
        params: { dataset: TURNSTILE_EVENTS },
        detail: `${TURNSTILE_EVENTS} settings: ${limits === undefined ? "absent" : "enabled: false"}`,
      });
    }
    checkAnalyticsWindow(window, limits, MEASURED, now, refuseWindow);
    events = await source.turnstileEvents({ ...window, siteKeys: [...new Set(real.map((w) => w.sitekey))] });
  }

  const widgets: TurnstileWidgetReport[] = planned.map((widget) =>
    widget.state === "real"
      ? {
          state: "reported",
          mode: widget.mode,
          sitekey: widget.sitekey,
          testKey: false,
          outcomes: summarizeOutcomes(events.get(widget.sitekey) ?? new Map()),
        }
      : widget,
  );
  return {
    environment: deps.environment,
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    widgets,
  };
}
