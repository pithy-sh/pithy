// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress, parseAddress } from "@pithy-sh/core/src/address/address";
import { z } from "zod";
import { SupportReplySnippet } from "../reply/snippets";

/**
 * The support capability's configuration — the thin, user-owned surface in `pithy.config.ts`.
 *
 * The one field with no sensible default is `inboundAddresses`, and the reason is worth stating
 * where an adopter will read it: **Cloudflare Email Routing takes over a zone's MX.** An address on
 * the apex would move the adopter's real mail off their existing provider, so the address is theirs
 * to choose deliberately — almost always on a subdomain (`support@help.theirdomain.com`) — and this
 * capability will not guess one. Until it is set the inbox is inert: every message is ignored, and
 * the handler says so once in the log rather than quietly storing mail from an address nobody
 * configured.
 */

/**
 * The default Workers AI model for classification.
 *
 * An instruct model rather than a classifier: the taxonomy is federated, so the valid label set is
 * not known until an adopter composes the capability, and a fine-tuned classifier cannot be given new
 * classes in a config file. Small on purpose — this runs once per inbound message on the adopter's
 * own bill, and the judgement is "which of these eight sentences fits", not a reasoning task.
 */
export const DEFAULT_CLASSIFY_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** How the inbound message is classified, and by what. */
export const SupportAiConfig = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Classify each inbound message with Workers AI. Off means every thread stays `uncategorized` and the inbox is chronological — still useful, and still free.",
      ),
    model: z
      .string()
      .default(DEFAULT_CLASSIFY_MODEL)
      .describe(
        "The Workers AI model classification runs on, over your own `AI` binding. Recorded on every classification, so a model change is visible in the data rather than inferred. Override to swap models with no code edits.",
      ),
    maxChars: z
      .number()
      .int()
      .positive()
      .default(4000)
      .describe(
        "How much of a message body the model sees. A support request states its point in the first paragraph; the rest is usually a quoted thread, and paying to embed somebody's own signature block twice a day is the kind of cost that creeps.",
      ),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .default(0)
      .describe(
        "Sampling temperature. Zero by default: classification wants the same answer for the same message, and a reclassification pass that disagreed with itself would be unreadable.",
      ),
  })
  .describe("Workers AI classification settings — the model, how much it reads, and how deterministic it is.");
export type SupportAiConfig = z.output<typeof SupportAiConfig>;

/** What happens to files that arrive attached to a message. */
export const SupportAttachmentsConfig = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Store attachments in your own R2. Off drops them at ingest — the message is still stored and the attachment metadata is not, which is the right setting for an inbox that never needs a screenshot.",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024)
      .describe("The largest single attachment stored. A larger one is skipped; the message it arrived on is kept."),
    maxCount: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe(
        "How many attachments one message may contribute. Beyond this the extras are skipped — a bound on a number an attacker chooses.",
      ),
    retainRaw: z
      .boolean()
      .default(true)
      .describe(
        "Keep each message's raw MIME in R2, unchanged. Separate from `enabled` on purpose: the raw form is what makes the parse and the sanitise re-runnable, so a project that drops attachments still wants it, and folding the two together would silently turn off re-parsing for anyone who only meant to stop storing screenshots. Off means `rawKey` is null on every message and a sanitiser improvement can never be applied retroactively.",
      ),
  })
  .describe("Attachment and raw-message handling — what bytes are kept, and the bounds on what one message may store.");
export type SupportAttachmentsConfig = z.output<typeof SupportAttachmentsConfig>;

/**
 * The spam and volume guard.
 *
 * A public address is a public write endpoint into the adopter's D1, and that is the honest way to
 * think about it. These bounds are what stop a mail flood from being a storage bill.
 */
export const SupportGuardConfig = z
  .object({
    maxRawBytes: z
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024)
      .describe(
        "The largest raw message accepted. Anything bigger is refused before it is parsed, because parsing is the expensive step and the size is known first.",
      ),
    maxPerSenderPerHour: z
      .number()
      .int()
      .positive()
      .default(20)
      .describe(
        "How many messages one address may land in an hour. The per-sender bound catches the common case: one broken auto-responder in a loop with your inbox.",
      ),
    maxPerHour: z
      .number()
      .int()
      .positive()
      .default(500)
      .describe(
        "How many messages the whole inbox may accept in an hour, across every sender. The bound that matters under a distributed flood, where no single address trips the per-sender limit.",
      ),
    trustAuthenticationResults: z
      .boolean()
      .default(false)
      .describe(
        "Treat the `Authentication-Results` header in the received message as a verdict you can rely on. **Off by default, and the reason is that under Cloudflare Email Routing there is no trust anchor for it.** Cloudflare evaluates DMARC — its `reply()` API requires a valid result — but does not reliably hand the verdict to a Worker (`Authentication-Results`, `Received`, and `DKIM-Signature` are all reported missing from `message.headers`), and a header a sender wrote is indistinguishable from one an MTA wrote once the MTA's copy is absent. Turn this on only if your receiving MTA both **stamps** the header and **strips** any inbound copy of it, and set `authservId` alongside. With it off the inbox still matches a sender to an account — it just never claims that match was verified, and withholds their billing history.",
      ),
    authservId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The `authserv-id` your receiving MTA stamps its `Authentication-Results` header with — the field before the first `;`. Read only when `trustAuthenticationResults` is on. **This is a public hostname, not a credential**: an attacker who knows it can put it in a header they write, so it narrows a mistake rather than stopping an attacker. It is worth setting anyway, because with the wrong MTA in front of you it is the difference between reading somebody else's verdict and reading none.",
      ),
    archiveSpam: z
      .boolean()
      .default(true)
      .describe(
        "Archive a thread the moment the classifier calls it `spam`, so it never appears in the open inbox. **Archived, never deleted** — a classifier that silently destroyed mail would be untrustworthy the first time it was wrong, and it is wrong sometimes. The thread stays readable under the archived filter and unarchiving is one click, which is what makes this a filter rather than a bin. Off leaves spam in the open inbox for you to sort by hand.",
      ),
  })
  .describe("Inbound bounds — size, per-sender rate, global rate, and what happens to spam.");
export type SupportGuardConfig = z.output<typeof SupportGuardConfig>;

/**
 * What a signed-in user may attach to an in-app submission.
 *
 * **Stated here rather than inherited from `attachments`, and that is the point.** The mail path's
 * bounds were written for parts of a MIME message somebody sent to a public address: they cap size and
 * count, and they say nothing at all about type, because there is no useful type restriction on mail —
 * refusing a `.docx` a customer attached to a bug report would lose the report. A direct upload from a
 * browser is a different surface with a different answer: the client is authenticated but untrusted,
 * the useful payload is a screenshot, and an allowlist is both possible and worth having. Inheriting
 * the email numbers would have meant a 10 MB any-type upload endpoint arriving as a side effect of a
 * setting an adopter tuned for their inbox.
 *
 * Bytes are stored exactly as the mail path stores them — server-derived opaque key,
 * `application/octet-stream` on the object whatever was declared — so nothing here re-opens the
 * stored-XSS question `attachment/store.ts` already closed.
 */
/**
 * The hard ceiling on how many attachments one submission may declare, whatever
 * `submission.attachments.maxCount` is set to.
 *
 * On the schema as well as in the handler because the two refuse at different moments and the earlier
 * one is free: the validator rejects a thousand-element array before a handler runs, without reading
 * the resolved config. The configured bound is what an adopter tunes; this is what is true regardless.
 */
export const MAX_SUBMISSION_ATTACHMENTS = 10;

export const SupportSubmissionAttachmentsConfig = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Accept attachments on an in-app submission. Off refuses any, which is the right setting for a project that wants feedback but no upload surface at all — the report is still stored, without the file.",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024)
      .describe(
        "The largest single attachment accepted, measured on the **decoded** bytes. Deliberately smaller than the mail path's bound: a phone screenshot is under a megabyte, and this is a limit on what a signed-in client may push into your R2 in one request rather than on what a stranger's mail client happened to send.",
      ),
    maxCount: z
      .number()
      .int()
      .positive()
      .max(MAX_SUBMISSION_ATTACHMENTS)
      .default(3)
      .describe(
        "How many attachments one submission may carry. Low on purpose — a bug report is a screenshot or two, and every extra slot is another `maxBytes` a client may spend per request. Checked before any payload is decoded, so the cheapest refusal in the path does not sit behind its most expensive step.",
      ),
    allowedContentTypes: z
      .array(z.string().min(3).describe("One exact MIME type, lowercased, e.g. `image/png`. No wildcards."))
      .default(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"])
      .describe(
        "The exact types a submission may carry — **an allowlist, not a denylist**, so a type nobody considered is refused rather than accepted. The default is what a bug report is actually made of: screenshots, a PDF, a log paste. The declared type is recorded and never honoured when the bytes are served, so this bounds what lands in your bucket rather than standing in for that protection.",
      ),
  })
  .describe(
    "Bounds on a direct upload from a signed-in client — size, count, and an allowlist of types. Stated explicitly rather than inherited from the mail path, which answers a different question.",
  );
export type SupportSubmissionAttachmentsConfig = z.output<typeof SupportSubmissionAttachmentsConfig>;

/**
 * The ceilings a configured submission bound may not exceed — the route's own schema is written to
 * these, so a payload beyond one is refused by the validator before a handler runs.
 *
 * Two layers, and both earn their place. The **config** bound is the adopter's number and produces the
 * message their user reads; the **schema** ceiling is what stops a megabyte of text reaching a handler
 * at all, and it cannot be config-derived because a request schema is built once at module load while
 * config is resolved per project. Bounding the config field by the same constant is what keeps them
 * from disagreeing: a setting above the ceiling would be a limit the route silently refused to honour.
 */
export const MAX_SUBMISSION_SUBJECT_CHARS = 500;
/** The hard ceiling on a submission body, whatever `submission.maxBodyChars` is set to. */
export const MAX_SUBMISSION_BODY_CHARS = 100_000;

/**
 * The in-app submission channel: a signed-in user of the adopter's own app opening a support thread
 * without leaving it.
 *
 * **The hardest problem in the mail path does not exist here.** `inbound/authenticity.ts` spends two
 * hundred lines earning a customer link from a `From:` header that anybody can write; a submission
 * arrives on a request `requireAuth()` already proved, so the account is the identity rather than a
 * guess about it. Everything below is therefore a bound on *volume and shape*, never on identity.
 *
 * Bounded separately from `guard` for the same reason it is counted separately: that block exists
 * because a public address is a public write endpoint, and this surface is neither public nor
 * anonymous. Abuse here is attributable to an account and revocable with it, which is a materially
 * different threat model and deserves its own numbers rather than a share of somebody else's.
 */

export const SupportSubmissionConfig = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Serve the in-app submission routes. On by default because the capability is inert without an address either way, and a project that composes support almost always wants its signed-in users able to write in. Off removes the routes entirely — they answer 404, not 403, because a route that is not served has nothing to say about who was asking.",
      ),
    maxSubjectChars: z
      .number()
      .int()
      .positive()
      .max(MAX_SUBMISSION_SUBJECT_CHARS)
      .default(200)
      .describe(
        "The longest subject a submission may carry. It becomes the thread's name in the inbox and the subject line of every reply, so it is bounded to something that renders in a list.",
      ),
    maxBodyChars: z
      .number()
      .int()
      .positive()
      .max(MAX_SUBMISSION_BODY_CHARS)
      .default(10_000)
      .describe(
        "The longest report body accepted. Generous — somebody describing a bug properly is exactly who this channel is for — but bounded, because it is a string a client chose and it lands in a D1 row and a model prompt.",
      ),
    maxPerAccountPerHour: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe(
        "How many submissions one account may land in an hour. **Session-bound abuse is attributable and revocable in a way mail is not**, which is why this number is smaller than the mail path's and still safe: a real person filing a genuine report does not file eleven, and an account that does is one an adopter can act on. Counted from the messages table over the same sliding hour the mail guard uses, and counted **only against app submissions** — a busy inbox must never stop a user reporting the outage.",
      ),
    attachments: SupportSubmissionAttachmentsConfig.prefault({}).describe(
      "What a signed-in client may upload with a report.",
    ),
  })
  .describe(
    "The in-app submission channel — whether it is served, what one submission may contain, and how many one account may send.",
  );
export type SupportSubmissionConfig = z.output<typeof SupportSubmissionConfig>;

/** How a reply leaves the building. */
export const SupportReplyConfig = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Allow replies from the control-plane route. Off makes the inbox read-only, which is a reasonable setting for a project that answers support from its own mail client.",
      ),
    replyToAddress: z
      .string()
      .optional()
      // Normalized for the same reason, and it matters more here: this address is what a customer's
      // answer comes back to, so a casing mismatch against `inboundAddresses` ends the conversation
      // silently rather than loudly.
      .transform((address) =>
        address === undefined ? undefined : (parseAddress(address) ?? normalizeAddress(address)),
      )
      .describe(
        "The `Reply-To` a reply carries — the address the customer's answer comes back to, which must be one of `inboundAddresses` or the conversation ends there. Defaults to the inbox address the thread arrived on, which is almost always what you want.",
      ),
    snippets: z
      .record(z.string(), SupportReplySnippet)
      .default({})
      .describe(
        "Your own canned replies, merged over the ones Pithy ships and winning on a key collision. These are *starting points a human picks and edits* in the dashboard, not automatic replies — nothing here is ever sent without somebody pressing send. Author them with `defineSupportReplies` so a malformed one fails where it is written.",
      ),
  })
  .describe(
    "Reply settings — whether replies are allowed, where the answer goes, and what to offer as a starting point.",
  );
export type SupportReplyConfig = z.output<typeof SupportReplyConfig>;

/**
 * How text search is answered.
 *
 * The one setting here has a cost an adopter must opt into knowingly, which is why it is a setting
 * at all rather than a decision this package made for them.
 */
export const SupportSearchConfig = z
  .object({
    fts: z
      .boolean()
      .default(false)
      .describe(
        "Build a SQLite FTS5 index over message subjects and bodies. **Off by default, and the reason is not performance.** `wrangler d1 export` refuses to dump any database containing an FTS5 virtual table — it fails outright rather than skipping the table — and the check runs server-side across the whole database before `--table` filtering, so turning this on takes your **entire app database's** export with it. A failed attempt has also been reported to leave the database inaccessible until it clears. If you do not use `wrangler d1 export`, none of that reaches you and FTS5 is the better search. Safe to toggle either way: the index is derived rather than migrated, so `pithy support provision` creates or drops it to match — and until you re-provision, search falls back to the `LIKE` scan rather than failing.",
      ),
  })
  .describe("Text search settings — the `LIKE` scan by default, FTS5 as a deliberate opt-in.");
export type SupportSearchConfig = z.output<typeof SupportSearchConfig>;

/** The full support configuration. */
export const SupportConfig = z
  .object({
    inboundAddresses: z
      .array(
        z
          .string()
          .min(3)
          .describe("One address this inbox accepts mail for, e.g. `support@help.example.com`.")
          // Normalized at parse time, because every comparison downstream is against a normalized
          // envelope recipient. Without this, `Support@Help.Example.com` in an adopter's config
          // matches nothing, every message returns `not_addressed`, and the inbox is *silently*
          // inert — no error, no warning, just no mail ever appearing.
          .transform((address) => parseAddress(address) ?? normalizeAddress(address)),
      )
      .default([])
      .describe(
        "The addresses this capability claims. Every capability's `email()` handler sees every message the Worker receives, so this list is how support tells its mail apart from the bounce handler's — and it is a claim, not a route: the routing rule that delivers to this Worker is created by `pithy support provision`. **Use a subdomain, never your apex**: Email Routing takes over the zone's MX, and enabling it on the apex moves your real mail off your provider. Empty means the inbox is inert.",
      ),
    categories: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Your own categories, merged over the eight Pithy ships and winning on a key collision. A key is `snake_case`; the value is the instruction a model reads when deciding whether this is the one, and it lands in the prompt verbatim. Author it with `defineSupportCategories` so a typo fails where it is written.",
      ),
    ai: SupportAiConfig.prefault({}).describe("Classification settings."),
    attachments: SupportAttachmentsConfig.prefault({}).describe("Attachment handling."),
    guard: SupportGuardConfig.prefault({}).describe("Inbound mail size and rate bounds."),
    submission: SupportSubmissionConfig.prefault({}).describe("The in-app submission channel."),
    reply: SupportReplyConfig.prefault({}).describe("Reply settings."),
    search: SupportSearchConfig.prefault({}).describe("How text search is answered."),
  })
  .describe(
    "Configuration for the support capability — which addresses it claims, and how it classifies and bounds them.",
  );
export type SupportConfig = z.output<typeof SupportConfig>;
export type SupportConfigInput = z.input<typeof SupportConfig>;
