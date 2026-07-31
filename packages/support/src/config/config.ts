// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { normalizeAddress } from "../mime/address";
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
      .transform((address) => (address === undefined ? undefined : (normalizeAddress(address) ?? address)))
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
          .transform((address) => normalizeAddress(address) ?? address.trim().toLowerCase()),
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
    guard: SupportGuardConfig.prefault({}).describe("Inbound size and rate bounds."),
    reply: SupportReplyConfig.prefault({}).describe("Reply settings."),
    search: SupportSearchConfig.prefault({}).describe("How text search is answered."),
  })
  .describe(
    "Configuration for the support capability — which addresses it claims, and how it classifies and bounds them.",
  );
export type SupportConfig = z.output<typeof SupportConfig>;
export type SupportConfigInput = z.input<typeof SupportConfig>;
