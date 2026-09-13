// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { OrganizationConfig } from "../config/config";

/**
 * The one mail this capability sends.
 *
 * ## The seam is a function, and that is deliberate
 *
 * `@pithy-sh/email` publishes `enqueue`, and this module takes it as an argument rather than reaching
 * for it — the same shape `@pithy-sh/testers` and `@pithy-sh/auth` use. Three things follow. The write
 * path is testable against real D1 with no mail transport at all. A Worker composed without email fails
 * by name at the invite rather than silently sending nothing. And email stays an **optional** peer of
 * this package: nothing here imports it, not even a type, so a project that never composed it still
 * compiles.
 *
 * **Nothing here sends.** Enqueuing inherits the existing path in full — the send Workflow with its
 * retries, the suppression list, bounce handling, and the job history that records exactly what went out
 * and when. An inline send would be a second delivery path with none of it.
 *
 * ## Two ways the words get written, and why both exist
 *
 * {@link sendInvitationMail} enqueues through the kit's `invite` template. That is the delivery path,
 * and it is the one a composed project takes: the template already carries the shell, the light/dark
 * theme, the translated catalog and the tracked-link declaration, and writing a second template here
 * would be a second place for the wording to drift.
 *
 * {@link renderInvitationMail} writes the same three facts as plain text and HTML, for the project that
 * set `sendInvitationEmail` to false and delivers the offer its own way. It is not a fallback template —
 * it is the words, so that a project which composed no email capability is not left assembling them from
 * a type.
 *
 * **The organization's name is never interpolated into HTML unescaped, in either path.** It is text an
 * adopter's tenant chose, rendered on a page somebody else reads, which is the definition of untrusted
 * input — a tenant named `<img onerror=…>` would otherwise be markup in every colleague's inbox, sent
 * over the adopter's own DKIM signature. The template path is safe structurally, because Handlebars
 * escapes an interpolated value; this module's path is safe because {@link escapeHtml} is applied to
 * every one of them, and `invitation.test.ts` plants a name full of markup against both.
 *
 * ## The token is in the payload, and the payload is a row
 *
 * `enqueue` writes a `pithy_email_jobs` row with the payload in it, and the email capability never
 * deletes a job. So the accept URL — token included — is at rest in the same D1 as the digest in
 * `pithy_organization_invitations.token_digest`, for longer than the invitation is redeemable.
 *
 * **There is nothing to route around here.** The template renders the link, so the link has to be in the
 * payload; an id swapped for the token at click time would be a second name for the same secret, live
 * for exactly as long, in exactly the same row. It is stated rather than papered over, because the
 * digest column reads like a guarantee this defeats. What still holds is the property the digest was
 * never carrying alone: acceptance needs a signed-in session whose own address equals the invited one,
 * so a token read out of that table is an offer somebody has to be able to receive mail as, not a key.
 */

/**
 * The enqueue seam, as `@pithy-sh/email` exposes it — bound to the request env by the caller.
 *
 * Structural rather than imported, because email is an optional peer of this package and a type-only
 * import would still be a compile-time edge into a package a project may not have.
 */
export type EnqueueInvitation = (input: {
  to: string;
  template: string;
  payload: unknown;
  locale?: string;
}) => Promise<{ jobId: string; status: string }>;

/**
 * The kit template this mail renders through, named once.
 *
 * Named rather than spelled at the `enqueue` call, because more than one thing reads it and one spelling
 * is what keeps them agreeing. The suppression rule is the sharpest case: whether an address on the list
 * may still be sent to depends on the *kind* of mail, and the kind is a property of this template.
 */
export const INVITATION_TEMPLATE = "invite";

/**
 * The path segment the **JSON** invitation routes live under, inside `basePath`.
 *
 * It was `INVITATION_ACCEPT_SEGMENT` and it no longer names the accept link — `pithy-sh/pithy#571` moved
 * that to `invitationAcceptPath`, a page in the adopter's own app. A constant still called *accept*
 * would point the next reader at exactly the conflation that bug was.
 */
export const INVITATIONS_ROUTE_SEGMENT = "invitations";

/** What an invitation mail says. Three facts, and a link that carries the token. */
export interface InvitationMail {
  /** The invited address. */
  readonly to: string;
  /** The organization being joined, by display name. **Tenant text.** Escaped wherever it meets markup. */
  readonly organizationName: string;
  /** What the sender calls themselves, or a plain stand-in when they never said. Tenant text too. */
  readonly inviterName: string;
  /**
   * The link that accepts it. Built by {@link invitationAcceptUrl}, which is the only thing that should.
   *
   * The plaintext token lives here and in the recipient's inbox. It is never logged, never audited, and
   * never returned in a response body — but it **is** persisted, and by the email capability: see this
   * module's note.
   */
  readonly acceptUrl: string;
}

/**
 * The absolute link an invitation mail carries. One place mints it; the invite and the resend both come
 * here.
 *
 * **Absolute, because an email cannot carry a relative URL.** `baseUrl` is optional in the config and
 * required here, so a project that composed invitations without an origin fails at the first send with a
 * sentence naming the setting — rather than mailing `/organizations/invitations/…` to somebody whose
 * mail client will render it as nothing.
 *
 * **Built from `invitationAcceptPath`, never from `basePath` — `pithy-sh/pithy#571`.** It was the latter,
 * and that was the defect: `GET {basePath}/invitations/:token` is a real route on this capability and it
 * answers `c.json(...)`, so every invitation ever sent pointed a person at a response body in their
 * browser. No composition could avoid it — aiming `basePath` at a page path does not help, because the
 * JSON route mounts there too and the Worker answers before any client router sees the request.
 *
 * The two are now different settings because they are different things: one is where this capability's
 * API lives, the other is where a person is sent. The JSON read stays where it was, for the page at the
 * other end to call.
 *
 * **The token is a path segment, not a query parameter.** A query string reaches `Referer` headers,
 * access logs and analytics that record a full query without being asked, and none of those is somewhere
 * a live invitation token should turn up. Neither form is a breach on its own — the mail carries the
 * token either way — but one of them spills further for nothing.
 *
 * `encodeURIComponent` is belt and braces: `mintInvitationToken` is base64url and has nothing to escape.
 * It stays because the day that changes, this is the line that would have to have been remembered.
 */
export function invitationAcceptUrl(
  config: Pick<OrganizationConfig, "baseUrl" | "invitationAcceptPath">,
  token: string,
): string {
  if (config.baseUrl === undefined) {
    throw new InternalError({
      message: "That invitation could not be sent.",
      action: "Set `baseUrl` on the organization capability, so an invitation link has an origin.",
      detail: "organization config has no baseUrl, and an invitation link cannot be relative",
    });
  }
  // One trailing slash on the origin and one leading slash on the base path would otherwise meet.
  const origin = config.baseUrl.replace(/\/+$/, "");
  return `${origin}${config.invitationAcceptPath}/${encodeURIComponent(token)}`;
}

/** The three facts the `invite` template takes, built once so the subject and the send cannot differ. */
function invitationPayload(mail: InvitationMail): Record<string, unknown> {
  return {
    inviterName: mail.inviterName,
    organizationName: mail.organizationName,
    acceptUrl: mail.acceptUrl,
  };
}

/**
 * Enqueue one invitation mail.
 *
 * **Answers with the enqueue's own result, not just the job id.** A recipient the global suppression list
 * blocks gets a row saying `suppressed` and no send. A caller that read only the id would audit a mail
 * that never left, and would leave an invitation outstanding for somebody who was never going to receive
 * it.
 *
 * The locale is the recipient's, not the sender's request's — omitted where nothing is known, which
 * renders the kit's English rather than claiming a choice the recipient never made.
 */
export async function sendInvitationMail(
  enqueue: EnqueueInvitation,
  mail: InvitationMail,
  locale?: string | null,
): Promise<{ jobId: string; status: string }> {
  return await enqueue({
    to: mail.to,
    template: INVITATION_TEMPLATE,
    payload: invitationPayload(mail),
    ...(locale === null || locale === undefined ? {} : { locale }),
  });
}

/** One invitation, written out. Both bodies, so a caller sending it itself sends a complete message. */
export interface RenderedInvitationMail {
  /** The subject line. */
  readonly subject: string;
  /** The plain-text body. The link on its own line, so every client makes it clickable. */
  readonly text: string;
  /** The HTML body. Every tenant-supplied value escaped — see this module's note. */
  readonly html: string;
}

/**
 * Write one invitation as plain text and HTML.
 *
 * For the project that set `sendInvitationEmail` to false and delivers the offer its own way. The words
 * are the kit `invite` template's, to the letter, so the two paths say the same thing — a project that
 * later composes email does not find its invitations rephrased.
 *
 * **Plain text and HTML both, never HTML alone.** A mail with no text part is a mail a screen reader, a
 * terminal client and every spam filter in the path read worse, and the text part is the one that
 * survives a client that strips markup.
 */
export function renderInvitationMail(mail: InvitationMail): RenderedInvitationMail {
  const subject = `${mail.inviterName} invited you to ${mail.organizationName}`;
  const body = `${mail.inviterName} invited you to join ${mail.organizationName}.`;

  return {
    subject,
    text: `${body}\n\nAccept: ${mail.acceptUrl}`,
    // Escaped at the point of interpolation rather than on the way in, so a reader of this line can see
    // that it is escaped. A value sanitized somewhere upstream is a value somebody adds a second caller
    // for.
    html: [`<p>${escapeHtml(body)}</p>`, `<p><a href="${escapeHtml(mail.acceptUrl)}">Accept invitation</a></p>`].join(
      "",
    ),
  };
}

/** The five characters that turn a value into markup, and the one place this package spells them. */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape a value for HTML, attribute position included.
 *
 * `&` first is not a detail: escaping it after the others would rewrite the ampersands they just
 * introduced, and `&lt;` would arrive as `&amp;lt;`. Doing all five in one pass through a character
 * class is how that ordering stops being something to remember.
 *
 * Quotes are escaped as well as brackets because the accept URL is interpolated into an `href`, and a
 * value that can close an attribute is a value that can open an event handler.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
