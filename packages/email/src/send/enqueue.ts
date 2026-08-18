// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import type { EmailJob } from "../data/emailJob";
import { EmailJob as EmailJobSchema } from "../data/emailJob";
import type { EmailJobStatus, SendMode, SuppressionReason } from "../data/enums";
import type { EmailDatabase, EmailSuppressionDatabase } from "../data/tables";
import { EmailInvalidPayloadError } from "../error/errors";
import { getTemplate, renderSubject, templateKind } from "../templates/engine";
import type { EmailTheme } from "../templates/theme";
import { mintBatchId } from "./batchIdentity";
import { recordEvent } from "./events";
import { resolveTimezoneSendAt } from "./sendAt";
import { blockingSuppression } from "./suppression";

/**
 * Enqueue an email. A request handler only ever does this — it never sends inline. Every email becomes
 * a `pithy_email_jobs` row; an `immediate` job also kicks the send Workflow now (lowest latency), while
 * `scheduled` and `timezone` jobs are left for the every-minute scheduler to pick up. The payload is
 * validated against the template schema here, so a bad call fails at enqueue, not mid-send.
 *
 * **Suppression is consulted here too, and no caller asks for it** (pithy-sh/pithy#355). A blocked
 * recipient never becomes a queued send: the row is born `suppressed`, no Workflow is started, and the
 * reason comes back on the result. The point is not a second gate — `runSend` is and stays the
 * authority, because whether an address is blocked is a question about the instant of sending and a
 * scheduled job is enqueued days before that. The point is that the caller **learns**, at the moment it
 * asked, without holding the suppression database itself. A three-person account whose addresses have
 * all hard-bounced is otherwise three ordinary skips in a send log nobody reads, rather than one notice
 * that reached nobody, said at the moment it went out.
 *
 * **The kind comes from the template, never from a caller** — {@link templateKind}, the same accessor
 * `runSend` uses. That is what keeps an unsubscribe from a newsletter from withholding an invitation:
 * the four suppression reasons stopped being interchangeable, and a check that restated
 * `"transactional"` at the call site would be making a claim about somebody else's template.
 */

/**
 * The Workflow binding used to start a send (Cloudflare `Workflow.create`). At enqueue it sends a batch
 * of one; the scheduler's fan-out starts one instance per batch through the same binding.
 *
 * `id` names the instance being created, and **every dispatcher passes one** (pithy-sh/pithy#342): the
 * scheduler passes its batch's, an enqueue passes the one it just stamped on the row, and a retry passes
 * the one it minted to replace the failed batch's. It is optional here only because the platform allows
 * omitting it, and omitting it is what made an immediate send unattributable to any instance — so the
 * row could not say a Workflow was coming and the safety net sent a second one. See
 * `send/batchIdentity.ts`.
 */
export interface SendWorkflowBinding {
  create(options: { id?: string; params: { jobIds: string[] } }): Promise<unknown>;
}

/** What the caller provides to enqueue an email. */
export interface EnqueueInput {
  /** The recipient address. */
  to: string;
  /** The template id (e.g. `magicLink`). */
  template: string;
  /** The template input variables; validated against the template's payload schema. */
  payload: unknown;
  /** Send mode; defaults to `immediate`. */
  mode?: SendMode;
  /** For `scheduled` mode: the absolute time to send. */
  sendAt?: Date;
  /** For `timezone` mode: the recipient-local time-of-day, `HH:MM`. */
  localTime?: string;
  /** For `timezone` mode: the recipient's IANA timezone. */
  timezone?: string;
  /** The marketing campaign id, for attribution. */
  campaignId?: string;
  /**
   * What this message is *about*, when the template id does not say it on its own.
   *
   * The discriminator for a template that carries more than one kind of message (pithy-sh/pithy#382).
   * `sentSince` matches on it, so a caller deciding whether to send — or whether to send a *correction* —
   * can tell two messages apart that share a template and a recipient. Opaque: nothing here parses it,
   * renders it, or puts it on a header or a link.
   *
   * **Not `campaignId`.** That one is marketing attribution and it leaves this row — onto every event,
   * into `campaignStats`, and signed into the tracking token that travels in a delivered email's URLs.
   * See the column's own note on `EmailJob`.
   *
   * Omit it where the template id already answers "what is this", which is most templates.
   */
  correlation?: string;
  /** Override click-link rewriting (defaults on for marketing, off for transactional). */
  clickTracking?: boolean;
  /** Override open-pixel injection (defaults on for marketing, off for transactional). */
  openTracking?: boolean;
  /**
   * The address a recipient's answer should go to, when it is not `fromAddress`.
   *
   * `@pithy-sh/support` is what this is for: a reply is sent as the adopter's onboarded sending
   * identity (Cloudflare validates the `From` domain against exactly what was onboarded) while the
   * conversation has to come back to the support inbox, which is usually a different subdomain.
   */
  replyTo?: string;
  /**
   * The `Message-ID` this job answers, angle brackets included — the `In-Reply-To` header.
   *
   * Set together with {@link references}. Threading on ids is what keeps a customer's client showing
   * one conversation instead of one message per answer, and only the Worker holds the chain, which
   * is why a reply is enqueued here rather than composed by whatever surface a human typed it into.
   */
  inReplyTo?: string;
  /** The `References` chain, angle-bracketed and space-separated. Built by the caller from the parent. */
  references?: string;
}

/** Dependencies enqueue needs: the database, the from identity, optional send-Workflow binding, time, ids. */
export interface EnqueueDeps {
  db: EmailDatabase;
  fromAddress: string;
  fromName: string;
  theme: EmailTheme;
  /** The send Workflow binding. When present, an immediate job is dispatched now; absent, the scheduler takes it. */
  sender?: SendWorkflowBinding;
  /**
   * The global suppression list. When present, a blocked recipient is recorded here and never queued.
   *
   * Optional for the same reason {@link EnqueueDeps.sender} is, and it is worth being exact about which
   * reason: absence does not mean "send to blocked addresses". The capability declares
   * `EMAIL_SUPPRESSIONS` a required binding, so a composed app worker always has one; and where a caller
   * genuinely has none, `runSend` still refuses the recipient before anything leaves. Making it fatal
   * here would mean refusing to *queue* a message because a list that will be consulted again before it
   * goes could not be consulted yet, which is strictly worse than queueing it.
   */
  suppressionDb?: EmailSuppressionDatabase;
  now: Date;
  /** Generate a job id (a UUID in production). */
  newId: () => string;
  /**
   * Mint the id of the batch this enqueue dispatches — **the send Workflow instance's id**
   * (pithy-sh/pithy#342). Defaults to {@link mintBatchId}; injected only so a test can name it.
   */
  newBatchId?: () => string;
}

/** The result of enqueuing: the new job id and its initial status. */
export interface EnqueueResult {
  jobId: string;
  /**
   * What the row was born as — and, for the caller, whether anything is coming for it.
   *
   * `pending` and `scheduled` both mean a send is on its way. `suppressed` means the address is
   * blocked. **`undispatched` means this composition binds no send Workflow**, so nothing was started
   * and nothing is coming while it stays that way (pithy-sh/pithy#410): a caller that renders "check
   * your inbox" off it is reporting a delivery that cannot happen. It is the one status here that
   * describes the *deployment* rather than the message — and the scheduler drains those rows once a
   * host exists, so it is not the end of the job.
   */
  status: EmailJobStatus;
  /**
   * Why nothing was queued, when the recipient is on the suppression list.
   *
   * The same field {@link import("./runSend").SendOutcome} carries and for the same reason: a caller
   * that only saw a status other than `failed` would report a delivery that never happened. "Suppressed"
   * alone is not enough either — whether the mailbox bounced, complained, or opted out is what an
   * operator's next move depends on.
   */
  suppressionReason?: SuppressionReason;
}

/** Resolve the absolute send time and initial status from the requested mode. */
function resolveSchedule(input: EnqueueInput, now: Date): { mode: SendMode; sendAt: Date; status: EmailJobStatus } {
  const mode = input.mode ?? "immediate";
  if (mode === "immediate") return { mode, sendAt: now, status: "pending" };
  if (mode === "scheduled") {
    if (!input.sendAt) throw new EmailInvalidPayloadError({ detail: "scheduled mode requires an absolute sendAt" });
    return { mode, sendAt: input.sendAt, status: "scheduled" };
  }
  if (!input.localTime || !input.timezone) {
    throw new EmailInvalidPayloadError({ detail: "timezone mode requires localTime and timezone" });
  }
  return { mode, sendAt: resolveTimezoneSendAt(input.localTime, input.timezone, now), status: "scheduled" };
}

/** Enqueue an email job, dispatching the send Workflow immediately when the mode is `immediate`. */
export async function enqueueEmail(deps: EnqueueDeps, input: EnqueueInput): Promise<EnqueueResult> {
  const template = getTemplate(input.template);
  // Validates the payload against the template schema and computes the stored subject.
  const subject = renderSubject(input.template, input.payload, deps.theme);
  const { mode, sendAt, status: scheduled } = resolveSchedule(input, deps.now);

  /**
   * Whether the suppression list withholds *this* message from *this* address.
   *
   * `templateKind(input.template)` and never a literal — `runSend` reads the same accessor, and the two
   * agreeing is what makes a hard bounce withhold an invitation while an unsubscribe does not. A caller
   * cannot influence this and is not asked to: it is the template's own declaration.
   */
  const blocked: SuppressionReason | null = deps.suppressionDb
    ? await blockingSuppression(deps.suppressionDb, input.to, deps.now, templateKind(input.template))
    : null;
  // The match key, on the same normalisation the suppression list is written and read under. The row
  // keeps the address as the caller typed it in `toAddress` — an operator diagnosing a send needs the
  // string that was actually addressed — and carries this beside it as `recipientKey`, which is what
  // the events table is keyed on and what `sentSince` matches. One value, computed once, so a job and
  // its events cannot disagree about who the person is.
  const recipient = normalizeAddress(input.to);

  // Whether this call starts a send Workflow at all: only an immediate job does, only where a binding
  // exists to start one on, and never for a recipient the list withholds this message from. Everything
  // else is left for the scheduler to claim.
  const sender = !blocked && mode === "immediate" ? deps.sender : undefined;
  /**
   * An immediate job with nothing to dispatch it on (pithy-sh/pithy#410).
   *
   * A missing binding is a **configuration fact known at compose time**, not a transient failure, and
   * the two used to be recorded identically: both left the row `pending` and told the caller "on its
   * way". That reads as deferral because of the scheduler's safety net — but the net is the
   * every-minute cron on the host worker, and a composition with no send Workflow binding has no host
   * worker either. So there is nothing to defer to *yet*, and `pending` was a promise the deployment
   * could not keep. A magic link enqueued under `pithy dev` sat in that state forever while the sign-in
   * screen said "check your inbox".
   *
   * It is a truthful status, never a grave. The day a host is deployed, its first tick claims these
   * rows exactly as it claims a stranded `pending` one — a tick running at all is the host existing —
   * so mail enqueued before `pithy email provision` is delayed and not lost.
   *
   * A `scheduled` or `timezone` job is deliberately not this: the scheduler claims it by `sendAt` and
   * never needed a binding at enqueue. Nor is a suppressed recipient, which has its own status and its
   * own event. This is only the case where the caller asked for a send now and nothing exists to make
   * one.
   */
  const undispatchable = !blocked && mode === "immediate" && !deps.sender;
  const status: EmailJobStatus = blocked ? "suppressed" : undispatchable ? "undispatched" : scheduled;
  /**
   * The batch this enqueue is about to start — named here, before the row exists, because the row has to
   * carry it (pithy-sh/pithy#342).
   *
   * Without it the row is born naming nobody, and a row naming nobody is stranded by definition: the
   * scheduler's safety net claims any `pending` job older than `graceMs` and starts a *second* send
   * Workflow for it. That is not a hypothetical race with a slow enqueue — it is the ordinary shape of a
   * transient send failure. `runSend` throws on a retryable error so the Workflow step backs off, and a
   * backoff writes nothing at all, so the very first retry leaves the row looking exactly like a dispatch
   * that died. `runSend` short-circuits only a job already `sent`, so both instances would render and
   * both would call the Email Service. One person, two emails.
   *
   * Null for a `scheduled` or `timezone` job, and for an immediate one with no binding, because in those
   * cases nothing is coming for the row and saying otherwise would hold it against a batch that does not
   * exist.
   */
  const batchId = sender ? (deps.newBatchId ?? mintBatchId)() : null;

  const marketing = template.category === "marketing";
  const job: EmailJob = {
    id: deps.newId(),
    toAddress: input.to,
    recipientKey: recipient,
    fromAddress: deps.fromAddress,
    fromName: deps.fromName,
    subject,
    template: input.template,
    category: template.category,
    payload: input.payload as Record<string, unknown>,
    payloadRedactedAt: null,
    status,
    mode,
    attempts: 0,
    batchId,
    sendAt,
    timezone: input.timezone ?? null,
    localTime: input.localTime ?? null,
    campaignId: input.campaignId ?? null,
    correlation: input.correlation ?? null,
    openTracking: input.openTracking ?? marketing,
    clickTracking: input.clickTracking ?? marketing,
    messageId: null,
    // The same sentence `runSend` writes when it skips one, so the send log reads the same whichever
    // pass caught it — and, for the undispatchable row, the one sentence that says why it stopped
    // here. The status is the state; this column is what an operator reads next to it.
    error: blocked
      ? `recipient suppressed: ${blocked}`
      : undispatchable
        ? "no EMAIL_SENDER binding: this composition can start no send Workflow"
        : null,
    bounceCode: null,
    bounceType: null,
    replyTo: input.replyTo ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    createdAt: deps.now,
    updatedAt: deps.now,
    sentAt: null,
  };

  await deps.db.insertInto("pithyEmailJobs").values(EmailJobSchema.encode(job)).execute();

  // A withheld message is on the record as an event, not merely as a status — the send log's history is
  // what an operator reads to find out that an advisory reached nobody, and a row with no event in it
  // looks exactly like a job still waiting its turn.
  if (blocked) {
    await recordEvent(deps.db, { jobId: job.id, recipient, type: "suppressed", detail: blocked }, deps.now);
    return { jobId: job.id, status, suppressionReason: blocked };
  }

  // Immediate sends start the Workflow now for lowest latency, under the id the row already carries —
  // the row is written first so the instance can never be alive before the row can name it.
  //
  // If the dispatch fails, the row stays `pending` naming an instance the runtime has never heard of.
  // `batchIsAlive` turns that into "not alive", so the scheduler re-drives it on the next tick exactly
  // as it did before batch ids existed — a failed dispatch still never loses an email. And if the
  // failure was only the *answer* going missing, the instance is there and alive, the row names it, and
  // the tick holds off: the case that used to be a double-send is now the case the id was minted for.
  if (sender && batchId) {
    try {
      await sender.create({ id: batchId, params: { jobIds: [job.id] } });
    } catch {
      // Swallowed deliberately: the scheduler's safety net owns recovery.
    }
  }

  return { jobId: job.id, status };
}
