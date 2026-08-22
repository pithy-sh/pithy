// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SupportInvalidCategoryError } from "../error/errors";
import { UNCATEGORIZED } from "./enums";

/**
 * The support taxonomy — federated, the way audit actions and migration namespaces already are.
 *
 * Pithy ships eight categories chosen to map to **action rather than topic**, because an inbox sorted
 * by topic is a filing cabinet and an inbox sorted by action is a work queue. An adopter adds their
 * own with {@link defineSupportCategories} — a game adds `tournament_dispute`, a marketplace adds
 * `seller_payout` — and core never learns about it.
 *
 * A category is a `snake_case` key plus the sentence that tells a model when to pick it. The
 * description is not documentation for humans: it is **prompt input**, interpolated into the
 * classification prompt verbatim, which is why a bad one shows up as bad classifications rather than
 * as a bad doc. Write it as an instruction.
 */

/** The shape a category key must take: lowercase `snake_case`, so it is safe in a prompt and a filter. */
const CATEGORY_KEY = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** How long a category description may be. Bounded because every one of them lands in every prompt. */
const MAX_DESCRIPTION = 200;

/** A category map: key → the instruction a model reads when deciding whether this is the one. */
export type SupportCategories = Record<string, string>;

/**
 * The eight Pithy ships. Each earns its slot by naming something a developer would *do differently*,
 * not something a message is *about*.
 */
export const DEFAULT_SUPPORT_CATEGORIES = {
  billing:
    "A question or complaint about money: a refund, a double charge, a failed renewal, or 'I paid and did not get it'.",
  account_access:
    "The sender cannot get in: a magic link that never arrived, a sign-in that fails, a lost or changed email address.",
  bug_report: "The sender is reporting that something is broken, wrong, or behaving differently than it should.",
  feature_request: "The sender is asking for something that does not exist yet, or for an existing thing to change.",
  abuse_report: "The sender is reporting another user's behavior — harassment, cheating, spam, or impersonation.",
  privacy_request:
    "The sender is exercising a data right: deletion, export, access, or correction of their personal data.",
  spam: "Unsolicited bulk mail, marketing, or an obvious phishing or scam attempt. Not a real support request.",
  [UNCATEGORIZED]:
    "Use this when no other category clearly applies, or when the message is too ambiguous to place with confidence.",
} as const satisfies SupportCategories;

/**
 * Declare an adopter's own categories, validated at author time.
 *
 * The same shape `defineAuditActions` uses, for the same reason: a typo in a key is a filter that
 * silently matches nothing, and it should fail where the constant is written rather than the first
 * time a model happens to return it. Returns the same object, typed, so `MyCategories.tournament_dispute`
 * narrows to a literal.
 *
 * ```ts
 * export const GameCategories = defineSupportCategories({
 *   tournament_dispute: "The sender is contesting a tournament result, a disqualification, or a prize.",
 * });
 * ```
 */
export function defineSupportCategories<const T extends SupportCategories>(categories: T): T {
  for (const [key, description] of Object.entries(categories)) {
    if (!CATEGORY_KEY.test(key)) {
      throw new SupportInvalidCategoryError({
        message: `Invalid support category key: ${key}`,
        action: "Use a lowercase snake_case key, e.g. `tournament_dispute`.",
        detail: `key ${JSON.stringify(key)} does not match ${CATEGORY_KEY}`,
      });
    }
    if (description.trim().length === 0 || description.length > MAX_DESCRIPTION) {
      throw new SupportInvalidCategoryError({
        message: `Invalid description for support category "${key}".`,
        action: `Write one instructional sentence, at most ${MAX_DESCRIPTION} characters, telling a model when to pick it.`,
        detail: `description length ${description.length} is outside 1..${MAX_DESCRIPTION}`,
      });
    }
  }
  return categories;
}

/**
 * The taxonomy a capability actually classifies against: the defaults, plus the adopter's, with the
 * adopter's winning on a key collision so a shipped description can be reworded for their product.
 */
export function resolveCategories(extra: SupportCategories = {}): SupportCategories {
  return { ...DEFAULT_SUPPORT_CATEGORIES, ...defineSupportCategories(extra) };
}

/**
 * The Zod enum a model's answer is checked against.
 *
 * Built from the *effective* taxonomy at capability-construction time rather than declared as a
 * literal, because the whole point of federation is that the valid set is not known until an adopter
 * composes the capability. This is the schema `classifyMessage` parses against before anything is
 * written — the single place an invented label is caught.
 */
export function categoryEnum(categories: SupportCategories): z.ZodEnum<Record<string, string>> {
  const keys = Object.keys(categories);
  return z
    .enum(Object.fromEntries(keys.map((key) => [key, key])))
    .describe("One of this project's effective support categories — the shipped defaults plus any the adopter added.");
}

/**
 * The taxonomy rendered for a prompt: one `key — instruction` line per category, in declaration order.
 *
 * Deliberately not JSON. A bulleted list is what these models are trained to follow, and the format
 * is stable enough that a category added by an adopter reads exactly like a shipped one.
 */
export function describeCategories(categories: SupportCategories): string {
  return Object.entries(categories)
    .map(([key, description]) => `- ${key}: ${description}`)
    .join("\n");
}
