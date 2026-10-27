// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { z } from "zod";

/**
 * **Whether this Worker processes under consent with no consent record behind it.**
 *
 * `@pithy-sh/email` tracks opens and clicks and sends marketing mail, and declares both as consent purposes. With
 * `@pithy-sh/consent` composed, it asks before either. Without it, email behaves as it always has — which is the
 * right default for a project that never needed consent, and the wrong one to leave unsaid for a project that
 * does. So `pithy doctor` asks it of each Worker's own composition: which composed capabilities declare
 * `consentPurposes`, and whether any provides the consent seam. The same question the scope gates ask, one seam
 * over, answered the same way: from the capabilities as composed, never from a list kept here.
 *
 * **It reports and it does not fail the exit.** Whether a law requires consent for this processing is the
 * adopter's call, and the kit records and gates without deciding which law applies. What it must never be is
 * silent.
 */

/** One purpose processed with no consent record behind it. */
export const ConsentPurposeFinding = z
  .object({
    capability: z.string().describe("The capability that processes under the purpose."),
    purpose: z.string().describe("The purpose id — `email.tracking`."),
  })
  .describe("One purpose a composed capability processes under consent.");
export type ConsentPurposeFinding = z.infer<typeof ConsentPurposeFinding>;

/** What `doctor` learned about one Worker's consent. */
export const ConsentHealth = z
  .object({
    recorder: z
      .string()
      .nullable()
      .describe("The composed capability that records consent and answers `hasConsent` — `consent` — or null."),
    purposes: z
      .array(ConsentPurposeFinding)
      .describe("Every purpose this Worker's capabilities process under consent, in composition order."),
    unrecorded: z
      .boolean()
      .describe("True when there are purposes and no recorder: the processing runs with no consent record behind it."),
  })
  .describe("This Worker's consent purposes against a consent record. Reported; never fails the exit.");
export type ConsentHealth = z.infer<typeof ConsentHealth>;

/** Read one Worker's composition for its consent purposes and its recorder. Pure; never throws. */
export function consentHealth(capabilities: readonly Capability[]): ConsentHealth {
  const recorder = capabilities.find((capability) => capability.consentReader !== undefined)?.name ?? null;
  const purposes = capabilities.flatMap((capability) =>
    (capability.consentPurposes ?? []).map((purpose) => ({ capability: capability.name, purpose: purpose.id })),
  );
  return { recorder, purposes, unrecorded: purposes.length > 0 && recorder === null };
}
