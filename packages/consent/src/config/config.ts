// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import { z } from "zod";

/** Where the consent routes mount when no `basePath` is given. */
export const CONSENT_DEFAULT_BASE_PATH = "/consent";

/** The first-party cookie a visitor's anonymous device id is held in, once they have chosen. */
export const CONSENT_VISITOR_COOKIE = "pithy_consent_visitor";

/** The rate limiter the writes are held to by default: auth's, which consent already composes beside. */
export const CONSENT_DEFAULT_RATE_LIMITER = "AUTH_RATE_LIMITER";

/** How long an unmerged visitor's consent counts, by default: 395 days, thirteen months, the common ceiling. */
export const CONSENT_DEFAULT_VISITOR_WINDOW_DAYS = 395;

/** Configuration for the consent capability, passed in `pithy.config.ts`. */
export const ConsentConfig = z
  .object({
    basePath: z
      .string()
      .startsWith("/")
      .default(CONSENT_DEFAULT_BASE_PATH)
      .describe("Where the consent routes mount. The person's own routes and the control-plane reads sit under it."),
    purposes: z
      .array(ConsentPurpose)
      .default([])
      .describe(
        "Your own purposes, beside the ones composed capabilities declare (email declares `email.marketing` and `email.tracking`). Each under your own domain — `clinic.records` — with a summary written for the person, a notice version, the data classes it covers, whether it is explicit, the minimum method a grant needs, and whether a withdrawal must be written.",
      ),
    rateLimiterBinding: z
      .string()
      .min(1)
      .default(CONSENT_DEFAULT_RATE_LIMITER)
      .describe(
        "The Workers Rate Limiting binding the two writes are held to, per client IP. Defaults to auth's own `AUTH_RATE_LIMITER`, counted under a `consent:` key of its own, so nothing new is provisioned. A grant needs no account, so this is what stops a script filling the append-only record.",
      ),
    visitorWindowDays: z
      .number()
      .int()
      .positive()
      .max(3650)
      .default(CONSENT_DEFAULT_VISITOR_WINDOW_DAYS)
      .describe(
        "How many days a visitor's consent counts while it has not been merged into an account. Past it, `hasConsent` answers no and the visitor is asked again. The device-id cookie lives as long.",
      ),
  })
  .describe("Configuration for the consent capability.");
export type ConsentConfig = z.output<typeof ConsentConfig>;
export type ConsentConfigInput = z.input<typeof ConsentConfig>;
