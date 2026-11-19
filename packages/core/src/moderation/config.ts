// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { fromZodError, ValidationError } from "../error/pithyError";
import { blocklistModerator } from "./blocklist";
import { foldEntry } from "./fold";
import { DEFAULT_MODERATION_TIMEOUT_MS, type TextModerator } from "./moderator";
import { SHIPPED_BLOCKLIST } from "./shippedList";

/** Whether `value` has the one method a {@link TextModerator} needs. */
function isModerator(value: unknown): value is TextModerator {
  return typeof value === "object" && value !== null && typeof (value as { check?: unknown }).check === "function";
}

/** One blocklist entry as config writes it. */
export const BlocklistEntry = z
  .string()
  .regex(/^[^*]*\*?$/, "Only a trailing * is allowed.")
  .refine((entry) => foldEntry(entry).words.length > 0, "An entry needs at least one letter or digit.")
  .describe(
    "A word to reject, matched whole after folding case, width, accents and look-alike characters. End it with `*` to match every word that starts with it; write several words to match them in order or run together.",
  );
export type BlocklistEntry = z.infer<typeof BlocklistEntry>;

/** The `moderation` block of a Worker's `pithy.config.ts`. */
export const ModerationConfig = z
  .strictObject({
    words: z
      .array(BlocklistEntry)
      .optional()
      .describe("Words the default moderator rejects, added to the list the kit ships."),
    includeShipped: z
      .boolean()
      .optional()
      .describe("Set `false` to drop the list the kit ships, so `words` is the whole list. Defaults to `true`."),
    moderator: z
      .custom<TextModerator>(isModerator, "Expected an object with a check(text, context) method.")
      .optional()
      .describe(
        "Your own moderator, such as a Workers AI classifier or a third-party API, in place of the default. Compose `blocklistModerator` inside it to keep the list too.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(30_000)
      .optional()
      .describe(
        "How long the moderator has to answer before the seam answers `review`, in milliseconds. Defaults to 3000.",
      ),
  })
  .describe("How this Worker checks text one person writes and others see, read through `c.var.moderator`.");
export type ModerationConfig = z.input<typeof ModerationConfig>;

/** The moderator a Worker's requests read, and how long it has to answer. */
export interface ResolvedModeration {
  /** The moderator before the seam's guard: the default blocklist, or the adopter's own. */
  readonly moderator: TextModerator;
  /** How long it has to answer, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * Parse a `moderation` block, or refuse it naming what is wrong. Called when a Worker assembles, so a block that
 * does not parse never deploys. `undefined` is the default: the shipped list, a 3-second budget.
 */
export function resolveModeration(input: unknown): ResolvedModeration {
  const parsed = ModerationConfig.safeParse(input ?? {});
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The moderation block in pithy.config.ts does not parse.",
      action: "Fix the field named, then deploy again.",
    });
  }
  const config = parsed.data;
  const timeoutMs = config.timeoutMs ?? DEFAULT_MODERATION_TIMEOUT_MS;
  if (config.moderator !== undefined) {
    if (config.words !== undefined || config.includeShipped !== undefined) {
      throw new ValidationError({
        message: "The moderation block names a moderator and a word list. The moderator replaces the list.",
        action: "Drop words and includeShipped, or call blocklistModerator inside your moderator to keep the list.",
      });
    }
    return { moderator: config.moderator, timeoutMs };
  }
  const shipped = config.includeShipped === false ? [] : SHIPPED_BLOCKLIST;
  return { moderator: blocklistModerator({ words: [...shipped, ...(config.words ?? [])] }), timeoutMs };
}
