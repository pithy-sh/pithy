// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { OPT_IN_TOKEN_PATTERN } from "../crypto/token";
import { NudgeKind } from "../data/enums";

/**
 * Every request contract this capability accepts. There is nowhere else input may be declared, and no
 * handler parses anything itself — a handler receives typed values, so the route signature carries the
 * whole contract.
 *
 * **What is deliberately absent is as much of the design as what is here.** No request names a sender,
 * a signing key, or an environment: those come from the deployment. No request supplies a tester's
 * opt-in date: that comes from the link they followed. And no request accepts HTML anywhere, for
 * the reason `nudge/copy.ts` sets out at length — words go out over the adopter's own DKIM signature,
 * so bounding the input to text is what bounds the blast radius of a leaked dashboard credential.
 */

/** The longest a cohort or tester name may be in a request. Matches the config bound. */
const MAX_NAME_LENGTH = 120;

/** The longest an overridden subject may be. Longer is truncated by every mail client anyway. */
const MAX_SUBJECT_LENGTH = 200;

/**
 * The longest an overridden body may be.
 *
 * Generous for a nudge and small enough that a flood of them cannot be a rendering denial of service.
 * The config bound may be tighter; this is the ceiling the route will parse at all.
 */
const MAX_BODY_LENGTH = 20_000;

/**
 * The path parameter carrying an opt-in or opt-out token.
 *
 * This bounds the *shape* of the segment; it does not authenticate anything and must not be mistaken
 * for doing so. A well-formed token that belongs to nobody still fails, with the capability's own
 * `testers/invalid_token` — the same code a real lookup miss raises, and deliberately so: a malformed
 * segment is answered by the validator with `validation/invalid_input`, so the two failures a caller
 * can tell apart are "that is not a token" and "that token opens nothing", never "that token belongs
 * to somebody else".
 */
export const OptInTokenParam = z
  .object({
    token: z
      .string()
      // The generator's own pattern, imported rather than restated. These two drifted apart once
      // already — the schema still described the old signed `payload.signature` form after the token
      // became a single 43-character value — and every tester link 400'd before reaching a handler.
      .regex(OPT_IN_TOKEN_PATTERN)
      .describe(
        "The confirmation token from the path. Shape only, and deliberately not authenticity: a well-formed token matching no member still fails, with the same words.",
      ),
  })
  .describe("The path parameter carrying a testers opt-in or opt-out token.");
export type OptInTokenParam = z.infer<typeof OptInTokenParam>;

/** Creating a cohort. Every field but the name inherits from config when omitted. */
export const CreateCohortRequest = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_NAME_LENGTH)
      .describe("A human label for the cohort, unique within the project. Shown in the CLI and the dashboard."),
    targetSize: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How many testers must be opted in simultaneously. Defaults to the configured value — twelve, for Google Play.",
      ),
    windowDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How many continuous days the target must hold. Defaults to the configured value — fourteen, for Google Play.",
      ),
    maxRosterSize: z.number().int().positive().optional().describe("The roster cap. Defaults to the configured value."),
    targetPlatform: z
      .enum(["android", "ios"])
      .optional()
      .describe("Which store's program this cohort serves. Defaults to the configured value."),
  })
  .describe(
    "Create a testing cohort. Omitted fields inherit the project's configured defaults and are then frozen on the row.",
  );
export type CreateCohortRequest = z.infer<typeof CreateCohortRequest>;

/** Inviting one address onto a cohort. */
export const InviteRequest = z
  .object({
    cohortId: z.string().min(1).describe("The cohort to invite them onto."),
    email: z
      .email()
      .max(320)
      .describe("The tester's address. Lowercased on write, and the join key to the user record if they ever sign in."),
    name: z.string().max(MAX_NAME_LENGTH).nullish().describe("A display name for the roster. Optional."),
    sendInvitation: z
      .boolean()
      .default(true)
      .describe(
        "Whether to email the confirmation link now. False adds them to the roster silently — for importing a list of people already contacted elsewhere, so their history starts in the right place.",
      ),
  })
  .describe("Invite one address onto a cohort.");
export type InviteRequest = z.output<typeof InviteRequest>;

/** Sending another invitation to someone already on the roster. */
export const ResendRequest = z
  .object({
    memberId: z.string().min(1).describe("The roster member to send another invitation to."),
  })
  .describe("Send another invitation, preserving the tester's existing history and their original invited date.");
export type ResendRequest = z.infer<typeof ResendRequest>;

/** Taking a tester off a cohort. */
export const RemoveRequest = z
  .object({
    memberId: z.string().min(1).describe("The roster member to remove."),
    reason: z
      .string()
      .max(200)
      .optional()
      .describe("A short note recorded on the event, for the developer's own records. Never shown to the tester."),
  })
  .describe("Take a tester off a cohort's roster. Recorded as the developer's act, not the tester's.");
export type RemoveRequest = z.infer<typeof RemoveRequest>;

/**
 * Triggering a nudge.
 *
 * **`subject` and `body` are the only overridable fields, and both are plain text.** There is no HTML
 * field, no template id, and no layout option, because this Worker owns the envelope and signs it with
 * the adopter's domain. `body` is split into paragraphs and each renders HTML-escaped, so markup
 * arrives as visible text rather than as markup — structurally, not by filtering.
 */
export const NudgeRequest = z
  .object({
    cohortId: z.string().min(1).describe("The cohort whose testers to nudge."),
    kind: NudgeKind.describe(
      "Which nudge to send. Decides the default copy and, for `confirm`, whether a link is attached.",
    ),
    memberIds: z
      .array(z.string().min(1))
      .max(500)
      .optional()
      .describe(
        "Specific testers to nudge. Omit to let the kind select them — `confirm` targets everyone who has not confirmed, `inactive` everyone who has gone quiet.",
      ),
    subject: z
      .string()
      .max(MAX_SUBJECT_LENGTH)
      .optional()
      .describe(
        "An overridden subject line, as plain text. Control characters and newlines are stripped before it reaches the renderer, because a newline in a header is how a subject becomes an injected one.",
      ),
    body: z
      .string()
      .max(MAX_BODY_LENGTH)
      .optional()
      .describe(
        "An overridden body, as PLAIN TEXT only. Blank lines separate paragraphs. Markup is not accepted and not stripped — it is escaped, so it reaches the recipient as visible characters. There is no field that accepts HTML, deliberately: supplied words go out over your own DKIM signature.",
      ),
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Report who would be nudged and enqueue nothing. The safe way to check a selection before mailing twelve people.",
      ),
  })
  .describe(
    "Trigger a nudge to selected testers. The per-tester cooldown is enforced server-side on this path and cannot be overridden by the caller.",
  );
export type NudgeRequest = z.output<typeof NudgeRequest>;

/** Reading cohort state. Cheap by default; the expensive parts are opt-in. */
export const CohortsQuery = z
  .object({
    cohortId: z.string().min(1).optional().describe("Restrict to one cohort. Omit for every cohort in this Worker."),
    members: z
      .stringbool()
      .default(false)
      .describe("Include the full roster with per-tester activity and health. Costs the roster join."),
    trend: z
      .stringbool()
      .default(false)
      .describe("Include the trailing daily snapshots the chart is drawn from. Costs `trendDays` rows per cohort."),
    trendDays: z.coerce
      .number()
      .int()
      .min(1)
      .max(180)
      .default(30)
      .describe("How many trailing daily snapshots to return when `trend` is set."),
  })
  .describe("Query contract for the control-plane cohort read. The summary is one row per cohort; extras are opt-in.");
export type CohortsQuery = z.output<typeof CohortsQuery>;

/** A tester reading their own position. */
export const StatusQuery = z
  .object({
    cohortId: z.string().min(1).optional().describe("Restrict to one cohort. Omit for every cohort this tester is on."),
  })
  .describe("Query contract for a tester's own view of where they stand.");
export type StatusQuery = z.output<typeof StatusQuery>;
