// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { NudgeKind } from "../data/enums";

/**
 * The words a nudge goes out with.
 *
 * **Two messages, not one, and the reason is external.** A tester's store opt-in page only works once
 * the developer has added that address to the tester list — and no API can do that, so it is a manual
 * step in the console. Sending the store link before it completes produces `App not available`, which
 * reads to the tester as a broken app. So `confirm` asks whether they will help, and `store` follows
 * once they are actually on the list.
 *
 * **Every kind ships serviceable default copy, and that is a requirement rather than a courtesy.** A
 * developer with no dashboard must be able to run `pithy testers run` and have it say something
 * sensible. Shipping the mechanism without the words would functionally gate the library behind the
 * paid tier, which is not on the table.
 *
 * **A caller may override the words, and only the words.** The route accepts a subject and a
 * plain-text body. This capability wraps them in its own layout, branding, footer, and unsubscribe, and
 * renders the HTML itself.
 *
 * **Why the route must never accept HTML.** A control-plane caller supplying nudge content is asking
 * this Worker to mail arbitrary content to the adopter's own users, signed with the adopter's DKIM. If
 * that content were unconstrained markup, a compromised dashboard credential would stop being a
 * disclosure problem and become a phishing platform operating from a domain those users already trust —
 * the trust being the whole point of DKIM. Bounding the input to text bounds the blast radius: the
 * worst a compromised caller can send is a lie in prose, which is bad, rather than a credential-harvest
 * form that renders as the adopter's own product, which is catastrophic.
 *
 * The body is split into paragraphs here and handed to the template as an **array of plain strings**,
 * each rendered through Handlebars' escaping `{{this}}`. So markup in a supplied body cannot become
 * markup in the sent mail even if every other check were bypassed: the escaping is structural, not a
 * filter that has to anticipate what to strip.
 */

/** The shipped default copy for one nudge kind. */
export interface NudgeCopy {
  /** The subject line. */
  readonly subject: string;
  /** The lead sentence, rendered as the email's heading. */
  readonly heading: string;
  /** The body, already split into paragraphs. Each renders escaped. */
  readonly paragraphs: readonly string[];
  /** The call-to-action label, when the nudge carries a link. */
  readonly ctaLabel: string | null;
}

/**
 * The shipped defaults, in brand voice: short sentences, deliberate periods, nothing oversold.
 *
 * Each is written to be true regardless of what the adopter's app is, because this copy goes out from
 * their domain and a nudge that overclaims costs them the relationship, not us.
 */
const DEFAULTS: Record<NudgeKind, NudgeCopy> = {
  confirm: {
    subject: "Can you help test an app?",
    heading: "Will you be a tester?",
    paragraphs: [
      "You have been asked to help test an early build. Answering takes one tap, and it is only a yes — nothing installs yet.",
      "Once you say yes, the developer adds your address to the test, and you will get a second email with the link to join and install. The test runs for a fixed period and needs everyone who joins to stay joined for the whole of it.",
    ],
    ctaLabel: "Yes, count me in",
  },
  store: {
    subject: "You're on the list — here's the link",
    heading: "Time to join the test",
    paragraphs: [
      "You have been added to the test. Use the button below to join and install the app.",
      "Open it in a browser rather than the store app, and sign in with the same address this email reached you at — the store will not let you join with a different account.",
      "Stay on the test until the window closes. That is the part that actually counts.",
    ],
    ctaLabel: "Join the test",
  },
  inactive: {
    subject: "Still testing?",
    heading: "We have not seen you in a while",
    paragraphs: [
      "You joined the test but have not opened the app recently. If something is broken or in the way, that is worth knowing — it is the reason the test exists.",
      "If you have uninstalled, no hard feelings. Letting the developer know means they can invite someone else in time.",
    ],
    ctaLabel: null,
  },
  closing: {
    subject: "The test window closes soon",
    heading: "Nearly there",
    paragraphs: [
      "The testing period is almost over. Staying enrolled until it closes is what makes it count.",
      "Nothing is needed from you but that. Thank you for helping.",
    ],
    ctaLabel: null,
  },
};

/** The shipped default copy for a nudge kind. */
export function defaultCopy(kind: NudgeKind): NudgeCopy {
  return DEFAULTS[kind];
}

/**
 * Split a supplied plain-text body into paragraphs.
 *
 * Blank lines separate paragraphs; single newlines inside one are collapsed to spaces, because a
 * hard-wrapped paragraph pasted from a terminal should not render as a column of one-line stanzas.
 * Control characters are stripped: they cannot become markup, but they can smuggle direction overrides
 * that make a subject line read as something other than what was approved.
 */
export function toParagraphs(body: string, maxParagraphs = 20): string[] {
  return (
    body
      // Everything but the newline this function is about to split on. The bidi range is the one worth
      // naming: a right-to-left override inside a body renders the text after it reversed, which is how
      // an approved-looking sentence can display as something else entirely.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
      .filter((paragraph) => paragraph.length > 0)
      .slice(0, maxParagraphs)
  );
}

/**
 * Flatten a supplied subject to a single safe line.
 *
 * **A subject is not an HTML context, so escaping it would be wrong** — `&lt;` in an inbox is a
 * rendering bug, not a defence, and the email engine precompiles subjects with escaping off for exactly
 * that reason. The threat in a subject is different and this is what answers it: a carriage return or
 * newline can terminate the header and let everything after it be read as another header, which is how
 * a supplied subject becomes an injected `Bcc`. Every control character goes, newlines included, and
 * the remaining whitespace collapses so a multi-line paste arrives as one line rather than a truncated
 * one.
 */
export function sanitizeSubject(subject: string): string {
  return (
    subject
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
      .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Where a nudge's words came from. Recorded on the email job so a send is attributable. */
export type CopySource = "default" | "supplied";

/** The words one nudge will actually go out with, and their provenance. */
export interface ResolvedCopy {
  readonly subject: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly ctaLabel: string | null;
  readonly source: CopySource;
}

/**
 * Resolve the copy for a nudge: the caller's words if they supplied any and the deployment allows it,
 * otherwise the shipped default.
 *
 * A caller supplying only a subject keeps the default body, and vice versa. Partial overrides are a
 * normal thing to want — "same message, our subject line" — and forcing all-or-nothing would push
 * callers into copying the default body into their request, where it would then never receive an
 * improvement.
 */
export function resolveCopy(kind: NudgeKind, supplied: { subject?: string; body?: string } | undefined): ResolvedCopy {
  const base = defaultCopy(kind);
  const subject = supplied?.subject === undefined ? undefined : sanitizeSubject(supplied.subject);
  const paragraphs = supplied?.body ? toParagraphs(supplied.body) : undefined;
  const overridden = Boolean(subject) || (paragraphs !== undefined && paragraphs.length > 0);

  return {
    subject: subject && subject.length > 0 ? subject : base.subject,
    heading: base.heading,
    paragraphs: paragraphs && paragraphs.length > 0 ? paragraphs : base.paragraphs,
    ctaLabel: base.ctaLabel,
    source: overridden ? "supplied" : "default",
  };
}
