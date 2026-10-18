// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What turnstile's control-plane read answers (#731).
 *
 * **A management client in a browser parses these**, so this module imports Zod and nothing else — never a
 * config module, never the middleware. The widget modes are written out here rather than imported from the
 * config for the same reason.
 *
 * Every widget is reported in exactly one of three states, and a client branches on `state`: counted from
 * Cloudflare's analytics, a documented test key whose outcome is fixed and so is never counted, or no
 * sitekey at all. A test key is never reported as zero challenges, and never as broken.
 */

/** The widget mode, as the config names it. */
const WidgetMode = z
  .enum(["visible", "invisible"])
  .describe("The widget's mode: `visible` (a Cloudflare managed widget) or `invisible`.");

/** One Turnstile event type and how many Cloudflare counted. */
export const TurnstileEventCount = z
  .object({
    eventType: z.string().describe("The event type, as Cloudflare names it, e.g. `challenge_issued`."),
    count: z.number().int().nonnegative().describe("Events of this type in the window."),
  })
  .describe("One Turnstile event type and its count.");
export type TurnstileEventCount = z.infer<typeof TurnstileEventCount>;

/** A real widget's challenge outcomes in the window. */
export const TurnstileOutcomes = z
  .object({
    issued: z.number().int().nonnegative().describe("Challenges Cloudflare issued to visitors."),
    solved: z.number().int().nonnegative().describe("Challenges visitors solved, interactive or not."),
    unsolved: z
      .number()
      .int()
      .nonnegative()
      .describe("Challenges issued and not solved: abandoned or failed. Issued less solved, never below zero."),
    solveRate: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe("Solved over issued, from 0 to 1. Null when nothing was issued, which is not a rate of zero."),
    siteverify: z
      .object({
        passed: z.number().int().nonnegative().describe("Tokens this Worker's siteverify call accepted."),
        refused: z
          .number()
          .int()
          .nonnegative()
          .describe("Tokens siteverify refused: spent twice, invalid, rate-limited, or failed otherwise."),
      })
      .describe("What the server-side check made of the tokens visitors brought back."),
    events: z
      .array(TurnstileEventCount)
      .describe("Every event type Cloudflare counted, most first — a type added later is counted here too."),
  })
  .describe("A real widget's challenge outcomes in the window, from Cloudflare's Turnstile analytics.");
export type TurnstileOutcomes = z.infer<typeof TurnstileOutcomes>;

/** What a documented test key always does. */
export const TurnstileTestKeyVerdict = z
  .enum(["passes", "blocks", "challenges"])
  .describe(
    "What the test key always does: `passes` every visitor, `blocks` every visitor, or `challenges` every visitor.",
  );
export type TurnstileTestKeyVerdict = z.infer<typeof TurnstileTestKeyVerdict>;

/** One widget, as this environment's Worker serves it. */
export const TurnstileWidgetReport = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("reported").describe("A real widget, its outcomes read from Cloudflare's analytics."),
        mode: WidgetMode,
        sitekey: z.string().describe("The widget's public sitekey, in force in this environment."),
        testKey: z.literal(false).describe("Not one of Cloudflare's documented test keys."),
        outcomes: TurnstileOutcomes,
      })
      .describe("A real widget and how its challenges went."),
    z
      .object({
        state: z.literal("test-key").describe("A documented test key. Its outcome is fixed, so nothing is counted."),
        mode: WidgetMode,
        sitekey: z.string().describe("The test sitekey, in force in this environment."),
        testKey: z.literal(true).describe("One of Cloudflare's documented test keys."),
        verdict: TurnstileTestKeyVerdict,
        message: z.string().describe("What the key does, and that it is deliberate."),
      })
      .describe("A test key, deliberately. Never reported as broken, and never as zero challenges."),
    z
      .object({
        state: z.literal("unconfigured").describe("No sitekey is in force here, so no widget renders."),
        mode: WidgetMode,
        message: z.string().describe("Why no widget renders in this environment."),
      })
      .describe("A widget the config declares and this environment renders nowhere."),
  ])
  .describe("One widget this Worker's config declares, as its environment serves it.");
export type TurnstileWidgetReport = z.infer<typeof TurnstileWidgetReport>;

/** What the widget read returns. */
export const TurnstileWidgetsResponse = z
  .object({
    environment: z
      .string()
      .nullable()
      .describe("The environment this Worker serves, from its `ENVIRONMENT` var. Null for a Worker that names none."),
    since: z.string().describe("The window's start, inclusive, as ISO-8601."),
    until: z.string().describe("The window's end, exclusive, as ISO-8601."),
    widgets: z.array(TurnstileWidgetReport).describe("Every widget the config declares, `visible` first."),
  })
  .describe(
    "Which widget guards this environment, whether it is a real one or a test key, and how its challenges went.",
  );
export type TurnstileWidgetsResponse = z.infer<typeof TurnstileWidgetsResponse>;
