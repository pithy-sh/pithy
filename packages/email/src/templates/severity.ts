// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * How urgent an operational notice is, and how that urgency is said out loud.
 *
 * **Severity is words first and color second, and the order matters.** A notice is read in an inbox
 * list before it is opened, in a plain-text client that has no colors at all, and by people who cannot
 * tell the red one from the amber one. So each level owns a *label* — which goes in the subject line,
 * in the body, and in the text part — and a color that only ever reinforces it. A design where the
 * only difference between "a release is out" and "your sign-in is broken" is a hex value has flattened
 * them, and a reader who cannot see the difference learns to ignore both.
 *
 * The labels name the response, not the volume. "Action needed" tells somebody what the message wants
 * from them; "Warning" only tells them how loudly it is being said.
 */

export const NoticeSeverity = z
  .enum(["info", "warning", "critical"])
  .describe(
    "How urgent an operational notice is. `info` is something that happened and needs nothing (a release is out); `warning` is something that needs attention before it becomes a fault (a secret is overdue for rotation); `critical` is something that is failing now. The level sets the subject-line label, so it is visible in an inbox before the message is opened.",
  );
export type NoticeSeverity = z.output<typeof NoticeSeverity>;

/** One severity's presentation: the key its word is looked up under, and the color that reinforces it. */
interface SeverityPresentation {
  /**
   * The catalog key holding the word — in the subject line, the body, and the text part.
   *
   * A key rather than the word itself, because the word is the half of this table that changes with the
   * reader. The colors below do not: an accent belongs to a brand and "this is on fire" belongs to
   * everyone, so they stay literals here while the label goes through `email/severity.*` in the
   * catalog. `messages.ts` writes the English; `@pithy-sh/i18n` ships the rest.
   */
  labelKey: string;
  /** The light-mode color, applied inline. Contrast-checked against the card white every preset uses. */
  light: string;
  /** The dark-mode color, swapped in by class under `prefers-color-scheme: dark`. */
  dark: string;
}

/**
 * The one place a severity's presentation is decided.
 *
 * Colors are fixed rather than themed, deliberately: an accent belongs to a brand, but "this is on
 * fire" belongs to the reader. A project whose accent is red would otherwise render a routine notice
 * in the color of an emergency. Both ramps are contrast-checked — the light values against the white
 * card every preset ships, the dark values against the near-black one.
 */
const PRESENTATION = {
  info: { labelKey: "email/severity.info", light: "#475467", dark: "#98A2B3" },
  warning: { labelKey: "email/severity.warning", light: "#B54708", dark: "#FEC84B" },
  critical: { labelKey: "email/severity.critical", light: "#B42318", dark: "#FDA29B" },
} as const satisfies Record<NoticeSeverity, SeverityPresentation>;

/**
 * The presentation for a value that has already been through {@link NoticeSeverity}.
 *
 * A template renders after its payload is parsed, so the value is always one of the three. The
 * fallback exists because a Handlebars helper must return *something* and `info` is the only safe
 * guess: a notice that renders as calmer than it is can still be read, while one that throws mid-render
 * is the notice nobody receives.
 */
function presentationOf(severity: unknown): SeverityPresentation {
  // `Object.hasOwn`, not `in`: `in` walks the prototype, so `severity === "constructor"` would answer
  // true and hand back `Object` itself. Unreachable today — the payload is `NoticeSeverity`-parsed
  // before a render — but it is the same read the i18n lookups were fixed for, and one site left
  // spelled the other way is the one somebody copies.
  return typeof severity === "string" && Object.hasOwn(PRESENTATION, severity)
    ? PRESENTATION[severity as NoticeSeverity]
    : PRESENTATION.info;
}

/**
 * The catalog key holding the word this level is called.
 *
 * The engine's `{{severityLabel severity}}` helper resolves this through the render's translator, so
 * the level is said in the recipient's language in all three places it appears. Exported as a key and
 * not as a word, because a function returning a word would have to be handed a translator, and then
 * every caller would carry one to ask a question about an enum.
 */
export function severityLabelKey(severity: unknown): string {
  return presentationOf(severity).labelKey;
}

/** The `{{severityColor severity}}` helper: the light-mode color, applied inline like every other one. */
export function severityColor(severity: unknown): string {
  return presentationOf(severity).light;
}

/**
 * The dark-mode overrides for the severity colors, generated from the same table.
 *
 * The shared head partial carries the light values inline and swaps these in under
 * `prefers-color-scheme: dark`, exactly as it does for the theme's own palette. Generated rather than
 * written out so a color changed here cannot leave dark mode showing the old one.
 */
export const severityDarkModeCss: string = Object.entries(PRESENTATION)
  .map(([name, { dark }]) => `    .sev-${name} { color: ${dark} !important; }`)
  .join("\n");
