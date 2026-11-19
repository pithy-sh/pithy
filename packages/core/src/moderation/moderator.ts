// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { Logger } from "../logger/logger";

/** What a piece of text is, so a moderator can hold one kind to a stricter bar than another. */
export const ModerationContext = z
  .enum(["handle", "title", "free_text"])
  .describe(
    "What the text is: `handle` for a name people are known by, `title` for a name given to something they made, `free_text` for anything longer they wrote.",
  );
export type ModerationContext = z.infer<typeof ModerationContext>;

/** A moderator's answer about one piece of text. */
export const ModerationVerdict = z
  .discriminatedUnion("verdict", [
    z
      .object({
        verdict: z.literal("allow").describe("The text may be shown."),
      })
      .describe("The text may be shown."),
    z
      .object({
        verdict: z.literal("reject").describe("The text must not be shown."),
        reason: z
          .string()
          .min(1)
          .describe("Why, as a short code for logs and for the caller to branch on. The default answers `blocklist`."),
      })
      .describe("The text must not be shown."),
    z
      .object({
        verdict: z.literal("review").describe("A person should look before the text is shown."),
        reason: z
          .string()
          .min(1)
          .describe(
            "Why, as a short code. The seam answers `moderator_failed` when the moderator threw or answered something that is not a verdict, and `moderator_timeout` when it did not answer in time.",
          ),
      })
      .describe("A person should look before the text is shown. The caller decides whether to hold it."),
  ])
  .describe("A moderator's answer about one piece of text: allow, reject with a reason, or review with a reason.");
export type ModerationVerdict = z.infer<typeof ModerationVerdict>;

/**
 * The text-moderation seam (`c.var.moderator`): one question about text one person wrote and others will see.
 *
 * Always present. With no `moderation` config it checks a folded blocklist the kit ships; config extends that
 * list, replaces it, or replaces the moderator with your own, such as a Workers AI classifier.
 *
 * A `review` verdict goes back to the caller, which decides whether to hold the text. The seam never answers
 * `allow` for a moderator that threw or ran out of time: that is `review`.
 */
export interface TextModerator {
  /** Check `text`, written as the kind of text `context` names. */
  check(text: string, context: ModerationContext): Promise<ModerationVerdict>;
}

/** How long a moderator has to answer before the seam answers `review` for it, in milliseconds. */
export const DEFAULT_MODERATION_TIMEOUT_MS = 3000;

const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * `moderator`, held to the seam's contract: an answer within `timeoutMs` that parses as a
 * {@link ModerationVerdict}, or `review`.
 *
 * A throw, a rejected promise, or an answer that is not a verdict is `review` with `moderator_failed`; no answer
 * in time is `review` with `moderator_timeout`. Each is logged with the context and never the text, which is
 * a person's own words.
 */
export function guardModerator(
  moderator: TextModerator,
  options: { readonly timeoutMs: number; readonly log: Logger },
): TextModerator {
  const { timeoutMs, log } = options;
  return {
    async check(text, context) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      try {
        const answer = await Promise.race([Promise.resolve().then(() => moderator.check(text, context)), deadline]);
        if (answer === TIMED_OUT) {
          log.warn("moderator timed out", { context, timeoutMs });
          return { verdict: "review", reason: "moderator_timeout" };
        }
        const verdict = ModerationVerdict.safeParse(answer);
        if (verdict.success) return verdict.data;
        log.warn("moderator answered no verdict", { context });
        return { verdict: "review", reason: "moderator_failed" };
      } catch (error) {
        // The name only: a classifier's message can quote the text it was handed.
        log.warn("moderator failed", { context, errorName: error instanceof Error ? error.name : typeof error });
        return { verdict: "review", reason: "moderator_failed" };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
