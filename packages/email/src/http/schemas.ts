// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";
import { EmailJobStatus, SuppressionReason, TemplateCategory } from "../data/enums";

/**
 * The request schemas for every email route — the three public callbacks and the six control-plane
 * admin routes. Validation happens at the HTTP boundary (CLAUDE.md §Zod), declared on the route line
 * with `validate(target, Schema)` — so reading `callbacks.ts` or `routes.ts` tells
 * you what each route accepts without opening a handler.
 *
 * The callback schemas bound a value that already reaches the handler as free-form text. Neither tries
 * to *authenticate* anything: the token's signature is still the only gate, checked by `verifyToken`,
 * and a well-formed but forged or expired token still answers `email/invalid_token` (400).
 *
 * The admin schemas bound something a **verified** caller chose, which is a different job and just as
 * necessary: a control-plane credential is verified, and verified is not trusted. A management client
 * with a bug asks for a million rows exactly as easily as a hostile one does.
 */

/**
 * The characters a callback token path segment may contain: the base64url alphabet, plus `.` — the
 * token's own segment separator, and the `.png` suffix mail clients append to an
 * open-pixel URL (which `handleOpen` strips before verifying). Deliberately not a strict base64url
 * check: that would 400 every tracking pixel.
 */
const TOKEN_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The `:token` path parameter every callback route carries. A shape and size bound only — the ceiling
 * is generous enough for a click token whose sealed claims embed a long destination URL, so no link we
 * mint can exceed it, while an unbounded segment can no longer reach the verifier.
 */
export const CallbackTokenParam = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .regex(TOKEN_SEGMENT)
      .describe("The sealed callback token from the path, optionally with the open-pixel `.png` suffix."),
  })
  .describe("The path parameter carrying a click/open/unsubscribe callback token.");
export type CallbackTokenParam = z.output<typeof CallbackTokenParam>;

/** One form field as a client may send it: a value, or a repeated field's values. Anything else reads as absent. */
const FormField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .catch(undefined);

/**
 * The form body of an unsubscribe `POST`: what a mail client's one-click unsubscribe sends (RFC 8058 fixes it to
 * `List-Unsubscribe=One-Click`), what the confirmation page's button sends, and what the app's own preferences flow
 * sends with a `reason`.
 *
 * **Nothing in it can refuse the opt-out.** Every field is optional, a repeated field or one of the wrong type reads
 * as absent or as its first value, and an over-long reason is truncated by the handler rather than refused. The
 * token is the only gate; a body is never a reason somebody stays subscribed.
 *
 * The reason travels in the body because it is the recipient's own words, and a query string is written to every
 * request log between the client and the Worker. The route reads no query at all.
 */
export const UnsubscribeForm = z
  .object({
    "List-Unsubscribe": FormField.describe(
      "`One-Click` from a mail client's RFC 8058 one-click unsubscribe. Accepted and not otherwise read.",
    ),
    reason: FormField.describe(
      "Why the recipient opted out; the first value is kept, truncated to 200 characters before it is stored.",
    ),
  })
  .describe("The optional form fields an unsubscribe POST accepts.");
export type UnsubscribeForm = z.output<typeof UnsubscribeForm>;

/**
 * Where the next page starts. Opaque, and a malformed one is a first page rather than a 400 — the
 * decode lives in `@pithy-sh/core/src/data/cursor` and collapses every failure mode to the same
 * undefined, so this bounds the size and nothing else.
 */
const Cursor = z
  .string()
  .max(512)
  .optional()
  .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page.");

/** How many rows one page may carry. Bounded, because a verified client can still have a bug. */
const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe("How many rows to return. Clamped into range — an unbounded page is a table scan.");

/**
 * An address as an admin route accepts it for a **write**.
 *
 * Validated as a real address, because blocking a typo blocks nothing and the caller never finds out:
 * a suppression is silent to everyone, so a malformed one is a mistake that only surfaces as mail
 * still arriving. Lowercasing and trimming happen in the handler, through core's `normalizeAddress`,
 * so the stored key always matches what the send path checks — and what every other capability that
 * compares an address arrives at.
 */
const WritableAddress = z
  .email()
  .max(254)
  .describe("The address to block. Normalized (trimmed, lowercased) before it is stored or compared.");

/**
 * An address as an admin route accepts it for a **read or an undo**, deliberately looser than
 * {@link WritableAddress}.
 *
 * Bounces and inbound complaints write whatever address the remote server reported, and some of those
 * are not addresses a validator would accept. A rule strict enough to keep bad data out of a manual
 * block would also make the row it wrote unreachable — an operator could see a malformed suppression
 * in the list and have no way to lift it. An undo has to be able to reach anything already written.
 */
const AddressFilter = z
  .string()
  .min(3)
  .max(254)
  .includes("@")
  .describe("An address to match exactly, normalized the same way the stored key is.");

/**
 * The `:id` of one job.
 *
 * Shape and size, not `.uuid()`. Production ids are `crypto.randomUUID()`, but `newId` is an injected
 * dependency of `enqueueEmail`, so a consumer supplying its own generator would find every one of its
 * jobs answering 400 at a route that never reached the lookup. A param schema constrains the string;
 * the handler still does the lookup and still raises its own 404.
 */
export const JobIdParam = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .describe("The job's id, as `pithy_email_jobs.id` stores it."),
  })
  .describe("The path parameter of every single-job admin route.");
export type JobIdParam = z.output<typeof JobIdParam>;

/** The job log query. */
export const JobsQuery = z
  .object({
    status: EmailJobStatus.optional().describe(
      "Filter to one lifecycle state — `failed` is the pane this capability exists for. Absent lists every state.",
    ),
    template: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Filter to one template id, exactly (`magicLink`, `newsletter`). A shape check only: the template set is the project's, and one nothing has sent is an empty page.",
      ),
    category: TemplateCategory.optional().describe(
      "Filter to one category: `transactional` or `marketing`. Absent lists both.",
    ),
    cursor: Cursor,
    limit: Limit,
  })
  .describe("The send-log query: which state, template and category to filter by, and where to resume.");
export type JobsQuery = z.output<typeof JobsQuery>;

/**
 * The suppression list query.
 *
 * **No address, and an unknown key is refused.** A query string is written to every request log between
 * the client and the Worker, so looking one address up is {@link SuppressionLookupRequest}, a `POST`
 * with the address in its body. Strict rather than stripping, so a client still sending `?email=` is
 * told so with a 400 instead of being handed the whole list as though it were the match.
 */
export const SuppressionsQuery = z
  .object({
    reason: SuppressionReason.optional().describe(
      "Filter to one reason — hard bounce, complaint, unsubscribe, manual.",
    ),
    active: z
      .enum(["true", "false"])
      .describe("`true` or `false`.")
      .transform((value) => value === "true")
      .optional()
      .describe(
        "`true` for the blocks in force now, `false` for the ones whose expiry has passed. Judged as each row's `active` is. Both when absent.",
      ),
    cursor: Cursor,
    limit: Limit,
  })
  .strict()
  .describe(
    "The suppression-list query: what to filter by and where to resume. To look one address up, POST it to `/suppressions/lookup`.",
  );
export type SuppressionsQuery = z.output<typeof SuppressionsQuery>;

/**
 * Block an address by hand.
 *
 * **There is no `reason` field, on purpose.** The column records *why an address is blocked*, and three
 * of its four values (`hard_bounce`, `complaint`, `unsubscribe`) are facts the system observed: a
 * bounce arrived, a complaint arrived, a recipient followed their own opt-out link. A management client
 * observed none of them, so letting it name one would let an operator's assertion enter the record as
 * an observation, and the deliverability decisions read off that column would be made on fiction. Every
 * address blocked through this route is `manual`, and what the operator knows goes in `detail`.
 */
export const SuppressRequest = z
  .object({
    email: WritableAddress,
    detail: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Why you are blocking it, in your own words. Stored verbatim on the row and in the audit trail."),
    expiresAt: z.iso
      .datetime()
      .optional()
      .describe(
        "When the block lifts, as an ISO-8601 instant. **Must be in the future** — checked in the handler against its injected clock rather than here, because a schema reading the wall clock would ignore the clock the route was given. Absent blocks permanently; a time-boxed block expires on its own rather than waiting for somebody to remember it. A past instant is refused because the send path decides purely on `expiresAt <= now`, so backdating one is exactly equivalent to lifting the block — an act this route's scope deliberately does not confer.",
      ),
  })
  .describe("Add one address to the global suppression list, as a manual block.");
export type SuppressRequest = z.output<typeof SuppressRequest>;

/**
 * Look one address up.
 *
 * An exact match rather than a search, and that is the point: answering "is this one address blocked"
 * should not require paging a list of every other person who ever unsubscribed, and a prefix or substring
 * search would enumerate the list a page at a time while looking like a lookup. A body because a query
 * string is written to every request log between the client and the Worker.
 */
export const SuppressionLookupRequest = z
  .object({
    email: AddressFilter.describe(
      "The address to look up, matched exactly against the stored key. Answers `is this person blocked` without disclosing anybody else.",
    ),
  })
  .strict()
  .describe("Look one address up on the global suppression list.");
export type SuppressionLookupRequest = z.output<typeof SuppressionLookupRequest>;

/** Unblock an address — the undo of {@link SuppressRequest}, and of a bounce, complaint, or opt-out. */
export const UnsuppressRequest = z
  .object({
    email: AddressFilter.describe("The address to unblock, matched exactly against the stored key."),
  })
  .describe("Remove one address from the global suppression list, re-opening sending to it.");
export type UnsuppressRequest = z.output<typeof UnsuppressRequest>;
