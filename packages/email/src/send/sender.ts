// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The minimal shape of the Cloudflare Email Service `send_email` binding this capability depends on.
 * We type only what we use, structurally — the real binding (`env.EMAIL`) satisfies it, and tests
 * inject a fake so send outcomes are deterministic. The binding sends both `html` and `text` and
 * returns a `messageId`; it throws on failure with an `E_*` `.code` (mapped by `errorMapping`).
 */

/** An outbound message handed to the binding — html + text both, per deliverability best practice. */
export interface EmailMessage {
  /** The recipient address. */
  to: string;
  /** The sender — address plus display name. */
  from: { email: string; name?: string };
  /** Optional reply-to address. */
  replyTo?: string;
  /** The rendered subject line. */
  subject: string;
  /** The rendered HTML body. */
  html: string;
  /** The rendered plain-text body. */
  text: string;
  /** Optional whitelisted headers (e.g. `List-Unsubscribe`). */
  headers?: Record<string, string>;
}

/**
 * The send response. The Workers binding returns a `messageId`; the batch/REST shape additionally
 * reports `delivered`/`permanentBounces`/`queued`. We capture all of it so synchronous permanent
 * bounces can feed suppression immediately, and the `messageId` ties an asynchronous bounce back.
 */
export interface EmailSendResult {
  messageId?: string;
  delivered?: string[];
  permanentBounces?: string[];
  queued?: string[];
}

/** The send seam. `env.EMAIL` satisfies it; tests pass a fake. */
export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
