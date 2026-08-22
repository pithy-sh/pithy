// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SupportInvalidCategoryError } from "../error/errors";

/**
 * Canned replies — starting points a human picks in the dashboard, edits, and sends.
 *
 * ## What these are, and what they are not
 *
 * A snippet is **body text**, not an email template. The rendering shell — the adopter's theme, the
 * HTML and plain-text pair, the threading headers — is the single `supportReply` template in
 * `@pithy-sh/email`. Adding a second email template per canned reply would put the adopter's
 * wording in a precompiled Handlebars file that only a release can change, which is exactly backwards
 * for text somebody wants to reword on a Tuesday.
 *
 * So the Worker serves a catalog and **never renders it**. The dashboard shows the list, the operator
 * picks one, edits it, and posts the finished body to the reply route — which is why the placeholder
 * tokens below are substituted client-side and this package owns no template engine. A support reply
 * is a letter a person sent; the machine's only job is to hand them a better blank page.
 *
 * ## Federated, like the taxonomy
 *
 * Pithy ships a small set keyed to the default categories, and an adopter adds their own with
 * {@link defineSupportReplies} — the same shape `defineSupportCategories` uses, for the same reason.
 * A snippet tagged with a category is offered first on a thread the classifier put in that category,
 * which is the one place the classification does work for a human rather than for a filter.
 *
 * The shipped wording is deliberately plain and slightly incomplete: every one of them has a blank
 * an operator has to fill. A canned reply that could be sent without reading it is how a support
 * inbox starts insulting people.
 */

/** The shape a snippet key must take: lowercase `snake_case`, so it is a stable id in a dashboard. */
const SNIPPET_KEY = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** How long a snippet body may be. Long enough for a real answer; bounded because it ships in a manifest. */
const MAX_BODY = 2000;

/**
 * The tokens a dashboard substitutes before sending. Documented here because they are a contract
 * between this catalog and whatever renders it, and deliberately few: a placeholder language is a
 * template engine, and a template engine over untrusted context is a rendering vulnerability.
 */
export const SNIPPET_TOKENS = {
  /** The sender's display name, or their address when the app knows no name. */
  name: "{{name}}",
  /** The thread's subject. */
  subject: "{{subject}}",
} as const;

/** One canned reply. */
export const SupportReplySnippet = z
  .object({
    label: z
      .string()
      .min(1)
      .max(80)
      .describe("What the dashboard shows in the picker, e.g. `Refund issued`. A verb phrase, not a category name."),
    category: z
      .string()
      .optional()
      .describe(
        "The category this snippet is offered first for. Optional — a snippet with no category is always offered, which is right for the general-purpose ones.",
      ),
    body: z
      .string()
      .min(1)
      .max(MAX_BODY)
      .describe(
        "The starting text, with `{{name}}` and `{{subject}}` substituted by the dashboard before sending. Written to be edited: every shipped one leaves a blank a human has to fill.",
      ),
  })
  .describe("One canned reply — a starting point a human picks, edits, and sends.");
export type SupportReplySnippet = z.infer<typeof SupportReplySnippet>;

/** A snippet catalog: key → the snippet. */
export type SupportReplySnippets = Record<string, SupportReplySnippet>;

/**
 * The set Pithy ships, keyed to the default categories.
 *
 * Six, not sixteen. A picker long enough to need scrolling is one nobody reads, and the ones below
 * are the replies a solo developer actually writes over and over.
 */
export const DEFAULT_SUPPORT_REPLIES = {
  refund_issued: {
    label: "Refund issued",
    category: "billing",
    body: "Hi {{name}},\n\nI've refunded this — you should see it back on your original payment method within ___ working days.\n\nSorry for the trouble.\n",
  },
  billing_explained: {
    label: "Explain a charge",
    category: "billing",
    body: "Hi {{name}},\n\nThat charge is ___. It covers ___.\n\nIf that isn't what you expected, tell me and I'll sort it out.\n",
  },
  sign_in_help: {
    label: "Sign-in help",
    category: "account_access",
    body: "Hi {{name}},\n\nI've had a look — ___.\n\nTry signing in again and let me know if it still doesn't work. If the email isn't arriving, check your spam folder, and tell me which address you're using so I can confirm it matches the account.\n",
  },
  bug_acknowledged: {
    label: "Bug acknowledged",
    category: "bug_report",
    body: "Hi {{name}},\n\nThanks for reporting this — I've reproduced it and it's a real bug. ___.\n\nI'll follow up here once it's fixed.\n",
  },
  feature_noted: {
    label: "Feature request noted",
    category: "feature_request",
    body: "Hi {{name}},\n\nThanks — that's a good idea and I've written it down. I can't promise a date, but ___.\n\nIf you can tell me a bit about how you'd use it, that genuinely helps me prioritize.\n",
  },
  need_more_detail: {
    label: "Ask for more detail",
    body: "Hi {{name}},\n\nHappy to help with this. Could you tell me ___?\n\nA screenshot or the exact wording of any error would speed this up a lot.\n",
  },
} as const satisfies SupportReplySnippets;

/**
 * Declare an adopter's own canned replies, validated at author time.
 *
 * The same shape and the same reasoning as `defineSupportCategories`: a malformed key is a picker
 * entry that silently never matches, and it should fail where the constant is written.
 */
export function defineSupportReplies<const T extends SupportReplySnippets>(snippets: T): T {
  for (const [key, snippet] of Object.entries(snippets)) {
    if (!SNIPPET_KEY.test(key)) {
      throw new SupportInvalidCategoryError({
        message: `Invalid support reply key: ${key}`,
        action: "Use a lowercase snake_case key, e.g. `refund_issued`.",
        detail: `key ${JSON.stringify(key)} does not match ${SNIPPET_KEY}`,
      });
    }
    const parsed = SupportReplySnippet.safeParse(snippet);
    if (!parsed.success) {
      throw new SupportInvalidCategoryError({
        message: `Invalid support reply "${key}".`,
        action: "Give it a label and a body, and keep the body under 2000 characters.",
        detail: parsed.error.message,
      });
    }
  }
  return snippets;
}

/** The effective catalog: the shipped set, plus the adopter's, theirs winning on a key collision. */
export function resolveReplies(extra: SupportReplySnippets = {}): SupportReplySnippets {
  return { ...DEFAULT_SUPPORT_REPLIES, ...defineSupportReplies(extra) };
}

/**
 * The catalog as a dashboard consumes it: the snippets for this thread's category first, then the
 * uncategorized general-purpose ones, then everything else.
 *
 * Ordering rather than filtering, deliberately. A classifier that put a refund request in
 * `bug_report` would otherwise hide the refund snippets from the one person who can tell it was
 * wrong — the model orders the list, it never restricts it.
 */
export function repliesForCategory(
  snippets: SupportReplySnippets,
  category: string,
): Array<SupportReplySnippet & { key: string }> {
  const entries = Object.entries(snippets).map(([key, snippet]) => ({ key, ...snippet }));
  const rank = (snippet: SupportReplySnippet): number =>
    snippet.category === category ? 0 : snippet.category === undefined ? 1 : 2;
  return entries.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}
